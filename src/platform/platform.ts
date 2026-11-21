import { config } from "../config.ts";
import { callJson } from "../http.ts";
import { sessionTotal } from "../acp.ts";
import type { CheckoutSession, PaymentData } from "../acp.ts";
import { stripeCall } from "../stripe-api.ts";
import type { Confirm, PaymentAuthority } from "../agent/toolset.ts";
import { ENROLMENT_PATH, JWKS_PATH, REGISTRATIONS_PATH, createImmediateL2, generateSigningKey, presentL2, verifyCheckoutJwt } from "../vi/credentials.ts";
import type { CheckoutClaims, SigningKey, VerifiablePresentation } from "../vi/credentials.ts";

export const VI_APPROVAL_LINE = "Your agent platform signs this exact cart (Mastercard Verifiable Intent)";

const TEST_CARDS: Record<string, { brand: string; scheme: string; last4: string }> = {
  pm_card_visa: { brand: "Visa", scheme: "visa", last4: "4242" },
  pm_card_mastercard: { brand: "Mastercard", scheme: "mastercard", last4: "4444" },
  pm_card_chargeDeclined: { brand: "Visa", scheme: "visa", last4: "0002" },
  pm_card_authenticationRequired: { brand: "Visa", scheme: "visa", last4: "3184" },
};

export interface SharedTokenLimits {
  paymentMethod: string;
  currency: string;
  maxAmount: number;
  expiresAt: number;
  sharedMetadata?: Record<string, string>;
}

export async function grantSharedPaymentToken(limits: SharedTokenLimits): Promise<string> {
  const res = await stripeCall("POST", "/v1/test_helpers/shared_payment/granted_tokens", {
    label: "agent platform→stripe test helper",
    form: {
      payment_method: limits.paymentMethod,
      "usage_limits[currency]": limits.currency.toLowerCase(),
      "usage_limits[max_amount]": String(limits.maxAmount),
      "usage_limits[expires_at]": String(limits.expiresAt),
      ...Object.fromEntries(Object.entries(limits.sharedMetadata ?? {}).map(([k, v]) => [`shared_metadata[${k}]`, v])),
    },
  });
  if (res.status !== 200 || typeof res.body?.id !== "string") {
    throw new Error(`grant_shared_payment_token failed with HTTP ${res.status}: ${res.body?.error?.message ?? "no reason given"}`);
  }
  return res.body.id;
}

export interface PlatformOptions {
  paymentMethod?: string;
  email?: string;
  platformId?: string;
  mastercardUrl?: string;
  merchantJwksUrl?: string;
  merchantIssuer?: string;
  tokenTtlMinutes?: number;
}

export interface PreparedIntent {
  presentation: VerifiablePresentation;
  checkoutHash: string;
  amount: number;
  currency: string;
}

interface Wallet {
  key: SigningKey;
  l1: string;
}

export class AgentPaymentPlatform implements PaymentAuthority {
  readonly provider = "stripe";
  paymentMethod: string;
  private readonly email: string;
  private readonly platformId: string;
  private readonly mastercardUrl: string;
  private readonly merchantJwksUrl: string;
  private readonly merchantIssuer: string;
  private readonly tokenTtlMinutes: number;
  private wallet?: Promise<Wallet>;

  constructor(options: PlatformOptions = {}) {
    this.paymentMethod = options.paymentMethod ?? process.env.AGENT_STRIPE_PAYMENT_METHOD ?? "pm_card_visa";
    this.email = options.email ?? "jane.doe@example.com";
    this.platformId = options.platformId ?? config.vi.agentPlatformId;
    this.mastercardUrl = options.mastercardUrl ?? config.vi.mastercardUrl;
    this.merchantJwksUrl = options.merchantJwksUrl ?? `${config.merchantUrl}${JWKS_PATH}`;
    this.merchantIssuer = options.merchantIssuer ?? config.vi.merchant.website;
    this.tokenTtlMinutes = options.tokenTtlMinutes ?? 15;
  }

  paymentLabel(): string {
    const card = TEST_CARDS[this.paymentMethod];
    return card ? `${card.brand} •••• ${card.last4} via Stripe` : "card via Stripe";
  }

  async authorize(session: CheckoutSession, summary: string, confirm: Confirm): Promise<PaymentData | undefined> {
    const checkout = await this.verifyCheckout(session);
    if (!(await confirm(`${summary}\n  ${VI_APPROVAL_LINE}`))) return undefined;
    const intent = await this.signIntent(checkout);
    return { provider: "stripe", token: await this.grantToken(intent), verifiable_intent: intent.presentation };
  }

  async prepare(session: CheckoutSession): Promise<PreparedIntent> {
    return this.signIntent(await this.verifyCheckout(session));
  }

  grantToken(intent: PreparedIntent, overrides: Partial<Omit<SharedTokenLimits, "currency">> = {}): Promise<string> {
    return grantSharedPaymentToken({
      paymentMethod: this.paymentMethod,
      currency: intent.currency,
      maxAmount: intent.amount,
      expiresAt: Math.floor(Date.now() / 1000) + this.tokenTtlMinutes * 60,
      sharedMetadata: { vi_checkout_hash: intent.checkoutHash, vi_intent_id: intent.presentation.intent_id },
      ...overrides,
    });
  }

  private async verifyCheckout(session: CheckoutSession): Promise<{ jwt: string; claims: CheckoutClaims }> {
    const jwt = session.checkout_jwt;
    if (!jwt) throw new Error("the merchant did not sign this checkout (no checkout_jwt); the platform will not pay for it");
    const jwks = await callJson("GET", this.merchantJwksUrl, { label: "agent platform→merchant jwks" });
    if (jwks.status !== 200 || !Array.isArray(jwks.body?.keys)) throw new Error(`merchant JWKS unavailable (HTTP ${jwks.status})`);
    const claims = await verifyCheckoutJwt(jwt, jwks.body, this.merchantIssuer);
    const total = (type: string) => session.totals.find((t) => t.type === type)?.amount ?? 0;
    const sameLines = claims.line_items.length === session.line_items.length
      && session.line_items.every((li, i) => claims.line_items[i].sku === li.item.id && claims.line_items[i].quantity === li.item.quantity && claims.line_items[i].subtotal === li.subtotal);
    const matches = claims.checkout_session_id === session.id && claims.currency === session.currency && claims.total === sessionTotal(session)
      && claims.tax === total("tax") && (claims.fulfillment?.amount ?? 0) === total("fulfillment") && sameLines;
    if (!matches) throw new Error("the merchant-signed checkout_jwt does not match the checkout shown to the shopper; the platform will not pay for it");
    return { jwt, claims };
  }

  private async signIntent(checkout: { jwt: string; claims: CheckoutClaims }): Promise<PreparedIntent> {
    const { key, l1 } = await this.enrolled();
    const l2 = await createImmediateL2({
      l1,
      userKey: key,
      aud: this.platformId,
      checkoutJwt: checkout.jwt,
      payment: {
        payment_instrument: { type: "stripe.payment_method", id: this.paymentMethod, description: this.paymentLabel() },
        payment_amount: { currency: checkout.claims.currency, amount: checkout.claims.total },
        payee: checkout.claims.merchant,
      },
    });
    const res = await callJson("POST", `${this.mastercardUrl}${REGISTRATIONS_PATH}`, {
      label: "agent platform→mastercard (mock)",
      body: { l1, l2: presentL2(l2, ["payment"]) },
    });
    if (res.status !== 201 || typeof res.body?.intent_id !== "string") {
      throw new Error(`the card network did not register the intent (HTTP ${res.status}: ${res.body?.message ?? "no reason given"})`);
    }
    return {
      presentation: { l1, l2: l2.serialized, intent_id: res.body.intent_id },
      checkoutHash: l2.checkoutHash,
      amount: checkout.claims.total,
      currency: checkout.claims.currency,
    };
  }

  private enrolled(): Promise<Wallet> {
    this.wallet ??= this.enrol().catch((err) => {
      this.wallet = undefined;
      throw err;
    });
    return this.wallet;
  }

  private async enrol(): Promise<Wallet> {
    const key = generateSigningKey("shopper-device");
    const card = TEST_CARDS[this.paymentMethod] ?? { scheme: "visa", last4: "0000" };
    const res = await callJson("POST", `${this.mastercardUrl}${ENROLMENT_PATH}`, {
      label: "agent platform→mastercard (mock) enrolment",
      body: { cnf_jwk: key.publicJwk, pan_last_four: card.last4, scheme: card.scheme, email: this.email },
    });
    if (res.status !== 201 || typeof res.body?.credential !== "string") throw new Error(`card enrolment with the issuer failed (HTTP ${res.status})`);
    return { key, l1: res.body.credential };
  }
}
