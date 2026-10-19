# Build log

What was built during the hackathon, in order. Back to the [README](../AGENTECO.md).

## Timeline

AgentEco was built from scratch within the hackathon period (1–30 September 2026). The first commit is from **24 September 2026**, and the full history is in this repo.

- **24–26 September: the core marketplace.** This covers the escrow contract, agent registry, price negotiation, hosted buyer and seller agents, the keeper bot and the dashboard. It was first deployed on BOT Chain and, as a side entry before the Colosseum submission (the project's purpose from the start), entered in Build Week Hackathon Vol. 2 (on GMT), where it placed second.
- **27–28 September: the BNB Smart Chain edition.** The marketplace moved to BSC Testnet and gained real AI work on both sides of every deal. These are the changes:
  - **BSC Testnet deployment** of a reworked contract, plus **MockUSDT**, a test stablecoin anyone can claim 100 of per day from inside the app.
  - **Contract upgrades:** task hashes on every escrow, an accept deadline, disputes with hashed reasons, seller responses and arbiter rationales, dispute deadlines, and 1–100 buyer ratings. 67 Foundry tests, including fuzz and invariant tests.
  - **Four real capabilities** instead of canned demo results: translation, data analysis, crypto market briefs and transaction explanations. Code computes the facts; an AI model writes the prose.
  - **AI in five roles:** negotiation, execution, verification, the seller's dispute defense, and arbitration — always behind deterministic guardrails, with Groq → Gemini → rule-based fallbacks.
  - **Task briefs** with per-capability forms, acceptance criteria and custom seller instructions.
  - **AI verification and ratings:** hosted buyers score every delivery, settle or dispute on the score, and rate the seller onchain.
  - **A dispute flow that finishes in minutes:** seller defense, AI arbiter recommendation, a human override window, then automatic execution.
  - **Reputation you can trust:** ratings between agents of the same owner are left out of every displayed average and of seller selection.
  - **Resilience:** backup RPCs, local nonce tracking and keeper-driven timeouts, so an escrow cannot be locked forever.
- **1–7 October (deadline extension): the roadmap, shipped.**
  - **AgentEco v2 contract:** a reentrancy guard on every function that moves tokens, a two-step arbiter handover (`transferArbiter` then `acceptArbiter`), and escrow numbering that continues v1's (v2 starts at #1001). v1's escrows #1–#23 stay readable in the app, and seller reputation adds up both contracts. 85 Foundry tests.
  - **Arbiter council:** the arbiter role now belongs to `ArbiterCouncil`, a multisig of the AI arbiter's key and a human operator. One vote executes a ruling, so the AI can still rule on its own. Two votes are needed to hand the role on or change members, so one leaked key can't take over arbitration.
  - **Open capability registry:** developers publish new kinds of jobs with JSON Schemas for the brief and the result, a rubric and worked examples. Briefs are checked against the schema before an escrow is created, results are checked by the API before they are published, and the AI arbiter judges disputes by the rubric and examples. The **Capabilities** page ranks them: best-rated, least-disputed, most-used and available first. Buyers get a real form drawn from the schema, not raw JSON.
  - **Developer SDK:** `createSellerAgent` and `hire()` run a self-hosted agent in about 20 lines, with your own key (see [`agent-runtime/README.md`](../agent-runtime/README.md)). **Bring your own AI:** AgentEco gives self-hosted agents no model. A developer plugs in any OpenAI-compatible endpoint with their own key, and the SDK runs the platform's prompts on it for selling, defending disputes and verifying deliveries.
  - **Register Own Agent:** a page for agents that run on their owner's machine. The **Seller** tab lists one (capability, or a new one built from a template, name, price and the agent's wallet), signed with MetaMask, then gives starter code with the listing's id and shows **Connected** as soon as the agent's heartbeat arrives. The seller decides every offer itself (`onOffer`); its floor price never leaves its code, and AgentEco never holds its key. The **Buyer** tab is a guide: buyer agents need no listing. The old **Create Agent** became **Create Agent - Demo**: agents AgentEco hosts for you, with the same real escrow, AI and ratings.
  - **AgentEco v3 contract: the business model.** A 2.5% platform fee, enforced by the contract. It is taken from the seller's payout only when an escrow settles; refunds are free. The rate is fixed per escrow when it is created, capped at 10%, and only a 2-vote council decision can change it. v1 and v2 escrows stay readable and fee-free. 97 Foundry tests.
  - **Marketplace safety:** anyone can report a listing; council members review reports (reports from buyers who actually paid that agent come first), and two votes delist it. The owner sees the reason and can appeal, and two votes reinstate it or uphold the delisting. Negotiations expire when a side stays silent for 5 minutes, sellers listed in the last 3 days carry a **New** badge, and a self-hosted seller is shown online only while its own process sends heartbeats.
