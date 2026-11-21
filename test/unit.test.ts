import { test } from "node:test";
import assert from "node:assert/strict";
import { assertAddsUp } from "./helpers.ts";

process.env.TRACE = "0";
for (const name of ["ADYEN_MODE", "MERCHANT_FLOW", "PROTOCOL", "ADYEN_CHECKOUT_API_KEY", "ADYEN_HMAC_KEY", "MERCHANT_HOOK_SECRET"]) delete process.env[name];

const { isValidNotification, signNotification } = await import("../src/adyen-hmac.ts");
const { describeForApproval } = await import("../src/agent/shopper.ts");

const freshConfig = (tag: string) => import(new URL(`../src/config.ts?${tag}`, import.meta.url).href);

test("HMAC: a fixed notification signs to the value computed independently with openssl", () => {
  const key = "44782DEF547AAA06C910C43932B1EB0C71FC68D9D0C057550C48EC2ACF6BA056";
  const authorisation = {
    pspReference: "7914073381342284",
    merchantAccountCode: "TestMerchant",
    merchantReference: "TestPayment-1407325143704",
    amount: { value: 1130, currency: "EUR" },
    eventCode: "AUTHORISATION",
    success: "true" as const,
  };
  assert.equal(signNotification(authorisation, key), "coqCmt/IZ4E3CzPvMY8zTjQVL5hYJUiBRg8UU+iCWo0=");
  const refund = {
    ...authorisation,
    pspReference: "8815000000000001",
    originalReference: "7914073381342284",
    amount: { value: 500, currency: "EUR" },
    eventCode: "REFUND",
    success: "false" as const,
  };
  assert.equal(signNotification(refund, key), "UP2qazLfqhtRMhG8je76vuIIJ4FmJ+tzEuzImskEceo=");
  assert.ok(isValidNotification({ ...refund, additionalData: { hmacSignature: "UP2qazLfqhtRMhG8je76vuIIJ4FmJ+tzEuzImskEceo=" } }, key));
  assert.ok(!isValidNotification({ ...refund, amount: { value: 501, currency: "EUR" }, additionalData: { hmacSignature: "UP2qazLfqhtRMhG8je76vuIIJ4FmJ+tzEuzImskEceo=" } }, key));
});

test("config: unknown ADYEN_MODE, MERCHANT_FLOW and PROTOCOL values fail at startup", async () => {
  for (const [name, value] of [["ADYEN_MODE", "TEST"], ["MERCHANT_FLOW", "basic"], ["PROTOCOL", "ap2"]]) {
    process.env[name] = value;
    try {
      await assert.rejects(freshConfig(`bad-${name}`), new RegExp(`${name}=${value} is not one of`));
    } finally {
      delete process.env[name];
    }
  }
});

test("config: ADYEN_MODE=test needs a checkout API key and never falls back to mock credentials", async () => {
  process.env.ADYEN_MODE = "test";
  try {
    await assert.rejects(freshConfig("test-no-key"), /ADYEN_CHECKOUT_API_KEY/);
    process.env.ADYEN_CHECKOUT_API_KEY = "test_key";
    const { config } = await freshConfig("test-with-key");
    assert.equal(config.checkoutApiKey, "test_key");
    assert.deepEqual([config.commerceSuiteApiKey, config.agenticToken, config.merchantHookSecret, config.webhookHmacKey], ["", "", "", ""]);
  } finally {
    delete process.env.ADYEN_MODE;
    delete process.env.ADYEN_CHECKOUT_API_KEY;
  }
});

test("approval text: line amounts, shipping and tax add up to the total", () => {
  const text = describeForApproval({
    id: "chk_1",
    status: "ready_for_complete",
    ready: true,
    currency: "USD",
    line_items: [
      { product_id: "sku_coffee_beans", title: "Coffee beans", quantity: 2, subtotal: 5798, total: 6313 },
      { product_id: "sku_filters", title: "Paper filters", quantity: 1, subtotal: 699, total: 761 },
    ],
    fulfillment_options: [{ id: "ship_standard", title: "Standard shipping", subtitle: "", total: 599 }],
    selected_fulfillment_option_id: "ship_standard",
    totals: { subtotal: 6497, fulfillment: 599, tax: 577, total: 7673 },
    messages: [],
  }, "VISA •••• 1111");
  assert.match(text, /2 × Coffee beans {2}\$57\.98/);
  assert.match(text, /Total {2}\$76\.73/);
  assertAddsUp(text);
});
