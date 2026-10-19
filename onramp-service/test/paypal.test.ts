import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PayPalClient, PayPalError, usd, toCents } from '../src/paypal.ts'

interface Seen {
  method: string
  url: string
  headers: Headers
  body: string
}

function fakePayPal(handlers: Record<string, (seen: Seen) => { status?: number; body: unknown }>) {
  const seen: Seen[] = []
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const s: Seen = { method: init?.method ?? 'GET', url: String(url), headers: new Headers(init?.headers), body: typeof init?.body === 'string' ? init.body : '' }
    seen.push(s)
    const key = `${s.method} ${new URL(s.url).pathname}`
    const handler = handlers[key]
    if (!handler) return new Response(JSON.stringify({ name: 'NOT_FOUND' }), { status: 404 })
    const out = handler(s)
    return new Response(JSON.stringify(out.body), { status: out.status ?? 200, headers: { 'paypal-debug-id': 'dbg123' } })
  }) as unknown as typeof fetch
  return { seen, fetchImpl }
}

const token = { 'POST /v1/oauth2/token': () => ({ body: { access_token: 'tok', expires_in: 3600 } }) }
const cfg = { clientId: 'id', clientSecret: 'secret' }

test('only the sandbox is reachable', () => {
  assert.throws(() => new PayPalClient({ ...cfg, baseUrl: 'https://api-m.paypal.com' }), PayPalError)
  assert.throws(() => new PayPalClient({ clientId: '', clientSecret: '' }), /PAYPAL_CLIENT_ID/)
  assert.doesNotThrow(() => new PayPalClient({ ...cfg, baseUrl: 'https://api.sandbox.paypal.com' }))
})

test('money helpers round correctly', () => {
  assert.equal(usd(1999), '19.99')
  assert.equal(toCents('19.99'), 1999)
  assert.equal(toCents('0.1'), 10)
})

test('createOrder sends the documented body, the request id and returns the approval link', async () => {
  const { seen, fetchImpl } = fakePayPal({
    ...token,
    'POST /v2/checkout/orders': () => ({ body: { id: 'ORD1', status: 'PAYER_ACTION_REQUIRED', links: [{ rel: 'self', href: 'x' }, { rel: 'payer-action', href: 'https://sandbox.paypal.com/checkoutnow?token=ORD1' }] } }),
  })
  const client = new PayPalClient({ ...cfg, fetchImpl })
  const order = await client.createOrder({ amountCents: 1250, referenceId: 'user1', returnUrl: 'https://a/r', cancelUrl: 'https://a/c', requestId: 'req-1' })
  assert.deepEqual(order, { id: 'ORD1', status: 'PAYER_ACTION_REQUIRED', approveUrl: 'https://sandbox.paypal.com/checkoutnow?token=ORD1' })
  const call = seen.find((s) => s.url.endsWith('/v2/checkout/orders'))!
  const body = JSON.parse(call.body)
  assert.equal(body.intent, 'CAPTURE')
  assert.deepEqual(body.purchase_units[0].amount, { currency_code: 'USD', value: '12.50' })
  assert.equal(call.headers.get('paypal-request-id'), 'req-1')
  assert.equal(call.headers.get('authorization'), 'Bearer tok')
  const tokenCall = seen.find((s) => s.url.endsWith('/v1/oauth2/token'))!
  assert.equal(tokenCall.headers.get('authorization'), `Basic ${Buffer.from('id:secret').toString('base64')}`)
  assert.equal(tokenCall.body, 'grant_type=client_credentials')
})

test('the access token is cached until shortly before it expires', async () => {
  let tokens = 0
  let clock = 1_000_000
  const { fetchImpl } = fakePayPal({
    'POST /v1/oauth2/token': () => (tokens++, { body: { access_token: `t${tokens}`, expires_in: 100 } }),
    'GET /v2/checkout/orders/A': () => ({ body: { status: 'APPROVED' } }),
  })
  const client = new PayPalClient({ ...cfg, fetchImpl, now: () => clock })
  await client.getOrder('A')
  await client.getOrder('A')
  assert.equal(tokens, 1)
  clock += 50_000
  await client.getOrder('A')
  assert.equal(tokens, 2, 'refreshed inside the 60 second margin')
})

test('captureOrder reads the capture id, status and amount', async () => {
  const { fetchImpl } = fakePayPal({
    ...token,
    'POST /v2/checkout/orders/ORD1/capture': () => ({ body: { status: 'COMPLETED', payer: { email_address: 'buyer@example.com' }, purchase_units: [{ payments: { captures: [{ id: 'CAP1', status: 'COMPLETED', amount: { currency_code: 'USD', value: '12.50' } }] } }] } }),
  })
  const out = await new PayPalClient({ ...cfg, fetchImpl }).captureOrder('ORD1', 'c1')
  assert.deepEqual(out, { orderId: 'ORD1', status: 'COMPLETED', captureId: 'CAP1', captureStatus: 'COMPLETED', amountCents: 1250, payerEmail: 'buyer@example.com' })
})

test('PayPal errors carry the status and debug id', async () => {
  const { fetchImpl } = fakePayPal({ ...token, 'POST /v2/checkout/orders/BAD/capture': () => ({ status: 422, body: { name: 'UNPROCESSABLE_ENTITY', message: 'order not approved' } }) })
  await assert.rejects(new PayPalClient({ ...cfg, fetchImpl }).captureOrder('BAD'), (e: unknown) => e instanceof PayPalError && e.status === 422 && e.debugId === 'dbg123')
})

test('webhook verification posts the event exactly as received', async () => {
  const raw = '{"id":"WH-1",  "event_type":"PAYMENT.CAPTURE.COMPLETED","resource":{"amount":{"value":"12.50"}}}'
  const { seen, fetchImpl } = fakePayPal({ ...token, 'POST /v1/notifications/verify-webhook-signature': () => ({ body: { verification_status: 'SUCCESS' } }) })
  const client = new PayPalClient({ ...cfg, webhookId: 'WHID', fetchImpl })
  const headers = { 'paypal-auth-algo': 'SHA256withRSA', 'paypal-cert-url': 'https://api.sandbox.paypal.com/cert', 'paypal-transmission-id': 'T1', 'paypal-transmission-sig': 'SIG', 'paypal-transmission-time': '2026-10-20T00:00:00Z' }
  assert.equal(await client.verifyWebhook(headers, raw), true)
  const posted = seen.find((s) => s.url.endsWith('verify-webhook-signature'))!.body
  assert.ok(posted.endsWith(`"webhook_event":${raw}}`), 'the raw text, with its odd spacing, is what was sent')
  const parsed = JSON.parse(posted)
  assert.equal(parsed.webhook_id, 'WHID')
  assert.equal(parsed.transmission_id, 'T1')
})

test('webhook verification fails closed', async () => {
  const { fetchImpl } = fakePayPal({ ...token, 'POST /v1/notifications/verify-webhook-signature': () => ({ body: { verification_status: 'FAILURE' } }) })
  const client = new PayPalClient({ ...cfg, webhookId: 'WHID', fetchImpl })
  const headers = { 'paypal-auth-algo': 'a', 'paypal-cert-url': 'c', 'paypal-transmission-id': 't', 'paypal-transmission-sig': 's', 'paypal-transmission-time': 'x' }
  assert.equal(await client.verifyWebhook(headers, '{}'), false)
  assert.equal(await client.verifyWebhook({}, '{}'), false, 'missing headers')
  await assert.rejects(new PayPalClient({ ...cfg, fetchImpl }).verifyWebhook(headers, '{}'), /PAYPAL_WEBHOOK_ID/)
})

test('createPayout sends a batch header, an email item and a stable batch id', async () => {
  const { seen, fetchImpl } = fakePayPal({ ...token, 'POST /v1/payments/payouts': () => ({ status: 201, body: { batch_header: { payout_batch_id: 'B1', batch_status: 'PENDING' } } }) })
  const out = await new PayPalClient({ ...cfg, fetchImpl }).createPayout({ email: 'seller@example.com', amountCents: 80, senderBatchId: 'job-1', note: 'n' })
  assert.deepEqual(out, { batchId: 'B1', status: 'PENDING' })
  const body = JSON.parse(seen.find((s) => s.url.endsWith('/payouts'))!.body)
  assert.equal(body.sender_batch_header.sender_batch_id, 'job-1')
  assert.deepEqual(body.items[0].amount, { value: '0.80', currency: 'USD' })
  assert.equal(body.items[0].receiver, 'seller@example.com')
})
