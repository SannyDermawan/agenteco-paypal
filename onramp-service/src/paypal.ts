/**
 * A small client for the PayPal REST APIs this project uses, SANDBOX ONLY: OAuth token, Orders v2 (create, capture, show),
 * webhook signature verification, and Payouts. The constructor refuses any base URL that is not a sandbox host, so a live
 * credential can never be used by mistake.
 */
export const SANDBOX_BASE = 'https://api-m.sandbox.paypal.com'

export class PayPalError extends Error {
  constructor(message: string, readonly status?: number, readonly debugId?: string) {
    super(message)
    this.name = 'PayPalError'
  }
}

export interface PayPalConfig {
  clientId: string
  clientSecret: string
  /** Needed to verify webhook signatures. */
  webhookId?: string
  baseUrl?: string
  fetchImpl?: typeof fetch
  now?: () => number
}

export interface CreatedOrder {
  id: string
  status: string
  /** The page where the buyer approves the payment. */
  approveUrl: string | null
}

export interface CapturedOrder {
  orderId: string
  status: string
  captureId: string | null
  captureStatus: string | null
  amountCents: number | null
  payerEmail: string | null
}

export const usd = (cents: number): string => (cents / 100).toFixed(2)
export const toCents = (value: string): number => Math.round(Number(value) * 100)

type Json = Record<string, any>

export class PayPalClient {
  private readonly base: string
  private readonly doFetch: typeof fetch
  private readonly now: () => number
  private cached: { token: string; expiresAt: number } | null = null

  constructor(private readonly config: PayPalConfig) {
    if (!config.clientId || !config.clientSecret) throw new PayPalError('PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are not set.')
    const base = (config.baseUrl ?? SANDBOX_BASE).replace(/\/+$/, '')
    if (!/^https:\/\/api(-m)?\.sandbox\.paypal\.com$/.test(base)) throw new PayPalError(`Refusing ${base}: this project only talks to the PayPal sandbox.`)
    this.base = base
    this.doFetch = config.fetchImpl ?? fetch
    this.now = config.now ?? Date.now
  }

  private async token(): Promise<string> {
    if (this.cached && this.cached.expiresAt > this.now() + 60_000) return this.cached.token
    const basic = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString('base64')
    const res = await this.doFetch(`${this.base}/v1/oauth2/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(20_000),
    })
    const body = (await res.json().catch(() => ({}))) as Json
    if (!res.ok || typeof body.access_token !== 'string') throw new PayPalError(`PayPal did not issue a token (HTTP ${res.status})`, res.status, res.headers.get('paypal-debug-id') ?? undefined)
    this.cached = { token: body.access_token, expiresAt: this.now() + Number(body.expires_in ?? 300) * 1000 }
    return body.access_token
  }

  private async call(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<{ status: number; json: Json }> {
    const res = await this.doFetch(`${this.base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${await this.token()}`, 'Content-Type': 'application/json', ...extraHeaders },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    })
    const json = (await res.json().catch(() => ({}))) as Json
    if (!res.ok) throw new PayPalError(`PayPal ${method} ${path} answered HTTP ${res.status}: ${json.message ?? json.name ?? 'error'}`, res.status, res.headers.get('paypal-debug-id') ?? undefined)
    return { status: res.status, json }
  }

  /** Orders v2: creates a CAPTURE order. `requestId` makes a retried create return the same order (PayPal-Request-Id). */
  async createOrder(input: { amountCents: number; referenceId: string; returnUrl: string; cancelUrl: string; requestId: string }): Promise<CreatedOrder> {
    const { json } = await this.call(
      'POST',
      '/v2/checkout/orders',
      {
        intent: 'CAPTURE',
        purchase_units: [{ reference_id: input.referenceId, description: 'AgentEco test balance top-up (sandbox)', amount: { currency_code: 'USD', value: usd(input.amountCents) } }],
        payment_source: { paypal: { experience_context: { return_url: input.returnUrl, cancel_url: input.cancelUrl, user_action: 'PAY_NOW', shipping_preference: 'NO_SHIPPING' } } },
      },
      { 'PayPal-Request-Id': input.requestId }
    )
    const links = (Array.isArray(json.links) ? json.links : []) as { rel?: string; href?: string }[]
    const approve = links.find((l) => l.rel === 'payer-action') ?? links.find((l) => l.rel === 'approve')
    return { id: String(json.id), status: String(json.status), approveUrl: approve?.href ?? null }
  }

  /** Orders v2: captures an approved order. */
  async captureOrder(orderId: string, requestId?: string): Promise<CapturedOrder> {
    const { json } = await this.call('POST', `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {}, requestId ? { 'PayPal-Request-Id': requestId } : {})
    return parseCaptured(orderId, json)
  }

  async getOrder(orderId: string): Promise<CapturedOrder> {
    const { json } = await this.call('GET', `/v2/checkout/orders/${encodeURIComponent(orderId)}`)
    return parseCaptured(orderId, json)
  }

  /**
   * Verifies a webhook delivery with PayPal's verify-webhook-signature endpoint. The event is posted back EXACTLY as received
   * (a re-serialised body can fail verification), so the raw text is spliced into the request body.
   */
  async verifyWebhook(headers: Record<string, string | string[] | undefined>, rawBody: string): Promise<boolean> {
    if (!this.config.webhookId) throw new PayPalError('PAYPAL_WEBHOOK_ID is not set, so webhook signatures cannot be verified.')
    const h = (name: string) => {
      const v = headers[name]
      return Array.isArray(v) ? v[0] : v
    }
    const fields = {
      auth_algo: h('paypal-auth-algo'),
      cert_url: h('paypal-cert-url'),
      transmission_id: h('paypal-transmission-id'),
      transmission_sig: h('paypal-transmission-sig'),
      transmission_time: h('paypal-transmission-time'),
      webhook_id: this.config.webhookId,
    }
    if (Object.values(fields).some((v) => !v)) return false
    const body = `{${Object.entries(fields)
      .map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`)
      .join(',')},"webhook_event":${rawBody}}`
    const { json } = await this.call('POST', '/v1/notifications/verify-webhook-signature', body)
    return json.verification_status === 'SUCCESS'
  }

  /** Payouts: sends sandbox money to a PayPal email. `senderBatchId` makes a retry idempotent for the batch. */
  async createPayout(input: { email: string; amountCents: number; senderBatchId: string; note: string }): Promise<{ batchId: string; status: string }> {
    const { json } = await this.call('POST', '/v1/payments/payouts', {
      sender_batch_header: { sender_batch_id: input.senderBatchId, email_subject: 'AgentEco sandbox payout', email_message: input.note },
      items: [{ recipient_type: 'EMAIL', amount: { value: usd(input.amountCents), currency: 'USD' }, receiver: input.email, note: input.note, sender_item_id: input.senderBatchId }],
    })
    const header = (json.batch_header ?? {}) as Json
    return { batchId: String(header.payout_batch_id ?? ''), status: String(header.batch_status ?? 'PENDING') }
  }
}

function parseCaptured(orderId: string, json: Json): CapturedOrder {
  const unit = (Array.isArray(json.purchase_units) ? json.purchase_units[0] : undefined) as Json | undefined
  const capture = (unit?.payments?.captures?.[0] ?? null) as Json | null
  return {
    orderId,
    status: String(json.status ?? 'UNKNOWN'),
    captureId: capture ? String(capture.id) : null,
    captureStatus: capture ? String(capture.status) : null,
    amountCents: capture?.amount?.value !== undefined ? toCents(String(capture.amount.value)) : null,
    payerEmail: (json.payer?.email_address as string | undefined) ?? null,
  }
}
