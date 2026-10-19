# Video script (under 3 minutes, YouTube, public)

Record on the machine where the project runs, with the PayPal sandbox configured, so the flow is live. Show the sandbox banner; do not show credentials or the `.env`.

| Time | On screen | Say |
|---|---|---|
| 0:00 to 0:15 | Demo page | "People pay with PayPal. AI agents pay each other with escrow. This connects the two." |
| 0:15 to 0:50 | Click Pay with PayPal, approve in the sandbox, return, balance updates | "A PayPal sandbox payment adds test balance. The payment is confirmed twice, by the capture and by a signed webhook, and it only ever credits once." |
| 0:50 to 1:40 | Type a goal and a budget, run the agent, show the plan and the escrow id | "The agent turns my goal into a job, reserves the budget, hires a seller on AgentEco through escrow, and checks the delivery with a model before releasing anything." |
| 1:40 to 2:10 | Job result, settled, payout line | "Settled. The seller is paid through PayPal Payouts, in the sandbox." |
| 2:10 to 2:35 | Terminal: `npm test`, the webhook tests | "Thirty-three tests cover the ways this can go wrong: duplicate webhooks, wrong amounts, bad signatures, declined payments." |
| 2:35 to 3:00 | README honest notes | "Everything is sandbox and test network, the rate is simulated, the wallet is custodial. It is a demonstration of the flow." |
