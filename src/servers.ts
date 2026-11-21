import { MERCHANT_PORT, MOCK_PORT, config } from "./config.ts";
import { Merchant } from "./merchant/server.ts";
import { MockAdyen } from "./mock-adyen/server.ts";

if (config.mode === "mock") await new MockAdyen().listen(MOCK_PORT);
await new Merchant().listen(MERCHANT_PORT);
console.log(`adyen mode: ${config.mode}, merchant flow: ${config.merchantFlow}`);
