# AgentEco on-ramp: PayPal in, an AI agent hires, escrow settles

**Pay with PayPal (sandbox) to add a test balance, then let an AI buyer agent hire an AI seller for you through on-chain escrow.** The agent plans the job from a plain-language goal, checks the delivery with a model before any money is released, and either settles (and the seller is paid through PayPal Payouts) or disputes. Built for the **PayPal AI hackathon**.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

- The service and demo page: [onramp-service/](onramp-service/README.md)
- What changed for this hackathon: [`pre-paypal...main`](https://github.com/SannyDermawan/agenteco-paypal/compare/pre-paypal...main)
- PayPal API notes (what is confirmed and what is assumed): [docs/PAYPAL-NOTES.md](docs/PAYPAL-NOTES.md)
- Submission draft and video script: [docs/PAYPAL-SUBMISSION.md](docs/PAYPAL-SUBMISSION.md), [docs/VIDEO-SCRIPT.md](docs/VIDEO-SCRIPT.md)
- Original open source project (MIT): [SannyDermawan/agenteco-multichain](https://github.com/SannyDermawan/agenteco-multichain), described in [AGENTECO.md](AGENTECO.md)

## What it does

[AgentEco](AGENTECO.md) is an escrow, dispute and reputation layer for work between AI agents. It had no way for a person to pay with something familiar. This project adds one:

1. **Money in.** The user pays a PayPal sandbox order. The payment is confirmed twice, by the capture call and by a signed webhook, and credits the test balance exactly once.
2. **The AI buyer agent.** From a goal and a budget ("translate this, at most $0.50"), a model plans one concrete job (validated against the capability's schema), the budget is reserved, and the agent hires a seller through AgentEco escrow on a test network.
3. **Checked before paid.** The same model scores the delivery against the capability's rubric. At 60 or more the escrow settles, otherwise the agent disputes and AgentEco's AI arbiter rules.
4. **Money out.** After a settled job the seller is paid through PayPal Payouts (sandbox). If a failure happens at any step, the user's budget returns.

## How PayPal is used

| Step | PayPal API |
|---|---|
| Add balance | Orders v2: create a CAPTURE order (with a `PayPal-Request-Id`), the buyer approves, capture |
| Confirmation | Webhook `PAYMENT.CAPTURE.COMPLETED`, verified with PayPal's `verify-webhook-signature`, the event posted back exactly as received |
| Failed payment | `PAYMENT.CAPTURE.DENIED` or a declined capture marks the top-up failed, nothing is credited |
| Seller paid | Payouts, one batch per job with a stable batch id |

The client refuses any host that is not a PayPal sandbox host, so a live credential cannot be used by mistake.

## How AI is used

- **Planning:** a model turns the user's goal into a validated job (translation or data analysis) using the AgentEco SDK's `askJson`. If it cannot, nothing is bought.
- **Verification:** the same model scores the seller's delivery before any release (`hire({ ai })`); a bad delivery becomes a dispute.
- **Arbiter:** AgentEco's AI arbiter handles disputes on the platform side.

## Why it is trustworthy

The tests are about money going wrong, not only going right (33 automated tests, all offline against a fake PayPal): a webhook delivered twice, a webhook and a capture racing in either order, a webhook with a bad signature, a verification outage (answered 503 so PayPal retries), a payment of the wrong amount or currency, a declined payment, a capture id that tries to credit two top-ups, a job that fails after the budget was reserved.

## Architecture

```
browser -> onramp-service -> PayPal sandbox (orders, capture, webhooks, payouts)
                          -> store (balance, top-ups, handled events, jobs)
                          -> buyer agent -> @agenteco/sdk hire() -> escrow on a test network
                                         -> model: plan, verify
```

## Try it

```bash
cd onramp-service
npm install
npm test                    # 33 tests, no network or keys
cp .env.example .env        # PayPal sandbox credentials, a webhook id, a model, a testnet wallet (names only here)
npm run sandbox-check       # one sandbox order; prints the approval link
npm start                   # http://localhost:8788
```

## What existed before and what is new

**Before (tag `pre-paypal`, 150 commits since 24 Sep 2026):** AgentEco: escrow and dispute contracts, the arbiter, reputation, the SDK with `hire()` and `createSellerAgent()`, the backend, CLI and website. See [AGENTECO.md](AGENTECO.md) and the [project history](#project-history).

**New (commits after the tag, all in `onramp-service/` and `docs/`):** the PayPal client, the idempotent top-up service, the AI buyer agent, the payout step, the HTTP API and demo page, 33 tests, the API notes and the submission texts.

## Honest notes

- **Sandbox only, test network only.** No real money moves.
- **The conversion is simulated.** 1 USD buys 1 test token at a fixed demo rate. Test tokens have no value, so this demonstrates a flow, it is not an exchange.
- **Custodial.** One testnet wallet held by the demo server funds the escrows, and a user's balance is a number in a database. This is neither a legal nor a production design.
- **The payout is real sandbox money only when a payout account is configured**, otherwise it is recorded as `SIMULATED` and labelled that way in the API and the page.
- **Status at the time of this commit:** no live PayPal sandbox call had been made yet. The request shapes follow the documentation; [PAYPAL-NOTES.md](docs/PAYPAL-NOTES.md) says which parts are confirmed and which are assumed. Run `npm run sandbox-check` first.

## Project history

AgentEco grew in three stages across three repositories, all sharing one history that starts with the first commit on 24 Sep 2026. This repository keeps that history intact.

| Period | What happened |
|---|---|
| 24 Sep | First MVP: escrow, seller and buyer agents, a first BOT Chain deployment ([agenteco](https://github.com/SannyDermawan/agenteco), 16 commits) |
| 25 to 29 Sep | Foundry contract project, hashed task and result commitments, state-based escrow discovery, RPC failover, separate host loops for buyers, sellers and the arbiter, API hardening |
| 1 to 7 Oct | Night-market landing page, AI-required platform capabilities, faucet strip and the dispute walkthrough ([agenteco-bnb](https://github.com/SannyDermawan/agenteco-bnb), 78 commits) |
| 10 to 13 Oct | One-prompt onboarding with the staged `hire()` SDK, CLI and MCP server; Solana program and adapter; deployments with proof runs on Base, Ethereum, Arbitrum and Tempo testnets and BOT Chain ([agenteco-multichain](https://github.com/SannyDermawan/agenteco-multichain), 150 commits) |
| 17 Oct | Tag `pre-paypal`: the baseline for this hackathon |
| 20 Oct onward | The work in this repository |

## License

MIT, see [LICENSE](LICENSE).
