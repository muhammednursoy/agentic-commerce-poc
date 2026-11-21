import type http from "node:http";
import { config } from "../config.ts";
import { IdempotencyCache, Router, randomId } from "../http.ts";
import type { Json, Req, Res } from "../http.ts";
import { stripeAuthorization } from "../stripe-api.ts";

interface GrantedToken {
  id: string;
  object: "shared_payment.granted_token";
  created: number;
  livemode: false;
  payment_method: string;
  usage_limits: { currency: string; max_amount: number; expires_at: number };
  deactivated_at: number | null;
}

interface PaymentIntent {
  id: string;
  object: "payment_intent";
  amount: number;
  currency: string;
  status: "succeeded" | "requires_payment_method" | "requires_action";
  metadata: Record<string, string>;
  shared_payment_granted_token: string;
  amount_refunded: number;
  next_action?: Json;
  last_payment_error?: Json;
}

interface StripeRefund {
  id: string;
  object: "refund";
  amount: number;
  currency: string;
  payment_intent: string;
  status: "succeeded";
}

const TEST_PAYMENT_METHODS: Record<string, PaymentIntent["status"]> = {
  pm_card_visa: "succeeded",
  pm_card_chargeDeclined: "requires_payment_method",
  pm_card_authenticationRequired: "requires_action",
};

export class MockStripe {
  readonly tokens = new Map<string, GrantedToken>();
  readonly paymentIntents: PaymentIntent[] = [];
  readonly refunds: StripeRefund[] = [];
  private readonly idempotency = new IdempotencyCache();

  router(): Router {
    return new Router()
      .on("POST", "/v1/test_helpers/shared_payment/granted_tokens", (r) => this.guard(r, () => this.grant(r.body ?? {})))
      .on("GET", "/v1/shared_payment/granted_tokens/:id", (r) => this.guard(r, () => this.retrieveToken(r.params.id)))
      .on("POST", "/v1/payment_intents", (r) => this.createPaymentIntent(r))
      .on("POST", "/v1/refunds", (r) => this.guard(r, () => this.refund(r.body ?? {})));
  }

  listen(port: number): Promise<http.Server> {
    return this.router().listen(port, "mock-stripe");
  }

  private createPaymentIntent(req: Req): Promise<Res> | Res {
    return this.guard(req, () => this.confirm(req.body ?? {}));
  }

  private guard(req: Req, next: () => Res): Promise<Res> | Res {
    if (req.headers.authorization !== stripeAuthorization(config.stripe.secretKey)) {
      return stripeError(401, "invalid_request_error", "Invalid API Key provided");
    }
    if (req.headers["stripe-version"] !== config.stripe.apiVersion) {
      return stripeError(400, "invalid_request_error", `Shared payment tokens need Stripe-Version ${config.stripe.apiVersion}`);
    }
    return this.idempotency.run(
      req,
      next,
      () => stripeError(400, "idempotency_error", "Keys for idempotent requests can only be used with the same parameters they were first used with."),
      (res) => res.status < 500,
    );
  }

  private grant(body: Json): Res {
    const paymentMethod = body.payment_method;
    if (typeof paymentMethod !== "string" || !Object.hasOwn(TEST_PAYMENT_METHODS, paymentMethod)) {
      return stripeError(400, "invalid_request_error", `No such PaymentMethod: '${paymentMethod}'`, { code: "resource_missing", param: "payment_method" });
    }
    const maxAmount = Number(body["usage_limits[max_amount]"]);
    const expiresAt = Number(body["usage_limits[expires_at]"]);
    const currency = body["usage_limits[currency]"];
    if (!Number.isInteger(maxAmount) || maxAmount <= 0 || !Number.isInteger(expiresAt) || typeof currency !== "string") {
      return stripeError(400, "invalid_request_error", "usage_limits needs currency, max_amount and expires_at", { code: "parameter_missing", param: "usage_limits" });
    }
    const token: GrantedToken = {
      id: randomId("spt_", 12),
      object: "shared_payment.granted_token",
      created: now(),
      livemode: false,
      payment_method: paymentMethod,
      usage_limits: { currency, max_amount: maxAmount, expires_at: expiresAt },
      deactivated_at: null,
    };
    this.tokens.set(token.id, token);
    return { status: 200, body: token };
  }

  private retrieveToken(id: string): Res {
    const token = this.tokens.get(id);
    return token ? { status: 200, body: token } : stripeError(404, "invalid_request_error", `No such shared payment granted token: '${id}'`, { code: "resource_missing" });
  }

  private confirm(body: Json): Res {
    const amount = Number(body.amount);
    const currency = body.currency;
    const tokenId = body["payment_method_data[shared_payment_granted_token]"];
    if (!Number.isInteger(amount) || amount <= 0 || typeof currency !== "string" || body.confirm !== "true") {
      return stripeError(400, "invalid_request_error", "amount, currency and confirm=true are required", { code: "parameter_missing" });
    }
    const token = this.tokens.get(tokenId);
    if (!token) {
      return stripeError(400, "invalid_request_error", `No such shared payment granted token: '${tokenId}'`, { code: "resource_missing", param: "payment_method_data[shared_payment_granted_token]" });
    }
    if (token.deactivated_at === null && token.usage_limits.expires_at <= now()) token.deactivated_at = token.usage_limits.expires_at;
    if (token.deactivated_at !== null) {
      return stripeError(400, "invalid_request_error", "The shared payment granted token cannot be used because it is already in a deactivated state.");
    }
    if (currency !== token.usage_limits.currency) {
      return stripeError(400, "invalid_request_error", "The currency does not match the shared payment granted token's usage limits.");
    }
    if (amount > token.usage_limits.max_amount) {
      return stripeError(400, "invalid_request_error", "The requested amount is greater than the remaining amount capturable with this shared payment granted token.");
    }
    const status = TEST_PAYMENT_METHODS[token.payment_method];
    const intent: PaymentIntent = {
      id: randomId("pi_", 12),
      object: "payment_intent",
      amount,
      currency,
      status,
      metadata: Object.fromEntries(Object.entries(body).flatMap(([k, v]) => {
        const key = /^metadata\[(.+)\]$/.exec(k)?.[1];
        return key ? [[key, String(v)]] : [];
      })),
      shared_payment_granted_token: token.id,
      amount_refunded: 0,
    };
    this.paymentIntents.push(intent);
    if (status === "requires_payment_method") {
      const error = { type: "card_error", code: "card_declined", decline_code: "generic_decline", message: "Your card was declined." };
      intent.last_payment_error = error;
      return { status: 402, body: { error: { ...error, payment_intent: intent } } };
    }
    if (status === "requires_action") {
      intent.next_action = { type: "shared_payment_token_action" };
      return { status: 200, body: intent };
    }
    token.deactivated_at = now();
    return { status: 200, body: intent };
  }

  private refund(body: Json): Res {
    const intent = this.paymentIntents.find((p) => p.id === body.payment_intent);
    if (!intent) return stripeError(400, "invalid_request_error", `No such payment_intent: '${body.payment_intent}'`, { code: "resource_missing", param: "payment_intent" });
    if (intent.status !== "succeeded") return stripeError(400, "invalid_request_error", "This PaymentIntent has no successful charge to refund.");
    const amount = body.amount === undefined ? intent.amount - intent.amount_refunded : Number(body.amount);
    if (!Number.isInteger(amount) || amount <= 0 || intent.amount_refunded + amount > intent.amount) {
      return stripeError(400, "invalid_request_error", "Refund amount is greater than the unrefunded amount on the charge.", { code: "charge_already_refunded" });
    }
    intent.amount_refunded += amount;
    const refund: StripeRefund = { id: randomId("re_", 12), object: "refund", amount, currency: intent.currency, payment_intent: intent.id, status: "succeeded" };
    this.refunds.push(refund);
    return { status: 200, body: refund };
  }
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}

function stripeError(status: number, type: string, message: string, extra: Record<string, unknown> = {}): Res {
  return { status, body: { error: { type, message, ...extra } } };
}
