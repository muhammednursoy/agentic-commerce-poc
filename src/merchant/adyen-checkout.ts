import { config } from "../config.ts";
import { callJson } from "../http.ts";
import type { CallResult, Json } from "../http.ts";

export interface PaymentResult {
  pspReference?: string;
  resultCode: string;
  refusalReason?: string;
  action?: Json;
}

export const UNKNOWN_OUTCOME = "Unknown";

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
    return { resultCode: UNKNOWN_OUTCOME, refusalReason: err instanceof Error ? err.message : String(err) };
  }
  if (res.status >= 500 || (res.status === 422 && res.body?.errorCode === "704")) {
    return { resultCode: UNKNOWN_OUTCOME, refusalReason: res.body?.message ?? `HTTP ${res.status}` };
  }
  if (res.status !== 200) {
    return { resultCode: "Error", refusalReason: res.body?.message ?? `HTTP ${res.status}` };
  }
  return {
    pspReference: res.body.pspReference,
    resultCode: res.body.resultCode,
    refusalReason: res.body.refusalReason,
    action: res.body.action,
  };
}
