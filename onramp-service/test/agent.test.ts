import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AiModel } from '@agenteco/sdk'
import { planTask, runJob, type AgentDeps, type HireOutcome, type JobRunner } from '../src/agent.ts'
import { Store } from '../src/store.ts'

const plan = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ capability: 'translation', brief: { text: 'Good morning', targetLanguage: 'id' }, criteria: 'Natural Indonesian.', ...extra })
const planner = (text = plan()): AiModel => async () => text

function fakeRunner(outcome: Partial<HireOutcome> | Error): JobRunner & { calls: unknown[] } {
  const calls: unknown[] = []
  return {
    calls,
    async run(input) {
      calls.push(input)
      if (outcome instanceof Error) throw outcome
      return { outcome: 'settled', escrowId: '42', price: '0.08', result: { translatedText: 'Selamat pagi' }, seller: { name: 'Translator', wallet: '0xabc' }, ...outcome }
    },
  }
}

function setup(runner: JobRunner, ai: AiModel = planner(), payout?: AgentDeps['payout'], balanceCents = 500) {
  const store = new Store()
  store.user('alice').balanceCents = balanceCents
  const deps: AgentDeps = { store, runner, ai, payout }
  return { store, deps }
}

test('planTask turns a goal into a valid translation job, or null when the model cannot', async () => {
  const ok = await planTask('Translate "Good morning" to Indonesian', planner())
  assert.equal(ok?.capability, 'translation')
  assert.equal(await planTask('x', planner('not json')), null)
  assert.equal(await planTask('x', planner(plan({ brief: { text: 'hi', targetLanguage: 'klingon' } }))), null, 'a language the capability does not support is refused')
})

test('a settled job charges the price, returns the rest and records a simulated payout when none is configured', async () => {
  const runner = fakeRunner({})
  const { deps, store } = setup(runner)
  const job = await runJob('alice', 'Translate "Good morning" to Indonesian', 1, deps)
  assert.equal(job.status, 'settled')
  assert.equal(job.chargedCents, 8)
  assert.equal(store.user('alice').balanceCents, 500 - 8, 'only the escrow price is spent')
  assert.equal(job.payout?.simulated, true)
  assert.match(job.payout!.note, /simulated/i)
  assert.equal(job.escrowId, '42')
  assert.equal((runner.calls[0] as { maxBudgetUsd: number }).maxBudgetUsd, 1)
})

test('a configured sandbox payout is sent for the price with a stable batch id', async () => {
  const sent: unknown[] = []
  const payout = { paypal: { createPayout: async (i: unknown) => (sent.push(i), { batchId: 'B1', status: 'PENDING' }) }, sellerEmail: 'seller@example.com' }
  const { deps } = setup(fakeRunner({}), planner(), payout as AgentDeps['payout'])
  const job = await runJob('alice', 'Translate "Good morning" to Indonesian', 1, deps)
  assert.equal(job.payout?.simulated, false)
  assert.equal(job.payout?.batchId, 'B1')
  assert.deepEqual(sent[0], { email: 'seller@example.com', amountCents: 8, senderBatchId: `job-${job.id}`, note: sent[0] && (sent[0] as { note: string }).note })
})

test('a failed payout does not undo the job and is recorded honestly', async () => {
  const payout = { paypal: { createPayout: async () => Promise.reject(new Error('sandbox down')) }, sellerEmail: 'seller@example.com' }
  const { deps } = setup(fakeRunner({}), planner(), payout as AgentDeps['payout'])
  const job = await runJob('alice', 'Translate "Good morning" to Indonesian', 1, deps)
  assert.equal(job.status, 'settled')
  assert.deepEqual([job.payout?.simulated, job.payout?.status], [true, 'FAILED'])
})

test('a rejected delivery becomes a dispute and the reserved balance returns', async () => {
  const { deps, store } = setup(fakeRunner({ outcome: 'disputed', result: null }))
  const job = await runJob('alice', 'Translate "Good morning" to Indonesian', 1, deps)
  assert.equal(job.status, 'disputed')
  assert.equal(store.user('alice').balanceCents, 500)
  assert.equal(job.payout, undefined, 'no payout for a disputed delivery')
})

test('not enough balance buys nothing', async () => {
  const runner = fakeRunner({})
  const { deps, store } = setup(runner, planner(), undefined, 50)
  const job = await runJob('alice', 'Translate "Good morning" to Indonesian', 1, deps)
  assert.equal(job.status, 'failed')
  assert.match(job.error!, /balance/i)
  assert.equal(runner.calls.length, 0)
  assert.equal(store.user('alice').balanceCents, 50)
})

test('when the plan fails or the hire throws, the user gets the whole budget back', async () => {
  const noPlan = setup(fakeRunner({}), planner('nonsense'))
  const a = await runJob('alice', 'something vague here', 1, noPlan.deps)
  assert.equal(a.status, 'failed')
  assert.equal(noPlan.store.user('alice').balanceCents, 500)

  const boom = setup(fakeRunner(new Error('no seller online')))
  const b = await runJob('alice', 'Translate "Good morning" to Indonesian', 1, boom.deps)
  assert.equal(b.status, 'failed')
  assert.match(b.error!, /no seller online/)
  assert.equal(boom.store.user('alice').balanceCents, 500)
})

test('a silly budget is refused before any money is reserved', async () => {
  const { deps, store } = setup(fakeRunner({}))
  assert.equal((await runJob('alice', 'Translate "Good morning" to Indonesian', 0, deps)).status, 'failed')
  assert.equal((await runJob('alice', 'Translate "Good morning" to Indonesian', 500, deps)).status, 'failed')
  assert.equal(store.user('alice').balanceCents, 500)
})
