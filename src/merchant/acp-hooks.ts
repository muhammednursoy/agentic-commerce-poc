import { config } from "../config.ts";
import type { Json, Req, Res, Router } from "../http.ts";
import { errorMessage as error, sessionTotal } from "../acp.ts";
import type { CheckoutSession, LineItem, Message, Quote, Total } from "../acp.ts";
import type { Item } from "../domain.ts";
import { makePayment } from "./adyen-checkout.ts";
import { isOutcomeUnknown } from "./payment-outcome.ts";
import type { PaymentResult } from "./payment-outcome.ts";
import { RISK_LIMIT } from "./store.ts";
import type { Consent, MerchantStore, Pricing } from "./store.ts";

export interface Approval<Body = Record<string, unknown>> {
  total: number;
  currency: string;
  items: Item[];
  consent: Consent;
  pending?: { orderId: string; body: Body };
  inFlight?: boolean;
}

export function registerAcpHooks(router: Router, store: MerchantStore): void {
  const approvals = new Map<string, Approval>();
  router
    .on("POST", "/agentic/quote", (r) => unauthorised(r) ?? { status: 200, body: quote(store, r.body ?? {}) })
    .on("POST", "/agentic/sessions/:id/commit", (r) => unauthorised(r) ?? commit(store, approvals, r))
    .on("POST", "/agentic/sessions/:id/finalize", (r) => unauthorised(r) ?? finalize(store, approvals, r));
}

function unauthorised(req: Req): Res | undefined {
  if (config.merchantHookSecret && req.headers.authorization === `Bearer ${config.merchantHookSecret}`) return undefined;
  return { status: 401, body: { type: "invalid_request", code: "unauthorized", message: "merchant hook secret required" } };
}

export function quote(store: MerchantStore, body: Json): Quote {
  const items: Item[] = body.items ?? [];
  const pricing = store.price(body.currency, items, body.fulfillment_address, body.fulfillment_option_id);
  const repeated = items.findIndex((it, i) => items.findIndex((other) => other.id === it.id) !== i);
  if (repeated >= 0) {
    pricing.problems.push({ code: "invalid_item", content: `${items[repeated].id} is listed twice; merge the quantities`, lineIndex: repeated });
  }
  return toQuote(pricing, items);
}

function toQuote(p: Pricing, items: Item[]): Quote {
  const line_items: LineItem[] = p.lines.map((l) => ({
    id: `li_${l.product.id}`,
    item: items.find((i) => i.id === l.product.id) ?? { id: l.product.id, quantity: l.quantity },
    title: l.product.title,
    base_amount: l.subtotal,
    discount: 0,
    subtotal: l.subtotal,
    tax: l.tax,
    total: l.total,
  }));
  const messages: Message[] = p.problems.map((pr) => ({
    type: "error",
    code: pr.code,
    content: pr.content,
    content_type: "plain",
    path: pr.lineIndex === undefined ? "$.fulfillment_address.country" : `$.items[${pr.lineIndex}]`,
  }));
  return {
    line_items,
    fulfillment_options: p.options.map((o) => ({ type: "shipping", id: o.id, title: o.title, subtitle: o.subtitle, subtotal: o.amount, tax: 0, total: o.amount })),
    totals: [
      { type: "items_base_amount", display_text: "Items", amount: p.itemsSubtotal },
      { type: "subtotal", display_text: "Subtotal", amount: p.itemsSubtotal },
      { type: "fulfillment", display_text: p.chosen?.title ?? "Shipping", amount: p.fulfillment },
      { type: "tax", display_text: "Tax", amount: p.tax },
      { type: "total", display_text: "Total", amount: p.total },
    ],
    messages,
  };
}

export function approve(store: MerchantStore, session: CheckoutSession, paymentLabel: string): { approval: Omit<Approval, "pending" | "inFlight"> } | { messages: Message[] } {
  const fresh = quote(store, {
    currency: session.currency,
    items: session.line_items.map((li) => li.item),
    fulfillment_address: session.fulfillment_address,
    fulfillment_option_id: session.fulfillment_option_id,
  });
  const errors = fresh.messages.filter((m) => m.type === "error");
  if (errors.length) return { messages: errors };
  if (sessionTotal(fresh) !== sessionTotal(session)) return { messages: [error("product_price_mismatch", "Prices changed, update the session")] };
  if (sessionTotal(session) > RISK_LIMIT) return { messages: [error("risk_rejected", "Order exceeds the merchant risk limit")] };
  const items = fresh.line_items.map((li) => ({ id: li.item.id, quantity: li.item.quantity }));
  const shortage = store.reserve(items);
  if (shortage) return { messages: [error("product_out_of_stock", shortage)] };
  const amountOf = (type: Total["type"]) => fresh.totals.find((t) => t.type === type)?.amount ?? 0;
  const consent: Consent = {
    protocol: "acp",
    checkoutId: session.id,
    approvedAt: new Date().toISOString(),
    currency: session.currency,
    lineItems: fresh.line_items.map((li) => ({ id: li.item.id, title: li.title, quantity: li.item.quantity, subtotal: li.subtotal })),
    subtotal: amountOf("subtotal"),
    shipping: amountOf("fulfillment"),
    tax: amountOf("tax"),
    total: sessionTotal(fresh),
    ...(session.fulfillment_address ? { shippingAddress: session.fulfillment_address } : {}),
    buyerEmail: session.buyer?.email,
    paymentLabel,
  };
  return { approval: { total: sessionTotal(fresh), currency: session.currency, items, consent } };
}

function commit(store: MerchantStore, approvals: Map<string, Approval>, req: Req): Res {
  const session: CheckoutSession | undefined = req.body?.session;
  if (!session || session.id !== req.params.id || !Array.isArray(session.line_items)) {
    return { status: 400, body: { type: "invalid_request", code: "invalid_session", message: "body.session must be the session in the path" } };
  }
  const previous = approvals.get(session.id);
  if (previous?.pending) {
    return { status: 200, body: { approved: false, messages: [error("payment_pending", "A payment for this session is pending; finalize it again")] } };
  }
  if (previous) {
    store.release(previous.items);
    approvals.delete(session.id);
  }
  const label = config.merchantFlow === "advanced" ? "card, ACP delegated token (merchant authorises)" : "card, ACP delegated token (Adyen authorises)";
  const result = approve(store, session, label);
  if ("messages" in result) return { status: 200, body: { approved: false, messages: result.messages } };
  approvals.set(session.id, result.approval);
  return { status: 200, body: { approved: true } };
}

async function finalize(store: MerchantStore, approvals: Map<string, Approval>, req: Req): Promise<Res> {
  const sessionId = req.params.id;
  const approval = approvals.get(sessionId);
  if (!approval) {
    return { status: 409, body: { result_code: "Error", refusal_reason: "no approved commit for this session" } };
  }
  if (approval.inFlight) {
    return { status: 409, body: { result_code: "Error", refusal_reason: "a payment for this session is in flight" } };
  }
  const payment: Json = req.body?.payment ?? {};
  let orderId: string;
  let pspReference: string | undefined;
  let resultCode: string;
  let refusalReason: string | undefined;

  if (config.merchantFlow === "advanced") {
    if (!approval.pending) {
      const id = store.newOrderId();
      approval.pending = {
        orderId: id,
        body: {
          amount: { value: approval.total, currency: approval.currency },
          reference: id,
          shopperReference: sessionId,
          paymentMethod: { type: "scheme", storedPaymentMethodId: payment.token },
          shopperInteraction: "ContAuth",
          recurringProcessingModel: "UnscheduledCardOnFile",
          metadata: { agentProtocol: "ACP", agentSessionId: sessionId },
        },
      };
    }
    const attempt = approval.pending;
    orderId = attempt.orderId;
    approval.inFlight = true;
    let result: PaymentResult;
    try {
      result = await makePayment(attempt.body, `${sessionId}-${attempt.orderId}`);
    } finally {
      approval.inFlight = false;
    }
    if (isOutcomeUnknown(result.resultCode)) {
      return { status: 200, body: { result_code: "Pending", refusal_reason: result.refusalReason } };
    }
    ({ pspReference, resultCode, refusalReason } = result);
  } else {
    orderId = store.newOrderId();
    pspReference = payment.psp_reference;
    resultCode = payment.result_code;
  }
  approvals.delete(sessionId);

  if (resultCode !== "Authorised" || !pspReference) {
    store.release(approval.items);
    return { status: 200, body: { result_code: resultCode, psp_reference: pspReference, refusal_reason: refusalReason } };
  }
  const order = store.recordOrder({
    id: orderId,
    protocol: "acp",
    provider: "adyen",
    checkoutSessionId: sessionId,
    pspReference,
    amount: approval.total,
    currency: approval.currency,
    items: approval.items,
    consent: approval.consent,
  });
  return {
    status: 200,
    body: { result_code: resultCode, psp_reference: pspReference, order: { id: order.id, permalink_url: `${config.merchantUrl}/orders/${order.id}` } },
  };
}
