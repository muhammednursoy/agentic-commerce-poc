import type { Address, Buyer, Item } from "./domain.ts";

export type SessionStatus = "not_ready_for_payment" | "ready_for_payment" | "in_progress" | "completed" | "canceled";

export interface LineItem {
  id: string;
  item: Item;
  title: string;
  base_amount: number;
  discount: number;
  subtotal: number;
  tax: number;
  total: number;
}

export interface FulfillmentOption {
  type: "shipping";
  id: string;
  title: string;
  subtitle: string;
  subtotal: number;
  tax: number;
  total: number;
}

export interface Total {
  type: "items_base_amount" | "items_discount" | "subtotal" | "fulfillment" | "tax" | "total";
  display_text: string;
  amount: number;
}

export interface Message {
  type: "error" | "warning" | "info";
  code?: string;
  content: string;
  content_type?: "plain" | "markdown";
  path?: string;
}

export interface Order {
  id: string;
  checkout_session_id: string;
  permalink_url: string;
}

export interface CheckoutSession {
  id: string;
  status: SessionStatus;
  currency: string;
  payment_provider: { provider: "adyen" | "stripe"; supported_payment_methods: string[] };
  buyer?: Buyer;
  fulfillment_address?: Address;
  fulfillment_option_id?: string;
  line_items: LineItem[];
  fulfillment_options: FulfillmentOption[];
  totals: Total[];
  messages: Message[];
  links: { type: string; url: string }[];
  order?: Order;
}

export interface Quote {
  line_items: LineItem[];
  fulfillment_options: FulfillmentOption[];
  totals: Total[];
  messages: Message[];
}

export function sessionTotal(session: Pick<CheckoutSession, "totals">): number {
  return session.totals.find((t) => t.type === "total")?.amount ?? 0;
}

export function errorMessage(code: string, content: string, path?: string): Message {
  return { type: "error", code, content, content_type: "plain", ...(path ? { path } : {}) };
}

export function infoMessage(code: string, content: string): Message {
  return { type: "info", code, content, content_type: "plain" };
}

export function validateItems(items: unknown): string[] {
  if (!Array.isArray(items) || items.length === 0) return ["items"];
  return items.flatMap((it, i: number) => {
    const out: string[] = [];
    if (typeof it?.id !== "string") out.push(`items[${i}].id`);
    if (!Number.isInteger(it?.quantity) || it.quantity < 1) out.push(`items[${i}].quantity`);
    return out;
  });
}

export function applyQuote(session: CheckoutSession, quote: Quote): void {
  session.line_items = quote.line_items;
  session.fulfillment_options = quote.fulfillment_options;
  session.totals = quote.totals;
  session.messages = quote.messages;
  if (session.fulfillment_option_id && !quote.fulfillment_options.some((o) => o.id === session.fulfillment_option_id)) {
    session.fulfillment_option_id = undefined;
  }
  const hasError = quote.messages.some((m) => m.type === "error") || quote.line_items.length === 0;
  const missing: Message[] = [];
  if (!session.fulfillment_address) missing.push(infoMessage("missing_fulfillment_address", "Provide a fulfillment_address to calculate shipping and tax."));
  else if (!session.fulfillment_option_id) missing.push(infoMessage("missing_fulfillment_option", "Choose one of fulfillment_options via fulfillment_option_id."));
  session.messages.push(...missing);
  session.status = !hasError && missing.length === 0 ? "ready_for_payment" : "not_ready_for_payment";
}
