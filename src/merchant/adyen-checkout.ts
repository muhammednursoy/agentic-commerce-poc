import { config } from "../config.ts";
import { callJson } from "../http.ts";
import type { CallResult } from "../http.ts";
import { UNKNOWN_OUTCOME, transportFailure } from "./payment-outcome.ts";
import type { PaymentResult } from "./payment-outcome.ts";

export async function makePayment(body: Record<string, unknown>, idempotencyKey: string): Promise<PaymentResult> {
  let res: CallResult;
  try {
    res = await callJson("POST", `${config.checkoutBase}/payments`, {
      label: "merchant→adyen",
      headers: { "x-api-key": config.checkoutApiKey, "idempotency-key": idempotencyKey },
      body: { merchantAccount: config.merchantAccount, ...body },
      signal: AbortSignal.timeout(config.checkoutTimeoutMs),
    });
  } catch (err) {
    return transportFailure(err, "Adyen");
  }
  if (res.status >= 500 || (res.status === 422 && res.body?.errorCode === "704")) {
    return { resultCode: UNKNOWN_OUTCOME, refusalReason: res.body?.message ?? `HTTP ${res.status}` };
  }
  if (res.status !== 200) {
    return { resultCode: "Error", refusalReason: res.body?.message ?? `HTTP ${res.status}` };
  }
  if (typeof res.body?.resultCode !== "string") return { resultCode: UNKNOWN_OUTCOME, refusalReason: "unreadable response from Adyen" };
  return {
    pspReference: res.body.pspReference,
    resultCode: res.body.resultCode,
    refusalReason: res.body.refusalReason,
    action: res.body.action,
  };
}

export interface RefundResult {
  pspReference?: string;
  failure?: string;
}

export async function requestRefund(paymentPspReference: string, amount: { value: number; currency: string }, reference: string): Promise<RefundResult> {
  try {
    const res = await callJson("POST", `${config.checkoutBase}/payments/${encodeURIComponent(paymentPspReference)}/refunds`, {
      label: "merchant→adyen",
      headers: { "x-api-key": config.checkoutApiKey, "idempotency-key": `${reference}-refund` },
      body: { merchantAccount: config.merchantAccount, amount, reference },
      signal: AbortSignal.timeout(config.checkoutTimeoutMs),
    });
    if (res.status === 201 && res.body?.status === "received" && res.body.pspReference) return { pspReference: res.body.pspReference };
    return { failure: res.body?.message ?? `HTTP ${res.status}` };
  } catch (err) {
    return { failure: err instanceof Error ? err.message : String(err) };
  }
}
