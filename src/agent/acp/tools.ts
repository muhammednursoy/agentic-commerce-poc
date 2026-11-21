import type { CheckoutSession, PaymentData } from "../../acp.ts";
import { describeForApproval } from "../shopper.ts";
import { itemsInput, itemsSchema, sessionIdSchema, stringInput, toolError } from "../toolset.ts";
import type { CheckoutSummary, Confirm, ToolDefinition, Toolset } from "../toolset.ts";
import type { AgentPlatform } from "./platform.ts";

const PROVIDERS = {
  adyen: {
    host: "with the merchant through Adyen",
    tokenize: "tokenize their saved card with Adyen (single-use token limited to this session and amount)",
    role: "with Adyen as the payment provider",
  },
  stripe: {
    host: "directly with the merchant",
    tokenize: "have the agent platform verify the merchant-signed cart, sign a Mastercard Verifiable Intent for exactly that cart and grant the merchant a Stripe Shared Payment Token (single use, limited to this amount and 15 minutes)",
    role: "hosted by the merchant, with Stripe as the payment provider",
  },
} as const;

const definitions = (provider: keyof typeof PROVIDERS): ToolDefinition[] => [
  {
    name: "list_products",
    description: "List the merchant's product feed with ids, prices (minor units) and stock.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "create_checkout_session",
    description:
      `Create an ACP checkout session ${PROVIDERS[provider].host}. The shopper's saved shipping address and contact details are attached automatically. Returns line items, shipping options, totals and messages.`,
    parameters: { type: "object", properties: { items: itemsSchema }, required: ["items"], additionalProperties: false },
  },
  {
    name: "update_checkout_session",
    description:
      "Update a checkout session: replace the full item list and/or select a shipping option. The session becomes ready once a shipping option is selected and there are no error messages.",
    parameters: {
      type: "object",
      properties: {
        session_id: sessionIdSchema,
        items: itemsSchema,
        fulfillment_option_id: { type: "string", description: "One of the fulfillment_options ids" },
      },
      required: ["session_id"],
      additionalProperties: false,
    },
  },
  {
    name: "get_checkout_session",
    description: "Fetch the current state of a checkout session.",
    parameters: { type: "object", properties: { session_id: sessionIdSchema }, required: ["session_id"], additionalProperties: false },
  },
  {
    name: "pay_and_complete",
    description:
      `Ask the shopper to approve the exact total, then ${PROVIDERS[provider].tokenize} and complete the checkout. Only call when the session is ready.`,
    parameters: { type: "object", properties: { session_id: sessionIdSchema }, required: ["session_id"], additionalProperties: false },
  },
  {
    name: "cancel_checkout_session",
    description: "Cancel a checkout session that will not be paid.",
    parameters: { type: "object", properties: { session_id: sessionIdSchema }, required: ["session_id"], additionalProperties: false },
  },
];

export class AcpToolset implements Toolset {
  readonly protocol = "acp";
  readonly definitions: ToolDefinition[];
  readonly names = { list: "list_products", create: "create_checkout_session", update: "update_checkout_session", pay: "pay_and_complete" };
  readonly system: string;
  private readonly platform: AgentPlatform;
  private readonly confirm: Confirm;
  private readonly pending = new Map<string, PaymentData>();

  constructor(platform: AgentPlatform, confirm: Confirm) {
    this.platform = platform;
    this.confirm = confirm;
    this.definitions = definitions(platform.endpoint.provider);
    const a = platform.shopper.address;
    this.system = [
      `You are a shopping agent for the online store Brew & Co. You buy on the shopper's behalf through the Agentic Commerce Protocol (ACP), ${PROVIDERS[platform.endpoint.provider].role}.`,
      "Work only with the tools. Never invent product ids, prices or shipping options; read them from tool results. Amounts in tool results are in minor units (cents); always show them to the shopper formatted, e.g. $28.99.",
      "Flow: list_products, create_checkout_session, pick a shipping option with update_checkout_session (standard unless the shopper asked for faster delivery), then pay_and_complete.",
      "If a tool result has error messages (out of stock, partial stock, unsupported destination, declined payment), explain it to the shopper and suggest an alternative instead of retrying blindly.",
      "pay_and_complete asks the shopper for approval itself; do not ask for card details, the platform holds the card.",
      "If a pay result has status in_progress (message payment_pending) the payment may already have been taken: tell the shopper it is pending, call pay_and_complete again on the same session to re-check, and never create a new session for the same items.",
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
      case "list_products":
        return { products: await p.listProducts() };
      case "create_checkout_session":
        return summarizeAcp(await p.createSession(itemsInput(input.items)));
      case "update_checkout_session":
        return summarizeAcp(await p.updateSession(stringInput(input.session_id, "session_id"), {
          ...(input.items !== undefined ? { items: itemsInput(input.items) } : {}),
          ...(input.fulfillment_option_id ? { fulfillment_option_id: input.fulfillment_option_id } : {}),
        }));
      case "get_checkout_session":
        return summarizeAcp(await p.getSession(stringInput(input.session_id, "session_id")));
      case "cancel_checkout_session":
        return summarizeAcp(await p.cancelSession(stringInput(input.session_id, "session_id")));
      case "pay_and_complete":
        return this.payAndComplete(stringInput(input.session_id, "session_id"));
      default:
        return { error: `unknown tool ${name}` };
    }
  }

  private async payAndComplete(sessionId: string): Promise<unknown> {
    const session = await this.platform.getSession(sessionId);
    const summary = summarizeAcp(session);
    if (session.status === "in_progress") {
      const payment = this.pending.get(sessionId);
      return payment ? this.complete(sessionId, payment) : { error: "payment is pending at the merchant", session: summary };
    }
    if (!summary.ready) return { error: `session is ${session.status}, not ready_for_payment`, session: summary };
    const payer = this.platform.payer;
    const payment = await payer.authorize(session, describeForApproval(summary, payer.paymentLabel()), this.confirm);
    if (!payment) return { declined_by_shopper: true, session_id: sessionId };
    return this.complete(sessionId, payment);
  }

  private async complete(sessionId: string, payment: PaymentData): Promise<CheckoutSummary> {
    this.pending.set(sessionId, payment);
    const done = summarizeAcp(await this.platform.completeSession(sessionId, payment));
    if (done.status !== "in_progress") this.pending.delete(sessionId);
    return done;
  }
}

export function summarizeAcp(s: CheckoutSession): CheckoutSummary {
  return {
    id: s.id,
    status: s.status,
    ready: s.status === "ready_for_payment",
    currency: s.currency,
    line_items: s.line_items.map((li) => ({ product_id: li.item.id, title: li.title, quantity: li.item.quantity, subtotal: li.subtotal, total: li.total })),
    fulfillment_options: s.fulfillment_options.map((o) => ({ id: o.id, title: o.title, subtitle: o.subtitle, total: o.total })),
    selected_fulfillment_option_id: s.fulfillment_option_id ?? null,
    totals: Object.fromEntries(s.totals.map((t) => [t.type, t.amount])),
    messages: s.messages.map((m) => ({ type: m.type, code: m.code, content: m.content })),
    ...(s.order ? { order: s.order } : {}),
  };
}
