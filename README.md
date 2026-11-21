# Agentic payments with Adyen: Gemini + Google UCP, and ACP

A runnable proof of concept that answers one question: **can an AI agent pay a merchant whose backend runs on Adyen?** The agent is Gemini (or Claude, or a scripted stand-in); the merchant is a small backend; Adyen authorises the payment.

Two agentic protocols are implemented side by side:

| | **Google UCP** (default) | **ACP** |
|---|---|---|
| Who runs the checkout session | the merchant's backend | Adyen Commerce Suite |
| Payment credential | encrypted Google Pay token (`PAYMENT_GATEWAY`, gateway `adyen`) | Adyen single-use ACP token from `delegate_payment` |
| Merchant's Adyen call | `POST /payments` with `paymentMethod.type: googlepay` | `POST /payments` with `storedPaymentMethodId` |
| Adyen docs | [Google agentic commerce](https://docs.adyen.com/online-payments/agentic-commerce/merchant/google-agentic-commerce) | [AI agent integration (ACP)](https://docs.adyen.com/online-payments/agentic-commerce/agent-platform/ai-agent-integration-acp) |

Adyen's agentic endpoints and Google's agent surfaces need onboarding, so the repo ships a **local mock of Adyen** that follows the documented contracts. Everything runs offline; env vars switch the merchant to Adyen's real test environment.

## Google UCP flow (Gemini pays with Google Pay)

```
 Shopper ──chat──▶ Gemini agent ──UCP REST──▶ Merchant backend ──POST /payments (googlepay)──▶ Adyen
                     │  ▲                          │   ▲                                         │
                     │  └── Google Pay sheet ──────┘   └──────── AUTHORISATION webhook (HMAC) ───┘
                     │      (shopper approves, encrypted token for gateway "adyen")
```

1. **Discover.** The agent reads `GET /.well-known/ucp`: the `dev.ucp.shopping` REST endpoint, the checkout and fulfillment capabilities, and a `com.google.pay` payment handler whose `tokenization_specification` is `PAYMENT_GATEWAY` with `gateway: adyen` and `gatewayMerchantId` = the Adyen merchant account.
2. **Checkout.** `POST /checkout-sessions` with line items, buyer email and shipping destination returns `incomplete` with `missing` messages. `PUT /checkout-sessions/{id}` (full replacement) selects a shipping option, and the status becomes `ready_for_complete`.
3. **Google Pay.** The shopper approves the exact total in the Google Pay sheet. The sheet returns a payment instrument with `credential: { type: "PAYMENT_GATEWAY", token }`, where the token is encrypted for Adyen.
4. **Complete.** `POST /checkout-sessions/{id}/complete` (with `Idempotency-Key`). The merchant sends the token unchanged to Adyen `POST /payments`:
   ```json
   { "merchantAccount": "…", "amount": { "value": 7673, "currency": "USD" }, "reference": "ord_…",
     "paymentMethod": { "type": "googlepay", "googlePayToken": "<token>" },
     "returnUrl": "https://merchant/checkout/chk_…",
     "metadata": { "agentProtocol": "UCP", "agentSessionId": "chk_…", "agentPlatform": "Google" } }
   ```
5. **Outcome.**
   - `Authorised` → `completed` with `order.id` and `order.permalink_url`.
   - `Refused` → stays `ready_for_complete` with a recoverable `payment_declined` message; the agent asks the shopper and may retry with a new token.
   - `RedirectShopper` (3-D Secure) → `requires_escalation` with a `continue_url`.
   - Orders above the risk limit also escalate (`high_value_order`).
6. **Webhook.** Adyen posts an `AUTHORISATION` notification; the merchant verifies its HMAC signature and attaches it to the order.

The LLM never sees card data. Its payment tool takes only a checkout id, and the platform runs the approval step and the token step.

## ACP flow

The agent creates and updates the checkout session on Adyen's Commerce Suite, which asks the merchant for quotes. It tokenizes the card with `delegate_payment`: the token is single use, bound to the session and the merchant, and capped by `max_amount`. Completing the session makes Adyen call the merchant's commit and finalize hooks. In the advanced flow (the default) the merchant charges the token with `POST /payments`. Run it with `PROTOCOL=acp`.

## Run

Requires Node 23.6+ (TypeScript runs natively, no build step).

```bash
npm install
npm run demo                 # UCP + Google Pay, scripted agent, auto-approved, full HTTP trace
PROTOCOL=acp npm run demo    # same purchase over ACP
npm test                     # 40 contract and end-to-end tests
```

Chat with a real agent. Start the servers in one terminal:

```bash
npm run servers
```

Then run the agent in another:

```bash
GEMINI_API_KEY=... npm run agent -- "2 paket kahve çekirdeği ve filtre kağıdı al"
```

| `LLM_PROVIDER` | Cost | Key |
|---|---|---|
| `gemini` (default when a key is set) | free tier on Google AI Studio, rate limited | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) |
| `claude` | paid API usage | `ANTHROPIC_API_KEY` |
| `scripted` | free, no LLM | none; deterministic keyword matcher used by tests |

`GEMINI_MODEL` / `CLAUDE_MODEL` override the model. If the free tier rejects a model with a quota error, try `GEMINI_MODEL=gemini-3.5-flash-lite`.

Mock test cards (set `AGENT_TEST_CARD`):

| Card ending | Result |
|---|---|
| `1111` (default) | Authorised |
| `0002` | Refused, not enough balance |
| `0044` | 3-D Secure challenge (UCP: `requires_escalation`) |

Other scenarios to try in chat: the out-of-stock gooseneck kettle, express shipping, changing quantities, closing the Google Pay sheet.

## Against Adyen's test environment

UCP path: the merchant talks to the real Checkout API, and you supply a real Google Pay test token.

```bash
ADYEN_MODE=test ADYEN_MERCHANT_ACCOUNT=... ADYEN_CHECKOUT_API_KEY=... ADYEN_HMAC_KEY=... \
GOOGLE_PAY_TOKEN=@token.json npm run servers
```

Generate `token.json` with Google's Google Pay Code Generator, using gateway `adyen` and your merchant account as `gatewayMerchantId`. The token must be created for the same amount and currency as the checkout total. This proves the merchant → Adyen leg for real. Having real Gemini or AI Mode call your UCP endpoints requires Google's merchant onboarding and a public HTTPS endpoint, which a local POC cannot simulate.

ACP path: also set `ADYEN_COMPANY_ACCOUNT`, `ADYEN_COMMERCE_SUITE_API_KEY` and `ADYEN_AGENTIC_TOKEN`. Adyen must enable Delegated Payment and the agentic token for your account.

| Call | Test host | Auth |
|---|---|---|
| Checkout `/payments` | `https://checkout-test.adyen.com/v72` | `X-API-Key` |
| ACP checkout sessions | `https://commerce-suite-test.adyen.com/commerce-suite/acp/v1/{companyAccount}` | `Authorization: Bearer` (Commerce Suite API role) |
| ACP `delegate_payment` | `https://pal-test.adyen.com/paltokenization/servlet/Recurring/Agentic/acp/v1` | `Authorization: Bearer` agentic token, `API-Version: 2025-09-29` |

## Documented vs assumed

Taken from the docs:

- UCP 2026-01-23: discovery profile, checkout endpoints and statuses, PUT full replacement, message severities, `PAYMENT_GATEWAY` credential at `payment.instruments[].credential.token`.
- Adyen Google flow: `googlepay` + `googlePayToken`, `metadata.agentProtocol/agentSessionId/agentPlatform`, gateway `adyen`.
- ACP: endpoints, headers, `delegate_payment` fields, token scoping, error codes.

Assumed, to confirm before production:

- UCP field details that only appeared in summarised spec text: the postal address field names, `UCP-Agent` as the only required header, and the shape of the `ucp` envelope in responses.
- `Request-Signature` verification and `signing_keys` are not implemented.
- The mock decrypts nothing. Its Google Pay token wraps a base64 JSON payload, and the mock enforces the gateway merchant, amount and expiry that a real token binds cryptographically.
- ACP: the merchant hook paths and bodies (`/agentic/quote`, commit, finalize), `paymentMethod.type: "scheme"`, and the 201 response of `delegate_payment` (Adyen's pages disagree).
- 3-D Secure completion after `requires_escalation` is not implemented; `continue_url` returns the escalation details only.

## Layout

```
src/
  ucp.ts, acp.ts              protocol types
  config.ts, http.ts          env, JSON router, traced fetch with card redaction
  adyen-hmac.ts               webhook HMAC sign/verify
  google-pay-mock.ts          mock Google Pay token format
  mock-adyen/server.ts        fake Checkout /payments (googlepay + ACP token), ACP Commerce Suite, PAL, webhooks
  merchant/
    store.ts                  catalog, pricing, tax, shipping, orders
    ucp-server.ts             /.well-known/ucp and UCP checkout sessions
    acp-hooks.ts              quote/commit/finalize hooks Adyen calls for ACP
    adyen-checkout.ts         /payments client
    server.ts                 routes, webhook receiver
  agent/
    ucp/                      UCP client, Google Pay sheet, Gemini tools
    acp/                      ACP client (Commerce Suite + delegate_payment), tools
    llm/                      Gemini, Claude, scripted agents
    cli.ts, factory.ts, shopper.ts, toolset.ts
test/ucp.test.ts, test/acp.test.ts
```

All data is fake. Do not put real card numbers or real Google Pay tokens in this repo.
