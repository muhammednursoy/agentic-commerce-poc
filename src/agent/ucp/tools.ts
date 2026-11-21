import { formatAmount } from "../../acp.ts";
import type { PaymentInstrument, UcpCheckout } from "../../ucp.ts";
import { describeForApproval } from "../shopper.ts";
import { itemsInput, itemsSchema, sessionIdSchema, stringInput, toolError } from "../toolset.ts";
import type { CheckoutSummary, Confirm, ToolDefinition, Toolset } from "../toolset.ts";
import { GooglePaySheet } from "./google-pay.ts";
import type { UcpPlatform } from "./platform.ts";

const checkoutId = { ...sessionIdSchema, description: "Checkout id returned by create_checkout, e.g. chk_..." };

type Approved = { total: number; currency: string };

const DEFINITIONS: ToolDefinition[] = [
  {
    name: "get_merchant_capabilities",
    description: "Read the merchant's UCP profile (/.well-known/ucp): supported capabilities and whether Google Pay is accepted.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_products",
    description: "List the merchant's product feed with ids, prices (minor units) and stock.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "create_checkout",
    description:
      "Create a UCP checkout session on the merchant. The shopper's saved shipping address and email are attached automatically. Returns line items, shipping options, totals and messages.",
    parameters: { type: "object", properties: { items: itemsSchema }, required: ["items"], additionalProperties: false },
  },
  {
    name: "update_checkout",
    description:
      "Update a checkout: replace the full item list and/or select a shipping option. The checkout becomes ready_for_complete once a shipping option is selected and there are no blocking error messages.",
    parameters: {
      type: "object",
      properties: {
        checkout_id: checkoutId,
        items: itemsSchema,
        fulfillment_option_id: { type: "string", description: "One of the fulfillment_options ids" },
      },
      required: ["checkout_id"],
      additionalProperties: false,
    },
  },
  {
    name: "get_checkout",
    description: "Fetch the current state of a checkout.",
    parameters: { type: "object", properties: { checkout_id: checkoutId }, required: ["checkout_id"], additionalProperties: false },
  },
  {
    name: "pay_with_google_pay",
    description:
      "Show the Google Pay sheet with the exact total for the shopper to approve, then complete the checkout with the encrypted Google Pay token. The merchant charges it through Adyen. Only call when the checkout is ready_for_complete.",
    parameters: { type: "object", properties: { checkout_id: checkoutId }, required: ["checkout_id"], additionalProperties: false },
  },
  {
    name: "cancel_checkout",
    description: "Cancel a checkout that will not be paid.",
    parameters: { type: "object", properties: { checkout_id: checkoutId }, required: ["checkout_id"], additionalProperties: false },
  },
];

export class UcpToolset implements Toolset {
  readonly protocol = "ucp";
  readonly definitions = DEFINITIONS;
  readonly names = { list: "list_products", create: "create_checkout", update: "update_checkout", pay: "pay_with_google_pay" };
  readonly system: string;
  private readonly platform: UcpPlatform;
  private readonly sheet: GooglePaySheet;
  private readonly pending = new Map<string, { instrument: PaymentInstrument; approved: Approved }>();

  constructor(platform: UcpPlatform, confirm: Confirm) {
    this.platform = platform;
    const a = platform.shopper.address;
    this.sheet = new GooglePaySheet(platform.shopper.card, {
      street_address: a.line_one,
      address_locality: a.city,
      address_region: a.state,
      postal_code: a.postal_code,
      address_country: a.country,
    }, confirm);
    this.system = [
      "You are a Gemini shopping agent. You buy from the online store Brew & Co on the shopper's behalf using Google's Universal Commerce Protocol (UCP) and pay with the shopper's Google Pay wallet. The merchant processes the payment with Adyen.",
      "Work only with the tools. Never invent product ids, prices or shipping options; read them from tool results. Amounts in tool results are in minor units (cents); always show them formatted, e.g. $28.99.",
      "Flow: list_products, create_checkout, select a shipping option with update_checkout (standard unless the shopper asked for faster delivery), then pay_with_google_pay.",
      "Messages with severity recoverable can be fixed with update_checkout (for example remove an out-of-stock item after telling the shopper). If the status is requires_escalation, give the shopper the continue_url and stop.",
      "If the payment is declined, tell the shopper and ask before trying again. pay_with_google_pay asks the shopper for approval itself; never ask for card details.",
      "If a pay result has status complete_in_progress (message payment_pending) the payment may already have been taken: tell the shopper it is pending, call pay_with_google_pay again on the same checkout to re-check, and never create a new checkout for the same items.",
      `Saved shipping address: ${a.name}, ${a.line_one}, ${a.city} ${a.state} ${a.postal_code}, ${a.country}.`,
      "Reply in the shopper's language and keep replies short.",
    ].join("\n");
  }

  async execute(name: string, input: Record<string, any>): Promise<unknown> {
    try {
      return await this.run(name, input ?? {});
    } catch (err) {
      return toolError(err);
    }
  }

  private async run(name: string, input: Record<string, any>): Promise<unknown> {
    const p = this.platform;
    switch (name) {
      case "get_merchant_capabilities": {
        const info = await p.discover();
        return { capabilities: info.capabilities, google_pay_accepted: Boolean(info.googlePay), google_pay_gateway: info.googlePay?.config.allowed_payment_methods[0]?.tokenization_specification.parameters.gateway };
      }
      case "list_products":
        return { products: await p.listProducts() };
      case "create_checkout":
        return summarizeUcp(await p.create(itemsInput(input.items)));
      case "update_checkout":
        return summarizeUcp(await p.update(stringInput(input.checkout_id, "checkout_id"), {
          items: input.items === undefined ? undefined : itemsInput(input.items),
          fulfillmentOptionId: input.fulfillment_option_id,
        }));
      case "get_checkout":
        return summarizeUcp(await p.get(stringInput(input.checkout_id, "checkout_id")));
      case "cancel_checkout":
        return summarizeUcp(await p.cancel(stringInput(input.checkout_id, "checkout_id")));
      case "pay_with_google_pay":
        return this.pay(stringInput(input.checkout_id, "checkout_id"));
      default:
        return { error: `unknown tool ${name}` };
    }
  }

  private async pay(checkoutId: string): Promise<unknown> {
    const checkout = await this.platform.get(checkoutId);
    const summary = summarizeUcp(checkout);
    if (checkout.status === "complete_in_progress") {
      const entry = this.pending.get(checkoutId);
      if (!entry) return { error: "payment is pending at the merchant", checkout: summary };
      return this.complete(checkoutId, entry.instrument, entry.approved);
    }
    if (!summary.ready) return { error: `checkout is ${checkout.status}, not ready_for_complete`, checkout: summary };
    const handler = (await this.platform.discover()).googlePay;
    if (!handler) return { error: "merchant does not accept Google Pay" };
    const card = this.platform.shopper.card;
    const instrument = await this.sheet.requestPayment(
      handler,
      summary.totals.total,
      summary.currency,
      describeForApproval(summary, `Google Pay ${card.brand.toUpperCase()} •••• ${card.number.slice(-4)}`),
    );
    if (!instrument) return { declined_by_shopper: true, checkout_id: checkoutId };
    const approved = { total: summary.totals.total, currency: summary.currency };
    const latest = summarizeUcp(await this.platform.get(checkoutId));
    if (latest.totals.total !== approved.total || latest.currency !== approved.currency) {
      return { error: `the checkout total changed after the shopper approved ${formatAmount(approved.total, approved.currency)}; nothing was charged`, checkout: latest };
    }
    return this.complete(checkoutId, instrument, approved);
  }

  private async complete(checkoutId: string, instrument: PaymentInstrument, approved: Approved): Promise<unknown> {
    this.pending.set(checkoutId, { instrument, approved });
    const done = summarizeUcp(await this.platform.complete(checkoutId, instrument));
    if (done.status !== "complete_in_progress") this.pending.delete(checkoutId);
    if (done.totals.total !== approved.total || done.currency !== approved.currency) {
      return { ...done, error: `the merchant completed for ${formatAmount(done.totals.total, done.currency)} but the shopper approved ${formatAmount(approved.total, approved.currency)}` };
    }
    return done;
  }
}

export function summarizeUcp(c: UcpCheckout): CheckoutSummary {
  const group = c.fulfillment?.methods[0]?.groups?.[0];
  return {
    id: c.id,
    status: c.status,
    ready: c.status === "ready_for_complete",
    currency: c.currency,
    line_items: c.line_items.map((li) => ({
      product_id: li.item.id,
      title: li.item.title,
      quantity: li.quantity,
      total: li.totals.find((t) => t.type === "total")?.amount ?? 0,
    })),
    fulfillment_options: (group?.options ?? []).map((o) => ({ id: o.id, title: o.title, subtitle: o.description, total: o.totals.find((t) => t.type === "total")?.amount ?? 0 })),
    selected_fulfillment_option_id: group?.selected_option_id ?? null,
    totals: Object.fromEntries(c.totals.map((t) => [t.type, t.amount])),
    messages: c.messages.map((m) => ({ type: m.type, code: m.code, severity: m.severity, content: m.content })),
    ...(c.order ? { order: c.order } : {}),
    ...(c.continue_url ? { continue_url: c.continue_url } : {}),
  };
}
