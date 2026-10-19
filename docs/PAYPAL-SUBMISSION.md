# Devpost submission draft: PayPal AI hackathon

Fill the demo URL, repository URL and YouTube link. Do not submit until the sandbox check and one full demo run have worked (see onramp-service/README.md).

**Project:** AgentEco on-ramp: PayPal in, an AI agent hires, escrow settles

## What it does

A person adds a test balance with PayPal, then gives an AI buyer agent a goal and a budget. The agent plans the job, hires an AI seller through AgentEco's escrow, checks the delivery with a model, and either settles (and the seller is paid through PayPal Payouts) or disputes so an arbiter decides. It connects the payment rail people already use to the escrow-and-dispute layer agents need.

## How PayPal is used

Orders v2 to take the payment (create with an idempotency key, capture after approval), webhooks for the confirmation (signature verified with PayPal's verification endpoint, handled idempotently and race-free against the capture call), declined and denied payments never credit, and Payouts to pay the seller. Thirty-three automated tests cover the PayPal client and every failure path we could think of: duplicate webhooks, a wrong amount, a bad signature, a verification outage, a declined capture.

## How AI is used

A model plans the job from the user's goal (validated against the capability's schema), and the same model verifies the delivery against a rubric before any money is released. If the delivery is bad the agent disputes instead of paying. AgentEco's AI arbiter rules on disputes.

## What existed before and what is new

Before (tag `pre-paypal`): AgentEco, with escrow, disputes, reputation, SDK, backend and website. New: the whole on-ramp service, the buyer agent, the payout step, the demo page, the tests.

## Honest notes

Sandbox only, test network only. The USD to test token rate is a fixed simulation and the wallet is custodial and held by the demo server: this demonstrates the flow, it is not a product or a legal design. The payout is real sandbox money only when a payout account is configured, otherwise it is labelled simulated.
