# Adyen ACP agentic commerce POC

A runnable proof of concept of [Adyen's Agentic Commerce Protocol (ACP) integration](https://docs.adyen.com/online-payments/agentic-commerce/agent-platform/ai-agent-integration-acp): an LLM shopping agent buys from a merchant on the shopper's behalf, Adyen runs the ACP checkout session and tokenizes the card into a single-use, merchant-scoped token, and the merchant charges that token with `POST /payments`.

Adyen's ACP endpoints are gated (Delegated Payment access, a dedicated agentic token and merchant enablement come from your Adyen account manager), so the POC ships a **local mock of Adyen** that follows the documented contract. Point the env vars at the real test hosts once you have access.

## Actors and flow

```
 Shopper ──chat──▶ AI agent (Gemini / Claude / scripted)
                     │ tools
                     ▼
              Agent platform ──────────────▶ Adyen Commerce Suite (ACP)
              (holds the card)   checkout_sessions create / update / complete
                     │                              │  quote, commit, finalize
                     │ delegate_payment             ▼
                     └────────▶ Adyen PAL ──token──▶ Merchant ──POST /payments──▶ Adyen Checkout
```

1. The agent reads the merchant's product feed and calls `POST /checkout_sessions` with the items. Adyen asks the merchant for stock, shipping options, tax and totals.
2. The agent selects a shipping option with `POST /checkout_sessions/{id}` until the session is `ready_for_payment`.
3. The shopper approves the exact total in the terminal. The platform then calls `POST /agentic_commerce/delegate_payment` with the vaulted card and an `allowance` (`one_time`, `max_amount` = session total, bound to the session and the merchant, 15-minute expiry). The LLM never sees card data; the tool takes only a session id.
4. The agent calls `POST /checkout_sessions/{id}/complete` with `payment_data.token`. Adyen asks the merchant to commit (risk and price re-check) and finalize.
   - **advanced flow** (default): the merchant calls `POST /payments` with `paymentMethod.storedPaymentMethodId = <token>`, `shopperInteraction: ContAuth`, `recurringProcessingModel: UnscheduledCardOnFile`.
   - **standard flow** (`MERCHANT_FLOW=standard`): Adyen authorises and the merchant only records the order.
5. The session becomes `completed` with `order.id` and `order.permalink_url`.

## Run

Requires Node 23.6+ (TypeScript runs natively, no build step).

```bash
npm install
npm run demo          # mock Adyen + merchant + agent, auto-approved, full HTTP trace
npm test              # 19 contract and end-to-end tests
```

Chat with a real LLM agent (servers in one terminal, agent in another):

```bash
npm run servers
GEMINI_API_KEY=... npm run agent -- "2 paket kahve çekirdeği ve filtre kağıdı al"
```

| Provider | Cost | Key |
|---|---|---|
| `gemini` (default when a key is set) | Free tier available on Google AI Studio, with rate limits | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) |
| `claude` | Paid API usage | `ANTHROPIC_API_KEY` from the Claude Console |
| `scripted` | Free, no LLM | none; deterministic keyword matcher, used by tests |

`GEMINI_MODEL` / `CLAUDE_MODEL` override the model. If the free tier rejects a model with a quota error, try a Flash-Lite model such as `gemini-3.5-flash-lite`. The Claude client enables server-side refusal fallbacks (`fallbacks: "default"`).

Things to try in the chat: an out-of-stock item (the gooseneck kettle), express shipping, changing quantities, declining the approval, or `AGENT_TEST_CARD=4000000000000002` for a declined payment.

## Against the real Adyen test environment

```bash
ADYEN_MODE=test \
ADYEN_COMPANY_ACCOUNT=... ADYEN_MERCHANT_ACCOUNT=... \
ADYEN_COMMERCE_SUITE_API_KEY=... ADYEN_AGENTIC_TOKEN=... ADYEN_CHECKOUT_API_KEY=... \
npm run agent
```

| Call | Test host | Auth |
|---|---|---|
| ACP checkout sessions | `https://commerce-suite-test.adyen.com/commerce-suite/acp/v1/{companyAccount}` | `Authorization: Bearer` key with the Commerce Suite API role |
| delegate_payment | `https://pal-test.adyen.com/paltokenization/servlet/Recurring/Agentic/acp/v1` | `Authorization: Bearer` dedicated agentic token, `API-Version: 2025-09-29` |
| /payments | `https://checkout-test.adyen.com/v72` | `X-API-Key` |

Prerequisites from Adyen's docs: Delegated Payment access, the agentic token, merchant accounts enabled for Agentic Commerce, PCI DSS Level 1 and Adyen's security review for the agent platform. Adyen must also be able to reach the merchant server, so expose it publicly and register it with Adyen.

## What is documented and what is assumed

Taken from Adyen's docs: endpoint paths and hosts, headers, request fields for sessions, complete and delegate_payment, token scoping rules (single use, bound to session and merchant, capped by `max_amount`, expiry), error codes (`invalid_card` with `param`, `idempotency_conflict`), session statuses and `messages[]`, and the `/payments` fields for the ACP token.

Assumed by this POC, to confirm with Adyen:

- The merchant hooks Adyen calls. The docs' sequence diagram names `/agentic/sessions/{id}/commit` and `/finalize`; the quote hook (`POST /agentic/quote`) and all hook bodies are this POC's own design.
- `paymentMethod.type: "scheme"` in `/payments`; the ACP pages do not state it.
- `shopperReference` set to the checkout session id, as the merchant page says.
- delegate_payment returns 201 with `id` (the two Adyen pages disagree on 200 vs 201 and on the response fields).
- No `Signature` header; Adyen recommends HMAC-SHA256 but does not document the signing string or key.
- Webhooks are not modelled.

## Layout

```
src/
  acp.ts                 ACP types (session, line items, totals, messages)
  config.ts              env-driven hosts and keys, mock vs test
  http.ts                tiny JSON router and traced fetch, card redaction
  mock-adyen/server.ts   fake Commerce Suite, PAL delegate_payment, Checkout /payments
  merchant/server.ts     catalog, quote/commit/finalize hooks, /payments call, orders
  agent/platform.ts      agent platform: Adyen ACP client and card vault
  agent/tools.ts         tools exposed to the LLM, shopper approval gate
  agent/llm/*.ts         Gemini, Claude and scripted agents
  agent/cli.ts           interactive chat
  demo.ts, servers.ts
test/flow.test.ts
```

Test card numbers in the mock: anything ending in `0002` is refused, everything else is authorised. All data is fake; do not put real card numbers in this repo.
