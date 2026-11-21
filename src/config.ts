const env = process.env;

export const MOCK_PORT = Number(env.MOCK_ADYEN_PORT || 8080);
export const MERCHANT_PORT = Number(env.MERCHANT_PORT || 8081);

function oneOf<T extends string>(name: string, allowed: readonly T[]): T {
  const value = env[name] || allowed[0];
  if (!(allowed as readonly string[]).includes(value)) throw new Error(`${name}=${value} is not one of ${allowed.join(", ")}`);
  return value as T;
}

const mode = oneOf("ADYEN_MODE", ["mock", "test"]);
const mockBase = `http://localhost:${MOCK_PORT}`;
const mockOnly = (value: string) => (mode === "mock" ? value : "");
if (mode === "test" && !env.ADYEN_CHECKOUT_API_KEY) throw new Error("ADYEN_MODE=test needs ADYEN_CHECKOUT_API_KEY");

export const MOCK_STRIPE_PORT = Number(env.MOCK_STRIPE_PORT || 8082);
export const MOCK_STRIPE_KEY = "sk_test_mock";
const stripeKey = env.STRIPE_SECRET_KEY || "";
if (stripeKey.startsWith("sk_live_")) throw new Error("STRIPE_SECRET_KEY is a live key; live Shared Payment Tokens must come from a real agent platform, so this POC refuses to start");
if (stripeKey && !stripeKey.startsWith("sk_test_")) throw new Error("STRIPE_SECRET_KEY must be a secret test key (sk_test_...)");
const stripeMode = stripeKey ? "test" : "mock";

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
  commerceSuiteApiKey: env.ADYEN_COMMERCE_SUITE_API_KEY || mockOnly("mock_commerce_suite_key"),
  agenticToken: env.ADYEN_AGENTIC_TOKEN || mockOnly("mock_agentic_token"),
  checkoutApiKey: env.ADYEN_CHECKOUT_API_KEY || "mock_checkout_key",
  delegatePaymentApiVersion: "2025-09-29",
  merchantUrl: env.MERCHANT_URL || `http://localhost:${MERCHANT_PORT}`,
  merchantFlow: oneOf("MERCHANT_FLOW", ["advanced", "standard"]),
  merchantHookSecret: env.MERCHANT_HOOK_SECRET || mockOnly("mock_merchant_hook_secret"),
  webhookHmacKey: env.ADYEN_HMAC_KEY || mockOnly("44782DEF547AAA06C910C43932B1EB0C71FC68D9D0C057550C48EC2ACF6BA056"),
  webhookInsecure: env.ADYEN_WEBHOOK_INSECURE === "1",
  googlePayMerchantId: env.GOOGLE_PAY_MERCHANT_ID || "BCR2DN4TEST000000",
  googlePayToken: env.GOOGLE_PAY_TOKEN || "",
  protocol: oneOf("PROTOCOL", ["ucp", "acp", "stripe"]),
  merchantAcpApiKey: env.MERCHANT_ACP_API_KEY || "mock_merchant_acp_key",
  stripe: {
    mode: stripeMode,
    secretKey: stripeKey || MOCK_STRIPE_KEY,
    apiBase: env.STRIPE_API_BASE || (stripeMode === "test" ? "https://api.stripe.com" : `http://localhost:${MOCK_STRIPE_PORT}`),
    apiVersion: "2026-09-30.preview",
    timeoutMs: Number(env.STRIPE_TIMEOUT_MS || 15_000),
  },
} as const;

export function tracing(): boolean {
  return process.env.TRACE !== "0";
}

export type MerchantFlow = "standard" | "advanced";
