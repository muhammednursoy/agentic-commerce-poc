import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { config } from "../../config.ts";
import { encodeMockGooglePayToken } from "../../google-pay-mock.ts";
import type { GooglePayHandler, PaymentInstrument, PostalAddress } from "../../ucp.ts";
import type { Confirm } from "../toolset.ts";
import type { VaultedCard } from "../shopper.ts";

export class GooglePayUnavailable extends Error {}

export class GooglePaySheet {
  private readonly card: VaultedCard;
  private readonly billing: PostalAddress;
  private readonly confirm: Confirm;

  constructor(card: VaultedCard, billing: PostalAddress, confirm: Confirm) {
    this.card = card;
    this.billing = billing;
    this.confirm = confirm;
  }

  async requestPayment(handler: GooglePayHandler, amount: number, currency: string, summary: string): Promise<PaymentInstrument | null> {
    const method = handler.config.allowed_payment_methods.find((m) => m.type === "CARD");
    const tokenization = method?.tokenization_specification;
    if (!method || tokenization?.type !== "PAYMENT_GATEWAY") throw new GooglePayUnavailable("merchant does not accept Google Pay gateway tokens");
    const network = this.card.brand.toUpperCase();
    if (!method.parameters.allowed_card_networks.includes(network)) {
      throw new GooglePayUnavailable(`merchant does not accept ${network} through Google Pay`);
    }
    const merchant = handler.config.merchant_info.merchant_name;
    const approved = await this.confirm(`Google Pay · pay ${merchant}\n${summary}`);
    if (!approved) return null;

    return {
      id: `instr_${randomUUID().slice(0, 8)}`,
      handler_id: handler.id,
      type: "card",
      selected: true,
      display: { brand: this.card.brand, last_digits: this.card.number.slice(-4), description: `${this.card.brand.toUpperCase()} •••• ${this.card.number.slice(-4)}` },
      billing_address: this.billing,
      credential: { type: "PAYMENT_GATEWAY", token: this.token(tokenization.parameters, network, amount, currency) },
    };
  }

  private token(params: { gateway: string; gatewayMerchantId: string }, network: string, amount: number, currency: string): string {
    if (config.mode === "test") {
      const raw = config.googlePayToken;
      if (!raw) throw new GooglePayUnavailable("ADYEN_MODE=test needs GOOGLE_PAY_TOKEN (a token from the Google Pay test environment, raw JSON or @path)");
      return raw.startsWith("@") ? readFileSync(raw.slice(1), "utf8").trim() : raw;
    }
    return encodeMockGooglePayToken({
      gateway: params.gateway,
      gatewayMerchantId: params.gatewayMerchantId,
      network,
      last4: this.card.number.slice(-4),
      authMethod: "PAN_ONLY",
      amount,
      currency,
      messageExpiration: new Date(Date.now() + 5 * 60_000).toISOString(),
    });
  }
}
