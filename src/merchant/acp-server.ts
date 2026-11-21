import { config } from "../config.ts";
import { IdempotencyCache, randomId } from "../http.ts";
import type { Req, Res, Router } from "../http.ts";
import { applyQuote, errorMessage, infoMessage, validateItems } from "../acp.ts";
import type { CheckoutSession, Message } from "../acp.ts";
import type { Item } from "../domain.ts";
import { approve, quote } from "./acp-hooks.ts";
import type { Approval } from "./acp-hooks.ts";
import { CHALLENGE_RESULTS, isOutcomeUnknown } from "./payment-outcome.ts";
import type { PaymentResult } from "./payment-outcome.ts";
import { chargeSharedPaymentToken } from "./stripe-payments.ts";
import type { SharedTokenCharge } from "./stripe-payments.ts";
import type { MerchantStore } from "./store.ts";
import { CHECKOUT_JWT_TTL_SECONDS, IntentVerificationError } from "../vi/credentials.ts";
import type { MerchantIntents, VerifiedIntent } from "./verifiable-intent.ts";

export const ACP_BASE_PATH = "/acp/checkout_sessions";
const PAYMENT_LABEL = "card, Stripe Shared Payment Token (merchant charges), Mastercard Verifiable Intent";
const CHECKOUT_JWT_REFRESH_SECONDS = 60;

interface HostedSession {
  session: CheckoutSession;
  items: Item[];
  version: number;
  checkoutJwtExp?: number;
  approval?: Approval<SharedTokenCharge>;
  intent?: VerifiedIntent;
}

export class AcpMerchant {
  readonly sessions = new Map<string, HostedSession>();
  private readonly store: MerchantStore;
  private readonly intents: MerchantIntents;
  private readonly idempotency = new IdempotencyCache();

  constructor(store: MerchantStore, intents: MerchantIntents) {
    this.store = store;
    this.intents = intents;
  }

  register(router: Router): void {
    router
      .on("POST", ACP_BASE_PATH, (r) => this.guard(r, () => this.create(r)))
      .on("GET", `${ACP_BASE_PATH}/:id`, (r) => this.guard(r, () => this.get(r)))
      .on("POST", `${ACP_BASE_PATH}/:id`, (r) => this.guard(r, () => this.update(r)))
      .on("POST", `${ACP_BASE_PATH}/:id/complete`, (r) => this.guard(r, () => this.complete(r)))
      .on("POST", `${ACP_BASE_PATH}/:id/cancel`, (r) => this.guard(r, () => this.cancel(r)));
  }

  private guard(req: Req, next: () => Res | Promise<Res>): Promise<Res> | Res {
    if (req.headers.authorization !== `Bearer ${config.merchantAcpApiKey}`) {
      return { status: 401, body: { type: "invalid_request", code: "unauthorized", message: "merchant ACP API key required" } };
    }
    return this.idempotency.run(
      req,
      next,
      () => ({ status: 409, body: { type: "invalid_request", code: "idempotency_conflict", message: "Idempotency-Key reused with a different body" } }),
      (res) => res.status < 500 && res.status !== 409 && res.body?.status !== "in_progress",
    );
  }

  private async create(req: Req): Promise<Res> {
    const body = req.body ?? {};
    const problems = validateItems(body.items);
    if (typeof body.currency !== "string" || body.currency.length !== 3) problems.push("currency");
    if (problems.length) return unprocessable(problems);
    const session: CheckoutSession = {
      id: randomId("cs_", 8),
      status: "not_ready_for_payment",
      currency: body.currency.toUpperCase(),
      payment_provider: { provider: "stripe", supported_payment_methods: ["card"] },
      buyer: body.buyer,
      fulfillment_address: body.fulfillment_address,
      fulfillment_option_id: body.fulfillment_option_id,
      line_items: [],
      fulfillment_options: [],
      totals: [],
      messages: [],
      links: [
        { type: "terms_of_use", url: `${config.merchantUrl}/terms` },
        { type: "refund_policy", url: `${config.merchantUrl}/refunds` },
      ],
    };
    const hosted: HostedSession = { session, items: body.items, version: 0 };
    this.sessions.set(session.id, hosted);
    await this.requote(hosted);
    return { status: 201, body: session };
  }

  private async get(req: Req): Promise<Res> {
    const hosted = this.sessions.get(req.params.id);
    if (!hosted) return notFound();
    const open = hosted.session.status === "ready_for_payment" || hosted.session.status === "not_ready_for_payment";
    if (open && (hosted.checkoutJwtExp ?? 0) - CHECKOUT_JWT_REFRESH_SECONDS < Date.now() / 1000) await this.signCheckout(hosted);
    return { status: 200, body: hosted.session };
  }

  private async update(req: Req): Promise<Res> {
    const hosted = this.sessions.get(req.params.id);
    if (!hosted) return notFound();
    const { session } = hosted;
    if (session.status === "completed" || session.status === "canceled" || session.status === "in_progress") {
      return invalidState(session, `session is ${session.status}`);
    }
    const body = req.body ?? {};
    if (body.currency && body.currency.toUpperCase() !== session.currency) return unprocessable(["currency"]);
    if (body.items) {
      const problems = validateItems(body.items);
      if (problems.length) return unprocessable(problems);
      hosted.items = body.items;
    }
    if (body.buyer) session.buyer = { ...session.buyer, ...body.buyer };
    if (body.fulfillment_address) session.fulfillment_address = body.fulfillment_address;
    if (body.fulfillment_option_id) session.fulfillment_option_id = body.fulfillment_option_id;
    await this.requote(hosted);
    return { status: 200, body: session };
  }

  private async complete(req: Req): Promise<Res> {
    const hosted = this.sessions.get(req.params.id);
    if (!hosted) return notFound();
    const { session } = hosted;
    const paymentData = req.body?.payment_data;
    if (paymentData?.provider !== "stripe" || typeof paymentData.token !== "string" || !paymentData.token.startsWith("spt_")) {
      return unprocessable(["payment_data.provider", "payment_data.token"]);
    }
    const vi = paymentData.verifiable_intent;
    if (typeof vi?.l1 !== "string" || typeof vi.l2 !== "string" || typeof vi.intent_id !== "string") {
      return unprocessable(["payment_data.verifiable_intent"]);
    }
    const pending = hosted.approval?.pending;
    if (session.status === "in_progress" && hosted.approval && pending) {
      if (hosted.approval.inFlight) return { status: 409, body: { type: "invalid_request", code: "invalid_state", message: "a payment for this session is in flight" } };
      if (pending.body.token !== paymentData.token || hosted.intent?.intentId !== vi.intent_id) {
        return { status: 409, body: { type: "invalid_request", code: "invalid_state", message: "session is in_progress; only the same payment token and intent can be retried" } };
      }
      return this.charge(hosted);
    }
    if (session.status !== "ready_for_payment") return invalidState(session, `session is ${session.status}`);

    const signedCheckout = session.checkout_jwt;
    let intent: VerifiedIntent;
    try {
      intent = await this.intents.verify(vi, paymentData.token, session, signedCheckout);
    } catch (err) {
      if (!(err instanceof IntentVerificationError)) throw err;
      return intentRejected(session, err.message);
    }
    if (session.status !== "ready_for_payment" || session.checkout_jwt !== signedCheckout) return invalidState(session, "the checkout changed while the payment was being verified");
    if (!this.intents.consumeNonce(intent.nonce)) return intentRejected(session, "this L2 nonce was already used");
    if (req.body.buyer) session.buyer = { ...session.buyer, ...req.body.buyer };

    const result = approve(this.store, session, PAYMENT_LABEL);
    if ("messages" in result) return { status: 200, body: { ...session, messages: result.messages } };
    const orderId = this.store.newOrderId();
    hosted.intent = intent;
    hosted.approval = {
      ...result.approval,
      pending: {
        orderId,
        body: {
          amount: result.approval.total,
          currency: result.approval.currency,
          token: paymentData.token,
          metadata: { checkout_session_id: session.id, order_id: orderId, agent_protocol: "ACP", vi_checkout_hash: intent.checkoutHash, vi_intent_id: intent.intentId },
        },
      },
    };
    session.status = "in_progress";
    return this.charge(hosted);
  }

  private async charge(hosted: HostedSession): Promise<Res> {
    const { session } = hosted;
    const approval = hosted.approval!;
    const attempt = approval.pending!;
    approval.inFlight = true;
    let result: PaymentResult;
    try {
      result = await chargeSharedPaymentToken(attempt.body, `${session.id}-${attempt.orderId}`);
    } finally {
      approval.inFlight = false;
    }
    if (isOutcomeUnknown(result.resultCode)) {
      session.messages = [infoMessage("payment_pending", `The payment outcome is not known yet (${result.refusalReason ?? "no reason given"}). Complete the session again with the same token to re-check.`)];
      return { status: 200, body: session };
    }
    hosted.approval = undefined;
    if (result.resultCode === "Authorised" && result.pspReference) {
      const order = this.store.recordOrder({
        id: attempt.orderId,
        protocol: "acp",
        provider: "stripe",
        checkoutSessionId: session.id,
        pspReference: result.pspReference,
        amount: approval.total,
        currency: approval.currency,
        items: approval.items,
        consent: approval.consent,
        ...(hosted.intent ? { verifiableIntent: { checkoutHash: hosted.intent.checkoutHash, intentId: hosted.intent.intentId } } : {}),
      });
      session.status = "completed";
      session.order = { id: order.id, checkout_session_id: session.id, permalink_url: `${config.merchantUrl}/orders/${order.id}` };
      session.messages = [];
      return { status: 200, body: session };
    }
    this.store.release(approval.items);
    session.status = "ready_for_payment";
    session.messages = [failureMessage(result.resultCode, result.refusalReason)];
    return { status: 200, body: session };
  }

  private cancel(req: Req): Res {
    const hosted = this.sessions.get(req.params.id);
    if (!hosted) return notFound();
    const { session } = hosted;
    if (session.status === "completed" || session.status === "in_progress") {
      return invalidState(session, `${session.status} sessions cannot be canceled`);
    }
    session.status = "canceled";
    session.messages = [];
    return { status: 200, body: session };
  }

  private async requote(hosted: HostedSession): Promise<void> {
    const { session } = hosted;
    applyQuote(session, quote(this.store, {
      currency: session.currency,
      items: hosted.items,
      fulfillment_address: session.fulfillment_address,
      fulfillment_option_id: session.fulfillment_option_id,
    }));
    delete session.checkout_jwt;
    await this.signCheckout(hosted);
  }

  private async signCheckout(hosted: HostedSession): Promise<void> {
    const version = ++hosted.version;
    const jwt = await this.intents.issueCheckoutJwt(hosted.session);
    if (version !== hosted.version) return;
    hosted.session.checkout_jwt = jwt;
    hosted.checkoutJwtExp = Math.floor(Date.now() / 1000) + CHECKOUT_JWT_TTL_SECONDS;
  }
}

function intentRejected(session: CheckoutSession, reason: string): Res {
  return { status: 200, body: { ...session, messages: [errorMessage("intent_verification_failed", `The Verifiable Intent was rejected, nothing was charged: ${reason}.`, "$.payment_data.verifiable_intent")] } };
}

function failureMessage(resultCode: string, reason = resultCode): Message {
  if (CHALLENGE_RESULTS.has(resultCode)) {
    return errorMessage("requires_3ds", "The card issuer requires authentication that this agent cannot complete. Ask the shopper to pay with another card.", "$.payment_data.token");
  }
  if (resultCode === "Error") return errorMessage("payment_failed", `The merchant could not process the payment; nothing was charged (${reason}).`);
  return errorMessage("payment_declined", `Payment was declined: ${reason.replace(/\.?$/, ".")} Ask the shopper to approve again with a new payment token.`, "$.payment_data.token");
}

function invalidState(session: CheckoutSession, content: string): Res {
  return { status: 200, body: { ...session, messages: [errorMessage("invalid_state", content)] } };
}

function notFound(): Res {
  return { status: 404, body: { type: "invalid_request", code: "not_found", message: "checkout session not found" } };
}

function unprocessable(fields: string[]): Res {
  return { status: 422, body: { type: "invalid_request", code: "invalid_request", message: `invalid fields: ${fields.join(", ")}` } };
}
