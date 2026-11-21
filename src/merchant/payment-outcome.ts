import type { Json } from "../http.ts";

export interface PaymentResult {
  pspReference?: string;
  resultCode: string;
  refusalReason?: string;
  action?: Json;
}

export const UNKNOWN_OUTCOME = "Unknown";
export const CHALLENGE_RESULTS = new Set(["RedirectShopper", "IdentifyShopper", "ChallengeShopper"]);
const NOT_CONNECTED = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);

export function isOutcomeUnknown(resultCode: string): boolean {
  return resultCode === UNKNOWN_OUTCOME || resultCode === "Pending" || resultCode === "Received";
}

export function transportFailure(err: unknown, provider: string): PaymentResult {
  const code = (err as { cause?: { code?: string } }).cause?.code;
  if (code && NOT_CONNECTED.has(code)) return { resultCode: "Error", refusalReason: `${provider} unreachable (${code})` };
  return { resultCode: UNKNOWN_OUTCOME, refusalReason: err instanceof Error ? err.message : String(err) };
}
