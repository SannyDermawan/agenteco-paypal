# PayPal notes: what is confirmed and what is assumed

Read on 20 Oct 2026 from developer.paypal.com. No sandbox credentials were available, so no live call has been made. `onramp-service/scripts/sandbox-check.ts` makes the first one.

## Confirmed from the documentation

- Orders v2: `POST /v2/checkout/orders` creates, `POST /v2/checkout/orders/{id}/capture` captures, `GET /v2/checkout/orders/{id}` shows.
- Webhook verification: `POST /v1/notifications/verify-webhook-signature` with a bearer token and a body of `transmission_id`, `transmission_time`, `cert_url`, `auth_algo` (example `SHA256withRSA`), `transmission_sig`, `webhook_id` and `webhook_event`. The event must be posted exactly as received. The incoming delivery carries `paypal-transmission-id`, `paypal-transmission-time`, `paypal-cert-url`, `paypal-transmission-sig` (and `paypal-auth-algo`). Mock events from the webhook simulator cannot be verified.
- `PAYMENT.CAPTURE.COMPLETED` is the event for a completed capture (`resource_type: capture`).
- The Agent Toolkit (`@paypal/agent-toolkit`) exposes PayPal functions to agent frameworks and MCP. It was not integrated: the direct REST calls above already cover the flow and are testable.

Also confirmed from the endpoint reference pages (read later on 20 Oct 2026): create order requires `intent` (`CAPTURE` or `AUTHORIZE`) and `purchase_units[].amount` with `currency_code` and a string `value`; `PayPal-Request-Id` is an optional idempotency header of 1 to 10,000 characters; `verify-webhook-signature` requires `auth_algo`, `cert_url`, `transmission_id`, `transmission_sig`, `transmission_time`, `webhook_id` and `webhook_event`, and its documented success example is `verification_status: SUCCESS`.

## Assumed from general knowledge of the API (confirm with the first sandbox run)

- The create-order body (`intent: CAPTURE`, `purchase_units[].amount`, `payment_source.paypal.experience_context` with `return_url`, `cancel_url`, `user_action: PAY_NOW`), the `PayPal-Request-Id` idempotency header, and the approval link appearing as `rel: payer-action` (the client also accepts the older `rel: approve`).
- The capture response shape: `purchase_units[0].payments.captures[0]` with `id`, `status`, `amount`.
- The verification answer: `verification_status: SUCCESS` (anything else is treated as failure, so a wrong assumption fails closed).
- The related order id in a capture event: `resource.supplementary_data.related_ids.order_id`.
- Payouts: `POST /v1/payments/payouts` with `sender_batch_header` and `items` (EMAIL recipients), answer `batch_header.payout_batch_id`. Payouts must be enabled for the sandbox business account; if it is not, the job still settles and the payout is recorded as simulated.
- The sandbox host `https://api-m.sandbox.paypal.com` (the older `api.sandbox.paypal.com` is also accepted by the guard).

## Webhook setup (Sanny)

Create a webhook in the PayPal developer dashboard (Sandbox) for the hosted URL `https://<host>/api/webhooks/paypal` subscribed to `PAYMENT.CAPTURE.COMPLETED` and `PAYMENT.CAPTURE.DENIED`, then copy the webhook id into `PAYPAL_WEBHOOK_ID`. Local development needs a tunnel to a public HTTPS URL; the capture call made when the buyer returns from PayPal works without a webhook, which is why both paths exist.
