import { createHash } from "node:crypto";
import { config } from "../config.ts";
import { IdempotencyCache, randomId } from "../http.ts";
import type { Json, Req, Res, Router } from "../http.ts";
import {
  CHECKOUT_CAPABILITY,
  FULFILLMENT_CAPABILITY,
  GOOGLE_PAY_HANDLER,
  SHOPPING_SERVICE,
  UCP_VERSION,
  ucpTotal,
} from "../ucp.ts";
import type {
  GooglePayHandler,
  PaymentInstrument,
  PostalAddress,
  Severity,
  UcpBuyer,
  UcpCheckout,
  UcpEnvelope,
  UcpLineItemInput,
  UcpMessage,
  UcpProfile,
  UcpStatus,
  UcpTotal,
} from "../ucp.ts";
import type { Address, Item } from "../domain.ts";
import { makePayment } from "./adyen-checkout.ts";
import { CHALLENGE_RESULTS, isOutcomeUnknown } from "./payment-outcome.ts";
import type { PaymentResult } from "./payment-outcome.ts";
import { RISK_LIMIT } from "./store.ts";
import type { Consent, MerchantStore, PriceProblem } from "./store.ts";

export const UCP_BASE_PATH = "/ucp/v1";
const SESSION_TTL_MS = 6 * 60 * 60 * 1000;

interface SessionState {
  id: string;
  currency: string;
  lineItems: UcpLineItemInput[];
  buyer?: UcpBuyer;
  destination?: PostalAddress;
  selectedOptionId?: string;
  expiresAt: number;
  sticky?: UcpStatus;
  escalation?: { reason: string; action?: Json };
  paymentMessages: UcpMessage[];
  pending?: PendingPayment;
  snapshot?: UcpCheckout;
}

interface PendingPayment {
  orderId: string;
  tokenHash: string;
  total: number;
  items: Item[];
  frozen: UcpCheckout;
  consent: Consent;
  body: Record<string, unknown>;
  inFlight: boolean;
}

export function googlePayHandler(): GooglePayHandler {
  return {
    id: "gpay_adyen",
    version: UCP_VERSION,
    spec: `https://pay.google.com/gp/p/ucp/${UCP_VERSION}/`,
    schema: `https://pay.google.com/gp/p/ucp/${UCP_VERSION}/schemas/config.json`,
    config: {
      api_version: 2,
      api_version_minor: 0,
      environment: "TEST",
      merchant_info: {
        merchant_name: "Brew & Co",
        merchant_id: config.googlePayMerchantId,
        merchant_origin: new URL(config.merchantUrl).host,
      },
      allowed_payment_methods: [{
        type: "CARD",
        parameters: {
          allowed_auth_methods: ["PAN_ONLY", "CRYPTOGRAM_3DS"],
          allowed_card_networks: ["AMEX", "DISCOVER", "MASTERCARD", "VISA"],
          billing_address_required: true,
          billing_address_parameters: { format: "FULL" },
        },
        tokenization_specification: {
          type: "PAYMENT_GATEWAY",
          parameters: { gateway: "adyen", gatewayMerchantId: config.merchantAccount },
        },
      }],
    },
  };
}

export class UcpMerchant {
  readonly sessions = new Map<string, SessionState>();
  private readonly store: MerchantStore;
  private readonly idempotency = new IdempotencyCache();

  constructor(store: MerchantStore) {
    this.store = store;
  }

  register(router: Router): void {
    const base = `${UCP_BASE_PATH}/checkout-sessions`;
    router
      .on("GET", "/.well-known/ucp", () => ({ status: 200, body: this.profile() }))
      .on("POST", base, (r) => this.guard(r, () => this.create(r)))
      .on("GET", `${base}/:id`, (r) => this.guard(r, () => this.get(r)))
      .on("PUT", `${base}/:id`, (r) => this.guard(r, () => this.update(r)))
      .on("POST", `${base}/:id/complete`, (r) => this.guard(r, () => this.complete(r)))
      .on("POST", `${base}/:id/cancel`, (r) => this.guard(r, () => this.cancel(r)))
      .on("GET", "/checkout/:id", (r) => this.continuePage(r));
  }

  profile(): UcpProfile {
    const spec = `https://ucp.dev/${UCP_VERSION}/specification`;
    return {
      ucp: {
        version: UCP_VERSION,
        services: { [SHOPPING_SERVICE]: [{ version: UCP_VERSION, spec: `${spec}/overview`, transport: "rest", endpoint: `${config.merchantUrl}${UCP_BASE_PATH}`, schema: `https://ucp.dev/${UCP_VERSION}/services/shopping/openapi.json` }] },
        capabilities: {
          [CHECKOUT_CAPABILITY]: [{ version: UCP_VERSION, spec: `${spec}/checkout` }],
          [FULFILLMENT_CAPABILITY]: [{ version: UCP_VERSION, spec: `${spec}/fulfillment`, extends: CHECKOUT_CAPABILITY }],
        },
        payment_handlers: { [GOOGLE_PAY_HANDLER]: [googlePayHandler()] },
      },
      signing_keys: [],
    };
  }

  private async guard(req: Req, next: () => Res | Promise<Res>): Promise<Res> {
    if (!req.headers["ucp-agent"]) return fail(400, "missing_header", "UCP-Agent header is required");
    return this.idempotency.run(
      req,
      next,
      () => fail(409, "idempotency_conflict", "Idempotency-Key reused with a different body"),
      (res) => res.status < 500 && res.status !== 409 && res.body?.status !== "complete_in_progress",
    );
  }

  private create(req: Req): Res {
    const body = req.body ?? {};
    const invalid = validateLineItems(body.line_items);
    if (invalid) return fail(400, "invalid", invalid);
    const state: SessionState = {
      id: randomId("chk_", 6),
      currency: (body.currency ?? "USD").toUpperCase(),
      lineItems: body.line_items,
      expiresAt: Date.now() + SESSION_TTL_MS,
      paymentMessages: [],
    };
    applyBuyerAndFulfillment(state, body);
    this.sessions.set(state.id, state);
    return { status: 201, body: this.view(state) };
  }

  private get(req: Req): Res {
    const state = this.load(req.params.id);
    return state ? { status: 200, body: this.view(state) } : fail(404, "not_found", "checkout session not found");
  }

  private update(req: Req): Res {
    const state = this.load(req.params.id);
    if (!state) return fail(404, "not_found", "checkout session not found");
    if (state.sticky && state.sticky !== "requires_escalation") {
      return fail(409, "invalid_state", `checkout is ${state.sticky} and cannot be updated`);
    }
    const body = req.body ?? {};
    const invalid = validateLineItems(body.line_items);
    if (invalid) return fail(400, "invalid", `${invalid} (PUT replaces the whole checkout)`);
    if (body.currency && body.currency.toUpperCase() !== state.currency) return fail(400, "invalid", "currency cannot change");
    state.lineItems = body.line_items;
    state.buyer = undefined;
    state.destination = undefined;
    state.selectedOptionId = undefined;
    state.paymentMessages = [];
    if (state.sticky === "requires_escalation") {
      state.sticky = undefined;
      state.escalation = undefined;
    }
    applyBuyerAndFulfillment(state, body);
    return { status: 200, body: this.view(state) };
  }

  private async complete(req: Req): Promise<Res> {
    const state = this.load(req.params.id);
    if (!state) return fail(404, "not_found", "checkout session not found");
    const current = this.view(state);
    const retry = current.status === "complete_in_progress";
    if (!retry && current.status !== "ready_for_complete") {
      return fail(409, "invalid_state", `checkout is ${current.status}, not ready_for_complete`);
    }
    const handler = googlePayHandler();
    const instruments: PaymentInstrument[] = req.body?.payment?.instruments ?? [];
    const instrument = instruments.find((i) => i.selected) ?? instruments[0];
    if (!instrument) return fail(400, "missing", "payment.instruments is required", "$.payment.instruments");
    if (instrument.handler_id !== handler.id) {
      return fail(400, "invalid", `unknown handler_id ${instrument.handler_id}`, "$.payment.instruments[0].handler_id");
    }
    if (instrument.credential?.type !== "PAYMENT_GATEWAY" || typeof instrument.credential.token !== "string" || !instrument.credential.token) {
      return fail(400, "invalid", "credential must be a PAYMENT_GATEWAY token", "$.payment.instruments[0].credential");
    }
    const tokenHash = createHash("sha256").update(instrument.credential.token).digest("hex").slice(0, 16);
    if (retry) {
      const pending = state.pending;
      if (pending?.inFlight) return fail(409, "invalid_state", "a payment for this checkout is in flight");
      if (!pending || pending.tokenHash !== tokenHash) {
        return fail(409, "invalid_state", "checkout is complete_in_progress; only the same payment instrument can be retried");
      }
      return this.charge(state, pending);
    }
    if (req.body.buyer) state.buyer = { ...state.buyer, ...req.body.buyer };

    const frozen = this.view(state);
    const total = ucpTotal(frozen);
    if (total > RISK_LIMIT) {
      return { status: 200, body: this.escalate(state, "high_value_order", "requires_buyer_review", "Order exceeds the merchant's automatic approval limit") };
    }
    const items = state.lineItems.map((li) => ({ id: li.item.id, quantity: li.quantity }));
    const shortage = this.store.reserve(items);
    if (shortage) return fail(409, "out_of_stock", shortage, "$.line_items");

    const orderId = this.store.newOrderId();
    state.sticky = "complete_in_progress";
    state.paymentMessages = [];
    state.pending = {
      orderId,
      tokenHash,
      total,
      items,
      frozen,
      consent: {
        protocol: "ucp",
        checkoutId: state.id,
        approvedAt: new Date().toISOString(),
        currency: state.currency,
        lineItems: frozen.line_items.map((li) => ({ id: li.item.id, title: li.item.title, quantity: li.quantity, subtotal: amountOf(li.totals, "subtotal") })),
        subtotal: amountOf(frozen.totals, "subtotal"),
        shipping: amountOf(frozen.totals, "fulfillment"),
        tax: amountOf(frozen.totals, "tax"),
        total,
        ...(state.destination ? { shippingAddress: toAddress(state.destination) } : {}),
        buyerEmail: state.buyer?.email,
        paymentLabel: `Google Pay ${instrument.display?.description ?? "card"}`,
      },
      inFlight: false,
      body: {
        amount: { value: total, currency: state.currency },
        reference: orderId,
        paymentMethod: { type: "googlepay", googlePayToken: instrument.credential.token },
        returnUrl: `${config.merchantUrl}/checkout/${state.id}`,
        shopperEmail: state.buyer?.email,
        metadata: { agentProtocol: "UCP", agentSessionId: state.id, agentPlatform: "Google" },
      },
    };
    return this.charge(state, state.pending);
  }

  private async charge(state: SessionState, pending: PendingPayment): Promise<Res> {
    pending.inFlight = true;
    let result: PaymentResult;
    try {
      result = await makePayment(pending.body, `${state.id}-${pending.orderId}`);
    } finally {
      pending.inFlight = false;
    }
    if (state.pending === pending) this.settle(state, result);
    return { status: 200, body: this.view(state) };
  }

  settleByReference(merchantReference: string, amount: { value: number; currency: string } | undefined, result: PaymentResult): boolean {
    const state = [...this.sessions.values()].find((s) => s.pending?.orderId === merchantReference);
    if (!state?.pending || amount?.value !== state.pending.total || amount.currency !== state.currency) return false;
    this.settle(state, result);
    return true;
  }

  private settle(state: SessionState, result: PaymentResult): void {
    const pending = state.pending;
    if (state.sticky !== "complete_in_progress" || !pending) return;
    if (isOutcomeUnknown(result.resultCode)) {
      state.paymentMessages = [{
        type: "info",
        code: "payment_pending",
        content: "The payment outcome is not known yet. Retry complete with the same payment instrument, or get the checkout again later.",
      }];
      return;
    }
    state.pending = undefined;
    if (result.resultCode === "Authorised" && result.pspReference) {
      const order = this.store.recordOrder({
        id: pending.orderId,
        protocol: "ucp",
        provider: "adyen",
        checkoutSessionId: state.id,
        pspReference: result.pspReference,
        amount: pending.total,
        currency: state.currency,
        items: pending.items,
        consent: pending.consent,
      });
      state.sticky = "completed";
      state.paymentMessages = [];
      state.snapshot = { ...pending.frozen, status: "completed", messages: [], order: { id: order.id, permalink_url: `${config.merchantUrl}/orders/${order.id}` } };
      return;
    }
    this.store.release(pending.items);
    state.sticky = undefined;
    if (CHALLENGE_RESULTS.has(result.resultCode)) {
      this.escalate(state, "requires_3ds", "requires_buyer_input", "The card issuer requires 3-D Secure authentication", result.action);
      return;
    }
    state.paymentMessages = [result.resultCode === "Error"
      ? {
          type: "error",
          code: "payment_failed",
          severity: "recoverable",
          content: `The merchant could not process the payment; nothing was charged (${result.refusalReason ?? "Error"}).`,
        }
      : {
          type: "error",
          code: "payment_declined",
          severity: "recoverable",
          content: `Payment was not authorised: ${result.refusalReason ?? result.resultCode}. Try another card.`,
          path: "$.payment.instruments[0]",
        }];
  }

  private cancel(req: Req): Res {
    const state = this.load(req.params.id);
    if (!state) return fail(404, "not_found", "checkout session not found");
    if (state.sticky === "completed" || state.sticky === "canceled" || state.sticky === "complete_in_progress") {
      return fail(409, "invalid_state", `checkout is ${state.sticky} and cannot be canceled`);
    }
    state.sticky = "canceled";
    state.paymentMessages = [];
    state.snapshot = this.view(state);
    return { status: 200, body: state.snapshot };
  }

  private continuePage(req: Req): Res {
    const state = this.load(req.params.id);
    if (!state) return fail(404, "not_found", "checkout session not found");
    return { status: 200, body: { checkout_id: state.id, status: this.view(state).status, escalation: state.escalation ?? null } };
  }

  private escalate(state: SessionState, code: string, severity: Severity, content: string, action?: Json): UcpCheckout {
    state.sticky = "requires_escalation";
    state.escalation = { reason: code, action };
    state.paymentMessages = [{ type: "error", code, severity, content }];
    return this.view(state);
  }

  private load(id: string): SessionState | undefined {
    const state = this.sessions.get(id);
    const expirable = !state?.sticky || state.sticky === "requires_escalation";
    if (state && expirable && state.expiresAt <= Date.now()) state.sticky = "canceled";
    return state;
  }

  view(state: SessionState): UcpCheckout {
    if (state.snapshot) return state.snapshot;
    const items = state.lineItems.map((li) => ({ id: li.item.id, quantity: li.quantity }));
    const destination = state.destination
      ? { country: state.destination.address_country, state: state.destination.address_region }
      : undefined;
    const pricing = this.store.price(state.currency, items, destination, state.selectedOptionId);
    const messages: UcpMessage[] = pricing.problems.map(problemMessage);
    if (!state.buyer?.email) messages.push(missing("Buyer email is required", "$.buyer.email"));
    if (!state.destination) messages.push(missing("A shipping destination is required", "$.fulfillment.methods[0].destinations"));
    else if (pricing.options.length && !pricing.chosen) {
      messages.push(missing("Select a shipping option", "$.fulfillment.methods[0].groups[0].selected_option_id"));
    }
    const blocked = messages.some((m) => m.type === "error") || pricing.lines.length === 0;
    messages.push(...state.paymentMessages);
    const status: UcpStatus = state.sticky ?? (blocked ? "incomplete" : "ready_for_complete");
    const lineIds = pricing.lines.map((l) => `li_${l.product.id}`);

    return {
      ucp: envelope(),
      id: state.id,
      status,
      currency: state.currency,
      line_items: pricing.lines.map((l) => ({
        id: `li_${l.product.id}`,
        item: { id: l.product.id, title: l.product.title, price: l.product.price },
        quantity: l.quantity,
        totals: [
          { type: "subtotal", amount: l.subtotal },
          { type: "tax", amount: l.tax },
          { type: "total", amount: l.total },
        ],
      })),
      totals: [
        { type: "subtotal", display_text: "Subtotal", amount: pricing.itemsSubtotal },
        { type: "fulfillment", display_text: pricing.chosen?.title ?? "Shipping", amount: pricing.fulfillment },
        { type: "tax", display_text: "Tax", amount: pricing.tax },
        { type: "total", display_text: "Total", amount: pricing.total },
      ],
      ...(state.buyer ? { buyer: state.buyer } : {}),
      fulfillment: {
        methods: [{
          id: "method_shipping",
          type: "shipping",
          line_item_ids: lineIds,
          destinations: state.destination ? [state.destination] : [],
          ...(state.destination?.id ? { selected_destination_id: state.destination.id } : {}),
          groups: [{
            id: "group_1",
            line_item_ids: lineIds,
            ...(pricing.chosen ? { selected_option_id: pricing.chosen.id } : {}),
            options: pricing.options.map((o) => ({ id: o.id, title: o.title, description: o.subtitle, totals: [{ type: "total", amount: o.amount }] })),
          }],
        }],
      },
      messages,
      links: [
        { type: "terms_of_service", url: `${config.merchantUrl}/terms` },
        { type: "refund_policy", url: `${config.merchantUrl}/refunds` },
      ],
      expires_at: new Date(state.expiresAt).toISOString(),
      ...(status === "requires_escalation" ? { continue_url: `${config.merchantUrl}/checkout/${state.id}` } : {}),
    };
  }
}

function amountOf(totals: UcpTotal[], type: UcpTotal["type"]): number {
  return totals.find((t) => t.type === type)?.amount ?? 0;
}

function toAddress(d: PostalAddress): Address {
  const name = [d.first_name, d.last_name].filter(Boolean).join(" ");
  return {
    ...(name ? { name } : {}),
    line_one: d.street_address,
    ...(d.extended_address ? { line_two: d.extended_address } : {}),
    city: d.address_locality,
    ...(d.address_region ? { state: d.address_region } : {}),
    country: d.address_country,
    postal_code: d.postal_code,
  };
}

function envelope(): UcpEnvelope {
  return {
    version: UCP_VERSION,
    capabilities: { [CHECKOUT_CAPABILITY]: [{ version: UCP_VERSION }], [FULFILLMENT_CAPABILITY]: [{ version: UCP_VERSION }] },
    payment_handlers: { [GOOGLE_PAY_HANDLER]: [googlePayHandler()] },
  };
}

function applyBuyerAndFulfillment(state: SessionState, body: Json): void {
  if (body.buyer) state.buyer = body.buyer;
  const method = body.fulfillment?.methods?.find((m: Json) => m.type === "shipping");
  const destinations: PostalAddress[] = method?.destinations ?? [];
  const chosen = destinations.find((d) => d.id && d.id === method?.selected_destination_id) ?? destinations[0];
  if (chosen) state.destination = { ...chosen, id: chosen.id ?? "dest_1" };
  const optionId = method?.groups?.[0]?.selected_option_id;
  if (optionId) state.selectedOptionId = optionId;
}

function validateLineItems(items: Json): string | undefined {
  if (!Array.isArray(items) || items.length === 0) return "line_items must be a non-empty array";
  const ids = new Set<string>();
  for (const [i, li] of items.entries()) {
    if (typeof li?.item?.id !== "string") return `line_items[${i}].item.id is required`;
    if (!Number.isInteger(li.quantity) || li.quantity < 1) return `line_items[${i}].quantity must be a positive integer`;
    if (ids.has(li.item.id)) return `line_items[${i}].item.id ${li.item.id} is listed twice; merge the quantities`;
    ids.add(li.item.id);
  }
  return undefined;
}

const UCP_CODES: Record<PriceProblem["code"], string> = {
  invalid_item: "invalid",
  currency_unsupported: "invalid",
  product_out_of_stock: "out_of_stock",
  product_partial_stock: "out_of_stock",
  shipping_destination_unsupported: "unsupported_destination",
};

function problemMessage(problem: PriceProblem): UcpMessage {
  return {
    type: "error",
    code: UCP_CODES[problem.code],
    severity: "recoverable",
    content: problem.content,
    content_type: "plain",
    path: problem.lineIndex === undefined ? "$.fulfillment.methods[0].destinations[0].address_country" : `$.line_items[${problem.lineIndex}]`,
  };
}

function missing(content: string, path: string): UcpMessage {
  return { type: "error", code: "missing", severity: "recoverable", content, content_type: "plain", path };
}

function fail(status: number, code: string, content: string, path?: string): Res {
  return { status, body: { messages: [{ type: "error", code, severity: "recoverable", content, ...(path ? { path } : {}) }] } };
}
