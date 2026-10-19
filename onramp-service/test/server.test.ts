import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { buildServer, type ServerDeps } from '../src/server.ts'
import { OnrampService, type PayPalLike } from '../src/service.ts'
import { Store } from '../src/store.ts'

async function run<T>(deps: ServerDeps, fn: (base: string) => Promise<T>): Promise<T> {
  const server = buildServer(deps)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  try {
    return await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
  } finally {
    server.close()
  }
}

const fakePaypal = (verify = true): PayPalLike => ({
  async createOrder() {
    return { id: 'ORD1', status: 'CREATED', approveUrl: 'https://sandbox.paypal.com/approve' }
  },
  async captureOrder() {
    return { orderId: 'ORD1', status: 'COMPLETED', captureId: 'CAP1', captureStatus: 'COMPLETED', amountCents: 1000, payerEmail: null }
  },
  async verifyWebhook() {
    return verify
  },
})

function withService(verify = true): ServerDeps {
  const store = new Store()
  return {
    service: new OnrampService({ paypal: fakePaypal(verify), store, publicBaseUrl: 'http://localhost' }),
    agent: null,
    store,
    config: { paypal: true, webhook: true, agent: false, payout: false, usdToToken: 1 },
  }
}

const post = (base: string, path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) })

test('top up, capture, and read the balance over HTTP', async () => {
  await run(withService(), async (base) => {
    const top = (await (await post(base, '/api/topups', { userId: 'alice', amountUsd: 10 })).json()) as { orderId: string; approveUrl: string }
    assert.equal(top.orderId, 'ORD1')
    const cap = (await (await post(base, `/api/topups/${top.orderId}/capture`, {})).json()) as { credited: boolean; balanceCents: number }
    assert.deepEqual([cap.credited, cap.balanceCents], [true, 1000])
    const user = (await (await fetch(`${base}/api/users/alice`)).json()) as { balanceCents: number }
    assert.equal(user.balanceCents, 1000)
  })
})

test('the webhook route verifies the raw body and applies a payment once', async () => {
  const deps = withService()
  await run(deps, async (base) => {
    await post(base, '/api/topups', { userId: 'alice', amountUsd: 10 })
    const event = JSON.stringify({ id: 'WH-1', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'CAP1', amount: { value: '10.00', currency_code: 'USD' }, supplementary_data: { related_ids: { order_id: 'ORD1' } } } })
    assert.equal((await post(base, '/api/webhooks/paypal', event)).status, 200)
    assert.equal((await post(base, '/api/webhooks/paypal', event)).status, 200)
    assert.equal(deps.store.user('alice').balanceCents, 1000)
  })
  await run(withService(false), async (base) => {
    assert.equal((await post(base, '/api/webhooks/paypal', '{"id":"x","event_type":"y"}')).status, 401)
  })
})

test('bad input is a clear 400 and a missing integration is a clear 503, not a crash', async () => {
  await run(withService(), async (base) => {
    assert.equal((await post(base, '/api/topups', { userId: 'alice' })).status, 400)
    assert.equal((await post(base, '/api/topups', 'not json')).status, 400)
    assert.equal((await post(base, '/api/topups', { userId: 'alice', amountUsd: 9999 })).status, 400)
    const noAgent = await post(base, '/api/jobs', { userId: 'alice', goal: 'translate something please', maxBudgetUsd: 1 })
    assert.equal(noAgent.status, 503)
    assert.equal(((await noAgent.json()) as { error: string }).error, 'not_configured')
  })
  const empty: ServerDeps = { service: null, agent: null, store: new Store(), config: { paypal: false, webhook: false, agent: false, payout: false, usdToToken: 1 } }
  await run(empty, async (base) => {
    assert.equal((await post(base, '/api/topups', { userId: 'a', amountUsd: 5 })).status, 503)
    const config = (await (await fetch(`${base}/api/config`)).json()) as { paypal: boolean }
    assert.equal(config.paypal, false)
  })
})

test('the demo page is served and path traversal is refused', async () => {
  await run(withService(), async (base) => {
    const page = await fetch(base)
    assert.equal(page.status, 200)
    assert.match(await page.text(), /AgentEco/)
    assert.equal((await fetch(`${base}/..%2f..%2fpackage.json`)).status, 404)
  })
})
