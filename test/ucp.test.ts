import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import type http from "node:http";
import { setTimeout as sleep } from "node:timers/promises";

process.env.MOCK_ADYEN_PORT = "18090";
process.env.MERCHANT_PORT = "18091";
process.env.TRACE = "0";
delete process.env.ADYEN_MODE;
delete process.env.PROTOCOL;

const { config } = await import("../src/config.ts");
const { callJson } = await import("../src/http.ts");
const { MockAdyen } = await import("../src/mock-adyen/server.ts");
const { Merchant } = await import("../src/merchant/server.ts");
const { UcpPlatform, UcpError } = await import("../src/agent/ucp/platform.ts");
const { UcpToolset } = await import("../src/agent/ucp/tools.ts");
const { defaultShopper } = await import("../src/agent/shopper.ts");
const { ScriptedAgent } = await import("../src/agent/llm/scripted.ts");
const { encodeMockGooglePayToken } = await import("../src/google-pay-mock.ts");
const { ucpTotal } = await import("../src/ucp.ts");

let adyen: InstanceType<typeof MockAdyen>;
let merchant: InstanceType<typeof Merchant>;
const servers: http.Server[] = [];

before(async () => {
  adyen = new MockAdyen();
  merchant = new Merchant();
  servers.push(await adyen.listen(18090), await merchant.listen(18091));
});

after(() => servers.forEach((s) => s.close()));

const base = `${config.merchantUrl}/ucp/v1/checkout-sessions`;
const agentHeaders = { "ucp-agent": 'profile="https://agent.example/.well-known/ucp"' };

function shopperWithCard(number: string) {
  const shopper = defaultShopper();
  shopper.card = { ...shopper.card, number };
  return shopper;
}

async function readyCheckout(platform = new UcpPlatform(), items = [{ id: "sku_filters", quantity: 2 }]) {
  const created = await platform.create(items);
  return platform.update(created.id, { fulfillmentOptionId: "ship_standard" });
}

function instrument(checkout: { totals: import("../src/ucp.ts").UcpTotal[]; currency: string }, overrides: Record<string, unknown> = {}) {
  const token = encodeMockGooglePayToken({
    gateway: "adyen",
    gatewayMerchantId: config.merchantAccount,
    network: "VISA",
    last4: "1111",
    authMethod: "PAN_ONLY",
    amount: ucpTotal(checkout),
    currency: checkout.currency,
    messageExpiration: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  });
  return { id: "instr_1", handler_id: "gpay_adyen", type: "card", selected: true, credential: { type: "PAYMENT_GATEWAY", token } };
}

function complete(id: string, body: unknown, headers: Record<string, string> = {}) {
  return callJson("POST", `${base}/${id}/complete`, { headers: { ...agentHeaders, ...headers }, body });
}

function getCheckout(id: string) {
  return callJson("GET", `${base}/${id}`, { headers: agentHeaders });
}

type PaymentsHandler = (req: unknown) => unknown;

async function withAdyen(wrap: (original: PaymentsHandler) => PaymentsHandler, run: () => Promise<void>) {
  const mock = adyen as unknown as { checkoutPayments: PaymentsHandler };
  const original = mock.checkoutPayments.bind(adyen);
  mock.checkoutPayments = wrap(original);
  try {
    await run();
  } finally {
    delete (mock as Partial<typeof mock>).checkoutPayments;
  }
}

function addProduct(id: string, price: number, stock: number) {
  merchant.catalog.set(id, { id, title: `Test product ${id}`, description: "", price, currency: "USD", stock });
}

describe("discovery", () => {
  test("/.well-known/ucp advertises the checkout service and an Adyen Google Pay handler", async () => {
    const res = await callJson("GET", `${config.merchantUrl}/.well-known/ucp`);
    assert.equal(res.status, 200);
    assert.equal(res.body.ucp.version, "2026-01-23");
    assert.equal(res.body.ucp.services["dev.ucp.shopping"][0].endpoint, `${config.merchantUrl}/ucp/v1`);
    const handler = res.body.ucp.payment_handlers["com.google.pay"][0];
    const tokenization = handler.config.allowed_payment_methods[0].tokenization_specification;
    assert.deepEqual(tokenization, { type: "PAYMENT_GATEWAY", parameters: { gateway: "adyen", gatewayMerchantId: config.merchantAccount } });
  });
});

describe("checkout lifecycle", () => {
  test("create returns 201 incomplete until a shipping option is chosen", async () => {
    const platform = new UcpPlatform();
    const created = await platform.create([{ id: "sku_coffee_beans", quantity: 2 }]);
    assert.equal(created.status, "incomplete");
    assert.ok(created.messages.some((m) => m.code === "missing" && m.path?.includes("selected_option_id")));
    const ready = await platform.update(created.id, { fulfillmentOptionId: "ship_express" });
    assert.equal(ready.status, "ready_for_complete");
    assert.equal(ucpTotal(ready), 2 * 2899 + 1999 + Math.round(2 * 2899 * 0.08875));
  });

  test("UCP-Agent header is required", async () => {
    const res = await callJson("POST", base, { body: { line_items: [{ item: { id: "sku_filters" }, quantity: 1 }] } });
    assert.equal(res.status, 400);
    assert.equal(res.body.messages[0].code, "missing_header");
  });

  test("PUT is a full replacement: omitted buyer and fulfillment are cleared", async () => {
    const checkout = await readyCheckout();
    const res = await callJson("PUT", `${base}/${checkout.id}`, {
      headers: agentHeaders,
      body: { id: checkout.id, line_items: [{ item: { id: "sku_filters" }, quantity: 1 }] },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, "incomplete");
    assert.equal(res.body.buyer, undefined);
    assert.ok(res.body.messages.some((m: { path?: string }) => m.path === "$.buyer.email"));
  });

  test("out of stock item is a recoverable error", async () => {
    const created = await new UcpPlatform().create([{ id: "sku_kettle", quantity: 1 }]);
    const msg = created.messages.find((m) => m.code === "out_of_stock");
    assert.equal(msg?.severity, "recoverable");
    assert.equal(msg?.path, "$.line_items[0]");
    assert.equal(created.status, "incomplete");
  });

  test("non-US destination is unsupported", async () => {
    const shopper = defaultShopper();
    shopper.address = { ...shopper.address, country: "DE", state: undefined, city: "Berlin", postal_code: "10115" };
    const created = await new UcpPlatform(shopper).create([{ id: "sku_filters", quantity: 1 }]);
    assert.ok(created.messages.some((m) => m.code === "unsupported_destination"));
  });

  test("complete before ready is rejected with 409", async () => {
    const created = await new UcpPlatform().create([{ id: "sku_filters", quantity: 1 }]);
    const res = await complete(created.id, { payment: { instruments: [instrument(created)] } });
    assert.equal(res.status, 409);
  });

  test("canceled checkout cannot be completed or canceled again", async () => {
    const platform = new UcpPlatform();
    const checkout = await readyCheckout(platform);
    assert.equal((await platform.cancel(checkout.id)).status, "canceled");
    await assert.rejects(platform.cancel(checkout.id), UcpError);
    assert.equal((await complete(checkout.id, { payment: { instruments: [instrument(checkout)] } })).status, 409);
  });
});

describe("complete with Google Pay through Adyen", () => {
  test("authorises, records the order and receives a signed AUTHORISATION webhook", async () => {
    const checkout = await readyCheckout();
    const res = await complete(checkout.id, { payment: { instruments: [instrument(checkout)] } }, { "idempotency-key": "k-auth" });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, "completed");
    const order = merchant.orders.get(res.body.order.id)!;
    assert.equal(order.amount, ucpTotal(checkout));
    const payment = adyen.payments.at(-1)!;
    assert.equal(payment.paymentMethodType, "googlepay");
    assert.equal(payment.resultCode, "Authorised");
    await sleep(100);
    assert.deepEqual(order.webhookEvents, ["AUTHORISATION:true"]);
  });

  test("replaying complete with the same Idempotency-Key does not charge twice", async () => {
    const checkout = await readyCheckout();
    const body = { payment: { instruments: [instrument(checkout)] } };
    const before = adyen.payments.length;
    const first = await complete(checkout.id, body, { "idempotency-key": "k-replay" });
    const replay = await complete(checkout.id, body, { "idempotency-key": "k-replay" });
    assert.deepEqual(replay.body, first.body);
    assert.equal(adyen.payments.length, before + 1);
    const conflict = await complete(checkout.id, { payment: { instruments: [instrument(checkout, { last4: "4444" })] } }, { "idempotency-key": "k-replay" });
    assert.equal(conflict.status, 409);
  });

  test("completed checkout is immutable", async () => {
    const checkout = await readyCheckout();
    await complete(checkout.id, { payment: { instruments: [instrument(checkout)] } });
    const again = await complete(checkout.id, { payment: { instruments: [instrument(checkout)] } });
    assert.equal(again.status, 409);
    const put = await callJson("PUT", `${base}/${checkout.id}`, { headers: agentHeaders, body: { line_items: [{ item: { id: "sku_filters" }, quantity: 9 }] } });
    assert.equal(put.status, 409);
  });

  test("declined card returns payment_declined and the checkout stays payable", async () => {
    const checkout = await readyCheckout();
    const res = await complete(checkout.id, { payment: { instruments: [instrument(checkout, { last4: "0002" })] } });
    assert.equal(res.body.status, "ready_for_complete");
    assert.equal(res.body.messages.at(-1).code, "payment_declined");
    const retry = await complete(checkout.id, { payment: { instruments: [instrument(checkout)] } });
    assert.equal(retry.body.status, "completed");
  });

  test("issuer challenge escalates with a continue_url", async () => {
    const checkout = await readyCheckout();
    const res = await complete(checkout.id, { payment: { instruments: [instrument(checkout, { last4: "0044" })] } });
    assert.equal(res.body.status, "requires_escalation");
    assert.equal(res.body.continue_url, `${config.merchantUrl}/checkout/${checkout.id}`);
    assert.equal(res.body.messages.at(-1).severity, "requires_buyer_input");
  });

  test("a token encrypted for another gateway merchant is refused", async () => {
    const checkout = await readyCheckout();
    const res = await complete(checkout.id, { payment: { instruments: [instrument(checkout, { gatewayMerchantId: "SomeoneElse" })] } });
    assert.equal(res.body.status, "ready_for_complete");
    assert.match(res.body.messages.at(-1).content, /another gateway merchant/);
  });

  test("the mock refuses a token for a different amount (a real Google Pay token carries no amount)", async () => {
    const checkout = await readyCheckout();
    const res = await complete(checkout.id, { payment: { instruments: [instrument(checkout, { amount: 1 })] } });
    assert.match(res.body.messages.at(-1).content, /Amount differs/);
  });

  test("unknown handler_id and non-gateway credentials are rejected", async () => {
    const checkout = await readyCheckout();
    const wrongHandler = await complete(checkout.id, { payment: { instruments: [{ ...instrument(checkout), handler_id: "shop_pay" }] } });
    assert.equal(wrongHandler.status, 400);
    const wrongCredential = await complete(checkout.id, { payment: { instruments: [{ ...instrument(checkout), credential: { type: "DIRECT", token: "x" } }] } });
    assert.equal(wrongCredential.status, 400);
  });

  test("webhook with a bad HMAC signature is rejected", async () => {
    const res = await callJson("POST", `${config.merchantUrl}/adyen/webhooks`, {
      body: {
        live: "false",
        notificationItems: [{ NotificationRequestItem: {
          amount: { value: 1, currency: "USD" }, eventCode: "AUTHORISATION", merchantAccountCode: config.merchantAccount,
          merchantReference: "x", pspReference: "y", success: "true", additionalData: { hmacSignature: "bm9wZQ==" },
        } }],
      },
    });
    assert.equal(res.status, 401);
  });

  test("with no HMAC key configured, unsigned webhooks are rejected", async () => {
    const c = config as { webhookHmacKey: string };
    const key = c.webhookHmacKey;
    c.webhookHmacKey = "";
    try {
      const res = await callJson("POST", `${config.merchantUrl}/adyen/webhooks`, {
        body: { live: "false", notificationItems: [{ NotificationRequestItem: {
          amount: { value: 1, currency: "USD" }, eventCode: "AUTHORISATION", merchantAccountCode: config.merchantAccount,
          merchantReference: "x", pspReference: "y", success: "true",
        } }] },
      });
      assert.equal(res.status, 401);
    } finally {
      c.webhookHmacKey = key;
    }
  });

  test("empty env values fall back to the defaults", async () => {
    process.env.ADYEN_MERCHANT_ACCOUNT = "";
    process.env.ADYEN_HMAC_KEY = "";
    try {
      const fresh = await import(new URL("../src/config.ts?empty-env", import.meta.url).href);
      assert.equal(fresh.config.merchantAccount, "PocMerchantECOM");
      assert.ok(fresh.config.webhookHmacKey);
    } finally {
      delete process.env.ADYEN_MERCHANT_ACCOUNT;
      delete process.env.ADYEN_HMAC_KEY;
    }
  });
});

describe("Adyen faults and races during complete", () => {
  test("Adyen authorises but answers 500: no decline is shown and the webhook completes the checkout", async () => {
    const checkout = await readyCheckout();
    const before = adyen.payments.length;
    await withAdyen((original) => (req) => {
      original(req);
      return { status: 500, body: { status: 500, errorCode: "905", message: "Internal error", errorType: "internal" } };
    }, async () => {
      const res = await complete(checkout.id, { payment: { instruments: [instrument(checkout)] } });
      assert.equal(res.status, 200);
      assert.equal(res.body.status, "complete_in_progress");
      assert.ok(!res.body.messages.some((m: { code?: string }) => m.code === "payment_declined"));
      const otherToken = await complete(checkout.id, { payment: { instruments: [instrument(checkout, { last4: "4444" })] } });
      assert.equal(otherToken.status, 409);
    });
    await sleep(100);
    const after = await getCheckout(checkout.id);
    assert.equal(after.body.status, "completed");
    assert.equal(adyen.payments.length, before + 1);
    assert.equal(merchant.orders.get(after.body.order.id)!.amount, ucpTotal(checkout));
  });

  test("Adyen times out: retrying with the same instrument charges once", async () => {
    const checkout = await readyCheckout();
    const body = { payment: { instruments: [instrument(checkout)] } };
    const before = adyen.payments.length;
    const c = config as { checkoutTimeoutMs: number };
    const timeout = c.checkoutTimeoutMs;
    c.checkoutTimeoutMs = 50;
    try {
      await withAdyen(() => async () => {
        await sleep(200);
        return { status: 503, body: { status: 503, message: "unavailable" } };
      }, async () => {
        const res = await complete(checkout.id, body);
        assert.equal(res.body.status, "complete_in_progress");
        assert.equal(res.body.messages.at(-1).code, "payment_pending");
      });
    } finally {
      c.checkoutTimeoutMs = timeout;
    }
    const retry = await complete(checkout.id, body);
    assert.equal(retry.body.status, "completed");
    assert.equal(adyen.payments.length, before + 1);
  });

  test("cancel while complete is in flight is refused and the payment completes", async () => {
    const checkout = await readyCheckout();
    await withAdyen((original) => async (req) => {
      await sleep(150);
      return original(req);
    }, async () => {
      const paying = complete(checkout.id, { payment: { instruments: [instrument(checkout)] } });
      await sleep(30);
      const cancel = await callJson("POST", `${base}/${checkout.id}/cancel`, { headers: agentHeaders, body: {} });
      assert.equal(cancel.status, 409);
      assert.equal((await paying).body.status, "completed");
    });
    assert.equal((await getCheckout(checkout.id)).body.status, "completed");
  });

  test("the same token can be retried after a decline (fixed test-mode token)", async () => {
    const checkout = await readyCheckout();
    const body = { payment: { instruments: [instrument(checkout)] } };
    let calls = 0;
    await withAdyen((original) => (req) => {
      calls += 1;
      return calls === 1 ? { status: 200, body: { pspReference: "REFUSED1", resultCode: "Refused", refusalReason: "Refused" } } : original(req);
    }, async () => {
      const first = await complete(checkout.id, body);
      assert.equal(first.body.messages.at(-1).code, "payment_declined");
      const second = await complete(checkout.id, body);
      assert.equal(second.body.status, "completed");
    });
  });

  test("concurrent completes with the same Idempotency-Key share one result", async () => {
    const checkout = await readyCheckout();
    const body = { payment: { instruments: [instrument(checkout)] } };
    const before = adyen.payments.length;
    const [a, b] = await Promise.all([
      complete(checkout.id, body, { "idempotency-key": "k-concurrent" }),
      complete(checkout.id, body, { "idempotency-key": "k-concurrent" }),
    ]);
    assert.equal(a.body.status, "completed");
    assert.deepEqual(b.body, a.body);
    assert.equal(adyen.payments.length, before + 1);
  });
});

describe("stock", () => {
  test("two shoppers racing for the last unit: one order, one out_of_stock, no oversell", async () => {
    addProduct("sku_last_one", 1000, 1);
    const a = await readyCheckout(new UcpPlatform(), [{ id: "sku_last_one", quantity: 1 }]);
    const b = await readyCheckout(new UcpPlatform(), [{ id: "sku_last_one", quantity: 1 }]);
    const results = await Promise.all([a, b].map((c) => complete(c.id, { payment: { instruments: [instrument(c)] } })));
    const completed = results.filter((r) => r.body.status === "completed");
    const refused = results.filter((r) => r.status === 409);
    assert.equal(completed.length, 1);
    assert.equal(refused.length, 1);
    assert.equal(refused[0].body.messages[0].code, "out_of_stock");
    assert.equal(merchant.catalog.get("sku_last_one")!.stock, 0);
  });

  test("the same product on two lines is rejected", async () => {
    const res = await callJson("POST", base, {
      headers: agentHeaders,
      body: { line_items: [{ item: { id: "sku_filters" }, quantity: 1 }, { item: { id: "sku_filters" }, quantity: 1 }] },
    });
    assert.equal(res.status, 400);
  });

  test("buying the whole stock returns the charged total, not a re-priced empty cart", async () => {
    addProduct("sku_two_left", 4000, 2);
    const checkout = await readyCheckout(new UcpPlatform(), [{ id: "sku_two_left", quantity: 2 }]);
    const res = await complete(checkout.id, { payment: { instruments: [instrument(checkout)] } });
    assert.equal(res.body.status, "completed");
    assert.equal(ucpTotal(res.body), ucpTotal(checkout));
    assert.equal(res.body.line_items.length, 1);
    assert.deepEqual(res.body.messages, []);
    assert.equal(merchant.orders.get(res.body.order.id)!.amount, ucpTotal(checkout));
    assert.equal(merchant.catalog.get("sku_two_left")!.stock, 0);
    assert.equal(ucpTotal((await getCheckout(checkout.id)).body), ucpTotal(checkout));
  });
});

describe("escalation and expiry", () => {
  test("orders above the risk limit escalate without calling Adyen", async () => {
    addProduct("sku_espresso_machine", 600000, 5);
    const checkout = await readyCheckout(new UcpPlatform(), [{ id: "sku_espresso_machine", quantity: 1 }]);
    const before = adyen.payments.length;
    const res = await complete(checkout.id, { payment: { instruments: [instrument(checkout)] } });
    assert.equal(res.body.status, "requires_escalation");
    assert.equal(res.body.messages.at(-1).code, "high_value_order");
    assert.equal(adyen.payments.length, before);
  });

  test("an escalated checkout still expires", async () => {
    const checkout = await readyCheckout();
    const res = await complete(checkout.id, { payment: { instruments: [instrument(checkout, { last4: "0044" })] } });
    assert.equal(res.body.status, "requires_escalation");
    merchant.ucp.sessions.get(checkout.id)!.expiresAt = Date.now() - 1;
    assert.equal((await getCheckout(checkout.id)).body.status, "canceled");
  });
});

describe("agent tools", () => {
  test("the pay tool refuses to complete when the total changed after approval", async () => {
    const platform = new UcpPlatform();
    const checkout = await readyCheckout(platform);
    const before = adyen.payments.length;
    const toolset = new UcpToolset(platform, async () => {
      await platform.update(checkout.id, { items: [{ id: "sku_filters", quantity: 5 }] });
      return true;
    });
    const out = await toolset.execute("pay_with_google_pay", { checkout_id: checkout.id }) as { error?: string };
    assert.match(out.error ?? "", /total changed/);
    assert.equal(adyen.payments.length, before);
  });

  test("bad tool input and an unreachable merchant come back as { error } instead of throwing", async () => {
    const toolset = new UcpToolset(new UcpPlatform(), async () => true);
    const badInput = await toolset.execute("create_checkout", {}) as { error?: string };
    assert.match(badInput.error ?? "", /items must be/);
    const down = new UcpToolset(new UcpPlatform(defaultShopper(), "http://localhost:1"), async () => true);
    const unreachable = await down.execute("list_products", {}) as { error?: string };
    assert.ok(unreachable.error);
  });
});

describe("Gemini-style agent end to end (scripted)", () => {
  test("discovers, builds the cart, pays with Google Pay and gets an order", async () => {
    const approvals: string[] = [];
    const toolset = new UcpToolset(new UcpPlatform(), async (summary: string) => {
      approvals.push(summary);
      return true;
    });
    const reply = await new ScriptedAgent({ toolset }).send("Buy 2 bags of the coffee beans and a pack of paper filters");
    assert.match(reply, /^Order ord_/);
    assert.equal(approvals.length, 1);
    assert.match(approvals[0], /Google Pay · pay Brew & Co/);
    assert.match(approvals[0], /2 × Ethiopia Yirgacheffe/);
    const order = [...merchant.orders.values()].at(-1)!;
    assert.equal(order.protocol, "ucp");
  });

  test("shopper closing the Google Pay sheet places no order and no payment", async () => {
    const paymentsBefore = adyen.payments.length;
    const toolset = new UcpToolset(new UcpPlatform(), async () => false);
    const reply = await new ScriptedAgent({ toolset }).send("one pour-over dripper");
    assert.match(reply, /did not place/);
    assert.equal(adyen.payments.length, paymentsBefore);
  });

  test("3DS challenge surfaces the continue_url to the shopper", async () => {
    const toolset = new UcpToolset(new UcpPlatform(shopperWithCard("4111111111110044")), async () => true);
    const reply = await new ScriptedAgent({ toolset }).send("one pour-over dripper");
    assert.match(reply, /finish on their site: http/);
  });

  test("a card network the merchant does not accept is reported as a tool error", async () => {
    const shopper = defaultShopper();
    shopper.card = { ...shopper.card, brand: "unionpay" };
    const toolset = new UcpToolset(new UcpPlatform(shopper), async () => true);
    const reply = await new ScriptedAgent({ toolset }).send("one pour-over dripper");
    assert.match(reply, /does not accept UNIONPAY/);
  });
});
