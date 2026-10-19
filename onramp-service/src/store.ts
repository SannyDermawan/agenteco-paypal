import { existsSync, readFileSync, writeFileSync } from 'node:fs'

export interface User {
  id: string
  /** Test balance in cents of a dollar. Simulated: see the README. */
  balanceCents: number
}

export type TopUpStatus = 'created' | 'credited' | 'failed'

export interface TopUp {
  orderId: string
  userId: string
  amountCents: number
  status: TopUpStatus
  captureId?: string
  /** Where the credit came from: the capture call, the webhook, or whichever arrived first. */
  creditedBy?: 'capture' | 'webhook'
  createdAt: string
}

export type JobStatus = 'running' | 'settled' | 'disputed' | 'failed'

export interface Job {
  id: string
  userId: string
  goal: string
  capability?: string
  maxBudgetCents: number
  chargedCents: number
  status: JobStatus
  escrowId?: string
  result?: unknown
  payout?: { simulated: boolean; batchId?: string; status: string; note: string }
  error?: string
  createdAt: string
}

interface Data {
  users: Record<string, User>
  topUps: Record<string, TopUp>
  /** Every webhook event id already handled. */
  events: string[]
  jobs: Record<string, Job>
}

/**
 * The service's tiny database: users, top-ups, handled webhook events and jobs. A JSON file keeps it across restarts
 * (DATA_FILE); without one it lives in memory. A real deployment would use Postgres: the interface is the same.
 */
export class Store {
  private data: Data = { users: {}, topUps: {}, events: [], jobs: {} }

  constructor(private readonly file?: string) {
    if (file && existsSync(file)) {
      try {
        this.data = { ...this.data, ...(JSON.parse(readFileSync(file, 'utf8')) as Partial<Data>) }
      } catch {
        // A corrupt file must not stop the service; it starts empty and the file is overwritten on the next save.
      }
    }
  }

  private save() {
    if (this.file) writeFileSync(this.file, JSON.stringify(this.data, null, 2))
  }

  user(id: string): User {
    return (this.data.users[id] ??= { id, balanceCents: 0 })
  }

  getTopUp(orderId: string): TopUp | undefined {
    return this.data.topUps[orderId]
  }

  putTopUp(topUp: TopUp) {
    this.data.topUps[topUp.orderId] = topUp
    this.save()
  }

  /**
   * Credits a top-up exactly once. The check and the credit happen together, so the capture call and the webhook
   * (which both report the same payment) cannot both add money. Returns false when it was already credited.
   */
  creditOnce(orderId: string, captureId: string, amountCents: number, by: 'capture' | 'webhook'): boolean {
    const topUp = this.data.topUps[orderId]
    if (!topUp) return false
    if (topUp.status === 'credited') return false
    if (Object.values(this.data.topUps).some((t) => t.status === 'credited' && t.captureId === captureId)) return false
    topUp.status = 'credited'
    topUp.captureId = captureId
    topUp.creditedBy = by
    this.user(topUp.userId).balanceCents += amountCents
    this.save()
    return true
  }

  markFailed(orderId: string) {
    const topUp = this.data.topUps[orderId]
    if (topUp && topUp.status === 'created') {
      topUp.status = 'failed'
      this.save()
    }
  }

  /** True the first time an event id is seen, false for a redelivery. */
  firstSeen(eventId: string): boolean {
    if (this.data.events.includes(eventId)) return false
    this.data.events.push(eventId)
    this.save()
    return true
  }

  debit(userId: string, cents: number): boolean {
    const user = this.user(userId)
    if (user.balanceCents < cents) return false
    user.balanceCents -= cents
    this.save()
    return true
  }

  refund(userId: string, cents: number) {
    this.user(userId).balanceCents += cents
    this.save()
  }

  putJob(job: Job) {
    this.data.jobs[job.id] = job
    this.save()
  }

  getJob(id: string): Job | undefined {
    return this.data.jobs[id]
  }

  jobsOf(userId: string): Job[] {
    return Object.values(this.data.jobs).filter((j) => j.userId === userId)
  }
}
