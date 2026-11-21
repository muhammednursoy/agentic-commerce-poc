import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import type http from "node:http";

process.env.MOCK_ADYEN_PORT = "18080";
process.env.MERCHANT_PORT = "18081";
process.env.TRACE = "0";
delete process.env.ADYEN_MODE;
delete process.env.MERCHANT_FLOW;

const { config } = await import("../src/config.ts");
const { callJson } = await import("../src/http.ts");
const { MockAdyen } = await import("../src/mock-adyen/server.ts");
const { Merchant } = await import("../src/merchant/server.ts");
const { AgentPlatform, AdyenApiError, defaultShopper } = await import("../src/agent/platform.ts");
const { AgentTools, systemPrompt } = await import("../src/agent/tools.ts");
const { ScriptedAgent, pickItems } = await import("../src/agent/llm/scripted.ts");
const { sessionTotal } = await import("../src/acp.ts");

let adyen: InstanceType<typeof MockAdyen>;
let merchant: InstanceType<typeof Merchant>;
const servers: http.Server[] = [];

before(async () => {
  adyen = new MockAdyen();
  merchant = new Merchant();
  servers.push(await adyen.listen(18080), await merchant.listen(18081));
});

after(() => servers.forEach((s) => s.close()));

async function readySession(platform = new AgentPlatform(), items = [{ id: "sku_filters", quantity: 2 }]) {
  const created = await platform.createSession(items);
  return platform.updateSession(created.id, { fulfillment_option_id: "ship_standard" });
}

function delegateBody(session: { id: string; currency: string }, overrides: Record<string, unknown> = {}) {
  return {
    payment_method: { type: "card", card_number_type: "fpan", number: "4111111111111111", exp_month: "03", exp_year: "2030", cvc: "737", metadata: {} },
    allowance: {
      reason: "one_time",
      max_amount: 5000,
      currency: session.currency,
      checkout_session_id: session.id,
      merchant_id: config.merchantAccount,
      expires_at: new Date(Date.now() + 600_000).toISOString(),
    },
    billing_address: { name: "Jane Doe", line_one: "350 5th Ave", city: "New York", state: "NY", country: "US", postal_code: "10118" },
    risk_signals: [{ type: "card_testing", score: 0, action: "authorized" }],
    metadata: {},
    ...overrides,
  };
}

function delegate(body: unknown, headers: Record<string, string> = {}) {
  return callJson("POST", `${config.palBase}/agentic_commerce/delegate_payment`, {
    headers: { authorization: `Bearer ${config.agenticToken}`, "api-version": "2025-09-29", ...headers },
    body,
  });
}

function pay(token: string, sessionId: string, value: number) {
  return callJson("POST", `${config.checkoutBase}/payments`, {
    headers: { "x-api-key": config.checkoutApiKey },
    body: {
      merchantAccount: config.merchantAccount,
      amount: { value, currency: "USD" },
      reference: "test",
      shopperReference: sessionId,
      paymentMethod: { type: "scheme", storedPaymentMethodId: token },
      shopperInteraction: "ContAuth",
      recurringProcessingModel: "UnscheduledCardOnFile",
    },
  });
}

describe("checkout session lifecycle", () => {
  test("session is not ready until a shipping option is chosen, then ready_for_payment", async () => {
    const platform = new AgentPlatform();
    const created = await platform.createSession([{ id: "sku_coffee_beans", quantity: 2 }]);
    assert.equal(created.status, "not_ready_for_payment");
    assert.deepEqual(created.fulfillment_options.map((o) => o.id), ["ship_standard", "ship_express"]);
    assert.ok(created.messages.some((m) => m.code === "missing_fulfillment_option"));

    const ready = await platform.updateSession(created.id, { fulfillment_option_id: "ship_express" });
    assert.equal(ready.status, "ready_for_payment");
    const tax = Math.round(2 * 2899 * 0.08875);
    assert.equal(sessionTotal(ready), 2 * 2899 + 1999 + tax);
  });

  test("out of stock item blocks payment", async () => {
    const session = await readySession(new AgentPlatform(), [{ id: "sku_kettle", quantity: 1 }]);
    assert.equal(session.status, "not_ready_for_payment");
    assert.ok(session.messages.some((m) => m.code === "product_out_of_stock"));
  });

  test("non-US destination is unsupported", async () => {
    const shopper = defaultShopper();
    shopper.address = { ...shopper.address, country: "DE", state: undefined, city: "Berlin", postal_code: "10115" };
    const session = await new AgentPlatform(shopper).createSession([{ id: "sku_filters", quantity: 1 }]);
    assert.equal(session.status, "not_ready_for_payment");
    assert.ok(session.messages.some((m) => m.code === "shipping_destination_unsupported"));
  });

  test("commerce suite calls need the API key", async () => {
    const res = await callJson("POST", `${config.commerceSuiteBase}/${config.companyAccount}/checkout_sessions`, {
      headers: { authorization: "Bearer wrong" },
      body: { currency: "USD", items: [{ id: "sku_filters", quantity: 1 }] },
    });
    assert.equal(res.status, 401);
  });

  test("canceled session cannot be completed", async () => {
    const platform = new AgentPlatform();
    const session = await readySession(platform);
    await platform.cancelSession(session.id);
    const token = (await delegate(delegateBody(session))).body.id;
    const result = await platform.completeSession(session.id, token);
    assert.equal(result.status, "canceled");
    assert.equal(result.messages[0].code, "invalid_state");
  });
});

describe("delegate_payment (token vault)", () => {
  test("returns 201 with a token bound to the session", async () => {
    const session = await readySession();
    const res = await delegate(delegateBody(session));
    assert.equal(res.status, 201);
    assert.equal(res.body.metadata.shopperReference, session.id);
    assert.equal(res.body.metadata.merchant_id, config.merchantAccount);
  });

  test("a standard API key is rejected", async () => {
    const res = await delegate(delegateBody({ id: "cs_x", currency: "USD" }), { authorization: `Bearer ${config.commerceSuiteApiKey}` });
    assert.equal(res.status, 401);
  });

  test("missing card number is invalid_card on payment_method.number", async () => {
    const body = delegateBody({ id: "cs_x", currency: "USD" });
    delete (body.payment_method as Record<string, unknown>).number;
    const res = await delegate(body);
    assert.equal(res.status, 400);
    assert.equal(res.body.code, "invalid_card");
    assert.equal(res.body.param, "payment_method.number");
  });

  test("unknown merchant and malformed expiry are rejected", async () => {
    const base = delegateBody({ id: "cs_x", currency: "USD" });
    const badMerchant = await delegate({ ...base, allowance: { ...base.allowance, merchant_id: "Nope" } });
    assert.equal(badMerchant.body.param, "allowance.merchant_id");
    const badExpiry = await delegate({ ...base, allowance: { ...base.allowance, expires_at: "tomorrow" } });
    assert.equal(badExpiry.body.param, "allowance.expires_at");
  });

  test("blocked risk signal prevents tokenization", async () => {
    const res = await delegate(delegateBody({ id: "cs_x", currency: "USD" }, { risk_signals: [{ type: "card_testing", score: 95, action: "blocked" }] }));
    assert.equal(res.status, 400);
    assert.equal(res.body.param, "risk_signals");
  });

  test("idempotency: same body replays, different body conflicts", async () => {
    const body = delegateBody({ id: "cs_idem", currency: "USD" });
    const key = crypto.randomUUID();
    const first = await delegate(body, { "idempotency-key": key });
    const replay = await delegate(body, { "idempotency-key": key });
    assert.equal(replay.status, 201);
    assert.equal(replay.body.id, first.body.id);
    const conflict = await delegate({ ...body, metadata: { changed: true } }, { "idempotency-key": key });
    assert.equal(conflict.status, 400);
    assert.equal(conflict.body.code, "idempotency_conflict");
  });
});

describe("merchant /payments with the ACP token", () => {
  test("authorises within the allowance and the token is single use", async () => {
    const session = await readySession();
    const token = (await delegate(delegateBody(session))).body.id;
    const first = await pay(token, session.id, 1000);
    assert.equal(first.body.resultCode, "Authorised");
    const second = await pay(token, session.id, 1000);
    assert.equal(second.body.resultCode, "Refused");
    assert.equal(second.body.refusalReason, "Token already used");
  });

  test("amount above max_amount is refused", async () => {
    const session = await readySession();
    const token = (await delegate(delegateBody(session))).body.id;
    const res = await pay(token, session.id, 5001);
    assert.equal(res.body.refusalReason, "Amount exceeds allowance max_amount");
  });

  test("token cannot be used for another checkout session", async () => {
    const session = await readySession();
    const token = (await delegate(delegateBody(session))).body.id;
    const res = await pay(token, "cs_test_other", 1000);
    assert.equal(res.body.refusalReason, "Token is bound to another checkout session");
  });
});

describe("agent end to end", () => {
  test("scripted agent completes an order and the merchant records it", async () => {
    const platform = new AgentPlatform();
    const approvals: string[] = [];
    const tools = new AgentTools(platform, async (summary) => {
      approvals.push(summary);
      return true;
    });
    const stockBefore = merchant.catalog.get("sku_coffee_beans")!.stock;
    const reply = await new ScriptedAgent({ tools, system: systemPrompt(platform) }).send("Buy 2 bags of the coffee beans and a pack of paper filters");

    assert.match(reply, /^Order ord_/);
    assert.equal(approvals.length, 1);
    assert.match(approvals[0], /2 × Ethiopia Yirgacheffe/);
    assert.equal(merchant.catalog.get("sku_coffee_beans")!.stock, stockBefore - 2);
    const order = [...merchant.orders.values()].at(-1)!;
    const session = adyen.sessions.get(order.checkoutSessionId)!;
    assert.equal(session.status, "completed");
    assert.equal(session.order?.id, order.id);
    assert.equal(adyen.payments.at(-1)?.amount.value, order.amount);
  });

  test("shopper declining approval creates no token and no order", async () => {
    const platform = new AgentPlatform();
    const tokensBefore = adyen.tokens.size;
    const ordersBefore = merchant.orders.size;
    const tools = new AgentTools(platform, async () => false);
    const reply = await new ScriptedAgent({ tools, system: "" }).send("one pour-over dripper");
    assert.match(reply, /did not place/);
    assert.equal(adyen.tokens.size, tokensBefore);
    assert.equal(merchant.orders.size, ordersBefore);
  });

  test("a declined card leaves the session payable with payment_declined", async () => {
    const shopper = defaultShopper();
    shopper.card = { ...shopper.card, number: "4000000000000002" };
    const platform = new AgentPlatform(shopper);
    const session = await readySession(platform);
    const token = await platform.delegatePayment(session);
    const result = await platform.completeSession(session.id, token);
    assert.equal(result.status, "ready_for_payment");
    assert.equal(result.messages[0].code, "payment_declined");
  });

  test("delegate errors surface as AdyenApiError", async () => {
    const shopper = defaultShopper();
    shopper.card = { ...shopper.card, number: "41" };
    const platform = new AgentPlatform(shopper);
    const session = await readySession(platform);
    await assert.rejects(platform.delegatePayment(session), AdyenApiError);
  });
});

test("pickItems reads quantities from free text", () => {
  const products = [...new Merchant().catalog.values()];
  assert.deepEqual(pickItems("Buy 2 bags of the coffee beans and paper filters", products), [
    { id: "sku_coffee_beans", quantity: 2 },
    { id: "sku_filters", quantity: 1 },
  ]);
});
