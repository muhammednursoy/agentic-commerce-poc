import { config } from "../config.ts";
import { callJson } from "../http.ts";
import type { Json } from "../http.ts";

export interface PaymentResult {
  pspReference?: string;
  resultCode: string;
  refusalReason?: string;
  action?: Json;
}

export async function makePayment(body: Record<string, unknown>, idempotencyKey: string): Promise<PaymentResult> {
  const res = await callJson("POST", `${config.checkoutBase}/payments`, {
    label: "merchant→adyen",
    headers: { "x-api-key": config.checkoutApiKey, "idempotency-key": idempotencyKey },
    body: { merchantAccount: config.merchantAccount, ...body },
  });
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
