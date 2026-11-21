import type { JSONWebKeySet } from "jose";
import { config } from "../config.ts";
import { callJson } from "../http.ts";
import { sessionTotal } from "../acp.ts";
import type { CheckoutSession } from "../acp.ts";
import {
  IntentVerificationError,
  JWKS_PATH,
  REGISTRATIONS_PATH,
  generateSigningKey,
  jwksOf,
  signCheckoutJwt,
  verifyCheckoutJwt,
  verifyImmediateL2,
  verifyL1,
} from "../vi/credentials.ts";
import type { CheckoutClaims, Payee, SigningKey } from "../vi/credentials.ts";
import { retrieveSharedPaymentToken } from "./stripe-payments.ts";

export interface VerifiedIntent {
  checkoutHash: string;
  intentId: string;
  nonce: string;
}

export interface IntentOptions {
  trustedIssuers?: Record<string, string>;
  agentPlatforms?: string[];
  networkUrl?: string;
}

function reject(message: string): never {
  throw new IntentVerificationError(message);
}

export class MerchantIntents {
  readonly merchant: Payee = config.vi.merchant;
  private readonly key: SigningKey = generateSigningKey("merchant");
  private readonly usedNonces = new Set<string>();
  private readonly trustedIssuers: Record<string, string>;
  private readonly agentPlatforms: string[];
  private readonly networkUrl: string;

  constructor(options: IntentOptions = {}) {
    this.trustedIssuers = options.trustedIssuers ?? { [config.vi.mastercardUrl]: `${config.vi.mastercardUrl}${JWKS_PATH}` };
    this.agentPlatforms = options.agentPlatforms ?? [config.vi.agentPlatformId];
    this.networkUrl = options.networkUrl ?? config.vi.mastercardUrl;
  }

  jwks(): JSONWebKeySet {
    return jwksOf(this.key);
  }

  issueCheckoutJwt(session: CheckoutSession): Promise<string> {
    const amount = (type: string) => session.totals.find((t) => t.type === type)?.amount ?? 0;
    const option = session.fulfillment_options.find((o) => o.id === session.fulfillment_option_id);
    const claims: Omit<CheckoutClaims, "iat" | "exp" | "jti"> = {
      iss: this.merchant.website,
      sub: session.id,
      merchant: this.merchant,
      checkout_session_id: session.id,
      currency: session.currency,
      line_items: session.line_items.map((li) => ({
        sku: li.item.id,
        title: li.title,
        quantity: li.item.quantity,
        unit_price: Math.round(li.base_amount / li.item.quantity),
        subtotal: li.subtotal,
        tax: li.tax,
        total: li.total,
      })),
      fulfillment: option ? { option_id: option.id, title: option.title, amount: option.total, ...(session.fulfillment_address ? { address: session.fulfillment_address } : {}) } : null,
      subtotal: amount("subtotal"),
      tax: amount("tax"),
      total: sessionTotal(session),
    };
    return signCheckoutJwt(this.key, claims);
  }

  async verify(vi: { l1: string; l2: string; intent_id: string }, token: string, session: CheckoutSession, latestCheckoutJwt: string | undefined): Promise<VerifiedIntent> {
    const holder = await verifyL1(vi.l1, (iss) => this.issuerJwks(iss));
    const intent = await verifyImmediateL2(vi.l2, vi.l1, holder, { audiences: this.agentPlatforms, require: ["checkout", "payment"] });
    const checkout = intent.checkout!;
    const payment = intent.payment!;
    if (!latestCheckoutJwt || checkout.checkout_jwt !== latestCheckoutJwt) reject("the signed checkout_jwt is not the latest checkout this merchant issued for this session");
    const claims = await verifyCheckoutJwt(checkout.checkout_jwt, this.jwks(), this.merchant.website);
    if (claims.checkout_session_id !== session.id) reject("the signed checkout belongs to another session");
    const total = sessionTotal(session);
    if (payment.payment_amount.amount !== claims.total || claims.total !== total || payment.payment_amount.currency.toUpperCase() !== session.currency) {
      reject(`payment_amount ${payment.payment_amount.amount} ${payment.payment_amount.currency} does not equal the checkout total ${total} ${session.currency}`);
    }
    if (payment.payee.id !== this.merchant.id) reject(`payee ${payment.payee.id ?? payment.payee.name} is not this merchant`);
    if (this.usedNonces.has(intent.nonce)) reject("this L2 nonce was already used");
    await this.confirmWithNetwork(vi.intent_id, checkout.checkout_hash, intent.nonce, total, session.currency);
    await this.confirmTokenBinding(token, vi.intent_id, checkout.checkout_hash);
    return { checkoutHash: checkout.checkout_hash, intentId: vi.intent_id, nonce: intent.nonce };
  }

  consumeNonce(nonce: string): boolean {
    if (this.usedNonces.has(nonce)) return false;
    this.usedNonces.add(nonce);
    return true;
  }

  private async confirmWithNetwork(intentId: string, checkoutHash: string, nonce: string, total: number, currency: string): Promise<void> {
    const res = await callJson("GET", `${this.networkUrl}${REGISTRATIONS_PATH}/${encodeURIComponent(intentId)}`, { label: "merchant→mastercard (mock)" }).catch(() => undefined);
    const r = res?.status === 200 ? res.body : undefined;
    if (!r) reject(`the card network does not know intent ${intentId}`);
    if (r.transaction_id !== checkoutHash || r.nonce !== nonce || r.payment_amount?.amount !== total || r.payment_amount?.currency?.toUpperCase() !== currency || r.payee?.id !== this.merchant.id) {
      reject("the intent registered with the card network is for a different checkout, amount or payee");
    }
  }

  private async confirmTokenBinding(token: string, intentId: string, checkoutHash: string): Promise<void> {
    const spt = await retrieveSharedPaymentToken(token);
    if (!spt) reject("the Shared Payment Token could not be retrieved from Stripe");
    if (spt.shared_metadata?.vi_intent_id !== intentId || spt.shared_metadata?.vi_checkout_hash !== checkoutHash) {
      reject("the Shared Payment Token was not granted for this intent (shared_metadata mismatch)");
    }
  }

  private async issuerJwks(iss: string): Promise<JSONWebKeySet | undefined> {
    const url = this.trustedIssuers[iss];
    if (!url) return undefined;
    const res = await callJson("GET", url, { label: "merchant→issuer jwks" }).catch(() => undefined);
    if (res?.status !== 200 || !Array.isArray(res.body?.keys)) reject(`issuer JWKS ${url} unavailable`);
    return res.body;
  }
}
