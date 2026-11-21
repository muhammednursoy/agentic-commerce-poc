import { createHash } from "node:crypto";
import type http from "node:http";
import { config } from "../config.ts";
import { Router, callJson, pspReference, randomId } from "../http.ts";
import type { Json, Req, Res } from "../http.ts";
import { sessionTotal } from "../acp.ts";
import type { CheckoutSession, Message, Quote } from "../acp.ts";
import { signNotification } from "../adyen-hmac.ts";
import type { NotificationRequestItem } from "../adyen-hmac.ts";
import { decodeMockGooglePayToken } from "../google-pay-mock.ts";

interface Allowance {
  reason: "one_time";
  max_amount: number;
  currency: string;
  checkout_session_id: string;
  merchant_id: string;
  expires_at: string;
}

interface TokenRecord {
  id: string;
  allowance: Allowance;
  cardNumber: string;
  used: boolean;
  created: string;
}

interface Payment {
  pspReference: string;
  resultCode: "Authorised" | "Refused" | "RedirectShopper";
  refusalReason?: string;
  merchantReference: string;
  amount: { value: number; currency: string };
  paymentMethodType?: string;
  action?: Json;
}

const HOOK_HEADERS = () => ({ authorization: `Bearer ${config.merchantHookSecret}` });
const REFUSED_CARD_SUFFIX = "0002";
const CHALLENGE_CARD_SUFFIX = "0044";

export class MockAdyen {
  readonly sessions = new Map<string, CheckoutSession>();
  readonly tokens = new Map<string, TokenRecord>();
  readonly payments: Payment[] = [];
  private readonly requestedItems = new Map<string, Json>();
  private readonly idempotency = new Map<string, { hash: string; res: Res }>();
  private readonly merchantAccounts = new Set([config.merchantAccount]);

  router(): Router {
    const acp = `/commerce-suite/acp/v1/:company/checkout_sessions`;
    return new Router()
      .on("POST", acp, (r) => this.guardCommerce(r, () => this.createSession(r)))
      .on("GET", `${acp}/:id`, (r) => this.guardCommerce(r, () => this.getSession(r)))
      .on("POST", `${acp}/:id`, (r) => this.guardCommerce(r, () => this.updateSession(r)))
      .on("POST", `${acp}/:id/complete`, (r) => this.guardCommerce(r, () => this.completeSession(r)))
      .on("POST", `${acp}/:id/cancel`, (r) => this.guardCommerce(r, () => this.cancelSession(r)))
      .on(
        "POST",
        "/paltokenization/servlet/Recurring/Agentic/acp/v1/agentic_commerce/delegate_payment",
        (r) => this.delegatePayment(r),
      )
      .on("POST", "/v72/payments", (r) => this.checkoutPayments(r));
  }

  listen(port: number): Promise<http.Server> {
    return this.router().listen(port, "mock-adyen");
  }

  private async guardCommerce(req: Req, next: () => Promise<Res> | Res): Promise<Res> {
    if (req.headers.authorization !== `Bearer ${config.commerceSuiteApiKey}`) {
      return { status: 401, body: { type: "invalid_request", code: "unauthorized", message: "invalid API key" } };
    }
    if (req.params.company !== config.companyAccount) {
      return { status: 403, body: { type: "invalid_request", code: "forbidden", message: "company account not enabled for agentic commerce" } };
    }
    return next();
  }

  private async createSession(req: Req): Promise<Res> {
    const body = req.body ?? {};
    const problems = validateItems(body.items);
    if (typeof body.currency !== "string" || body.currency.length !== 3) problems.push("currency");
    if (problems.length) return unprocessable(problems);

    const session: CheckoutSession = {
      id: randomId("cs_test_", 6),
      status: "not_ready_for_payment",
      currency: body.currency.toUpperCase(),
      payment_provider: { provider: "adyen", supported_payment_methods: ["card"] },
      buyer: body.buyer,
      fulfillment_address: body.fulfillment_address,
      fulfillment_option_id: body.fulfillment_option_id,
      line_items: [],
      fulfillment_options: [],
      totals: [],
      messages: [],
      links: [{ type: "terms_of_use", url: `${config.merchantUrl}/terms` }],
    };
    await this.requote(session, body.items, body.discounts);
    this.sessions.set(session.id, session);
    return { status: 201, body: session };
  }

  private getSession(req: Req): Res {
    const session = this.sessions.get(req.params.id);
    return session ? { status: 200, body: session } : notFound();
  }

  private async updateSession(req: Req): Promise<Res> {
    const session = this.sessions.get(req.params.id);
    if (!session) return notFound();
    if (session.status === "completed" || session.status === "canceled" || session.status === "in_progress") {
      return { status: 200, body: { ...session, messages: [error("invalid_state", `session is ${session.status}`)] } };
    }
    const body = req.body ?? {};
    if (body.currency && body.currency.toUpperCase() !== session.currency) return unprocessable(["currency"]);
    if (body.items) {
      const problems = validateItems(body.items);
      if (problems.length) return unprocessable(problems);
    }
    if (body.buyer) session.buyer = { ...session.buyer, ...body.buyer };
    if (body.fulfillment_address) session.fulfillment_address = body.fulfillment_address;
    if (body.fulfillment_option_id) session.fulfillment_option_id = body.fulfillment_option_id;
    await this.requote(session, body.items ?? this.requestedItems.get(session.id), body.discounts);
    return { status: 200, body: session };
  }

  private async requote(session: CheckoutSession, items: Json, discounts: Json): Promise<void> {
    this.requestedItems.set(session.id, items);
    const { body: quote } = await callJson("POST", `${config.merchantUrl}/agentic/quote`, {
      label: "adyen→merchant",
      headers: HOOK_HEADERS(),
      body: {
        checkout_session_id: session.id,
        currency: session.currency,
        items,
        fulfillment_address: session.fulfillment_address,
        fulfillment_option_id: session.fulfillment_option_id,
        discounts,
      },
    }) as { body: Quote };
    session.line_items = quote.line_items;
    session.fulfillment_options = quote.fulfillment_options;
    session.totals = quote.totals;
    session.messages = quote.messages;
    if (session.fulfillment_option_id && !quote.fulfillment_options.some((o) => o.id === session.fulfillment_option_id)) {
      session.fulfillment_option_id = undefined;
    }
    const hasError = quote.messages.some((m) => m.type === "error") || quote.line_items.length === 0;
    const missing: Message[] = [];
    if (!session.fulfillment_address) missing.push(info("missing_fulfillment_address", "Provide a fulfillment_address to calculate shipping and tax."));
    else if (!session.fulfillment_option_id) missing.push(info("missing_fulfillment_option", "Choose one of fulfillment_options via fulfillment_option_id."));
    session.messages.push(...missing);
    session.status = !hasError && missing.length === 0 ? "ready_for_payment" : "not_ready_for_payment";
  }

  private async completeSession(req: Req): Promise<Res> {
    const session = this.sessions.get(req.params.id);
    if (!session) return notFound();
    if (session.status !== "ready_for_payment") {
      return { status: 200, body: { ...session, messages: [error("invalid_state", `session is ${session.status}`)] } };
    }
    const paymentData = req.body?.payment_data;
    if (!paymentData?.token || paymentData.provider !== "adyen") return unprocessable(["payment_data.token", "payment_data.provider"]);
    const token = this.tokens.get(paymentData.token);
    if (!token || token.allowance.checkout_session_id !== session.id) {
      return { status: 200, body: { ...session, messages: [error("payment_declined", "payment token is not valid for this checkout session", "$.payment_data.token")] } };
    }
    if (req.body.buyer) session.buyer = { ...session.buyer, ...req.body.buyer };

    session.status = "in_progress";
    const commit = await callJson("POST", `${config.merchantUrl}/agentic/sessions/${session.id}/commit`, {
      label: "adyen→merchant",
      headers: HOOK_HEADERS(),
      body: { session },
    });
    if (!commit.body?.approved) {
      session.status = "ready_for_payment";
      return { status: 200, body: { ...session, messages: commit.body?.messages ?? [error("risk_rejected", "merchant rejected the order")] } };
    }

    const flow = config.merchantFlow;
    const payment = flow === "standard"
      ? this.authorise({
          merchantAccount: token.allowance.merchant_id,
          amount: { value: sessionTotal(session), currency: session.currency },
          reference: session.id,
          shopperReference: session.id,
          paymentMethod: { type: "scheme", storedPaymentMethodId: token.id },
          shopperInteraction: "ContAuth",
          recurringProcessingModel: "UnscheduledCardOnFile",
        }).body
      : undefined;

    const finalize = await callJson("POST", `${config.merchantUrl}/agentic/sessions/${session.id}/finalize`, {
      label: "adyen→merchant",
      headers: HOOK_HEADERS(),
      body: flow === "standard"
        ? { flow, session, payment: { psp_reference: payment.pspReference, result_code: payment.resultCode } }
        : { flow, session, payment: { provider: "adyen", token: token.id } },
    });

    const result = finalize.body ?? {};
    if (result.result_code === "Authorised" && result.order) {
      session.status = "completed";
      session.order = { id: result.order.id, checkout_session_id: session.id, permalink_url: result.order.permalink_url };
      session.messages = [];
      return { status: 200, body: session };
    }
    session.status = "ready_for_payment";
    return {
      status: 200,
      body: { ...session, messages: [error("payment_declined", result.refusal_reason ?? payment?.refusalReason ?? "payment was declined")] },
    };
  }

  private cancelSession(req: Req): Res {
    const session = this.sessions.get(req.params.id);
    if (!session) return notFound();
    if (session.status === "completed" || session.status === "in_progress") {
      return { status: 200, body: { ...session, messages: [error("invalid_state", `${session.status} sessions cannot be canceled`)] } };
    }
    session.status = "canceled";
    session.messages = [];
    return { status: 200, body: session };
  }

  private delegatePayment(req: Req): Res {
    if (req.headers.authorization !== `Bearer ${config.agenticToken}`) {
      return { status: 401, body: { type: "invalid_request", code: "unauthorized", message: "a dedicated agentic token is required" } };
    }
    if (req.headers["api-version"] !== config.delegatePaymentApiVersion) {
      return invalid("invalid_request", `API-Version must be ${config.delegatePaymentApiVersion}`, "API-Version");
    }
    const key = req.headers["idempotency-key"];
    const hash = createHash("sha256").update(JSON.stringify(req.body ?? {})).digest("hex");
    if (typeof key === "string") {
      const seen = this.idempotency.get(key);
      if (seen) {
        return seen.hash === hash
          ? seen.res
          : { status: 400, body: { type: "invalid_request", code: "idempotency_conflict", message: "Idempotency-Key reused with a different body" } };
      }
    }
    const res = this.tokenize(req.body ?? {});
    if (typeof key === "string" && res.status === 201) this.idempotency.set(key, { hash, res });
    return res;
  }

  private tokenize(body: Json): Res {
    const pm = body.payment_method;
    if (!pm || pm.type !== "card") return invalid("invalid_card", "payment_method.type must be card", "payment_method.type");
    if (!["fpan", "network_token", "dpan"].includes(pm.card_number_type)) {
      return invalid("invalid_card", "unsupported card_number_type", "payment_method.card_number_type");
    }
    if (typeof pm.number !== "string" || !/^\d{12,19}$/.test(pm.number)) {
      return invalid("invalid_card", "card number must be 12-19 digits", "payment_method.number");
    }
    if (pm.card_number_type !== "fpan" && !pm.cryptogram) {
      return invalid("invalid_card", "cryptogram is required for network tokens", "payment_method.cryptogram");
    }
    if (pm.metadata === undefined) return invalid("invalid_card", "payment_method.metadata is required", "payment_method.metadata");

    const a = body.allowance;
    if (!a || a.reason !== "one_time") return invalid("invalid_card", "allowance.reason must be one_time", "allowance.reason");
    if (!Number.isInteger(a.max_amount) || a.max_amount <= 0) return invalid("invalid_card", "max_amount must be a positive integer", "allowance.max_amount");
    if (typeof a.currency !== "string" || a.currency.length !== 3) return invalid("invalid_card", "invalid currency", "allowance.currency");
    if (!a.checkout_session_id) return invalid("invalid_card", "checkout_session_id is required", "allowance.checkout_session_id");
    if (!this.merchantAccounts.has(a.merchant_id)) return invalid("invalid_card", "unknown merchant", "allowance.merchant_id");
    const expires = Date.parse(a.expires_at);
    if (Number.isNaN(expires)) return invalid("invalid_card", "expires_at must be ISO 8601", "allowance.expires_at");
    if (expires <= Date.now()) return invalid("invalid_card", "expires_at is in the past", "allowance.expires_at");

    const b = body.billing_address;
    for (const field of ["name", "line_one", "city", "country", "postal_code"]) {
      if (!b?.[field]) return invalid("invalid_card", `billing_address.${field} is required`, `billing_address.${field}`);
    }
    if (!Array.isArray(body.risk_signals)) return invalid("invalid_card", "risk_signals must be an array", "risk_signals");
    if (body.risk_signals.some((s: Json) => s.action === "blocked" || s.action === "manual_review")) {
      return invalid("invalid_card", "tokenization prevented by risk signal", "risk_signals");
    }
    if (body.metadata === undefined) return invalid("invalid_card", "metadata is required", "metadata");

    const created = new Date().toISOString();
    const id = pspReference();
    this.tokens.set(id, {
      id,
      allowance: { ...a, currency: a.currency.toUpperCase() },
      cardNumber: pm.number,
      used: false,
      created,
    });
    return {
      status: 201,
      body: {
        id,
        created,
        created_at: created,
        metadata: {
          recurringDetailReference: id,
          source: "agentic_commerce",
          merchant_id: a.merchant_id,
          shopperReference: a.checkout_session_id,
        },
      },
    };
  }

  private checkoutPayments(req: Req): Res {
    if (req.headers["x-api-key"] !== config.checkoutApiKey) {
      return { status: 401, body: { status: 401, errorCode: "000", message: "HTTP Status Response - Unauthorized", errorType: "security" } };
    }
    const key = req.headers["idempotency-key"];
    const scope = typeof key === "string" ? `payments ${key}` : undefined;
    const hash = createHash("sha256").update(JSON.stringify(req.body ?? {})).digest("hex");
    const seen = scope ? this.idempotency.get(scope) : undefined;
    if (seen) {
      return seen.hash === hash
        ? seen.res
        : { status: 422, body: { status: 422, errorCode: "704", message: "request already processed or in progress", errorType: "validation" } };
    }
    const body = req.body ?? {};
    const res = body.paymentMethod?.type === "googlepay" ? this.authoriseGooglePay(body) : this.authorise(body);
    if (scope) this.idempotency.set(scope, { hash, res });
    this.notify(body, res.body);
    return res;
  }

  private authoriseGooglePay(body: Json): { status: number; body: Payment & Json } {
    const reference = body.reference ?? "";
    const amount = body.amount ?? {};
    const payload = decodeMockGooglePayToken(body.paymentMethod.googlePayToken ?? "");
    if (!payload) {
      return { status: 422, body: { status: 422, errorCode: "14_018", message: "Invalid googlePayToken", errorType: "validation" } as Json };
    }
    const record = (resultCode: Payment["resultCode"], extra: Partial<Payment> = {}) => {
      const payment: Payment = { pspReference: pspReference(), resultCode, merchantReference: reference, amount, paymentMethodType: "googlepay", ...extra };
      this.payments.push(payment);
      return { status: 200, body: payment };
    };
    if (payload.gateway !== "adyen" || payload.gatewayMerchantId !== body.merchantAccount) {
      return record("Refused", { refusalReason: "Token was encrypted for another gateway merchant" });
    }
    if (Date.parse(payload.messageExpiration) <= Date.now()) return record("Refused", { refusalReason: "Google Pay token expired" });
    if (payload.amount !== amount.value || payload.currency !== amount.currency) {
      return record("Refused", { refusalReason: "Amount differs from the amount shown in the Google Pay sheet" });
    }
    if (payload.last4 === REFUSED_CARD_SUFFIX) return record("Refused", { refusalReason: "Not enough balance" });
    if (payload.last4 === CHALLENGE_CARD_SUFFIX && payload.authMethod === "PAN_ONLY") {
      return record("RedirectShopper", { action: { type: "redirect", paymentMethodType: "googlepay", url: "https://checkoutshopper-test.adyen.com/mock-3ds", method: "GET" } });
    }
    return record("Authorised");
  }

  private notify(request: Json, payment: Json): void {
    if (!payment?.pspReference || payment.resultCode === "RedirectShopper") return;
    const item: NotificationRequestItem = {
      amount: payment.amount,
      eventCode: "AUTHORISATION",
      eventDate: new Date().toISOString(),
      merchantAccountCode: request.merchantAccount,
      merchantReference: payment.merchantReference,
      pspReference: payment.pspReference,
      reason: payment.refusalReason ?? "",
      success: payment.resultCode === "Authorised" ? "true" : "false",
      additionalData: { paymentMethod: payment.paymentMethodType ?? "visa" },
    };
    if (config.webhookHmacKey) item.additionalData!.hmacSignature = signNotification(item, config.webhookHmacKey);
    setTimeout(() => {
      callJson("POST", `${config.merchantUrl}/adyen/webhooks`, {
        label: "adyen→merchant webhook",
        body: { live: "false", notificationItems: [{ NotificationRequestItem: item }] },
      }).catch(() => undefined);
    }, 20);
  }

  private authorise(body: Json): { status: number; body: Payment & Json } {
    const reference = body.reference ?? "";
    const amount = body.amount ?? {};
    const refuse = (refusalReason: string) => {
      const payment: Payment = { pspReference: pspReference(), resultCode: "Refused", refusalReason, merchantReference: reference, amount };
      this.payments.push(payment);
      return { status: 200, body: payment };
    };
    const token = this.tokens.get(body.paymentMethod?.storedPaymentMethodId);
    if (!token) return refuse("Unknown stored payment method");
    if (token.used) return refuse("Token already used");
    token.used = true;
    const al = token.allowance;
    if (body.merchantAccount !== al.merchant_id) return refuse("Token is scoped to another merchant");
    if (body.shopperReference !== al.checkout_session_id) return refuse("Token is bound to another checkout session");
    if (Date.parse(al.expires_at) <= Date.now()) return refuse("Token expired");
    if (amount.currency !== al.currency) return refuse("Currency does not match allowance");
    if (!(amount.value <= al.max_amount)) return refuse("Amount exceeds allowance max_amount");
    if (body.shopperInteraction !== "ContAuth" || body.recurringProcessingModel !== "UnscheduledCardOnFile") {
      return refuse("Expected ContAuth / UnscheduledCardOnFile");
    }
    if (token.cardNumber.endsWith(REFUSED_CARD_SUFFIX)) return refuse("Not enough balance");
    const payment: Payment = { pspReference: pspReference(), resultCode: "Authorised", merchantReference: reference, amount };
    this.payments.push(payment);
    return { status: 200, body: payment };
  }
}

function validateItems(items: Json): string[] {
  if (!Array.isArray(items) || items.length === 0) return ["items"];
  return items.flatMap((it: Json, i: number) => {
    const out: string[] = [];
    if (typeof it?.id !== "string") out.push(`items[${i}].id`);
    if (!Number.isInteger(it?.quantity) || it.quantity < 1) out.push(`items[${i}].quantity`);
    return out;
  });
}

function error(code: string, content: string, path?: string): Message {
  return { type: "error", code, content, content_type: "plain", ...(path ? { path } : {}) };
}

function info(code: string, content: string): Message {
  return { type: "info", code, content, content_type: "plain" };
}

function notFound(): Res {
  return { status: 404, body: { type: "invalid_request", code: "not_found", message: "checkout session not found or expired" } };
}

function unprocessable(fields: string[]): Res {
  return { status: 422, body: { type: "invalid_request", code: "invalid_request", message: `invalid fields: ${fields.join(", ")}` } };
}

function invalid(code: string, message: string, param: string): Res {
  return { status: 400, body: { type: "invalid_request", code, message, param } };
}
