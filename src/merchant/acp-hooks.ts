import { config } from "../config.ts";
import type { Json, Req, Res, Router } from "../http.ts";
import { sessionTotal } from "../acp.ts";
import type { CheckoutSession, Item, LineItem, Message, Quote } from "../acp.ts";
import { makePayment } from "./adyen-checkout.ts";
import { RISK_LIMIT } from "./store.ts";
import type { MerchantStore, Pricing } from "./store.ts";

export function registerAcpHooks(router: Router, store: MerchantStore): void {
  router
    .on("POST", "/agentic/quote", (r) => ({ status: 200, body: quote(store, r.body ?? {}) }))
    .on("POST", "/agentic/sessions/:id/commit", (r) => commit(store, r))
    .on("POST", "/agentic/sessions/:id/finalize", (r) => finalize(store, r));
}

export function quote(store: MerchantStore, body: Json): Quote {
  const items: Item[] = body.items ?? [];
  const pricing = store.price(body.currency, items, body.fulfillment_address, body.fulfillment_option_id);
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

function commit(store: MerchantStore, req: Req): Res {
  const session: CheckoutSession = req.body.session;
  const fresh = quote(store, {
    currency: session.currency,
    items: session.line_items.map((li) => li.item),
    fulfillment_address: session.fulfillment_address,
    fulfillment_option_id: session.fulfillment_option_id,
  });
  const errors = fresh.messages.filter((m) => m.type === "error");
  if (errors.length) return { status: 200, body: { approved: false, messages: errors } };
  if (sessionTotal(fresh) !== sessionTotal(session)) {
    return { status: 200, body: { approved: false, messages: [error("product_price_mismatch", "Prices changed, update the session")] } };
  }
  if (sessionTotal(session) > RISK_LIMIT) {
    return { status: 200, body: { approved: false, messages: [error("risk_rejected", "Order exceeds the merchant risk limit")] } };
  }
  return { status: 200, body: { approved: true } };
}

async function finalize(store: MerchantStore, req: Req): Promise<Res> {
  const { flow, session, payment } = req.body as { flow: string; session: CheckoutSession; payment: Json };
  const amount = sessionTotal(session);
  const orderId = store.newOrderId();
  let pspReference: string | undefined;
  let resultCode: string;
  let refusalReason: string | undefined;

  if (flow === "advanced") {
    const result = await makePayment(
      {
        amount: { value: amount, currency: session.currency },
        reference: orderId,
        shopperReference: session.id,
        paymentMethod: { type: "scheme", storedPaymentMethodId: payment.token },
        shopperInteraction: "ContAuth",
        recurringProcessingModel: "UnscheduledCardOnFile",
        metadata: { agentProtocol: "ACP", agentSessionId: session.id },
      },
      `${session.id}-${payment.token}`,
    );
    ({ pspReference, resultCode, refusalReason } = result);
  } else {
    pspReference = payment.psp_reference;
    resultCode = payment.result_code;
  }

  if (resultCode !== "Authorised" || !pspReference) {
    return { status: 200, body: { result_code: resultCode, psp_reference: pspReference, refusal_reason: refusalReason } };
  }
  const order = store.recordOrder({
    id: orderId,
    protocol: "acp",
    checkoutSessionId: session.id,
    pspReference,
    amount,
    currency: session.currency,
    items: session.line_items.map((li) => li.item),
  });
  return {
    status: 200,
    body: { result_code: resultCode, psp_reference: pspReference, order: { id: order.id, permalink_url: `${config.merchantUrl}/orders/${order.id}` } },
  };
}

function error(code: string, content: string): Message {
  return { type: "error", code, content, content_type: "plain" };
}
