import { randomUUID } from 'node:crypto'
import type { CapturedOrder, CreatedOrder } from './paypal.ts'
import { toCents } from './paypal.ts'
import type { Store } from './store.ts'

/** What the service needs from PayPal. The real PayPalClient satisfies it; tests use a fake. */
export interface PayPalLike {
  createOrder(input: { amountCents: number; referenceId: string; returnUrl: string; cancelUrl: string; requestId: string }): Promise<CreatedOrder>
  captureOrder(orderId: string, requestId?: string): Promise<CapturedOrder>
  verifyWebhook(headers: Record<string, string | string[] | undefined>, rawBody: string): Promise<boolean>
}

export class ServiceError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'ServiceError'
  }
}

/** Sandbox safety cap per top-up, in cents. */
export const MIN_TOPUP_CENTS = 100
export const MAX_TOPUP_CENTS = 5000

export interface ServiceDeps {
  paypal: PayPalLike
  store: Store
  publicBaseUrl: string
  log?: (message: string) => void
}

/**
 * Money in: a user tops up a test balance by paying a PayPal sandbox order. There are two ways the payment can be
 * confirmed, the capture call the page makes after the buyer returns from PayPal, and PayPal's webhook. Both can arrive,
 * in either order, and both report the same capture, so crediting goes through Store.creditOnce: one payment credits one
 * time, however many confirmations come.
 */
export class OnrampService {
  constructor(private readonly deps: ServiceDeps) {}

  private get log() {
    return this.deps.log ?? (() => {})
  }

  async startTopUp(userId: string, amountUsd: number): Promise<{ orderId: string; approveUrl: string | null; amountCents: number }> {
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(userId)) throw new ServiceError('userId must be 1 to 40 letters, digits, - or _.', 400)
    const amountCents = Math.round(amountUsd * 100)
    if (!Number.isFinite(amountCents) || amountCents < MIN_TOPUP_CENTS || amountCents > MAX_TOPUP_CENTS) {
      throw new ServiceError(`A top-up is between $${MIN_TOPUP_CENTS / 100} and $${MAX_TOPUP_CENTS / 100} in the sandbox.`, 400)
    }
    const base = this.deps.publicBaseUrl.replace(/\/+$/, '')
    const order = await this.deps.paypal.createOrder({
      amountCents,
      referenceId: userId,
      returnUrl: `${base}/?paypal=return`,
      cancelUrl: `${base}/?paypal=cancel`,
      requestId: `topup-${randomUUID()}`,
    })
    this.deps.store.user(userId)
    this.deps.store.putTopUp({ orderId: order.id, userId, amountCents, status: 'created', createdAt: new Date().toISOString() })
    return { orderId: order.id, approveUrl: order.approveUrl, amountCents }
  }

  /** The page calls this when the buyer returns from PayPal having approved the order. */
  async capture(orderId: string): Promise<{ credited: boolean; status: string; balanceCents: number }> {
    const topUp = this.deps.store.getTopUp(orderId)
    if (!topUp) throw new ServiceError('Unknown order.', 404)
    if (topUp.status === 'credited') return { credited: false, status: 'already_credited', balanceCents: this.deps.store.user(topUp.userId).balanceCents }
    // The request id makes a retried capture safe on PayPal's side too.
    const captured = await this.deps.paypal.captureOrder(orderId, `capture-${orderId}`)
    if (captured.status === 'COMPLETED' && captured.captureStatus === 'COMPLETED' && captured.captureId) {
      if (captured.amountCents !== topUp.amountCents) {
        this.log(`capture ${captured.captureId} amount ${captured.amountCents} differs from the order ${topUp.amountCents}: not credited`)
        throw new ServiceError('The captured amount does not match the order. Nothing was credited.', 409)
      }
      const credited = this.deps.store.creditOnce(orderId, captured.captureId, topUp.amountCents, 'capture')
      return { credited, status: credited ? 'credited' : 'already_credited', balanceCents: this.deps.store.user(topUp.userId).balanceCents }
    }
    // Declined, voided or still pending: money did not arrive, so no credit.
    if (captured.captureStatus && captured.captureStatus !== 'COMPLETED' && captured.captureStatus !== 'PENDING') this.deps.store.markFailed(orderId)
    return { credited: false, status: captured.captureStatus ?? captured.status, balanceCents: this.deps.store.user(topUp.userId).balanceCents }
  }

  /** PayPal calls this. The signature is verified first; an unverifiable request credits nothing. */
  async handleWebhook(headers: Record<string, string | string[] | undefined>, rawBody: string): Promise<{ status: number; body: Record<string, unknown> }> {
    let verified = false
    try {
      verified = await this.deps.paypal.verifyWebhook(headers, rawBody)
    } catch (error) {
      this.log(`webhook verification error: ${(error as Error).message}`)
      // PayPal retries on a 5xx, which is what we want when verification itself could not run.
      return { status: 503, body: { error: 'verification_unavailable' } }
    }
    if (!verified) return { status: 401, body: { error: 'invalid_signature' } }

    let event: { id?: string; event_type?: string; resource?: Record<string, any> }
    try {
      event = JSON.parse(rawBody)
    } catch {
      return { status: 400, body: { error: 'invalid_json' } }
    }
    if (!event.id || !event.event_type) return { status: 400, body: { error: 'invalid_event' } }
    if (!this.deps.store.firstSeen(event.id)) return { status: 200, body: { handled: false, reason: 'duplicate_event' } }

    const resource = event.resource ?? {}
    const orderId: string | undefined = resource.supplementary_data?.related_ids?.order_id
    if (!orderId) return { status: 200, body: { handled: false, reason: 'no_order' } }
    const topUp = this.deps.store.getTopUp(orderId)
    if (!topUp) return { status: 200, body: { handled: false, reason: 'not_our_order' } }

    if (event.event_type === 'PAYMENT.CAPTURE.COMPLETED') {
      const paid = resource.amount?.value !== undefined ? toCents(String(resource.amount.value)) : null
      if (paid !== topUp.amountCents || resource.amount?.currency_code !== 'USD') {
        this.log(`webhook ${event.id}: amount ${paid} ${resource.amount?.currency_code} does not match order ${topUp.amountCents} USD: not credited`)
        return { status: 200, body: { handled: false, reason: 'amount_mismatch' } }
      }
      const credited = this.deps.store.creditOnce(orderId, String(resource.id), topUp.amountCents, 'webhook')
      return { status: 200, body: { handled: true, credited } }
    }
    if (event.event_type === 'PAYMENT.CAPTURE.DENIED' || event.event_type === 'PAYMENT.CAPTURE.DECLINED') {
      this.deps.store.markFailed(orderId)
      return { status: 200, body: { handled: true, credited: false } }
    }
    return { status: 200, body: { handled: false, reason: 'ignored_event_type' } }
  }
}
