import type http from "node:http";
import { MERCHANT_PORT, MOCK_PORT, MOCK_STRIPE_PORT, config } from "./config.ts";
import { Merchant } from "./merchant/server.ts";
import { MockAdyen } from "./mock-adyen/server.ts";
import { MockStripe } from "./mock-stripe/server.ts";

export function providerLabel(): string {
  return config.protocol === "stripe"
    ? `stripe ${config.stripe.mode}`
    : `adyen ${config.mode}${config.protocol === "acp" ? `, merchant flow ${config.merchantFlow}` : ""}`;
}

export async function startBackends(): Promise<http.Server[]> {
  const servers: http.Server[] = [];
  const stripe = config.protocol === "stripe";
  if (stripe && config.stripe.mode === "mock") servers.push(await new MockStripe().listen(MOCK_STRIPE_PORT));
  if (!stripe && config.mode === "mock") servers.push(await new MockAdyen().listen(MOCK_PORT));
  servers.push(await new Merchant().listen(MERCHANT_PORT));
  return servers;
}
