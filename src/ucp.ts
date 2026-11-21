export const UCP_VERSION = "2026-01-23";
export const SHOPPING_SERVICE = "dev.ucp.shopping";
export const CHECKOUT_CAPABILITY = "dev.ucp.shopping.checkout";
export const FULFILLMENT_CAPABILITY = "dev.ucp.shopping.fulfillment";
export const GOOGLE_PAY_HANDLER = "com.google.pay";

export type UcpStatus =
  | "incomplete"
  | "requires_escalation"
  | "ready_for_complete"
  | "complete_in_progress"
  | "completed"
  | "canceled";

export type Severity = "recoverable" | "requires_buyer_input" | "requires_buyer_review";

export interface UcpMessage {
  type: "error" | "warning" | "info";
  code?: string;
  severity?: Severity;
  content: string;
  content_type?: "plain" | "markdown";
  path?: string;
}

export interface UcpTotal {
  type: "items_discount" | "subtotal" | "discount" | "fulfillment" | "tax" | "fee" | "total";
  display_text?: string;
  amount: number;
}

export interface PostalAddress {
  id?: string;
  first_name?: string;
  last_name?: string;
  street_address: string;
  extended_address?: string;
  address_locality: string;
  address_region?: string;
  postal_code: string;
  address_country: string;
}

export interface UcpBuyer {
  first_name?: string;
  last_name?: string;
  email?: string;
  phone_number?: string;
}

export interface UcpLineItemInput {
  item: { id: string };
  quantity: number;
}

export interface UcpLineItem {
  id: string;
  item: { id: string; title: string; price: number };
  quantity: number;
  totals: UcpTotal[];
}

export interface FulfillmentOptionView {
  id: string;
  title: string;
  description: string;
  totals: UcpTotal[];
}

export interface FulfillmentMethod {
  id?: string;
  type: "shipping";
  line_item_ids?: string[];
  destinations?: PostalAddress[];
  selected_destination_id?: string;
  groups?: { id?: string; line_item_ids?: string[]; selected_option_id?: string; options?: FulfillmentOptionView[] }[];
}

export interface GooglePayHandler {
  id: string;
  version: string;
  spec: string;
  schema: string;
  config: {
    api_version: number;
    api_version_minor: number;
    environment: "TEST" | "PRODUCTION";
    merchant_info: { merchant_name: string; merchant_id: string; merchant_origin: string };
    allowed_payment_methods: {
      type: "CARD";
      parameters: {
        allowed_auth_methods: string[];
        allowed_card_networks: string[];
        billing_address_required?: boolean;
        billing_address_parameters?: { format: "MIN" | "FULL"; phone_number_required?: boolean };
      };
      tokenization_specification: {
        type: "PAYMENT_GATEWAY";
        parameters: { gateway: string; gatewayMerchantId: string };
      };
    }[];
  };
}

export interface PaymentInstrument {
  id: string;
  handler_id: string;
  type: "card";
  selected?: boolean;
  display?: { brand?: string; last_digits?: string; description?: string };
  billing_address?: PostalAddress;
  credential: { type: "PAYMENT_GATEWAY"; token: string };
}

export interface UcpEnvelope {
  version: string;
  capabilities: Record<string, { version: string }[]>;
  payment_handlers: Record<string, GooglePayHandler[]>;
}

export interface UcpCheckout {
  ucp: UcpEnvelope;
  id: string;
  status: UcpStatus;
  currency: string;
  line_items: UcpLineItem[];
  totals: UcpTotal[];
  buyer?: UcpBuyer;
  fulfillment?: { methods: FulfillmentMethod[] };
  messages: UcpMessage[];
  links: { type: string; url: string; title?: string }[];
  expires_at: string;
  continue_url?: string;
  order?: { id: string; permalink_url: string };
}

export interface UcpProfile {
  ucp: {
    version: string;
    services: Record<string, { version: string; spec: string; transport: "rest"; endpoint: string; schema?: string }[]>;
    capabilities: Record<string, { version: string; spec: string; extends?: string }[]>;
    payment_handlers: Record<string, GooglePayHandler[]>;
  };
  signing_keys: unknown[];
}

export function ucpTotal(checkout: Pick<UcpCheckout, "totals">): number {
  return checkout.totals.find((t) => t.type === "total")?.amount ?? 0;
}
