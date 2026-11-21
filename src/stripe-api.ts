import { config } from "./config.ts";
import { callJson } from "./http.ts";
import type { CallResult } from "./http.ts";

export function stripeAuthorization(secretKey: string = config.stripe.secretKey): string {
  return `Basic ${Buffer.from(`${secretKey}:`).toString("base64")}`;
}

export function stripeCall(
  method: "GET" | "POST",
  path: string,
  options: { form?: Record<string, string>; idempotencyKey?: string; label: string },
): Promise<CallResult> {
  return callJson(method, `${config.stripe.apiBase}${path}`, {
    label: options.label,
    headers: {
      authorization: stripeAuthorization(),
      "stripe-version": config.stripe.apiVersion,
      ...(options.idempotencyKey ? { "idempotency-key": options.idempotencyKey } : {}),
    },
    form: options.form,
    signal: AbortSignal.timeout(config.stripe.timeoutMs),
  });
}

export function dashboardPaymentUrl(paymentIntentId: string): string {
  return `https://dashboard.stripe.com/test/payments/${paymentIntentId}`;
}
