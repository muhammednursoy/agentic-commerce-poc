const env = process.env;

export const MOCK_PORT = Number(env.MOCK_ADYEN_PORT || 8080);
export const MERCHANT_PORT = Number(env.MERCHANT_PORT || 8081);

const mode = env.ADYEN_MODE === "test" ? "test" : "mock";
const mockBase = `http://localhost:${MOCK_PORT}`;

export const config = {
  mode,
  companyAccount: env.ADYEN_COMPANY_ACCOUNT || "PocCompany",
  merchantAccount: env.ADYEN_MERCHANT_ACCOUNT || "PocMerchantECOM",
  commerceSuiteBase:
    env.ADYEN_COMMERCE_SUITE_BASE ||
    (mode === "test"
      ? "https://commerce-suite-test.adyen.com/commerce-suite/acp/v1"
      : `${mockBase}/commerce-suite/acp/v1`),
  palBase:
    env.ADYEN_PAL_BASE ||
    (mode === "test"
      ? "https://pal-test.adyen.com/paltokenization/servlet/Recurring/Agentic/acp/v1"
      : `${mockBase}/paltokenization/servlet/Recurring/Agentic/acp/v1`),
  checkoutBase:
    env.ADYEN_CHECKOUT_BASE ||
    (mode === "test" ? "https://checkout-test.adyen.com/v72" : `${mockBase}/v72`),
  checkoutTimeoutMs: Number(env.ADYEN_CHECKOUT_TIMEOUT_MS || 15_000),
  commerceSuiteApiKey: env.ADYEN_COMMERCE_SUITE_API_KEY || "mock_commerce_suite_key",
  agenticToken: env.ADYEN_AGENTIC_TOKEN || "mock_agentic_token",
  checkoutApiKey: env.ADYEN_CHECKOUT_API_KEY || "mock_checkout_key",
  delegatePaymentApiVersion: "2025-09-29",
  merchantUrl: env.MERCHANT_URL || `http://localhost:${MERCHANT_PORT}`,
  merchantFlow: env.MERCHANT_FLOW === "standard" ? "standard" : "advanced",
  merchantHookSecret: env.MERCHANT_HOOK_SECRET || (mode === "mock" ? "mock_merchant_hook_secret" : ""),
  webhookHmacKey: env.ADYEN_HMAC_KEY || (mode === "mock" ? "44782DEF547AAA06C910C43932B1EB0C71FC68D9D0C057550C48EC2ACF6BA056" : ""),
  webhookInsecure: env.ADYEN_WEBHOOK_INSECURE === "1",
  googlePayMerchantId: env.GOOGLE_PAY_MERCHANT_ID || "BCR2DN4TEST000000",
  googlePayToken: env.GOOGLE_PAY_TOKEN || "",
  protocol: env.PROTOCOL === "acp" ? "acp" : "ucp",
} as const;

export function tracing(): boolean {
  return process.env.TRACE !== "0";
}

export type MerchantFlow = "standard" | "advanced";
