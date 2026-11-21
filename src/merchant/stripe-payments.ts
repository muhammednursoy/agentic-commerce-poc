import type { CallResult } from "../http.ts";
import { stripeCall } from "../stripe-api.ts";
import { UNKNOWN_OUTCOME, transportFailure } from "./payment-outcome.ts";
import type { PaymentResult } from "./payment-outcome.ts";

export interface SharedTokenCharge {
  amount: number;
  currency: string;
  token: string;
  metadata: Record<string, string>;
}

export async function chargeSharedPaymentToken(charge: SharedTokenCharge, idempotencyKey: string): Promise<PaymentResult> {
  let res: CallResult;
  try {
    res = await stripeCall("POST", "/v1/payment_intents", {
      label: "merchant→stripe",
      idempotencyKey,
      form: {
        amount: String(charge.amount),
        currency: charge.currency.toLowerCase(),
        confirm: "true",
        "payment_method_data[shared_payment_granted_token]": charge.token,
        ...Object.fromEntries(Object.entries(charge.metadata).map(([k, v]) => [`metadata[${k}]`, v])),
      },
    });
  } catch (err) {
    return transportFailure(err, "Stripe");
  }
  const error = res.body?.error;
  if (res.status >= 500 || res.status === 429) return { resultCode: UNKNOWN_OUTCOME, refusalReason: error?.message ?? `HTTP ${res.status}` };
  if (res.status !== 200) {
    const declined = error?.type === "card_error" || (res.status === 400 && error?.type === "invalid_request_error");
    return { resultCode: declined ? "Refused" : "Error", pspReference: error?.payment_intent?.id, refusalReason: error?.message ?? `HTTP ${res.status}` };
  }
  const intent = res.body;
  switch (intent?.status) {
    case "succeeded":
      return { resultCode: "Authorised", pspReference: intent.id };
    case "requires_action":
      return { resultCode: "RedirectShopper", pspReference: intent.id, action: intent.next_action };
    case "requires_payment_method":
    case "canceled":
      return { resultCode: "Refused", pspReference: intent.id, refusalReason: intent.last_payment_error?.message ?? intent.status };
    case "processing":
      return { resultCode: UNKNOWN_OUTCOME, pspReference: intent.id, refusalReason: "Stripe is still processing the payment" };
    default:
      return { resultCode: UNKNOWN_OUTCOME, refusalReason: "unreadable response from Stripe" };
  }
}

export interface GrantedTokenView {
  id: string;
  shared_metadata?: Record<string, string>;
  usage_limits?: { currency: string; max_amount: number; expires_at: number };
}

export async function retrieveSharedPaymentToken(id: string): Promise<GrantedTokenView | undefined> {
  try {
    const res = await stripeCall("GET", `/v1/shared_payment/granted_tokens/${encodeURIComponent(id)}`, { label: "merchant→stripe" });
    return res.status === 200 && typeof res.body?.id === "string" ? res.body : undefined;
  } catch {
    return undefined;
  }
}

export interface StripeRefund {
  id?: string;
  status?: "succeeded" | "pending" | "failed" | "canceled" | "requires_action";
  failure?: string;
}

export async function refundPaymentIntent(paymentIntentId: string, amount: number, idempotencyKey: string): Promise<StripeRefund> {
  try {
    const res = await stripeCall("POST", "/v1/refunds", {
      label: "merchant→stripe",
      idempotencyKey,
      form: { payment_intent: paymentIntentId, amount: String(amount) },
    });
    if (res.status === 200 && typeof res.body?.id === "string") return { id: res.body.id, status: res.body.status };
    return { failure: res.body?.error?.message ?? `HTTP ${res.status}` };
  } catch (err) {
    return { failure: err instanceof Error ? err.message : String(err) };
  }
}
