import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import type http from "node:http";
import { decodeJwt, decodeProtectedHeader } from "jose";

process.env.MERCHANT_PORT = "19281";
process.env.MOCK_STRIPE_PORT = "19282";
process.env.STRIPE_API_BASE = "http://localhost:19282";
process.env.MOCK_MASTERCARD_PORT = "19284";
process.env.MASTERCARD_URL = "http://localhost:19284";
process.env.PROTOCOL = "stripe";
process.env.TRACE = "0";
delete process.env.STRIPE_SECRET_KEY;
delete process.env.MERCHANT_ACP_API_KEY;
delete process.env.AGENT_STRIPE_PAYMENT_METHOD;

const { config } = await import("../src/config.ts");
const { callJson } = await import("../src/http.ts");
const { sessionTotal } = await import("../src/acp.ts");
const { MockStripe } = await import("../src/mock-stripe/server.ts");
const { MockMastercard } = await import("../src/mock-mastercard/server.ts");
const { Merchant } = await import("../src/merchant/server.ts");
const { AgentPlatform, merchantHostedAcp } = await import("../src/agent/acp/platform.ts");
const { AcpToolset } = await import("../src/agent/acp/tools.ts");
const { defaultShopper } = await import("../src/agent/shopper.ts");
const { AgentPaymentPlatform, grantSharedPaymentToken } = await import("../src/platform/platform.ts");
const { parseSdJwt, sha256B64u } = await import("../src/vi/sd-jwt.ts");
const vi = await import("../src/vi/credentials.ts");
type CheckoutSession = import("../src/acp.ts").CheckoutSession;
type PaymentData = import("../src/acp.ts").PaymentData;
type SigningKey = import("../src/vi/credentials.ts").SigningKey;

const MC = config.vi.mastercardUrl;
let stripe: InstanceType<typeof MockStripe>;
let network: InstanceType<typeof MockMastercard>;
let merchant: InstanceType<typeof Merchant>;
const servers: http.Server[] = [];
const platform = new AgentPaymentPlatform();
const client = new AgentPlatform(defaultShopper(), merchantHostedAcp(), platform);

before(async () => {
  stripe = new MockStripe();
  network = new MockMastercard();
  merchant = new Merchant();
  servers.push(await stripe.listen(19282), await network.listen(19284), await merchant.listen(19281));
});

after(() => servers.forEach((s) => s.close()));

async function readySession(items = [{ id: "sku_filters", quantity: 2 }]): Promise<CheckoutSession> {
  const created = await client.createSession(items);
  return client.updateSession(created.id, { fulfillment_option_id: "ship_standard" });
}

function approveAll(seen: string[] = []) {
  return async (summary: string) => {
    seen.push(summary);
    return true;
  };
}

async function authorized(session: CheckoutSession): Promise<PaymentData> {
  const payment = await platform.authorize(session, "test approval", approveAll());
  assert.ok(payment);
  return payment;
}

interface Wallet {
  key: SigningKey;
  l1: string;
}

async function testWallet(): Promise<Wallet> {
  const key = vi.generateSigningKey("test-device");
  const res = await callJson("POST", `${MC}${vi.ENROLMENT_PATH}`, { body: { cnf_jwk: key.publicJwk, pan_last_four: "4242", scheme: "visa" } });
  assert.equal(res.status, 201);
  return { key, l1: res.body.credential };
}

interface Craft {
  l1?: string;
  key?: SigningKey;
  checkoutJwt?: string;
  amount?: number;
  payeeId?: string;
  nonce?: string;
  iat?: number;
}

async function craft(session: CheckoutSession, wallet: Wallet, o: Craft = {}): Promise<PaymentData> {
  const l1 = o.l1 ?? wallet.l1;
  const l2 = await vi.createImmediateL2({
    l1,
    userKey: o.key ?? wallet.key,
    aud: config.vi.agentPlatformId,
    checkoutJwt: o.checkoutJwt ?? session.checkout_jwt!,
    nonce: o.nonce,
    iat: o.iat,
    payment: {
      payment_instrument: { type: "stripe.payment_method", id: "pm_card_visa" },
      payment_amount: { currency: session.currency, amount: o.amount ?? sessionTotal(session) },
      payee: { ...config.vi.merchant, id: o.payeeId ?? config.vi.merchant.id },
    },
  });
  const reg = await callJson("POST", `${MC}${vi.REGISTRATIONS_PATH}`, { body: { l1, l2: vi.presentL2(l2, ["payment"]) } });
  const intentId = reg.status === 201 ? reg.body.intent_id : "vi_unregistered";
  const token = await grantSharedPaymentToken({
    paymentMethod: "pm_card_visa",
    currency: session.currency,
    maxAmount: sessionTotal(session),
    expiresAt: Math.floor(Date.now() / 1000) + 900,
    sharedMetadata: { vi_checkout_hash: l2.checkoutHash, vi_intent_id: intentId },
  });
  return { provider: "stripe", token, verifiable_intent: { l1, l2: l2.serialized, intent_id: intentId } };
}

async function assertRejected(sessionId: string, payment: PaymentData, reason: RegExp) {
  const intentsBefore = stripe.paymentIntents.length;
  const ordersBefore = merchant.orders.size;
  const result = await client.completeSession(sessionId, payment);
  assert.equal(result.messages[0]?.code, "intent_verification_failed", JSON.stringify(result.messages));
  assert.match(result.messages[0].content, reason);
  assert.equal(result.status, "ready_for_payment");
  assert.equal(stripe.paymentIntents.length, intentsBefore, "nothing may be charged");
  assert.equal(merchant.orders.size, ordersBefore, "no order may be placed");
}

function tamperPayload(jwt: string, change: (claims: Record<string, any>) => void): string {
  const [header, payload, signature] = jwt.split(".");
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  change(claims);
  return [header, Buffer.from(JSON.stringify(claims)).toString("base64url"), signature].join(".");
}

describe("Verifiable Intent happy path", () => {
  test("the platform signs L2 over the merchant's checkout_jwt; merchant and network verify it before the charge", async () => {
    const session = await readySession();
    const approvals: string[] = [];
    const payment = await platform.authorize(session, "test approval", approveAll(approvals));
    assert.ok(payment?.verifiable_intent);
    assert.match(approvals[0], /signs this exact cart/);
    const done = await client.completeSession(session.id, payment);
    assert.equal(done.status, "completed");

    const { l1, l2, intent_id } = payment.verifiable_intent;
    const l1Jwt = parseSdJwt(l1).jwt;
    assert.deepEqual(decodeProtectedHeader(l1Jwt).typ, "sd+jwt");
    const l1Claims = decodeJwt(l1Jwt) as Record<string, any>;
    assert.equal(l1Claims.vct, vi.L1_VCT);
    assert.equal(l1Claims.iss, MC);
    assert.equal(l1Claims._sd_alg, "sha-256");
    assert.ok(l1Claims.cnf.jwk.x && !("d" in l1Claims.cnf.jwk));

    const parsed = parseSdJwt(l2);
    assert.equal(decodeProtectedHeader(parsed.jwt).typ, "kb-sd-jwt");
    const l2Claims = decodeJwt(parsed.jwt) as Record<string, any>;
    assert.equal(l2Claims.sd_hash, sha256B64u(l1));
    assert.equal(l2Claims.aud, config.vi.agentPlatformId);
    assert.ok(l2Claims.exp - l2Claims.iat <= 900);
    assert.deepEqual(l2Claims.delegate_payload.map((r: Record<string, string>) => r["..."]), parsed.disclosures.map((d) => d.hash));
    const [checkout, pay] = parsed.disclosures.map((d) => d.value[1] as Record<string, any>);
    assert.equal(checkout.vct, "mandate.checkout.1");
    assert.equal(pay.vct, "mandate.payment.1");
    assert.equal(checkout.checkout_jwt, session.checkout_jwt);
    assert.equal(checkout.checkout_hash, sha256B64u(session.checkout_jwt!));
    assert.equal(pay.transaction_id, checkout.checkout_hash);
    assert.deepEqual(pay.payment_amount, { currency: "USD", amount: sessionTotal(session) });
    assert.equal(pay.payee.id, config.vi.merchant.id);
    assert.ok(!("cnf" in checkout) && !("cnf" in pay) && !("constraints" in pay));

    const signedCart = decodeJwt(session.checkout_jwt!) as Record<string, any>;
    assert.equal(signedCart.iss, config.vi.merchant.website);
    assert.equal(signedCart.checkout_session_id, session.id);
    assert.equal(signedCart.total, sessionTotal(session));
    assert.deepEqual(signedCart.line_items.map((li: { sku: string; quantity: number }) => [li.sku, li.quantity]), [["sku_filters", 2]]);

    const registration = network.registrations.get(intent_id)!;
    assert.equal(registration.transaction_id, checkout.checkout_hash);
    assert.equal(registration.payment_amount.amount, sessionTotal(session));
    const order = merchant.orders.get(done.order!.id)!;
    assert.deepEqual(order.verifiableIntent, { checkoutHash: checkout.checkout_hash, intentId: intent_id });
    const intent = stripe.paymentIntents.at(-1)!;
    assert.equal(intent.metadata.vi_checkout_hash, checkout.checkout_hash);
    assert.equal(intent.metadata.vi_intent_id, intent_id);
    assert.equal(stripe.tokens.get(payment.token)?.usage_limits.max_amount, sessionTotal(session));
  });

  test("the checkout_jwt is re-issued when the cart changes", async () => {
    const session = await readySession();
    const updated = await client.updateSession(session.id, { items: [{ id: "sku_filters", quantity: 3 }] });
    assert.notEqual(updated.checkout_jwt, session.checkout_jwt);
    assert.equal((decodeJwt(updated.checkout_jwt!) as Record<string, any>).total, sessionTotal(updated));
  });
});

describe("Verifiable Intent attacks are rejected before any charge", () => {
  test("gift card attack: a valid presentation and token for one cart cannot pay a different session", async () => {
    const real = await readySession();
    const payment = await authorized(real);
    const giftCard = await readySession([{ id: "sku_pour_over", quantity: 1 }]);
    await assertRejected(giftCard.id, payment, /not the latest checkout this merchant issued/);
    assert.equal((await client.completeSession(real.id, payment)).status, "completed");
    await assertRejected((await readySession([{ id: "sku_pour_over", quantity: 1 }])).id, payment, /not the latest checkout/);
  });

  test("a presentation for a cart that was changed afterwards is rejected", async () => {
    const session = await readySession();
    const payment = await authorized(session);
    await client.updateSession(session.id, { items: [{ id: "sku_filters", quantity: 5 }] });
    await assertRejected(session.id, payment, /not the latest checkout/);
  });

  test("a tampered checkout_jwt (price changed) is rejected by the merchant and refused by the platform", async () => {
    const wallet = await testWallet();
    const session = await readySession();
    const cheaper = tamperPayload(session.checkout_jwt!, (c) => {
      c.line_items[0].unit_price = 1;
      c.total = 100;
    });
    await assertRejected(session.id, await craft(session, wallet, { checkoutJwt: cheaper, amount: 100 }), /not the latest checkout/);
    await assert.rejects(platform.authorize({ ...session, checkout_jwt: cheaper }, "x", approveAll()), /does not verify against the merchant JWKS/);
    await assert.rejects(platform.authorize({ ...session, totals: session.totals.map((t) => (t.type === "total" ? { ...t, amount: 100 } : t)) }, "x", approveAll()), /does not match the checkout shown/);
  });

  test("payment_amount different from the checkout total is rejected", async () => {
    const wallet = await testWallet();
    const session = await readySession();
    await assertRejected(session.id, await craft(session, wallet, { amount: sessionTotal(session) - 100 }), /payment_amount .* does not equal the checkout total/);
  });

  test("a payee other than this merchant is rejected", async () => {
    const wallet = await testWallet();
    const session = await readySession();
    await assertRejected(session.id, await craft(session, wallet, { payeeId: "gift-card-shop" }), /payee gift-card-shop is not this merchant/);
  });

  test("an L2 signed by a key that is not the one bound in L1 cnf.jwk is rejected", async () => {
    const wallet = await testWallet();
    const session = await readySession();
    await assertRejected(session.id, await craft(session, wallet, { key: vi.generateSigningKey("attacker") }), /L2 rejected: signature verification failed/);
  });

  test("an L1 from an unknown issuer, or with a forged issuer signature, is rejected", async () => {
    const wallet = await testWallet();
    const rogue = vi.generateSigningKey("rogue-issuer");
    const session = await readySession();
    const base = { sub: "user-rogue", cnfJwk: wallet.key.publicJwk, panLastFour: "4242", scheme: "visa" };
    const unknown = await vi.issueL1(rogue, { ...base, iss: "https://rogue-issuer.example" });
    await assertRejected(session.id, await craft(session, wallet, { l1: unknown }), /rogue-issuer.example is not a trusted issuer/);
    const forged = await vi.issueL1(rogue, { ...base, iss: MC });
    await assertRejected(session.id, await craft(session, wallet, { l1: forged }), /L1 rejected/);
  });

  test("an expired L2 is rejected", async () => {
    const wallet = await testWallet();
    const session = await readySession();
    const payment = await craft(session, wallet, { iat: Math.floor(Date.now() / 1000) - 900 - vi.CLOCK_SKEW_SECONDS - 5 });
    assert.equal(payment.verifiable_intent?.intent_id, "vi_unregistered", "the network refuses to register an expired L2");
    await assertRejected(session.id, payment, /L2 rejected: "exp" claim timestamp check failed/);
  });

  test("a replayed nonce is rejected by the merchant and by the network", async () => {
    const wallet = await testWallet();
    const nonce = "nonce-replay-test-1";
    const first = await readySession();
    assert.equal((await client.completeSession(first.id, await craft(first, wallet, { nonce }))).status, "completed");
    const second = await readySession();
    const replay = await craft(second, wallet, { nonce });
    assert.equal(replay.verifiable_intent?.intent_id, "vi_unregistered", "the network refuses a second registration with the same nonce");
    await assertRejected(second.id, replay, /nonce was already used/);
  });

  test("an intent the network never registered is rejected", async () => {
    const session = await readySession();
    const payment = await authorized(session);
    await assertRejected(session.id, { ...payment, verifiable_intent: { ...payment.verifiable_intent!, intent_id: "vi_unknown" } }, /network does not know intent vi_unknown/);
  });

  test("the platform detects a merchant JWKS mismatch: no approval, no token, no registration", async () => {
    const mismatched = new AgentPaymentPlatform({ merchantJwksUrl: `${MC}${vi.JWKS_PATH}` });
    const tokensBefore = stripe.tokens.size;
    const registrationsBefore = network.registrations.size;
    let asked = 0;
    const toolset = new AcpToolset(new AgentPlatform(defaultShopper(), merchantHostedAcp(), mismatched), async () => {
      asked += 1;
      return true;
    });
    const session = await readySession();
    const result = await toolset.execute("pay_and_complete", { session_id: session.id }) as { error?: string };
    assert.match(result.error ?? "", /does not verify against the merchant JWKS/);
    assert.equal(asked, 0);
    assert.equal(stripe.tokens.size, tokensBefore);
    assert.equal(network.registrations.size, registrationsBefore);
    assert.equal((await client.getSession(session.id)).status, "ready_for_payment");
  });
});

describe("mock Mastercard network", () => {
  test("publishes the issuer JWKS and serves registrations", async () => {
    const jwks = await callJson("GET", `${MC}${vi.JWKS_PATH}`);
    assert.equal(jwks.status, 200);
    assert.equal(jwks.body.keys[0].kty, "EC");
    assert.ok(!("d" in jwks.body.keys[0]));
    const session = await readySession();
    const payment = await authorized(session);
    const reg = await callJson("GET", `${MC}${vi.REGISTRATIONS_PATH}/${payment.verifiable_intent!.intent_id}`);
    assert.equal(reg.status, 200);
    assert.equal(reg.body.status, "registered");
    assert.equal((await callJson("GET", `${MC}${vi.REGISTRATIONS_PATH}/vi_missing`)).status, 404);
  });

  test("refuses an L2 for another audience or not bound to the presented L1", async () => {
    const wallet = await testWallet();
    const other = await testWallet();
    const session = await readySession();
    const payment = { payment_instrument: { type: "stripe.payment_method", id: "pm_card_visa" }, payment_amount: { currency: "USD", amount: sessionTotal(session) }, payee: config.vi.merchant };
    const wrongAud = await vi.createImmediateL2({ l1: wallet.l1, userKey: wallet.key, aud: "https://someone-else.example", checkoutJwt: session.checkout_jwt!, payment });
    const res = await callJson("POST", `${MC}${vi.REGISTRATIONS_PATH}`, { body: { l1: wallet.l1, l2: wrongAud.serialized } });
    assert.equal(res.status, 422);
    assert.match(res.body.message, /aud/);
    const unbound = await vi.createImmediateL2({ l1: other.l1, userKey: wallet.key, aud: config.vi.agentPlatformId, checkoutJwt: session.checkout_jwt!, payment });
    const res2 = await callJson("POST", `${MC}${vi.REGISTRATIONS_PATH}`, { body: { l1: wallet.l1, l2: unbound.serialized } });
    assert.equal(res2.status, 422);
    assert.match(res2.body.message, /sd_hash/);
  });
});
