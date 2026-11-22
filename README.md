# Agentic commerce POC: an AI agent shops and pays

ACP with Stripe Shared Payment Tokens (real Stripe test mode), the cart bound to the shopper's approval with Mastercard Verifiable Intent, plus Google UCP and ACP via Adyen (mocked). A chat UI in the browser runs it with Claude Haiku or Gemini.

**Question:** can an AI agent pay a merchant, and how small is the merchant side?
**Short answer from this repo:** small. An agent purchase ends as one ordinary payment call: a Stripe PaymentIntent confirmed with a Shared Payment Token, or an Adyen `POST /payments`. The **Stripe path runs against the real Stripe test API** (`npm run stripe:live`). The Adyen paths run only against a local mock, because Adyen test signup is closed.

> **What this proves / what it does not**
>
> | Proven by running this repo | Not proven |
> |---|---|
> | **Real provider:** a merchant-hosted ACP checkout charges a Stripe Shared Payment Token (SPT) as a real PaymentIntent in Stripe **test mode**, visible in the Dashboard. Refunds go to the real `/v1/refunds` | The SPT is granted by Stripe's **test helper**, standing in for the agent platform (for example OpenAI/ChatGPT). No real agent platform has issued a token to this merchant. Live keys are refused |
> | Stripe enforces the token's limits: single use, `max_amount`, expiry. A declined card is recoverable with a new token | Stripe webhooks (`payment_intent.*`, `shared_payment.granted_token.deactivated`) are not wired. An unknown outcome is resolved only by the agent's retry |
> | A merchant backend can expose Google UCP checkout and charge a Google Pay token through Adyen's documented `/payments` shape | No money, test or real, has moved through Adyen. Every `Authorised` comes from the local mock |
> | The LLM never sees card data or the SPT. The shopper approves the exact total, and a changed total is refused | The default demo has **no LLM**: it uses a scripted keyword matcher. Claude (Haiku) and Gemini run only with an API key, for example in the browser UI (`npm run web`) |
> | **Mastercard Verifiable Intent:** the payment is bound to the cart the shopper approved. A token and signature for one cart cannot pay another; the merchant refuses before charging | The issuer and Mastercard registration are a local mock. Stripe itself does not check the signature |
> | Unknown outcomes (timeouts, 5xx) never double-charge, on Stripe and Adyen alike. Retries resend the same idempotency key | Google has never called this merchant. Gemini or AI Mode needs Google onboarding and a public HTTPS endpoint |
> | Each order stores a consent record (what was approved, when, shipped where, paid how) | The approval screen is simulated. In production Google owns it, not the merchant |
> | Refunds go back to Adyen, and the `REFUND` webhook marks the order refunded (mock) | 3-D Secure is detected but cannot be completed. Capture, disputes and settlement are absent |
> | ACP: the same purchase through a mock of Adyen's Commerce Suite | ACP hook paths differ from Adyen's merchant page (see the ACP section). Adyen must enable ACP per account |
>
> **Real provider run = `npm run stripe:live`:** a scripted agent, a merchant-hosted ACP checkout and a real Stripe test-mode PaymentIntent. It needs only a `sk_test_` key. **Default run (`npm run demo`) = scripted agent + mocked Google Pay + mocked Adyen.**

## Real provider: ACP checkout hosted by the merchant, paid with a Stripe Shared Payment Token

This is how ACP works with Stripe and OpenAI. The seller implements the ACP checkout API itself. The agent platform keeps the shopper's card and delegates payment as a Shared Payment Token: single use, scoped to this seller, capped by `max_amount`, and expiring. The seller charges the token with an ordinary PaymentIntent. Stripe docs: [Shared Payment Tokens](https://docs.stripe.com/agentic-commerce/concepts/shared-payment-tokens) (seller view: `?agent-seller=seller`).

```bash
# .env: STRIPE_SECRET_KEY=sk_test_...   (the account needs the agentic commerce preview)
npm run stripe:live          # starts the merchant, runs the scripted agent, prints the PaymentIntent
```

It ends with something like:

```
PaymentIntent:  pi_3U...
status:         succeeded
dashboard:      https://dashboard.stripe.com/test/payments/pi_3U...
```

To chat instead, run `PROTOCOL=stripe npm run servers`, then `PROTOCOL=stripe npm run agent -- "Buy 2 bags of the coffee beans and a pack of paper filters"` (add `--yes` to auto-approve). Without `STRIPE_SECRET_KEY`, the same commands use a local mock Stripe on port 8082, and `npm test` always does.

```mermaid
sequenceDiagram
    actor S as Shopper
    participant A as Agent (LLM)<br/>scripted · Gemini · Claude
    participant P as Agent platform<br/>src/platform (card, key, L1)
    participant M as Merchant backend<br/>ACP API (this repo)
    participant N as Mastercard<br/>(MOCK issuer + VI service)
    participant T as Stripe<br/>(test mode)
    S->>A: "Buy 2 bags of coffee beans and filters"
    A->>M: POST /acp/checkout_sessions, then update with the shipping option
    M-->>A: ready_for_payment, line items, totals, merchant-signed checkout_jwt
    A->>P: pay_and_complete (session)
    P->>M: GET /.well-known/jwks.json, verify checkout_jwt matches the session
    P->>S: Approve $76.73? (the platform signs this exact cart)
    S-->>P: Approve
    P->>N: POST /verifiable-intent/registrations (L1 + L2, payment mandate disclosed)
    N-->>P: intent_id
    P->>T: test helper: grant SPT (max_amount = $76.73, 15 min, shared_metadata = checkout hash + intent id)
    T-->>P: spt_...
    P->>M: complete: payment_data { token: spt_..., verifiable_intent: { l1, l2, intent_id } }
    M->>N: issuer JWKS, GET registration (verify L1 → L2 chain first)
    M->>T: GET the SPT (shared_metadata must match), then POST /v1/payment_intents (metadata vi_checkout_hash, vi_intent_id)
    T-->>M: succeeded
    M-->>A: completed + order (consent record + Verifiable Intent stored)
```

| | Real | Simulated |
|---|---|---|
| Stripe API calls (`/v1/payment_intents`, `/v1/refunds`) | yes, Stripe test mode with header `Stripe-Version: 2026-09-30.preview` | |
| PaymentIntents and refunds | yes, visible in the Stripe Dashboard (test mode) | |
| Token limits: single use, `max_amount`, expiry | enforced by Stripe | |
| The SPT grant | | `POST /v1/test_helpers/shared_payment/granted_tokens` with the seller's own test key, standing in for the agent platform. In production the agent platform (for example OpenAI) creates the token from the shopper's saved card; the seller never calls this |
| The shopper's card | | Stripe test PaymentMethod `pm_card_visa` (`AGENT_STRIPE_PAYMENT_METHOD`), held only by the agent platform module |
| Mastercard Verifiable Intent issuer and registration service | | `src/mock-mastercard/server.ts` (port 8084), see the next section |
| The agent and the approval screen | | scripted agent, auto-approved in `stripe:live`; in production the platform owns both |

**Merchant ACP API** (bearer `MERCHANT_ACP_API_KEY`, default `mock_merchant_acp_key`): `POST /acp/checkout_sessions`, `GET|POST /acp/checkout_sessions/:id`, `POST /acp/checkout_sessions/:id/complete` (with `Idempotency-Key`), `POST /acp/checkout_sessions/:id/cancel`. Statuses: `not_ready_for_payment`, `ready_for_payment`, `in_progress`, `completed`, `canceled`. Pricing, stock, the risk limit and the consent record are the same code as the Adyen ACP hooks.

**Outcomes of the PaymentIntent** (amount = the approved session total, `metadata` = `checkout_session_id`, `order_id`, `agent_protocol: ACP`, `vi_checkout_hash`, `vi_intent_id`, idempotency key `<session>-<order>`, fixed per payment attempt). Before any of these, a failed Verifiable Intent check answers `ready_for_payment` with an `intent_verification_failed` error message and charges nothing:

- `succeeded` → `completed` with `order`. The order stores the `pi_...` and the consent record.
- `requires_action` → back to `ready_for_payment` with a `requires_3ds` message. Nothing is charged; 3DS completion is not built.
- 4xx `card_error` (decline) or `invalid_request_error` (token used, expired, or over `max_amount`) → `ready_for_payment` with a recoverable `payment_declined` message. The agent asks the shopper to approve again and gets a new token.
- Timeout, network error, 5xx or 429 → stays `in_progress` with an info `payment_pending` message, stock stays reserved, and `cancel` is refused. Completing again with the same token resends the identical PaymentIntent request with the same idempotency key, so Stripe returns the first result instead of charging twice. The pay tool does this itself, without asking the shopper again. A different token gets 409.
- Other 4xx (bad API key, idempotency conflict) → `payment_failed`, nothing charged.

**Refund:** `POST /orders/:id/refund` on a Stripe order calls `POST /v1/refunds` with `payment_intent`. A synchronous `succeeded` sets `order.refund.status` to `refunded` and answers 200.

Checked live against the Stripe test API on 2026-11-21: grant, charge, reuse (400 "already in a deactivated state"), over-limit (400 "greater than the remaining amount capturable"), `pm_card_chargeDeclined` (402 `card_error` `card_declined`; the token stays active afterwards), `pm_card_authenticationRequired` (200 `requires_action`, `next_action.type: shared_payment_token_action`), refund. Also checked live: the test helper accepts `shared_metadata[...]` on the grant, and the seller's `GET /v1/shared_payment/granted_tokens/{id}` returns it. The local mock (`src/mock-stripe/server.ts`) reproduces these responses.

## Mastercard Verifiable Intent: the payment is bound to the cart the shopper approved

**The problem.** A Shared Payment Token is not bound to a cart. Its only limits are `usage_limits` (currency, `max_amount`, `expires_at`), plus `agent_details`, `payment_method_details` and `shared_metadata`. An SPT granted for one cart was accepted by Stripe for an unrelated "gift card" PaymentIntent of a lower amount.

**What this repo adds.** [Mastercard Verifiable Intent](https://verifiableintent.dev/spec/) (VI), **Immediate Purchase mode**, spec v0.1-draft (2026-02-18), checked against the reference implementation [agent-intent/verifiable-intent](https://github.com/agent-intent/verifiable-intent). VI is mandatory for `PROTOCOL=stripe`: a complete without a VI presentation gets 422. The shopper's key signs the exact merchant-signed cart. The merchant and the card network each verify that signature chain before money moves. The SPT stays the payment instrument.

### The four roles

| Role | Code | Holds | Does |
|---|---|---|---|
| **Agent platform** | `src/platform/platform.ts` | The card reference (`pm_card_visa`), the shopper's ES256 key pair, the shopper's L1 credential | Enrols the key with the issuer once and gets L1. On `pay_and_complete` it fetches the merchant JWKS, verifies the `checkout_jwt` and checks that it matches the session shown to the shopper. Then it asks for approval through the existing `confirm` callback (the CLI prompt or the web modal), signs L2, registers the intent with the network, grants the SPT with `max_amount` = the approved total and `shared_metadata` = `vi_checkout_hash` and `vi_intent_id`, and sends `payment_data { provider, token, verifiable_intent: { l1, l2, intent_id } }`. The toolset reaches it only through the `PaymentAuthority` interface (`paymentLabel`, `authorize`). The LLM never sees the key, the credentials, the JWTs, the SPT or the card (asserted in `test/stripe.test.ts`) |
| **Merchant** | `src/merchant/verifiable-intent.ts`, `acp-server.ts` | Its own ES256 key; JWKS at `/.well-known/jwks.json` | Returns a merchant-signed `checkout_jwt` in every ACP session response, re-signed whenever the cart changes (and on GET when it is near expiry). Before charging, it verifies: L1 against the issuer JWKS (trusted issuers only); L2 against L1 `cnf.jwk`; `typ`; `sd_hash`; `exp`/`iat` with 300 s skew; lifetime ≤ 15 min; `aud`; the nonce has not been used here; every disclosure is committed in `_sd` and `delegate_payload`; no `cnf`/`constraints`; `checkout_hash` and `transaction_id` recompute. The disclosed `checkout_jwt` must be exactly the latest one it issued for this session, and its own signature must verify. `payment_amount` = `checkout_jwt` total = session total; `payee.id` = itself. The intent is registered at the network with the same hash, nonce, amount and payee. The SPT's `shared_metadata` names this intent. Only then does it charge, writing `vi_checkout_hash` and `vi_intent_id` into the PaymentIntent metadata and the order |
| **Card network (MOCK)** | `src/mock-mastercard/server.ts`, port 8084 | Issuer signing key | Issuer role: JWKS at `/.well-known/jwks.json`; `POST /issuer/credentials` issues L1 for the platform's public key. MCS role: `POST /verifiable-intent/registrations` verifies the L1 → L2 chain, expiry and nonce uniqueness (409 on replay) and returns `intent_id`; `GET /verifiable-intent/registrations/:id` |
| **PSP** | Stripe (real test mode, or `src/mock-stripe`) | The card | Enforces SPT limits and charges |

Credentials, as built (claim names from the spec):

- **L1** (`typ: sd+jwt`, issuer-signed): `iss`, `sub`, `iat`, `exp` (1 year), `vct: https://credentials.mastercard.com/card`, `cnf.jwk` (shopper public key), `pan_last_four`, `scheme`, `_sd_alg: sha-256`, `_sd` (the email is selectively disclosable).
- **L2 Immediate** (`typ: kb-sd-jwt`, signed with the L1 `cnf.jwk` key): `nonce`, `aud`, `iat`, `exp` (15 min), `sd_hash` = B64U(SHA-256(serialized L1)), `delegate_payload` and `_sd` referencing two array-element disclosures. One is the checkout mandate `mandate.checkout.1` { `checkout_jwt`, `checkout_hash` }. The other is the payment mandate `mandate.payment.1` { `payment_instrument`, `payment_amount` {currency, amount in minor units}, `payee` {id, name, website}, `transaction_id` = `checkout_hash` }.
- **`checkout_jwt`** (ES256, `typ: JWT`, merchant key): `iss` (merchant website), `sub` and `checkout_session_id`, `jti`, `iat`, `exp` (1 h), `merchant` {id, name, website}, `currency`, `line_items` [{sku, title, quantity, unit_price, subtotal, tax, total}], `fulfillment` {option_id, title, amount, address}, `subtotal`, `tax`, `total`.

### What the tests show (`test/verifiable-intent.test.ts`, offline)

All of these are rejected with `intent_verification_failed`, no PaymentIntent and no order:

- the "gift card" attack: a valid presentation plus SPT for one cart, used on another session;
- a presentation for a cart that was changed afterwards;
- a tampered `checkout_jwt` with the price changed;
- `payment_amount` ≠ total;
- a foreign payee;
- an L2 signed by a key that is not in L1;
- an L1 from an unknown issuer, or with a forged issuer signature;
- an expired L2;
- a replayed nonce;
- an intent unknown to the network.

The platform refuses to sign or pay, and asks for no approval, when the merchant JWKS does not verify the `checkout_jwt` or when the signed cart differs from the session. The network refuses a wrong `aud`, a mismatched `sd_hash` and nonce replay.

### What is simulated

- **The issuer and the network are a local mock, not Mastercard.** The startup log says so. No Mastercard system was called. The issuer trusts whatever `pan_last_four` and `scheme` the platform declares at enrolment. The test card is a Stripe Visa test PaymentMethod, not a Mastercard.
- **All keys are generated in memory at startup** (issuer, merchant, shopper device) and are lost on restart. There is no device binding, user authentication or passkey behind the shopper's key. Approval is the existing modal or the `--yes` flag.
- **One Stripe account plays every role**: the platform grants the SPT with the seller's own test key through the test helper, as before.
- The platform trusts the merchant JWKS at `MERCHANT_URL/.well-known/jwks.json`. There is no merchant directory.

### What Stripe still does not enforce

VI binds the payment to the cart **at this merchant's checkout and at the network**. Stripe itself knows nothing about VI: a PaymentIntent created directly with the SPT, outside this merchant's `complete` (for example by a compromised merchant backend), is not stopped by Stripe as long as it fits `usage_limits`. `shared_metadata` is informational and is checked only by this merchant. A real card network would enforce the registered intent at authorization time; this mock does not see the authorization.

### Spec deviations and assumptions

- `checkout_jwt` schema is implementation-defined in v0.1 (§6.3); ours is listed above and puts the line items and the total in it. It is merchant-signed, as §6.3 recommends.
- The spec's presentation pattern (README §4.3) does not disclose the payment mandate to the merchant. Here the merchant gets the full L2 (both mandates) so it can require `payment_amount` = `checkout_jwt` total = session total. The network gets the payment mandate only.
- L2 `aud` is the agent platform identifier (`AGENT_PLATFORM_ID`, default `https://agent-platform.example`), per the normative §4.3 table. The §11.1 example uses a network URL instead. Merchant and network accept only configured platform identifiers. The agent platform also acts as the wallet that holds the user key.
- The nonce is generated by the platform. Merchant and network each reject a reused nonce (in-memory sets, lost on restart). There is no verifier-issued challenge.
- `payment_instrument.type` is `stripe.payment_method` and `id` is the Stripe PaymentMethod id, instead of an SRC digital card. `payee.id` is required here (`MERCHANT_ID`, default `brew-and-co`), although the spec makes it optional.
- One mandate pair per L2; multi-pair L2s and Autonomous mode (L3) are rejected.
- The presentation is sent as `payment_data.verifiable_intent { l1, l2, intent_id }`, each serialized as `<jwt>~<disclosure>~…~`. This is an extension field on ACP `payment_data`, and `checkout_jwt` is an extension field on the ACP session.
- The merchant also requires the SPT's `shared_metadata` (`vi_intent_id`, `vi_checkout_hash`) to match the presented intent. This is this POC's own binding, not part of VI.
- Not implemented: L1 key rotation and revocation, and a status lifecycle for intents (the mock never marks an intent consumed).

## The purchase, step by step (Google UCP, mocked)

```mermaid
sequenceDiagram
    actor S as Shopper
    participant A as AI agent<br/>(Gemini · scripted by default)
    participant G as Google Pay<br/>(MOCK)
    participant M as Merchant backend<br/>(this repo)
    participant Y as Adyen<br/>(MOCK by default)
    S->>A: "Buy 2 bags of coffee beans and filters"
    A->>M: Discover (/.well-known/ucp), create checkout, choose shipping
    M-->>A: Line items, shipping, tax, total
    A->>G: Show the exact total
    G->>S: Approve $76.73?
    S-->>G: Approve
    G-->>A: Encrypted token for gateway "adyen"
    A->>M: Complete checkout with the token
    M->>Y: POST /payments (googlepay token, amount, agent metadata)
    Y-->>M: Authorised
    M-->>A: Order placed (consent record stored)
    Y->>M: AUTHORISATION webhook (HMAC-signed)
```

## UCP or ACP?

| | **Google UCP + Google Pay** (default) | **ACP via Adyen** (secondary) |
|---|---|---|
| Who runs the checkout | The merchant's backend [doc] | Adyen Commerce Suite, which calls the merchant's hooks [doc] |
| Who authorises the payment | The merchant, with its own `/payments` call [doc] | Adyen in the standard flow, which Adyen recommends. The merchant in the advanced flow, which this POC defaults to [doc] |
| Merchant of record | The merchant ("You remain the Merchant of Record") [doc] | Not stated on Adyen's pages. Expected to be the merchant [assumption] |
| Fraud liability | The POC models `PAN_ONLY`, which has no liability shift. `CRYPTOGRAM_3DS` (Android device tokens) can shift it [doc] | Stored-credential charge without the shopper present (`ContAuth`), no 3DS. Fraud chargebacks are likely the merchant's [assumption] |
| PCI scope | Same as an existing Google Pay integration: the token is passed on unread [doc] | The merchant sees a token, not card numbers. The agent platform must be PCI DSS Level 1 [doc] |
| Reach | AI Mode in Google Search; Gemini app announced [doc] | Agent platforms that have integrated with Adyen [doc]. Which ones are live is not stated |
| Onboarding gate | Google Pay setup, Merchant Center feed, Google production access [doc] | Adyen account-manager enablement. Calls return 403 until then [doc] |
| Testable today without anyone's permission | Yes: the merchant → Adyen leg | No |

Recommendation: build UCP + Google Pay first. Ask Adyen about ACP enablement in parallel, because enablement has its own lead time.

## Run

Requires Node 23.6+ (TypeScript runs natively, no build step).

```bash
npm install
npm run stripe:live          # real provider: ACP + Stripe SPT against Stripe test mode (needs sk_test_ key)
npm run demo                 # UCP + Google Pay, scripted agent, auto-approved, full HTTP trace
PROTOCOL=acp npm run demo    # same purchase over ACP via the Adyen mock
PROTOCOL=stripe npm run demo # merchant-hosted ACP + Stripe (mock Stripe unless STRIPE_SECRET_KEY is set)
npm test                     # 113 tests, all offline: contract, end to end, HMAC vectors, config, LLM loops, Stripe SPT, Verifiable Intent
```

### Shop in the browser

```bash
PROTOCOL=stripe npm run web  # http://localhost:8090 — chat UI, live cart, payment approval sheet, order card with Stripe Dashboard link
```

The page runs the agent with the LLM from `.env`, starts the merchant and the mock Mastercard, and binds to `127.0.0.1` only. You chat in any language. The cart panel updates as the agent works. Paying opens an approval sheet showing the exact items, shipping, tax and total. After you approve, the order card shows the Stripe PaymentIntent and the Verifiable Intent checkout hash and intent id.

### Chat in the terminal

Start the servers with `npm run servers`. Then, in another terminal:

```bash
PROTOCOL=stripe npm run agent -- "2 paket kahve çekirdeği ve filtre kağıdı al"
```

| `LLM_PROVIDER` | Cost | Key | Measured |
|---|---|---|---|
| `claude` (default when `ANTHROPIC_API_KEY` is set; model `claude-haiku-5-5`, effort `low`) | paid API usage | `ANTHROPIC_API_KEY` | one purchase in about 9 s |
| `gemini` (default when only a Gemini key is set) | free tier on Google AI Studio, rate limited | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) | the same purchase in about 94 s on the free tier |
| `scripted` | free, no LLM | none; deterministic keyword matcher used by tests | |

The timings come from one run each of the same Turkish request against Stripe test mode on 2026-11-21. They are not a benchmark.

`GEMINI_MODEL` / `CLAUDE_MODEL` override the model (Gemini default `gemini-3.6-flash`). `AGENT_CLAUDE_EFFORT` overrides the Claude effort level. Each Gemini request times out after 60 s with at most 3 attempts. If Google answers 503 "high demand" or a quota error, switch the model, for example `GEMINI_MODEL=gemini-3.5-flash-lite`. `ADYEN_MODE` (`mock` | `test`), `PROTOCOL` (`ucp` | `acp` | `stripe`) and `MERCHANT_FLOW` (`advanced` | `standard`) reject any other value at startup. `STRIPE_SECRET_KEY` must start with `sk_test_` (real Stripe test API) or be unset (local mock); a `sk_live_` key refuses to start, because live SPTs must come from a real agent platform. `STRIPE_API_BASE` overrides the Stripe host. With `PROTOCOL=stripe`, `npm run servers`, `npm run web` and `npm run stripe:live` also start the mock Mastercard on `MOCK_MASTERCARD_PORT` (default 8084; `MASTERCARD_URL` overrides its URL). `AGENT_PLATFORM_ID` and `MERCHANT_ID` set the L2 audience and the payee id.

Stripe test PaymentMethods (set `AGENT_STRIPE_PAYMENT_METHOD`, real and mock): `pm_card_visa` succeeds, `pm_card_chargeDeclined` is declined, `pm_card_authenticationRequired` needs 3DS. Adyen mock test cards (set `AGENT_TEST_CARD`): `…1111` is authorised, `…0002` is refused for insufficient balance, and `…0044` triggers a 3-D Secure challenge (UCP: `requires_escalation`). Other things to try in chat: the out-of-stock gooseneck kettle, express shipping, changing quantities, closing the Google Pay sheet.

## Google UCP flow in detail

1. **Discover.** `GET /.well-known/ucp` lists the `dev.ucp.shopping` REST endpoint, the checkout and fulfillment capabilities, and a `com.google.pay` handler. That handler uses `PAYMENT_GATEWAY` tokenization with `gateway: adyen` and `gatewayMerchantId` set to the Adyen merchant account.
2. **Checkout.** `POST /checkout-sessions` returns `incomplete` with `missing` messages. `PUT /checkout-sessions/{id}` replaces the whole checkout; once a shipping option is selected, the status becomes `ready_for_complete`.
3. **Approve.** The Google Pay sheet shows the line amounts before tax, then shipping, tax and total, and these add up. It returns `credential: { type: "PAYMENT_GATEWAY", token }`.
4. **Complete.** `POST /checkout-sessions/{id}/complete` (with `Idempotency-Key`). The merchant forwards the token unchanged:
   ```json
   { "merchantAccount": "…", "amount": { "value": 7673, "currency": "USD" }, "reference": "ord_…",
     "paymentMethod": { "type": "googlepay", "googlePayToken": "<token>" },
     "returnUrl": "https://merchant/checkout/chk_…",
     "metadata": { "agentProtocol": "UCP", "agentSessionId": "chk_…", "agentPlatform": "Google" } }
   ```
5. **Outcome.**
   - `Authorised` → `completed`, with `order.id` and `order.permalink_url`. The checkout is frozen at the charged total.
   - `Refused` → stays `ready_for_complete` with a recoverable `payment_declined` message.
   - `Error` (Adyen answered 4xx, or could not be reached) → `payment_failed`. Nothing was charged, and the shopper is not asked for another card.
   - `RedirectShopper` (3-D Secure) → `requires_escalation` with a `continue_url`. Orders above the risk limit (`high_value_order`) escalate the same way.
   - Unknown outcome (timeout, HTTP 5xx, a 200 without a readable result, 422/704, `Pending`, `Received`) → stays `complete_in_progress` with an info `payment_pending` message. A `complete` with the same instrument resends the identical `/payments` request, with the same reference and idempotency key. The pay tool does this itself, without asking again, and returns the completed order if the webhook settled it first. Meanwhile, a different instrument and `cancel` get 409. With no retry and no webhook, the checkout stays pending and its stock stays reserved, because the payment may have been taken.
   - Stock is reserved during the Adyen call, so concurrent checkouts cannot oversell. Only a definitive result releases a reservation.
6. **Webhook.** The merchant verifies the HMAC signature. An `AUTHORISATION` webhook settles a pending payment only when its amount and currency match the pending payment. Without `ADYEN_HMAC_KEY`, every webhook is rejected (`ADYEN_WEBHOOK_INSECURE=1` opts out).

## ACP flow via Adyen (mock)

Adyen docs: [Agentic Cart API integration (merchant side)](https://docs.adyen.com/online-payments/agentic-commerce/merchant/agentic-cart-api-integration), and [AI agent integration with ACP (agent-platform side)](https://docs.adyen.com/online-payments/agentic-commerce/agent-platform/ai-agent-integration-acp).

The agent creates and updates the session on Adyen's Commerce Suite. Adyen asks the merchant for quotes. The agent tokenizes the card with `delegate_payment`: the token is single use, bound to the session and the merchant, and capped by `max_amount`. On complete, Adyen calls the merchant's commit hook (re-quote, reserve stock, store the approved total and the consent record) and then its finalize hook, which charges only the approved total.

In the advanced flow (the POC default) the merchant charges the token with `POST /payments`. Adyen recommends the standard flow, where Adyen authorises, unless the merchant must control the payment request (`MERCHANT_FLOW=standard`). On an unknown outcome, finalize answers `Pending` and keeps the approval and the reservation. Completing the session again resends the identical `/payments` request.

ACP webhooks are only attached to orders; they do not settle a pending ACP payment. Making them do so would need a second settle path in the merchant and in the mock Commerce Suite. That is listed under "Before production".

## After the order

- **Consent record.** `GET /orders/:id` returns `consent`: the protocol, the checkout id, the approved line items (before tax), subtotal, shipping, tax and total, the shipping address, the buyer email, the payment label (for example `Google Pay VISA •••• 1111`) and `approvedAt`. `approvedAt` is when the merchant received the approved completion (UCP complete, ACP commit); the platform sends no timestamp of its own.
- **Refund.** For Stripe orders, see the Stripe section. For Adyen orders, `POST /orders/:id/refund` refunds the full amount with Adyen `POST /payments/{pspReference}/refunds` (idempotency key `<order>-refund`). It answers 202 `received`, and the `REFUND` webhook then sets `order.refund.status` to `refunded` or `failed`. A second refund is refused with 409. The checkout's `terms_of_service` and `refund_policy` links (`/terms`, `/refunds`) serve placeholder text.

## Against Adyen's test environment

UCP path: the merchant talks to the real Checkout API, using a real Google Pay test token.

```bash
ADYEN_MODE=test ADYEN_MERCHANT_ACCOUNT=... ADYEN_CHECKOUT_API_KEY=... ADYEN_HMAC_KEY=... \
GOOGLE_PAY_TOKEN=@token.json npm run servers
```

Generate `token.json` with Google's Google Pay Code Generator, using gateway `adyen` and your merchant account as `gatewayMerchantId`. The token binds the gateway merchant and an expiry, not an amount: Adyen charges whatever amount the merchant sends. In test mode, `ADYEN_CHECKOUT_API_KEY` is required at startup, and no `mock_*` credential or default secret is ever used.

ACP path: also set `ADYEN_COMPANY_ACCOUNT`, `ADYEN_COMMERCE_SUITE_API_KEY`, `ADYEN_AGENTIC_TOKEN` and `MERCHANT_HOOK_SECRET`. Without the hook secret, every hook call is rejected. Adyen must enable Agentic Commerce for the account.

| Call | Test host | Auth |
|---|---|---|
| Checkout `/payments`, `/payments/{psp}/refunds` | `https://checkout-test.adyen.com/v72` | `X-API-Key` |
| ACP checkout sessions | `https://commerce-suite-test.adyen.com/commerce-suite/acp/v1/{companyAccount}` | `Authorization: Bearer` (Commerce Suite API role) |
| ACP `delegate_payment` | `https://pal-test.adyen.com/paltokenization/servlet/Recurring/Agentic/acp/v1` | `Authorization: Bearer` agentic token, `API-Version: 2025-09-29` |

## Confirmed by the docs vs our guess

Confirmed by the docs:

- UCP 2026-01-23: checkout endpoints and statuses, PUT as full replacement, message severities, the `PAYMENT_GATEWAY` credential at `payment.instruments[].credential.token`, the `com.google.pay` handler. The discovery `services` entry follows the overview page's profile example; the same page's field table describes a nested `rest.endpoint`, so the page contradicts itself.
- Adyen Google flow: `googlepay` + `googlePayToken`, `metadata.agentProtocol/agentSessionId/agentPlatform`, gateway `adyen`.
- Adyen ACP advanced flow `/payments` fields: `storedPaymentMethodId` (the token), `shopperReference` (the session id), `shopperInteraction: ContAuth`, `recurringProcessingModel: UnscheduledCardOnFile`. Also the `delegate_payment` request fields and token scoping.
- Webhook HMAC: the signing string order is pinned by a known-answer test (`test/unit.test.ts`), with the expected value computed separately with `openssl`.

Our guess, to confirm before production:

- ACP merchant hooks. The mock uses `/agentic/quote` plus `/agentic/sessions/{id}/commit` and `/finalize`, all with a bearer secret. Adyen's merchant page documents something else: `POST /agentic/sessions/{id}` for create and update, optional `commit` and `cancel`, `finalize` (standard flow), `complete` with the token (advanced flow), an `X-Merchant-Account` check on commit and finalize, and a five-second response limit. The mock's `delegate_payment` responses (201 with `created`/`metadata`; 400 `invalid_card`) also differ from Adyen's (200 with `id` and `expires_at`).
- UCP details that only appeared in summarised spec text: the postal address field names and the shape of the response `ucp` envelope.
- UCP deviations: `Idempotency-Key`, `Request-Id` and `Request-Signature` are required by the spec, but only `UCP-Agent` is required here. `continue_url` is sent only for `requires_escalation`. Version negotiation and `signing_keys` are not implemented. A duplicate `complete` while the first is running gets 409.
- The mock decrypts nothing: its Google Pay token wraps a base64 JSON payload. Its amount check is a stand-in; the real guard is the platform-side total check in the pay tool.
- Checkout API `v72`. The `RedirectShopper` → `requires_escalation` mapping is this POC's choice, and 3DS completion is not built.

## Before production

- **Stripe:** a webhook endpoint with signature verification for `payment_intent.succeeded` / `payment_intent.payment_failed` (to settle an `in_progress` session without the agent's retry) and `shared_payment.granted_token.deactivated`. ACP request signing and `API-Version` negotiation on the merchant ACP API. A real agent platform (for example OpenAI) as the token issuer, which ends the use of the test helper. The official `stripe` Node library behind the existing outcome mapping.
- **Payment attempts:** one persistent `PaymentAttempt` store shared by UCP and ACP, so webhooks can settle ACP too. Sessions, reservations (conditional decrement), orders and the idempotency cache move into the same database. Store the reference, amount and token hash, never the payment credential.
- **Webhooks:** a durable queue after HMAC verification, with dedupe, explicit handling of unknown references, and a reconciliation job for payments stuck in `complete_in_progress`. Handle `CAPTURE`, `CANCELLATION` and `CHARGEBACK`.
- **Adyen:** the official Node library for Checkout and HMAC, behind the existing outcome classification. Contract tests from recorded test-mode traffic. Live-endpoint URL prefix.
- **UCP:** `Request-Signature` verification, published `signing_keys`, an agent allow-list, idempotency scoped by verified agent, version negotiation.
- **State machine:** an explicit UCP status field with a transition table, instead of a status derived from several fields. Expiry moved out of reads, with an injected clock.
- **Config:** injected rather than global, loaded from a secret manager, with strict per-environment validation.
- **Back office:** authentication on `POST /orders/:id/refund` (open in this POC); partial refunds; capture on shipment.
- **Operations:** structured logs, metrics and traces keyed by checkout, merchant reference and pspReference. No internal details in 500 responses. Edge validation from the UCP/ACP OpenAPI schemas. `MerchantStore` split into catalog, pricing/tax, inventory and orders.
- **Risk:** 3DS completion on the escalation path, a configurable risk limit, and signals beyond order value.

## Layout

```
src/
  domain.ts                   neutral types: Item, Address, Buyer, Product, formatAmount
  ucp.ts, acp.ts              protocol wire types
  config.ts, http.ts          env (validated), JSON/form router, traced fetch with card and SPT redaction, idempotency cache
  stripe-api.ts               Stripe auth, Stripe-Version header, form-encoded calls
  stripe-live.ts              npm run stripe:live
  adyen-hmac.ts               webhook HMAC sign/verify
  google-pay-mock.ts          mock Google Pay token format
  mock-adyen/server.ts        fake Checkout /payments + refunds, ACP Commerce Suite, PAL, webhooks
  mock-stripe/server.ts       fake SPT test helper, token retrieve, PaymentIntents, refunds
  mock-mastercard/server.ts   SIMULATED Mastercard: VI issuer (L1, JWKS) and intent registration service
  vi/                         Verifiable Intent: SD-JWT disclosures, L1/L2 issue and verify, checkout_jwt
  platform/platform.ts        agent platform: card reference, shopper key, L1, approval, L2 signing, SPT grant
  merchant/
    store.ts                  catalog, pricing, tax, shipping, orders with consent and refund
    ucp-server.ts             /.well-known/ucp and UCP checkout sessions
    acp-hooks.ts              quote/commit/finalize hooks Adyen calls for ACP; shared ACP pricing and approval
    acp-server.ts             merchant-hosted ACP checkout API (/acp/checkout_sessions) for Stripe
    adyen-checkout.ts         /payments and refund client
    stripe-payments.ts        PaymentIntent with an SPT, SPT retrieve, refund client
    verifiable-intent.ts      merchant key and JWKS, checkout_jwt signing, VI verification before the charge
    payment-outcome.ts        provider-neutral result codes and unknown-outcome classification
    server.ts                 routes, refunds, webhook receiver
  agent/
    ucp/                      UCP client, Google Pay sheet, tools
    acp/                      ACP client (Adyen Commerce Suite or merchant-hosted), Adyen delegate_payment, tools (pay through PaymentAuthority)
    llm/                      Gemini, Claude, scripted agents
    cli.ts, factory.ts, shopper.ts, toolset.ts
  web/server.ts, index.html   npm run web: chat UI, live cart, approval sheet, order card (SSE)
  backends.ts, servers.ts     start the merchant and the mocks the chosen protocol needs
test/ucp.test.ts, acp.test.ts, stripe.test.ts, verifiable-intent.test.ts, unit.test.ts, llm.test.ts, helpers.ts
```

All data is fake. Do not put real card numbers, real Google Pay tokens or Stripe keys in this repo; `.env` is git-ignored.
