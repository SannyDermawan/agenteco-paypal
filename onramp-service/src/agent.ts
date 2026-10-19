import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { askJson, hire, scoreWithAi, type AiModel } from '@agenteco/sdk'
import { dataAnalysisInput, translationInput } from '@agenteco/sdk/shared/capabilities/definitions.ts'
import type { PayPalClient } from './paypal.ts'
import { usd } from './paypal.ts'
import type { Job, Store } from './store.ts'

/** The two capabilities the demo buyer agent can plan for. Both are AgentEco platform capabilities. */
const planSchema = z.discriminatedUnion('capability', [
  z.object({ capability: z.literal('translation'), brief: translationInput, criteria: z.string().max(300) }),
  z.object({ capability: z.literal('data_analysis'), brief: dataAnalysisInput, criteria: z.string().max(300) }),
])
export type Plan = z.infer<typeof planSchema>

/**
 * The AI step on the buyer side: turn the user's goal into one concrete AgentEco job (which capability, what brief, what a good
 * result must satisfy). Returns null if the model cannot, so the caller says so instead of paying for the wrong thing.
 */
export async function planTask(goal: string, ai: AiModel): Promise<Plan | null> {
  const prompt = {
    system:
      'You turn a user goal into one job for a marketplace of AI agents. Choose exactly one capability. ' +
      'translation: {"capability":"translation","brief":{"text":string,"targetLanguage":one of en,id,ms,zh,ja,ko,es,fr,de,pt,vi,th,ar},"criteria":string}. ' +
      'data_analysis: {"capability":"data_analysis","brief":{"csv":string,"question":string},"criteria":string}. ' +
      '"criteria" is what a good result must satisfy, in one sentence. Use only content the user gave; never invent the text or the data.',
    user: `<DATA>\n${goal}\n</DATA>`,
  }
  return askJson(ai, prompt, planSchema)
}

export interface HireOutcome {
  outcome: 'settled' | 'disputed'
  escrowId: string
  price: string
  result: Record<string, unknown> | null
  seller: { name: string; wallet: string }
}

/** Runs one job on AgentEco. The real one uses the SDK's hire(); tests use a fake. */
export interface JobRunner {
  run(input: { capability: string; brief: unknown; criteria: string; maxBudgetUsd: number }): Promise<HireOutcome>
}

/**
 * hire() on the AgentEco test network from the service's custodial TEST wallet, with the buyer model as the verifier:
 * the delivery is scored against the capability's rubric and the criteria, accepted at 60 or more, otherwise disputed.
 */
export class SdkJobRunner implements JobRunner {
  constructor(
    private readonly options: { privateKey: `0x${string}`; apiUrl?: string; ai: AiModel; log?: (m: string) => void }
  ) {}

  async run(input: { capability: string; brief: unknown; criteria: string; maxBudgetUsd: number }): Promise<HireOutcome> {
    const result = await hire({
      privateKey: this.options.privateKey,
      apiUrl: this.options.apiUrl,
      capability: input.capability,
      brief: input.brief,
      criteria: input.criteria,
      maxBudget: input.maxBudgetUsd,
      ai: this.options.ai,
    })
    return { outcome: result.outcome, escrowId: String(result.escrowId), price: result.price, result: result.result, seller: { name: result.seller.name, wallet: result.seller.wallet } }
  }
}

/** Where the seller is paid in real PayPal sandbox money. Optional: without it the payout is simulated and labelled so. */
export interface PayoutDeps {
  paypal?: Pick<PayPalClient, 'createPayout'>
  sellerEmail?: string
}

export interface AgentDeps {
  store: Store
  runner: JobRunner
  ai: AiModel
  payout?: PayoutDeps
  /** Test tokens one USD buys (a fixed, disclosed demo rate). */
  usdToToken?: number
  log?: (message: string) => void
}

/**
 * The buyer agent's whole job for a user: plan from the goal, reserve the budget from the user's test balance, hire a seller
 * through escrow, check the delivery, and then either settle (and pay the seller out) or dispute (and refund the user).
 */
export async function runJob(userId: string, goal: string, maxBudgetUsd: number, deps: AgentDeps): Promise<Job> {
  const { store } = deps
  const maxBudgetCents = Math.round(maxBudgetUsd * 100)
  const job: Job = { id: randomUUID(), userId, goal, maxBudgetCents, chargedCents: 0, status: 'running', createdAt: new Date().toISOString() }

  if (!(maxBudgetCents >= 1 && maxBudgetCents <= 5000)) return fail(store, job, 'Budget must be between $0.01 and $50.')
  if (!store.debit(userId, maxBudgetCents)) return fail(store, job, 'Not enough balance. Top up with PayPal first.')
  job.chargedCents = maxBudgetCents
  store.putJob(job)

  try {
    const plan = await planTask(goal, deps.ai)
    if (!plan) {
      store.refund(userId, maxBudgetCents)
      return fail(store, { ...job, chargedCents: 0 }, 'The agent could not turn the goal into a job, so nothing was bought and the budget was returned.')
    }
    job.capability = plan.capability
    const outcome = await deps.runner.run({ capability: plan.capability, brief: plan.brief, criteria: plan.criteria, maxBudgetUsd: maxBudgetUsd * (deps.usdToToken ?? 1) })
    job.escrowId = outcome.escrowId
    job.result = outcome.result

    // The escrow price is in test tokens; convert back at the disclosed demo rate. The user is charged the price, the rest returns.
    const spentCents = Math.min(maxBudgetCents, Math.round((Number(outcome.price) / (deps.usdToToken ?? 1)) * 100))
    if (outcome.outcome === 'settled') {
      job.status = 'settled'
      job.chargedCents = spentCents
      store.refund(userId, maxBudgetCents - spentCents)
      job.payout = await paySeller(job, spentCents, outcome.seller.name, deps)
    } else {
      // A dispute holds the escrow until the arbiter rules; the user's reservation is returned in full in the sandbox.
      job.status = 'disputed'
      job.chargedCents = 0
      store.refund(userId, maxBudgetCents)
      job.error = 'The delivery was rejected and disputed. The arbiter will decide; your test balance was returned.'
    }
    store.putJob(job)
    return job
  } catch (error) {
    store.refund(userId, job.chargedCents)
    deps.log?.(`job ${job.id} failed: ${(error as Error).message}`)
    return fail(store, { ...job, chargedCents: 0 }, `The job failed and your budget was returned: ${(error as Error).message}`)
  }
}

function fail(store: Store, job: Job, message: string): Job {
  const failed: Job = { ...job, status: 'failed', error: message }
  store.putJob(failed)
  return failed
}

async function paySeller(job: Job, cents: number, sellerName: string, deps: AgentDeps): Promise<NonNullable<Job['payout']>> {
  const { paypal, sellerEmail } = deps.payout ?? {}
  const note = `AgentEco job ${job.id.slice(0, 8)} for ${sellerName}`
  if (!paypal || !sellerEmail || cents < 1) {
    return { simulated: true, status: 'SIMULATED', note: 'No sandbox payout account is configured, so this payout is simulated and no PayPal money moved.' }
  }
  try {
    const sent = await paypal.createPayout({ email: sellerEmail, amountCents: cents, senderBatchId: `job-${job.id}`, note })
    return { simulated: false, batchId: sent.batchId, status: sent.status, note: `Sandbox payout of $${usd(cents)} to the demo seller account.` }
  } catch (error) {
    return { simulated: true, status: 'FAILED', note: `The sandbox payout failed (${(error as Error).message}); recorded as simulated, no PayPal money moved.` }
  }
}

/** Exported so a buyer of your own can score a delivery the same way the agent does. */
export { scoreWithAi }
