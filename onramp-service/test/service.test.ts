import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OnrampService, ServiceError, type PayPalLike } from '../src/service.ts'
import { Store } from '../src/store.ts'
import type { CapturedOrder } from '../src/paypal.ts'

function setup(overrides: Partial<PayPalLike> = {}) {
  const store = new Store()
  const calls = { create: 0, capture: 0, verify: 0 }
  let captured: CapturedOrder = { orderId: 'ORD1', status: 'COMPLETED', captureId: 'CAP1', captureStatus: 'COMPLETED', amountCents: 1000, payerEmail: null }
  const paypal: PayPalLike = {
    async createOrder() {
      calls.create += 1
      return { id: 'ORD1', status: 'PAYER_ACTION_REQUIRED', approveUrl: 'https://sandbox.paypal.com/approve' }
    },
    async captureOrder() {
      calls.capture += 1
      return captured
    },
    async verifyWebhook() {
      calls.verify += 1
      return true
    },
    ...overrides,
  }
  const service = new OnrampService({ paypal, store, publicBaseUrl: 'http://localhost:8788' })
  return { store, service, calls, setCaptured: (c: Partial<CapturedOrder>) => (captured = { ...captured, ...c }) }
}

const event = (type: string, id: string, orderId = 'ORD1', captureId = 'CAP1', value = '10.00', currency = 'USD') =>
  JSON.stringify({ id, event_type: type, resource: { id: captureId, amount: { value, currency_code: currency }, supplementary_data: { related_ids: { order_id: orderId } } } })

test('a top-up creates an order and a pending record, within the sandbox limits', async () => {
  const { service, store } = setup()
  const out = await service.startTopUp('alice', 10)
  assert.deepEqual(out, { orderId: 'ORD1', approveUrl: 'https://sandbox.paypal.com/approve', amountCents: 1000 })
  assert.equal(store.getTopUp('ORD1')?.status, 'created')
  assert.equal(store.user('alice').balanceCents, 0, 'nothing is credited before the payment is captured')
  await assert.rejects(service.startTopUp('alice', 0.5), ServiceError)
  await assert.rejects(service.startTopUp('alice', 500), ServiceError)
  await assert.rejects(service.startTopUp('bad user!', 10), ServiceError)
})

test('capture credits the balance once, and a second capture does not credit again', async () => {
  const { service, store } = setup()
  await service.startTopUp('alice', 10)
  const first = await service.capture('ORD1')
  assert.deepEqual([first.credited, first.balanceCents], [true, 1000])
  const second = await service.capture('ORD1')
  assert.deepEqual([second.credited, second.balanceCents], [false, 1000])
  assert.equal(store.user('alice').balanceCents, 1000)
})

test('the capture call and the webhook for the same payment credit only once, in either order', async () => {
  for (const webhookFirst of [true, false]) {
    const { service, store } = setup()
    await service.startTopUp('alice', 10)
    const hook = () => service.handleWebhook({}, event('PAYMENT.CAPTURE.COMPLETED', 'WH-1'))
    if (webhookFirst) await hook()
    await service.capture('ORD1')
    if (!webhookFirst) await hook()
    assert.equal(store.user('alice').balanceCents, 1000, `webhookFirst=${webhookFirst}`)
  }
})

test('a redelivered webhook event is acknowledged but not applied again', async () => {
  const { service, store } = setup()
  await service.startTopUp('alice', 10)
  const first = await service.handleWebhook({}, event('PAYMENT.CAPTURE.COMPLETED', 'WH-1'))
  const again = await service.handleWebhook({}, event('PAYMENT.CAPTURE.COMPLETED', 'WH-1'))
  assert.deepEqual(first.body, { handled: true, credited: true })
  assert.deepEqual(again.body, { handled: false, reason: 'duplicate_event' })
  assert.equal(again.status, 200, 'PayPal must get 200 or it keeps retrying')
  assert.equal(store.user('alice').balanceCents, 1000)
})

test('a webhook with a bad signature credits nothing and is refused', async () => {
  const { service, store } = setup({ verifyWebhook: async () => false })
  await service.startTopUp('alice', 10)
  const out = await service.handleWebhook({}, event('PAYMENT.CAPTURE.COMPLETED', 'WH-1'))
  assert.equal(out.status, 401)
  assert.equal(store.user('alice').balanceCents, 0)
})

test('if verification cannot run the webhook gets a 503 so PayPal retries', async () => {
  const { service, store } = setup({
    verifyWebhook: async () => {
      throw new Error('network down')
    },
  })
  await service.startTopUp('alice', 10)
  const out = await service.handleWebhook({}, event('PAYMENT.CAPTURE.COMPLETED', 'WH-1'))
  assert.equal(out.status, 503)
  assert.equal(store.user('alice').balanceCents, 0)
})

test('a webhook whose amount does not match the order credits nothing', async () => {
  const { service, store } = setup()
  await service.startTopUp('alice', 10)
  const out = await service.handleWebhook({}, event('PAYMENT.CAPTURE.COMPLETED', 'WH-1', 'ORD1', 'CAP1', '99.00'))
  assert.deepEqual(out.body, { handled: false, reason: 'amount_mismatch' })
  const wrongCurrency = await service.handleWebhook({}, event('PAYMENT.CAPTURE.COMPLETED', 'WH-2', 'ORD1', 'CAP1', '10.00', 'EUR'))
  assert.deepEqual(wrongCurrency.body, { handled: false, reason: 'amount_mismatch' })
  assert.equal(store.user('alice').balanceCents, 0)
})

test('events for orders that are not ours, or that are not payments, are ignored', async () => {
  const { service, store } = setup()
  await service.startTopUp('alice', 10)
  assert.deepEqual((await service.handleWebhook({}, event('PAYMENT.CAPTURE.COMPLETED', 'WH-1', 'OTHER'))).body, { handled: false, reason: 'not_our_order' })
  assert.deepEqual((await service.handleWebhook({}, event('CHECKOUT.ORDER.APPROVED', 'WH-2'))).body, { handled: false, reason: 'ignored_event_type' })
  assert.equal((await service.handleWebhook({}, 'not json')).status, 400)
  assert.equal(store.user('alice').balanceCents, 0)
})

test('a failed payment never credits: declined capture marks the top-up failed', async () => {
  const { service, store, setCaptured } = setup()
  await service.startTopUp('alice', 10)
  setCaptured({ status: 'COMPLETED', captureStatus: 'DECLINED', captureId: 'CAP1' })
  const out = await service.capture('ORD1')
  assert.deepEqual([out.credited, out.status], [false, 'DECLINED'])
  assert.equal(store.getTopUp('ORD1')?.status, 'failed')
  assert.equal(store.user('alice').balanceCents, 0)
  const denied = setup()
  await denied.service.startTopUp('bob', 10)
  await denied.service.handleWebhook({}, event('PAYMENT.CAPTURE.DENIED', 'WH-9'))
  assert.equal(denied.store.getTopUp('ORD1')?.status, 'failed')
})

test('a capture whose amount differs from the order is refused and not credited', async () => {
  const { service, store, setCaptured } = setup()
  await service.startTopUp('alice', 10)
  setCaptured({ amountCents: 1 })
  await assert.rejects(service.capture('ORD1'), (e: unknown) => e instanceof ServiceError && e.status === 409)
  assert.equal(store.user('alice').balanceCents, 0)
})

test('one capture id can never credit two different top-ups', async () => {
  const { store } = setup()
  store.putTopUp({ orderId: 'A', userId: 'alice', amountCents: 1000, status: 'created', createdAt: '' })
  store.putTopUp({ orderId: 'B', userId: 'bob', amountCents: 1000, status: 'created', createdAt: '' })
  assert.equal(store.creditOnce('A', 'CAP-X', 1000, 'capture'), true)
  assert.equal(store.creditOnce('B', 'CAP-X', 1000, 'webhook'), false)
  assert.equal(store.user('bob').balanceCents, 0)
})

test('capture of an unknown order is a 404', async () => {
  const { service } = setup()
  await assert.rejects(service.capture('NOPE'), (e: unknown) => e instanceof ServiceError && e.status === 404)
})
