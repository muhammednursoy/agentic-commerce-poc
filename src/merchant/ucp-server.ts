import { createHash } from "node:crypto";
import { config } from "../config.ts";
import { randomId } from "../http.ts";
import type { Json, Req, Res, Router } from "../http.ts";
import {
  CHECKOUT_CAPABILITY,
  FULFILLMENT_CAPABILITY,
  GOOGLE_PAY_HANDLER,
  SHOPPING_SERVICE,
  UCP_VERSION,
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
} from "../ucp.ts";
import { makePayment } from "./adyen-checkout.ts";
import { RISK_LIMIT } from "./store.ts";
import type { MerchantStore, PriceProblem } from "./store.ts";

export const UCP_BASE_PATH = "/ucp/v1";
const SESSION_TTL_MS = 6 * 60 * 60 * 1000;
const STICKY: UcpStatus[] = ["completed", "canceled", "complete_in_progress", "requires_escalation"];
const CHALLENGE_RESULTS = new Set(["RedirectShopper", "IdentifyShopper", "ChallengeShopper"]);

interface SessionState {
  id: string;
  currency: string;
  lineItems: UcpLineItemInput[];
  buyer?: UcpBuyer;
  destination?: PostalAddress;
  selectedOptionId?: string;
  expiresAt: number;
  sticky?: UcpStatus;
  continueUrl?: string;
  escalation?: { reason: string; action?: Json };
  paymentMessages: UcpMessage[];
  order?: { id: string; permalink_url: string };
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
  private readonly idempotency = new Map<string, { hash: string; res: Res }>();

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
        services: { [SHOPPING_SERVICE]: [{ version: UCP_VERSION, spec: `${spec}/overview`, transport: "rest", endpoint: `${config.merchantUrl}${UCP_BASE_PATH}` }] },
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
    const key = req.headers["idempotency-key"];
    if (req.method === "GET" || typeof key !== "string") return next();
    const scope = `${req.method} ${req.path} ${key}`;
    const hash = createHash("sha256").update(JSON.stringify(req.body ?? {})).digest("hex");
    const seen = this.idempotency.get(scope);
    if (seen) return seen.hash === hash ? seen.res : fail(409, "idempotency_conflict", "Idempotency-Key reused with a different body");
    const res = await next();
    if (res.status < 500) this.idempotency.set(scope, { hash, res });
    return res;
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
      state.continueUrl = undefined;
      state.escalation = undefined;
    }
    applyBuyerAndFulfillment(state, body);
    return { status: 200, body: this.view(state) };
  }

  private async complete(req: Req): Promise<Res> {
    const state = this.load(req.params.id);
    if (!state) return fail(404, "not_found", "checkout session not found");
    const current = this.view(state);
    if (current.status !== "ready_for_complete") {
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
    if (req.body.buyer) state.buyer = { ...state.buyer, ...req.body.buyer };

    const total = current.totals.find((t) => t.type === "total")!.amount;
    if (total > RISK_LIMIT) {
      return { status: 200, body: this.escalate(state, "high_value_order", "requires_buyer_review", "Order exceeds the merchant's automatic approval limit") };
    }

    state.sticky = "complete_in_progress";
    const orderId = this.store.newOrderId();
    const result = await makePayment(
      {
        amount: { value: total, currency: state.currency },
        reference: orderId,
        paymentMethod: { type: "googlepay", googlePayToken: instrument.credential.token },
        returnUrl: `${config.merchantUrl}/checkout/${state.id}`,
        shopperEmail: state.buyer?.email,
        metadata: { agentProtocol: "UCP", agentSessionId: state.id, agentPlatform: "Google" },
      },
      `${state.id}-${createHash("sha256").update(instrument.credential.token).digest("hex").slice(0, 16)}`,
    );

    if (result.resultCode === "Authorised" && result.pspReference) {
      const order = this.store.recordOrder({
        id: orderId,
        protocol: "ucp",
        checkoutSessionId: state.id,
        pspReference: result.pspReference,
        amount: total,
        currency: state.currency,
        items: state.lineItems.map((li) => ({ id: li.item.id, quantity: li.quantity })),
      });
      state.sticky = "completed";
      state.order = { id: order.id, permalink_url: `${config.merchantUrl}/orders/${order.id}` };
      return { status: 200, body: this.view(state) };
    }
    if (CHALLENGE_RESULTS.has(result.resultCode)) {
      state.sticky = undefined;
      return { status: 200, body: this.escalate(state, "requires_3ds", "requires_buyer_input", "The card issuer requires 3-D Secure authentication", result.action) };
    }
    state.sticky = undefined;
    state.paymentMessages = [{
      type: "error",
      code: "payment_declined",
      severity: "recoverable",
      content: `Payment was not authorised: ${result.refusalReason ?? result.resultCode}. Try another card.`,
      path: "$.payment.instruments[0]",
    }];
    return { status: 200, body: this.view(state) };
  }

  private cancel(req: Req): Res {
    const state = this.load(req.params.id);
    if (!state) return fail(404, "not_found", "checkout session not found");
    if (state.sticky === "completed" || state.sticky === "canceled") {
      return fail(409, "invalid_state", `checkout is already ${state.sticky}`);
    }
    state.sticky = "canceled";
    return { status: 200, body: this.view(state) };
  }

  private continuePage(req: Req): Res {
    const state = this.sessions.get(req.params.id);
    if (!state) return fail(404, "not_found", "checkout session not found");
    return { status: 200, body: { checkout_id: state.id, status: this.view(state).status, escalation: state.escalation ?? null } };
  }

  private escalate(state: SessionState, code: string, severity: Severity, content: string, action?: Json): UcpCheckout {
    state.sticky = "requires_escalation";
    state.continueUrl = `${config.merchantUrl}/checkout/${state.id}`;
    state.escalation = { reason: code, action };
    state.paymentMessages = [{ type: "error", code, severity, content }];
    return this.view(state);
  }

  private load(id: string): SessionState | undefined {
    const state = this.sessions.get(id);
    if (state && !state.sticky && state.expiresAt <= Date.now()) state.sticky = "canceled";
    return state;
  }

  view(state: SessionState): UcpCheckout {
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
    messages.push(...state.paymentMessages);

    const blocked = messages.some((m) => m.type === "error" && m.code !== "payment_declined") || pricing.lines.length === 0;
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
      ...(state.continueUrl && status === "requires_escalation" ? { continue_url: state.continueUrl } : {}),
      ...(state.order ? { order: state.order } : {}),
    };
  }
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
  for (const [i, li] of items.entries()) {
    if (typeof li?.item?.id !== "string") return `line_items[${i}].item.id is required`;
    if (!Number.isInteger(li.quantity) || li.quantity < 1) return `line_items[${i}].quantity must be a positive integer`;
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
