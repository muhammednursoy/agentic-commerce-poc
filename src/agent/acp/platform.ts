import { createHash, randomUUID } from "node:crypto";
import { config } from "../../config.ts";
import { callJson } from "../../http.ts";
import type { CallResult } from "../../http.ts";
import { sessionTotal } from "../../acp.ts";
import type { CheckoutSession, PaymentData } from "../../acp.ts";
import type { Item, Product } from "../../domain.ts";
import { defaultShopper } from "../shopper.ts";
import type { ShopperProfile } from "../shopper.ts";
import type { Confirm, PaymentAuthority } from "../toolset.ts";

export class AcpApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(operation: string, result: CallResult) {
    super(`${operation} failed with HTTP ${result.status}: ${JSON.stringify(result.body)}`);
    this.status = result.status;
    this.body = result.body;
  }
}

export interface AcpEndpoint {
  provider: "adyen" | "stripe";
  sessionsUrl: string;
  apiKey: string;
  label: string;
}

export function adyenCommerceSuite(): AcpEndpoint {
  return {
    provider: "adyen",
    sessionsUrl: `${config.commerceSuiteBase}/${encodeURIComponent(config.companyAccount)}/checkout_sessions`,
    apiKey: config.commerceSuiteApiKey,
    label: "agent→adyen acp",
  };
}

export function merchantHostedAcp(): AcpEndpoint {
  return { provider: "stripe", sessionsUrl: `${config.merchantUrl}/acp/checkout_sessions`, apiKey: config.merchantAcpApiKey, label: "agent→merchant acp" };
}

export class AdyenDelegatedCard implements PaymentAuthority {
  readonly provider = "adyen";
  private readonly platform: AgentPlatform;

  constructor(platform: AgentPlatform) {
    this.platform = platform;
  }

  paymentLabel(): string {
    return `card •••• ${this.platform.shopper.card.number.slice(-4)}`;
  }

  async authorize(session: CheckoutSession, summary: string, confirm: Confirm): Promise<PaymentData | undefined> {
    if (!(await confirm(summary))) return undefined;
    return { provider: "adyen", token: await this.platform.delegatePayment(session) };
  }
}

export class AgentPlatform {
  readonly shopper: ShopperProfile;
  readonly endpoint: AcpEndpoint;
  readonly payer: PaymentAuthority;

  constructor(shopper: ShopperProfile = defaultShopper(), endpoint: AcpEndpoint = adyenCommerceSuite(), payer?: PaymentAuthority) {
    this.shopper = shopper;
    this.endpoint = endpoint;
    if (!payer && endpoint.provider !== "adyen") throw new Error(`a ${endpoint.provider} checkout needs a payment authority (the agent platform)`);
    this.payer = payer ?? new AdyenDelegatedCard(this);
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

  completeSession(id: string, payment: PaymentData | string): Promise<CheckoutSession> {
    const paymentData = typeof payment === "string" ? { provider: this.endpoint.provider, token: payment } : payment;
    return this.commerce("POST", `/${id}/complete`, "complete_checkout_session", {
      payment_data: paymentData,
      buyer: this.shopper.buyer,
    }, { "idempotency-key": `complete-${id}-${createHash("sha256").update(JSON.stringify(paymentData)).digest("hex").slice(0, 16)}` });
  }

  async delegatePayment(session: CheckoutSession, ttlMinutes = 15): Promise<string> {
    if (this.endpoint.provider !== "adyen") throw new Error("delegate_payment is the Adyen ACP path; merchant-hosted checkouts are paid through the agent platform");
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
    if (res.status !== 200 && res.status !== 201) throw new AcpApiError("delegate_payment", res);
    return res.body.id;
  }

  private async commerce(method: string, suffix: string, operation: string, body?: unknown, headers: Record<string, string> = {}): Promise<CheckoutSession> {
    const res = await callJson(method, `${this.endpoint.sessionsUrl}${suffix}`, {
      label: this.endpoint.label,
      headers: { authorization: `Bearer ${this.endpoint.apiKey}`, ...headers },
      body,
    });
    if (res.status !== 200 && res.status !== 201) throw new AcpApiError(operation, res);
    return res.body;
  }
}
