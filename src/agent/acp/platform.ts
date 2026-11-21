import { randomUUID } from "node:crypto";
import { config } from "../../config.ts";
import { callJson } from "../../http.ts";
import type { CallResult } from "../../http.ts";
import { sessionTotal } from "../../acp.ts";
import type { CheckoutSession, Item } from "../../acp.ts";
import type { Product } from "../../merchant/server.ts";
import { defaultShopper } from "../shopper.ts";
import type { ShopperProfile } from "../shopper.ts";

export class AdyenApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(operation: string, result: CallResult) {
    super(`${operation} failed with HTTP ${result.status}: ${JSON.stringify(result.body)}`);
    this.status = result.status;
    this.body = result.body;
  }
}

export class AgentPlatform {
  readonly shopper: ShopperProfile;

  constructor(shopper: ShopperProfile = defaultShopper()) {
    this.shopper = shopper;
  }

  async listProducts(): Promise<Product[]> {
    const res = await callJson("GET", `${config.merchantUrl}/products`, { label: "agent→merchant feed" });
    return res.body.products;
  }

  createSession(items: Item[], currency = "USD"): Promise<CheckoutSession> {
    return this.commerce("POST", "", "create_checkout_session", {
      currency,
      items,
      buyer: this.shopper.buyer,
      fulfillment_address: this.shopper.address,
    });
  }

  getSession(id: string): Promise<CheckoutSession> {
    return this.commerce("GET", `/${id}`, "get_checkout_session");
  }

  updateSession(id: string, update: { items?: Item[]; fulfillment_option_id?: string }): Promise<CheckoutSession> {
    return this.commerce("POST", `/${id}`, "update_checkout_session", update);
  }

  cancelSession(id: string): Promise<CheckoutSession> {
    return this.commerce("POST", `/${id}/cancel`, "cancel_checkout_session");
  }

  completeSession(id: string, token: string): Promise<CheckoutSession> {
    return this.commerce("POST", `/${id}/complete`, "complete_checkout_session", {
      payment_data: { provider: "adyen", token },
      buyer: this.shopper.buyer,
    });
  }

  async delegatePayment(session: CheckoutSession, ttlMinutes = 15): Promise<string> {
    const card = this.shopper.card;
    const address = this.shopper.address;
    const res = await callJson("POST", `${config.palBase}/agentic_commerce/delegate_payment`, {
      label: "agent→adyen pal",
      headers: {
        authorization: `Bearer ${config.agenticToken}`,
        "api-version": config.delegatePaymentApiVersion,
        "idempotency-key": randomUUID(),
        "request-id": randomUUID(),
        timestamp: new Date().toISOString(),
        "accept-language": "en-US",
        "user-agent": "adyen-acp-poc/0.1",
      },
      body: {
        payment_method: {
          type: "card",
          card_number_type: "fpan",
          number: card.number,
          exp_month: card.expMonth,
          exp_year: card.expYear,
          cvc: card.cvc,
          name: card.holder,
          display_brand: card.brand,
          display_last4: card.number.slice(-4),
          display_card_funding_type: "credit",
          checks_performed: ["cvv"],
          metadata: {},
        },
        allowance: {
          reason: "one_time",
          max_amount: sessionTotal(session),
          currency: session.currency,
          checkout_session_id: session.id,
          merchant_id: config.merchantAccount,
          expires_at: new Date(Date.now() + ttlMinutes * 60_000).toISOString(),
        },
        billing_address: {
          name: address.name ?? card.holder,
          line_one: address.line_one,
          city: address.city,
          state: address.state,
          country: address.country,
          postal_code: address.postal_code,
        },
        risk_signals: [{ type: "card_testing", score: 0, action: "authorized" }],
        metadata: {},
      },
    });
    if (res.status !== 200 && res.status !== 201) throw new AdyenApiError("delegate_payment", res);
    return res.body.id;
  }

  private async commerce(method: string, suffix: string, operation: string, body?: unknown): Promise<CheckoutSession> {
    const url = `${config.commerceSuiteBase}/${encodeURIComponent(config.companyAccount)}/checkout_sessions${suffix}`;
    const res = await callJson(method, url, {
      label: "agent→adyen acp",
      headers: { authorization: `Bearer ${config.commerceSuiteApiKey}` },
      body,
    });
    if (res.status !== 200 && res.status !== 201) throw new AdyenApiError(operation, res);
    return res.body;
  }
}
