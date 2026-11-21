import { formatAmount, sessionTotal } from "../acp.ts";
import type { CheckoutSession, Item } from "../acp.ts";
import { AdyenApiError } from "./platform.ts";
import type { AgentPlatform } from "./platform.ts";

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export type Confirm = (summary: string) => Promise<boolean>;

const itemsSchema = {
  type: "array",
  minItems: 1,
  items: {
    type: "object",
    properties: {
      id: { type: "string", description: "Product id from list_products" },
      quantity: { type: "integer", minimum: 1 },
    },
    required: ["id", "quantity"],
    additionalProperties: false,
  },
};

const sessionIdSchema = { type: "string", description: "Checkout session id, e.g. cs_test_..." };

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "list_products",
    description: "List the merchant's product feed with ids, prices (minor units) and stock.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "create_checkout_session",
    description:
      "Create an ACP checkout session with the merchant through Adyen. The shopper's saved shipping address and contact details are attached automatically. Returns line items, shipping options, totals and messages.",
    parameters: {
      type: "object",
      properties: { items: itemsSchema },
      required: ["items"],
      additionalProperties: false,
    },
  },
  {
    name: "update_checkout_session",
    description:
      "Update a checkout session: replace the full item list and/or select a shipping option. The session becomes ready_for_payment once a shipping option is selected and there are no error messages.",
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
      "Ask the shopper to approve the exact total, then tokenize their saved card with Adyen (single-use token limited to this session and amount) and complete the checkout. Only call when the session is ready_for_payment.",
    parameters: { type: "object", properties: { session_id: sessionIdSchema }, required: ["session_id"], additionalProperties: false },
  },
  {
    name: "cancel_checkout_session",
    description: "Cancel a checkout session that will not be paid.",
    parameters: { type: "object", properties: { session_id: sessionIdSchema }, required: ["session_id"], additionalProperties: false },
  },
];

export function systemPrompt(platform: AgentPlatform): string {
  const a = platform.shopper.address;
  return [
    "You are a shopping agent for the online store Brew & Co. You buy on the shopper's behalf through the Agentic Commerce Protocol (ACP) with Adyen as the payment provider.",
    "Work only with the tools. Never invent product ids, prices or shipping options; read them from tool results. Amounts in tool results are in minor units (cents); always show them to the shopper formatted, e.g. $28.99.",
    "Flow: list_products, create_checkout_session, pick a shipping option with update_checkout_session (standard unless the shopper asked for faster delivery), then pay_and_complete.",
    "If a tool result has error messages (out of stock, partial stock, unsupported destination, declined payment), explain it to the shopper and suggest an alternative instead of retrying blindly.",
    "pay_and_complete asks the shopper for approval itself; do not ask for card details, the platform holds the card.",
    `Saved shipping address: ${a.name}, ${a.line_one}, ${a.city} ${a.state} ${a.postal_code}, ${a.country}.`,
    "Reply in the shopper's language and keep replies short.",
  ].join("\n");
}

export class AgentTools {
  private readonly platform: AgentPlatform;
  private readonly confirm: Confirm;

  constructor(platform: AgentPlatform, confirm: Confirm) {
    this.platform = platform;
    this.confirm = confirm;
  }

  async execute(name: string, input: Record<string, any>): Promise<unknown> {
    try {
      return await this.run(name, input ?? {});
    } catch (err) {
      if (err instanceof AdyenApiError) return { error: err.message };
      throw err;
    }
  }

  private async run(name: string, input: Record<string, any>): Promise<unknown> {
    const p = this.platform;
    switch (name) {
      case "list_products":
        return { products: await p.listProducts() };
      case "create_checkout_session":
        return summarize(await p.createSession(input.items as Item[]));
      case "update_checkout_session":
        return summarize(await p.updateSession(input.session_id, {
          ...(input.items ? { items: input.items } : {}),
          ...(input.fulfillment_option_id ? { fulfillment_option_id: input.fulfillment_option_id } : {}),
        }));
      case "get_checkout_session":
        return summarize(await p.getSession(input.session_id));
      case "cancel_checkout_session":
        return summarize(await p.cancelSession(input.session_id));
      case "pay_and_complete":
        return this.payAndComplete(input.session_id);
      default:
        return { error: `unknown tool ${name}` };
    }
  }

  private async payAndComplete(sessionId: string): Promise<unknown> {
    const session = await this.platform.getSession(sessionId);
    if (session.status !== "ready_for_payment") {
      return { error: `session is ${session.status}, not ready_for_payment`, session: summarize(session) };
    }
    const approved = await this.confirm(describeForApproval(session, this.platform.shopper.card.number.slice(-4)));
    if (!approved) return { declined_by_shopper: true, session_id: sessionId };
    const token = await this.platform.delegatePayment(session);
    return summarize(await this.platform.completeSession(sessionId, token));
  }
}

export function summarize(s: CheckoutSession) {
  return {
    id: s.id,
    status: s.status,
    currency: s.currency,
    line_items: s.line_items.map((li) => ({ product_id: li.item.id, title: li.title, quantity: li.item.quantity, total: li.total })),
    fulfillment_options: s.fulfillment_options.map((o) => ({ id: o.id, title: o.title, subtitle: o.subtitle, total: o.total })),
    selected_fulfillment_option_id: s.fulfillment_option_id ?? null,
    totals: Object.fromEntries(s.totals.map((t) => [t.type, t.amount])),
    messages: s.messages.map((m) => ({ type: m.type, code: m.code, content: m.content })),
    ...(s.order ? { order: s.order } : {}),
  };
}

function describeForApproval(s: CheckoutSession, last4: string): string {
  const lines = s.line_items.map((li) => `  ${li.item.quantity} × ${li.title}  ${formatAmount(li.subtotal, s.currency)}`);
  const ship = s.fulfillment_options.find((o) => o.id === s.fulfillment_option_id);
  const tax = s.totals.find((t) => t.type === "tax")?.amount ?? 0;
  return [
    ...lines,
    `  ${ship?.title ?? "Shipping"}  ${formatAmount(ship?.total ?? 0, s.currency)}`,
    `  Tax  ${formatAmount(tax, s.currency)}`,
    `  Total  ${formatAmount(sessionTotal(s), s.currency)}  (card •••• ${last4})`,
  ].join("\n");
}
