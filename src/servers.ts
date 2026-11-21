import { MERCHANT_PORT, MOCK_PORT, MOCK_STRIPE_PORT, config } from "./config.ts";
import { Merchant } from "./merchant/server.ts";
import { MockAdyen } from "./mock-adyen/server.ts";
import { MockStripe } from "./mock-stripe/server.ts";

const stripe = config.protocol === "stripe";
if (stripe && config.stripe.mode === "mock") await new MockStripe().listen(MOCK_STRIPE_PORT);
if (!stripe && config.mode === "mock") await new MockAdyen().listen(MOCK_PORT);
await new Merchant().listen(MERCHANT_PORT);
console.log(stripe ? `stripe mode: ${config.stripe.mode} (${config.stripe.apiBase})` : `adyen mode: ${config.mode}, merchant flow: ${config.merchantFlow}`);
