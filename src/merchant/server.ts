import type http from "node:http";
import { config } from "../config.ts";
import { Router, callJson, randomId } from "../http.ts";
import type { Json, Req, Res } from "../http.ts";
import { sessionTotal } from "../acp.ts";
import type { CheckoutSession, FulfillmentOption, Item, LineItem, Message, Quote, Total } from "../acp.ts";

export interface Product {
  id: string;
  title: string;
  description: string;
  price: number;
  currency: string;
  stock: number;
}

export interface MerchantOrder {
  id: string;
  checkoutSessionId: string;
  pspReference: string;
  amount: number;
  currency: string;
  items: Item[];
  createdAt: string;
}

const TAX_RATES: Record<string, number> = { NY: 0.08875, CA: 0.0725, TX: 0.0625 };
const DEFAULT_TAX_RATE = 0.06;
const FREE_SHIPPING_FROM = 10000;
const RISK_LIMIT = 500000;

export function defaultCatalog(): Product[] {
  return [
    { id: "sku_coffee_beans", title: "Ethiopia Yirgacheffe coffee beans 1 kg", description: "Light roast, whole beans", price: 2899, currency: "USD", stock: 25 },
    { id: "sku_pour_over", title: "Ceramic pour-over dripper", description: "Size 02, white", price: 3450, currency: "USD", stock: 8 },
    { id: "sku_grinder", title: "Burr coffee grinder", description: "40 grind settings, conical burrs", price: 14900, currency: "USD", stock: 3 },
    { id: "sku_kettle", title: "Gooseneck kettle 1 L", description: "Electric, temperature control", price: 7900, currency: "USD", stock: 0 },
    { id: "sku_filters", title: "Paper filters (100 pcs)", description: "Fits size 02 drippers", price: 699, currency: "USD", stock: 200 },
  ];
}

export class Merchant {
  readonly catalog: Map<string, Product>;
  readonly orders = new Map<string, MerchantOrder>();

  constructor(products: Product[] = defaultCatalog()) {
    this.catalog = new Map(products.map((p) => [p.id, { ...p }]));
  }

  router(): Router {
    return new Router()
      .on("GET", "/products", () => ({ status: 200, body: { products: [...this.catalog.values()] } }))
      .on("GET", "/orders/:id", (r) => {
        const order = this.orders.get(r.params.id);
        return order ? { status: 200, body: order } : { status: 404, body: { message: "order not found" } };
      })
      .on("POST", "/agentic/quote", (r) => ({ status: 200, body: this.quote(r.body) }))
      .on("POST", "/agentic/sessions/:id/commit", (r) => this.commit(r))
      .on("POST", "/agentic/sessions/:id/finalize", (r) => this.finalize(r));
  }

  listen(port: number): Promise<http.Server> {
    return this.router().listen(port, "merchant");
  }

  quote(body: Json): Quote {
    const messages: Message[] = [];
    const currency: string = body.currency;
    const items: Item[] = body.items ?? [];
    const address = body.fulfillment_address;

    const lineItems: LineItem[] = [];
    items.forEach((item, i) => {
      const product = this.catalog.get(item.id);
      if (!product) {
        messages.push(err("invalid_item", `Unknown product ${item.id}`, `$.items[${i}]`));
        return;
      }
      if (product.currency !== currency) {
        messages.push(err("currency_unsupported", `${product.id} is sold in ${product.currency}`, `$.items[${i}]`));
        return;
      }
      if (product.stock === 0) {
        messages.push(err("product_out_of_stock", `${product.title} is out of stock`, `$.items[${i}]`));
        return;
      }
      if (product.stock < item.quantity) {
        messages.push(err("product_partial_stock", `Only ${product.stock} of ${product.title} left`, `$.items[${i}]`));
        return;
      }
      const base = product.price * item.quantity;
      lineItems.push({ id: `li_${product.id}`, item, title: product.title, base_amount: base, discount: 0, subtotal: base, tax: 0, total: base });
    });

    const itemsSubtotal = lineItems.reduce((s, li) => s + li.subtotal, 0);
    let options: FulfillmentOption[] = [];
    let taxRate = 0;
    if (address) {
      if (address.country !== "US") {
        messages.push(err("shipping_destination_unsupported", "This store only ships within the US", "$.fulfillment_address.country"));
      } else {
        taxRate = TAX_RATES[address.state ?? ""] ?? DEFAULT_TAX_RATE;
        options = [
          shipping("ship_standard", "Standard shipping", "5-7 business days", itemsSubtotal >= FREE_SHIPPING_FROM ? 0 : 599),
          shipping("ship_express", "Express shipping", "1-2 business days", 1999),
        ];
      }
    }
    for (const li of lineItems) {
      li.tax = Math.round(li.subtotal * taxRate);
      li.total = li.subtotal + li.tax;
    }
    const chosen = options.find((o) => o.id === body.fulfillment_option_id);
    const itemsTax = lineItems.reduce((s, li) => s + li.tax, 0);
    const fulfillment = chosen?.total ?? 0;
    const totals: Total[] = [
      { type: "items_base_amount", display_text: "Items", amount: itemsSubtotal },
      { type: "subtotal", display_text: "Subtotal", amount: itemsSubtotal },
      { type: "fulfillment", display_text: chosen ? chosen.title : "Shipping", amount: fulfillment },
      { type: "tax", display_text: "Tax", amount: itemsTax },
      { type: "total", display_text: "Total", amount: itemsSubtotal + fulfillment + itemsTax },
    ];
    return { line_items: lineItems, fulfillment_options: options, totals, messages };
  }

  private commit(req: Req): Res {
    const session: CheckoutSession = req.body.session;
    const fresh = this.quote({
      currency: session.currency,
      items: session.line_items.map((li) => li.item),
      fulfillment_address: session.fulfillment_address,
      fulfillment_option_id: session.fulfillment_option_id,
    });
    const errors = fresh.messages.filter((m) => m.type === "error");
    if (errors.length) return { status: 200, body: { approved: false, messages: errors } };
    if (sessionTotal(fresh) !== sessionTotal(session)) {
      return { status: 200, body: { approved: false, messages: [err("product_price_mismatch", "Prices changed, update the session")] } };
    }
    if (sessionTotal(session) > RISK_LIMIT) {
      return { status: 200, body: { approved: false, messages: [err("risk_rejected", "Order exceeds the merchant risk limit")] } };
    }
    return { status: 200, body: { approved: true } };
  }

  private async finalize(req: Req): Promise<Res> {
    const { flow, session, payment } = req.body as { flow: string; session: CheckoutSession; payment: Json };
    const amount = sessionTotal(session);
    const orderId = randomId("ord_", 5);
    let pspRef: string;
    let resultCode: string;
    let refusalReason: string | undefined;

    if (flow === "advanced") {
      const res = await callJson("POST", `${config.checkoutBase}/payments`, {
        label: "merchant→adyen",
        headers: { "x-api-key": config.checkoutApiKey, "idempotency-key": `${session.id}-${payment.token}` },
        body: {
          merchantAccount: config.merchantAccount,
          amount: { value: amount, currency: session.currency },
          reference: orderId,
          shopperReference: session.id,
          paymentMethod: { type: "scheme", storedPaymentMethodId: payment.token },
          shopperInteraction: "ContAuth",
          recurringProcessingModel: "UnscheduledCardOnFile",
        },
      });
      pspRef = res.body?.pspReference;
      resultCode = res.body?.resultCode ?? "Error";
      refusalReason = res.body?.refusalReason ?? res.body?.message;
    } else {
      pspRef = payment.psp_reference;
      resultCode = payment.result_code;
    }

    if (resultCode !== "Authorised") {
      return { status: 200, body: { result_code: resultCode, psp_reference: pspRef, refusal_reason: refusalReason } };
    }
    const items = session.line_items.map((li) => li.item);
    for (const item of items) {
      const product = this.catalog.get(item.id);
      if (product) product.stock -= item.quantity;
    }
    this.orders.set(orderId, {
      id: orderId,
      checkoutSessionId: session.id,
      pspReference: pspRef,
      amount,
      currency: session.currency,
      items,
      createdAt: new Date().toISOString(),
    });
    return {
      status: 200,
      body: {
        result_code: resultCode,
        psp_reference: pspRef,
        order: { id: orderId, permalink_url: `${config.merchantUrl}/orders/${orderId}` },
      },
    };
  }
}

function shipping(id: string, title: string, subtitle: string, amount: number): FulfillmentOption {
  return { type: "shipping", id, title, subtitle, subtotal: amount, tax: 0, total: amount };
}

function err(code: string, content: string, path?: string): Message {
  return { type: "error", code, content, content_type: "plain", ...(path ? { path } : {}) };
}
