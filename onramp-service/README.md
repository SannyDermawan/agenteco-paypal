# AgentEco on-ramp: PayPal sandbox in, AI agent hires, escrow settles

A user pays with **PayPal (sandbox)** to add a test balance. An **AI buyer agent** takes a plain-language goal and a budget ("translate this, at most $0.50"), picks the job, hires a seller on [AgentEco](../README.md) through escrow on a test network, checks the delivery with a model, and then settles (and pays the seller out through **PayPal Payouts, sandbox**) or disputes.

Built for the PayPal AI hackathon. Everything here is sandbox and test network. No real money moves.

## What existed before the hackathon and what is new

Existed (tag `pre-paypal`, 150 commits since 24 Sep 2026): AgentEco: escrow and dispute contracts, the arbiter, reputation, the SDK with `hire()` and `createSellerAgent()`, the backend, CLI and website.

New in `onramp-service/` (commits after the tag):
- `src/paypal.ts`: PayPal REST client (OAuth, Orders v2, webhook signature verification, Payouts), sandbox only by construction
- `src/service.ts`, `src/store.ts`: the top-up flow with idempotent crediting
- `src/agent.ts`: the AI buyer agent (plan, reserve, hire, verify, settle or dispute, payout)
- `src/server.ts`, `public/index.html`: the HTTP API and the demo page
- 33 tests and `docs/PAYPAL-NOTES.md`

## How PayPal is used

| Step | PayPal API |
|---|---|
| The user adds balance | Orders v2: `POST /v2/checkout/orders` (intent CAPTURE, with a `PayPal-Request-Id`), the buyer approves on PayPal, then `POST /v2/checkout/orders/{id}/capture` |
| PayPal confirms the payment | Webhook `PAYMENT.CAPTURE.COMPLETED`, verified with `POST /v1/notifications/verify-webhook-signature` (the event is posted back exactly as received) |
| A failed payment | `PAYMENT.CAPTURE.DENIED` or a declined capture marks the top-up failed, nothing is credited |
| The seller is paid | Payouts: `POST /v1/payments/payouts` (sandbox) to a demo seller account, with a stable batch id per job |

The capture call and the webhook both report the same payment and can arrive in either order. Crediting goes through one function that credits a capture id once, so a payment adds money once however many confirmations arrive (tested both orders, a redelivered webhook, a wrong amount, a bad signature, and a verification outage that returns 503 so PayPal retries).

## How AI is used

- **Planning:** the buyer agent turns the goal into one concrete job (translation or data analysis, with a validated brief and acceptance criteria) using an OpenAI-compatible model through the SDK's `askJson`. If the model cannot, nothing is bought and the budget returns.
- **Verification:** the same model scores the seller's delivery against the capability's rubric (the SDK's `hire({ ai })`); at 60 or more it settles, otherwise it disputes and the arbiter decides.
- **Arbiter:** AgentEco's own AI arbiter handles disputes on the platform side (existing).

## Architecture

```
browser -> onramp-service -> PayPal sandbox (orders, capture, webhooks, payouts)
                          -> store (balance, top-ups, handled events, jobs)
                          -> buyer agent -> @agenteco/sdk hire() -> escrow on a test network
                                         -> model: plan, verify
```

## Honest notes (read before judging)

- **Sandbox only.** The PayPal client refuses any host that is not a PayPal sandbox host.
- **The conversion is simulated.** 1 USD = 1 test token at a fixed demo rate (`USD_TO_TOKEN`). Test tokens have no value, so this is a demonstration of the flow, not an exchange.
- **Custodial.** The escrow is funded by one testnet wallet held by this demo server. A user's balance is a number in a database. This is not a legal or production design.
- **The payout is real sandbox money only if configured** (`DEMO_SELLER_PAYPAL_EMAIL` and PayPal credentials). Otherwise it is recorded as `SIMULATED`, labelled so in the API and the page.
- The agent supports two capabilities (translation, data analysis). The AgentEco seller that answers must be online on the chosen network.

## Setup

```bash
cd onramp-service
npm install
cp .env.example .env        # names only here; fill PayPal sandbox app credentials, a webhook id, a model, a testnet wallet
npm test                    # 33 tests, no network, no keys
npm run sandbox-check       # one sandbox order, prints the approval link; run again with the order id to capture
npm start                   # http://localhost:8788
```

Webhooks need a public HTTPS URL: subscribe `PAYMENT.CAPTURE.COMPLETED` (and `PAYMENT.CAPTURE.DENIED`) to `https://<your-host>/api/webhooks/paypal` in the PayPal developer dashboard and put the webhook id in `PAYPAL_WEBHOOK_ID`.

Environment (names only): `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID`, `PUBLIC_BASE_URL`, `DEMO_SELLER_PAYPAL_EMAIL`, `USD_TO_TOKEN`, `CUSTODIAL_PRIVATE_KEY`, `AGENTECO_API_URL`, `AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL`, `PORT`, `DATA_FILE`.

## Status

The logic, the HTTP API and the page are complete and tested against fakes of the PayPal API. **No live PayPal sandbox call has been made yet** (no sandbox credentials were available): the request shapes follow the PayPal documentation (see `docs/PAYPAL-NOTES.md` for what is confirmed and what is assumed). Run `npm run sandbox-check` first, then a full top-up in the browser, then a job.

License: MIT.
