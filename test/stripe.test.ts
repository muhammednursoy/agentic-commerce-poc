import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import type http from "node:http";
import { assertAddsUp } from "./helpers.ts";

process.env.MERCHANT_PORT = "19181";
process.env.MOCK_STRIPE_PORT = "19182";
process.env.STRIPE_API_BASE = "http://localhost:19182";
process.env.PROTOCOL = "stripe";
process.env.TRACE = "0";
delete process.env.STRIPE_SECRET_KEY;
delete process.env.MERCHANT_ACP_API_KEY;
delete process.env.AGENT_STRIPE_PAYMENT_METHOD;

const { config } = await import("../src/config.ts");
const { callJson, redact } = await import("../src/http.ts");
const { MockStripe } = await import("../src/mock-stripe/server.ts");
const { Merchant } = await import("../src/merchant/server.ts");
const { AgentPlatform, grantSharedPaymentToken, merchantHostedAcp } = await import("../src/agent/acp/platform.ts");
const { AcpToolset } = await import("../src/agent/acp/tools.ts");
const { defaultShopper } = await import("../src/agent/shopper.ts");
const { createToolset } = await import("../src/agent/factory.ts");
const { ScriptedAgent } = await import("../src/agent/llm/scripted.ts");
const { sessionTotal } = await import("../src/acp.ts");

type Handler = (req: { headers: Record<string, unknown> }) => unknown;
type PayResult = { status?: string; messages?: { code: string; content: string }[]; order?: { id: string } };

let stripe: InstanceType<typeof MockStripe>;
let merchant: InstanceType<typeof Merchant>;
const servers: http.Server[] = [];
const sessionsUrl = `${config.merchantUrl}/acp/checkout_sessions`;
const auth = { authorization: `Bearer ${config.merchantAcpApiKey}` };

before(async () => {
  stripe = new MockStripe();
  merchant = new Merchant();
  servers.push(await stripe.listen(19182), await merchant.listen(19181));
});

after(() => servers.forEach((s) => s.close()));

function hosted(shopper = defaultShopper()) {
  return new AgentPlatform(shopper, merchantHostedAcp());
}

async function readySession(platform = hosted(), items = [{ id: "sku_filters", quantity: 2 }]) {
  const created = await platform.createSession(items);
  return platform.updateSession(created.id, { fulfillment_option_id: "ship_standard" });
}

function grant(maxAmount: number, paymentMethod = "pm_card_visa", expiresAt = Math.floor(Date.now() / 1000) + 900) {
  return grantSharedPaymentToken({ paymentMethod, currency: "USD", maxAmount, expiresAt });
}

async function withStripe(wrap: (original: Handler) => Handler, run: () => Promise<void>) {
  const mock = stripe as unknown as { createPaymentIntent: Handler };
  const original = mock.createPaymentIntent.bind(stripe);
  mock.createPaymentIntent = wrap(original);
  try {
    await run();
  } finally {
    delete (mock as Partial<typeof mock>).createPaymentIntent;
  }
}

describe("merchant-hosted ACP checkout", () => {
  test("the merchant creates and prices the session; it is ready once shipping is chosen", async () => {
    const platform = hosted();
    const created = await platform.createSession([{ id: "sku_filters", quantity: 2 }]);
    assert.equal(created.status, "not_ready_for_payment");
    assert.equal(created.payment_provider.provider, "stripe");
    assert.equal(created.messages.at(-1)?.code, "missing_fulfillment_option");
    const ready = await platform.updateSession(created.id, { fulfillment_option_id: "ship_standard" });
    assert.equal(ready.status, "ready_for_payment");
    assert.equal(sessionTotal(ready), 1398 + 599 + Math.round(1398 * 0.08875));
    assert.equal((await platform.getSession(created.id)).status, "ready_for_payment");
  });

  test("calls need the merchant ACP API key", async () => {
    const body = { currency: "USD", items: [{ id: "sku_filters", quantity: 1 }] };
    assert.equal((await callJson("POST", sessionsUrl, { body })).status, 401);
    assert.equal((await callJson("POST", sessionsUrl, { body, headers: { authorization: "Bearer wrong" } })).status, 401);
    assert.equal((await callJson("POST", sessionsUrl, { body, headers: auth })).status, 201);
  });

  test("complete needs a Stripe Shared Payment Token", async () => {
    const session = await readySession();
    const res = await callJson("POST", `${sessionsUrl}/${session.id}/complete`, { headers: auth, body: { payment_data: { provider: "adyen", token: "tok_1" } } });
    assert.equal(res.status, 422);
  });

  test("a canceled session cannot be completed and nothing is charged", async () => {
    const platform = hosted();
    const session = await readySession(platform);
    assert.equal((await platform.cancelSession(session.id)).status, "canceled");
    const intentsBefore = stripe.paymentIntents.length;
    const result = await platform.completeSession(session.id, await grant(sessionTotal(session)));
    assert.equal(result.messages[0].code, "invalid_state");
    assert.equal(stripe.paymentIntents.length, intentsBefore);
  });
});

describe("Stripe Shared Payment Token payments", () => {
  test("a granted token pays the exact total; the PaymentIntent carries the session, order and protocol", async () => {
    const platform = hosted();
    const session = await readySession(platform);
    const done = await platform.completeSession(session.id, await grant(sessionTotal(session)));
    assert.equal(done.status, "completed");
    const order = merchant.orders.get(done.order!.id)!;
    const intent = stripe.paymentIntents.at(-1)!;
    assert.equal(intent.status, "succeeded");
    assert.equal(intent.id, order.pspReference);
    assert.equal(intent.amount, sessionTotal(session));
    assert.equal(intent.currency, "usd");
    assert.deepEqual(intent.metadata, { checkout_session_id: session.id, order_id: order.id, agent_protocol: "ACP" });
    assert.equal(order.provider, "stripe");
    assert.equal(order.consent.total, sessionTotal(session));
    assert.match(order.consent.paymentLabel, /Stripe Shared Payment Token/);
  });

  test("a used token is rejected as payment_declined and no second order is placed", async () => {
    const platform = hosted();
    const first = await readySession(platform);
    const token = await grant(sessionTotal(first));
    assert.equal((await platform.completeSession(first.id, token)).status, "completed");
    const second = await readySession(platform);
    const ordersBefore = merchant.orders.size;
    const result = await platform.completeSession(second.id, token);
    assert.equal(result.status, "ready_for_payment");
    assert.equal(result.messages[0].code, "payment_declined");
    assert.match(result.messages[0].content, /deactivated state/);
    assert.equal(merchant.orders.size, ordersBefore);
  });

  test("an amount above the token's max_amount is rejected", async () => {
    const platform = hosted();
    const session = await readySession(platform);
    const result = await platform.completeSession(session.id, await grant(sessionTotal(session) - 1));
    assert.equal(result.status, "ready_for_payment");
    assert.equal(result.messages[0].code, "payment_declined");
    assert.match(result.messages[0].content, /greater than the remaining amount/);
  });

  test("an expired token is rejected", async () => {
    const platform = hosted();
    const session = await readySession(platform);
    const result = await platform.completeSession(session.id, await grant(sessionTotal(session), "pm_card_visa", Math.floor(Date.now() / 1000) - 1));
    assert.equal(result.messages[0].code, "payment_declined");
  });

  test("a card needing authentication becomes requires_3ds and no order", async () => {
    const platform = hosted();
    const session = await readySession(platform);
    const ordersBefore = merchant.orders.size;
    const result = await platform.completeSession(session.id, await grant(sessionTotal(session), "pm_card_authenticationRequired"));
    assert.equal(result.status, "ready_for_payment");
    assert.equal(result.messages[0].code, "requires_3ds");
    assert.equal(merchant.orders.size, ordersBefore);
  });

  test("complete with the same Idempotency-Key replays; a different body conflicts", async () => {
    const session = await readySession();
    const token = await grant(sessionTotal(session));
    const call = (body: unknown) => callJson("POST", `${sessionsUrl}/${session.id}/complete`, { headers: { ...auth, "idempotency-key": "complete-1" }, body });
    const intentsBefore = stripe.paymentIntents.length;
    const first = await call({ payment_data: { provider: "stripe", token } });
    const replay = await call({ payment_data: { provider: "stripe", token } });
    assert.equal(first.body.status, "completed");
    assert.deepEqual(replay.body.order, first.body.order);
    assert.equal(stripe.paymentIntents.length, intentsBefore + 1);
    assert.equal((await call({ payment_data: { provider: "stripe", token: "spt_other" } })).status, 409);
  });

  test("refund goes to Stripe /v1/refunds and a second refund is refused", async () => {
    const platform = hosted();
    const session = await readySession(platform);
    const done = await platform.completeSession(session.id, await grant(sessionTotal(session)));
    const orderUrl = `${config.merchantUrl}/orders/${done.order!.id}/refund`;
    const refund = await callJson("POST", orderUrl);
    assert.equal(refund.status, 200);
    assert.equal(refund.body.status, "refunded");
    assert.equal(stripe.refunds.at(-1)?.payment_intent, merchant.orders.get(done.order!.id)!.pspReference);
    assert.equal(stripe.refunds.at(-1)?.amount, sessionTotal(session));
    assert.equal((await callJson("POST", orderUrl)).status, 409);
  });
});

describe("agent end to end over PROTOCOL=stripe", () => {
  test("scripted agent buys with a Shared Payment Token; the LLM never sees the token", async () => {
    const approvals: string[] = [];
    const toolset = createToolset(async (summary) => {
      approvals.push(summary);
      return true;
    });
    const outputs: unknown[] = [];
    const execute = toolset.execute.bind(toolset);
    toolset.execute = async (name, input) => {
      const out = await execute(name, input);
      outputs.push(out);
      return out;
    };
    const tokensBefore = stripe.tokens.size;
    const reply = await new ScriptedAgent({ toolset }).send("Buy 2 bags of the coffee beans and a pack of paper filters");

    assert.match(reply, /^Order ord_/);
    assert.equal(approvals.length, 1);
    assert.match(approvals[0], /2 × Ethiopia Yirgacheffe/);
    assert.match(approvals[0], /Stripe/);
    assertAddsUp(approvals[0]);
    assert.equal(stripe.tokens.size, tokensBefore + 1);
    const token = [...stripe.tokens.values()].at(-1)!;
    const order = [...merchant.orders.values()].at(-1)!;
    assert.equal(token.usage_limits.max_amount, order.amount);
    assert.ok(token.usage_limits.expires_at - Date.now() / 1000 <= 15 * 60);
    assert.equal(stripe.paymentIntents.at(-1)?.shared_payment_granted_token, token.id);
    const seenByLlm = JSON.stringify([outputs, toolset.definitions, toolset.system]);
    assert.ok(!seenByLlm.includes("spt_"), "a Shared Payment Token reached a tool result");
    assert.ok(!seenByLlm.includes("4111"), "card data reached a tool result");
  });

  test("a declined card asks the shopper again; a new token then succeeds", async () => {
    const shopper = defaultShopper();
    shopper.stripePaymentMethod = "pm_card_chargeDeclined";
    const platform = hosted(shopper);
    let approvals = 0;
    const toolset = new AcpToolset(platform, async () => {
      approvals += 1;
      return true;
    });
    const session = await readySession(platform);
    const tokensBefore = stripe.tokens.size;
    const ordersBefore = merchant.orders.size;
    const declined = await toolset.execute("pay_and_complete", { session_id: session.id }) as PayResult;
    assert.equal(declined.status, "ready_for_payment");
    assert.equal(declined.messages?.[0].code, "payment_declined");
    assert.match(declined.messages![0].content, /card was declined/);
    shopper.stripePaymentMethod = "pm_card_visa";
    const paid = await toolset.execute("pay_and_complete", { session_id: session.id }) as PayResult;
    assert.equal(paid.status, "completed");
    assert.equal(approvals, 2);
    assert.equal(stripe.tokens.size, tokensBefore + 2);
    assert.equal(merchant.orders.size, ordersBefore + 1);
  });

  test("Stripe charges but answers 500: the retry resends the same Idempotency-Key, one charge, one order", async () => {
    const platform = hosted();
    const session = await readySession(platform);
    let approvals = 0;
    const toolset = new AcpToolset(platform, async () => {
      approvals += 1;
      return true;
    });
    const intentsBefore = stripe.paymentIntents.length;
    const ordersBefore = merchant.orders.size;
    const keys: unknown[] = [];
    await withStripe((original) => async (req) => {
      keys.push(req.headers["idempotency-key"]);
      const res = await original(req);
      return keys.length === 1 ? { status: 500, body: { error: { type: "api_error", message: "Internal error" } } } : res;
    }, async () => {
      const first = await toolset.execute("pay_and_complete", { session_id: session.id }) as PayResult;
      assert.equal(first.status, "in_progress");
      assert.equal(first.messages?.[0].code, "payment_pending");
      assert.equal((await platform.cancelSession(session.id)).messages[0].code, "invalid_state");
      assert.equal((await platform.getSession(session.id)).status, "in_progress");
      const second = await toolset.execute("pay_and_complete", { session_id: session.id }) as PayResult;
      assert.equal(second.status, "completed");
    });
    assert.equal(keys.length, 2);
    assert.equal(keys[0], keys[1]);
    assert.equal(stripe.paymentIntents.length, intentsBefore + 1);
    assert.equal(merchant.orders.size, ordersBefore + 1);
    assert.equal(approvals, 1);
  });

  test("shopper declining approval grants no token and places no order", async () => {
    const tokensBefore = stripe.tokens.size;
    const ordersBefore = merchant.orders.size;
    const toolset = new AcpToolset(hosted(), async () => false);
    const reply = await new ScriptedAgent({ toolset }).send("one pour-over dripper");
    assert.match(reply, /did not place/);
    assert.equal(stripe.tokens.size, tokensBefore);
    assert.equal(merchant.orders.size, ordersBefore);
  });
});

describe("Stripe configuration", () => {
  const freshConfig = (tag: string) => import(new URL(`../src/config.ts?${tag}`, import.meta.url).href);

  test("a live key is refused at startup, a test key selects the real Stripe API", async () => {
    const base = process.env.STRIPE_API_BASE;
    delete process.env.STRIPE_API_BASE;
    try {
      process.env.STRIPE_SECRET_KEY = "sk_live_not_a_real_key";
      await assert.rejects(freshConfig("stripe-live"), (err: Error) => /refuses to start/.test(err.message) && !err.message.includes("not_a_real_key"));
      process.env.STRIPE_SECRET_KEY = "pk_test_publishable";
      await assert.rejects(freshConfig("stripe-publishable"), /sk_test_/);
      process.env.STRIPE_SECRET_KEY = "sk_test_placeholder";
      const { config: testConfig } = await freshConfig("stripe-test");
      assert.equal(testConfig.stripe.mode, "test");
      assert.equal(testConfig.stripe.apiBase, "https://api.stripe.com");
      delete process.env.STRIPE_SECRET_KEY;
      const { config: mockConfig } = await freshConfig("stripe-mock");
      assert.equal(mockConfig.stripe.mode, "mock");
      assert.match(mockConfig.stripe.apiBase, /^http:\/\/localhost:/);
    } finally {
      delete process.env.STRIPE_SECRET_KEY;
      process.env.STRIPE_API_BASE = base;
    }
  });

  test("the trace masks Shared Payment Tokens", () => {
    const text = redact(JSON.stringify({ id: "spt_1AbC", "payment_method_data[shared_payment_granted_token]": "spt_9xYz" }));
    assert.ok(!/spt_[A-Za-z0-9]/.test(text.replace(/spt_\*\*\*/g, "")), text);
  });
});
