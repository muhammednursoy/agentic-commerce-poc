export type SessionStatus = "not_ready_for_payment" | "ready_for_payment" | "in_progress" | "completed" | "canceled";

export interface Item {
  id: string;
  quantity: number;
}

export interface Address {
  name?: string;
  line_one: string;
  line_two?: string;
  city: string;
  state?: string;
  country: string;
  postal_code: string;
}

export interface Buyer {
  email?: string;
  first_name?: string;
  last_name?: string;
  phone_number?: string;
}

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
  payment_provider: { provider: "adyen"; supported_payment_methods: string[] };
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

export function formatAmount(minor: number, currency: string): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(minor / 100);
}
