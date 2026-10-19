// Phase 1 of the PayPal work as a script: one sandbox payment from creation to capture.
//   npm run sandbox-check          creates an order and prints the approval link
//   npm run sandbox-check <orderId> captures it after you approved it in the sandbox buyer account
// Credentials come from the environment and are never printed.
import { PayPalClient } from '../src/paypal.ts'

const clientId = process.env.PAYPAL_CLIENT_ID
const clientSecret = process.env.PAYPAL_CLIENT_SECRET
if (!clientId || !clientSecret) throw new Error('Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET (sandbox) in .env first.')
const paypal = new PayPalClient({ clientId, clientSecret, webhookId: process.env.PAYPAL_WEBHOOK_ID })
const base = (process.env.PUBLIC_BASE_URL || 'http://localhost:8788').replace(/\/+$/, '')

const orderId = process.argv[2]
if (!orderId) {
  const order = await paypal.createOrder({ amountCents: 500, referenceId: 'sandbox-check', returnUrl: `${base}/?paypal=return`, cancelUrl: `${base}/?paypal=cancel`, requestId: `check-${Date.now()}` })
  console.log('order id:', order.id, '| status:', order.status)
  console.log('Open this link, log in with a SANDBOX buyer account and approve:')
  console.log(order.approveUrl)
  console.log(`Then run: npm run sandbox-check ${order.id}`)
} else {
  const captured = await paypal.captureOrder(orderId, `check-capture-${orderId}`)
  console.log(captured)
}
