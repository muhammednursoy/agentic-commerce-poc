import { formatAmount } from "../domain.ts";
import type { Address, Buyer } from "../domain.ts";
import type { CheckoutSummary } from "./toolset.ts";

export interface VaultedCard {
  number: string;
  expMonth: string;
  expYear: string;
  cvc: string;
  holder: string;
  brand: string;
}

export interface ShopperProfile {
  buyer: Buyer;
  address: Address;
  card: VaultedCard;
  stripePaymentMethod: string;
}

export function defaultShopper(): ShopperProfile {
  const env = process.env;
  return {
    buyer: { first_name: "Jane", last_name: "Doe", email: "jane.doe@example.com" },
    address: { name: "Jane Doe", line_one: "350 5th Ave", city: "New York", state: "NY", country: "US", postal_code: "10118" },
    card: {
      number: env.AGENT_TEST_CARD || "4111111111111111",
      expMonth: env.AGENT_TEST_CARD_EXP_MONTH || "03",
      expYear: env.AGENT_TEST_CARD_EXP_YEAR || "2030",
      cvc: env.AGENT_TEST_CARD_CVC || "737",
      holder: "Jane Doe",
      brand: "visa",
    },
    stripePaymentMethod: env.AGENT_STRIPE_PAYMENT_METHOD || "pm_card_visa",
  };
}

export function describeForApproval(s: CheckoutSummary, paymentLabel: string): string {
  const lines = s.line_items.map((li) => `  ${li.quantity} × ${li.title}  ${formatAmount(li.subtotal, s.currency)}`);
  const ship = s.fulfillment_options.find((o) => o.id === s.selected_fulfillment_option_id);
  return [
    ...lines,
    `  ${ship?.title ?? "Shipping"}  ${formatAmount(s.totals.fulfillment ?? 0, s.currency)}`,
    `  Tax  ${formatAmount(s.totals.tax ?? 0, s.currency)}`,
    `  Total  ${formatAmount(s.totals.total ?? 0, s.currency)}  (${paymentLabel})`,
  ].join("\n");
}
