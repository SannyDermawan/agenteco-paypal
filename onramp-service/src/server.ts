import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { openAiCompatible } from '@agenteco/sdk'
import { PayPalClient } from './paypal.ts'
import { OnrampService, ServiceError } from './service.ts'
import { SdkJobRunner, runJob, type AgentDeps } from './agent.ts'
import { Store } from './store.ts'

const PUBLIC_DIR = resolve(fileURLToPath(new URL('../public', import.meta.url)))
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' }

export interface ServerDeps {
  service: OnrampService | null
  agent: AgentDeps | null
  store: Store
  /** What is configured, shown to the page so it can say what is missing instead of failing mysteriously. */
  config: { paypal: boolean; webhook: boolean; agent: boolean; payout: boolean; usdToToken: number }
}

function send(res: ServerResponse, status: number, body: unknown, type = 'application/json') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' })
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body))
}

async function readRaw(req: IncomingMessage, limit = 100_000): Promise<string> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > limit) throw new ServiceError('Request too large', 413)
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

const topUpBody = z.object({ userId: z.string(), amountUsd: z.number() })
const jobBody = z.object({ userId: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/), goal: z.string().min(5).max(4000), maxBudgetUsd: z.number().min(0.01).max(50) })

export function buildServer(deps: ServerDeps) {
  const notConfigured = (what: string) => ({ error: 'not_configured', detail: `${what} is not configured on this server. See the README.` })
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const path = url.pathname

      if (req.method === 'GET' && path === '/api/config') return send(res, 200, deps.config)

      if (req.method === 'POST' && path === '/api/webhooks/paypal') {
        if (!deps.service) return send(res, 503, notConfigured('PayPal'))
        const raw = await readRaw(req)
        const out = await deps.service.handleWebhook(req.headers, raw)
        return send(res, out.status, out.body)
      }

      if (req.method === 'POST' && path === '/api/topups') {
        if (!deps.service) return send(res, 503, notConfigured('PayPal'))
        const body = topUpBody.safeParse(JSON.parse((await readRaw(req)) || '{}'))
        if (!body.success) return send(res, 400, { error: 'invalid_request' })
        return send(res, 200, await deps.service.startTopUp(body.data.userId, body.data.amountUsd))
      }

      const capture = /^\/api\/topups\/([A-Za-z0-9-]+)\/capture$/.exec(path)
      if (req.method === 'POST' && capture) {
        if (!deps.service) return send(res, 503, notConfigured('PayPal'))
        return send(res, 200, await deps.service.capture(capture[1]!))
      }

      const user = /^\/api\/users\/([A-Za-z0-9_-]{1,40})$/.exec(path)
      if (req.method === 'GET' && user) {
        const id = user[1]!
        return send(res, 200, { userId: id, balanceCents: deps.store.user(id).balanceCents, jobs: deps.store.jobsOf(id).map(({ result: _r, ...j }) => j) })
      }

      if (req.method === 'POST' && path === '/api/jobs') {
        if (!deps.agent) return send(res, 503, notConfigured('The buyer agent (AI model and testnet wallet)'))
        const body = jobBody.safeParse(JSON.parse((await readRaw(req)) || '{}'))
        if (!body.success) return send(res, 400, { error: 'invalid_request', detail: body.error.issues[0]?.message })
        return send(res, 200, await runJob(body.data.userId, body.data.goal, body.data.maxBudgetUsd, deps.agent))
      }

      if (req.method === 'GET') {
        const file = path === '/' ? 'index.html' : path.slice(1)
        const full = normalize(join(PUBLIC_DIR, file))
        if (!full.startsWith(PUBLIC_DIR)) return send(res, 404, { error: 'Not found' })
        try {
          return send(res, 200, await readFile(full), TYPES[extname(full)] ?? 'application/octet-stream')
        } catch {
          return send(res, 404, { error: 'Not found' })
        }
      }
      send(res, 404, { error: 'Not found' })
    } catch (error) {
      if (error instanceof ServiceError) return send(res, error.status, { error: error.message })
      if (error instanceof SyntaxError) return send(res, 400, { error: 'invalid_json' })
      console.error('[server]', error)
      send(res, 500, { error: 'Something went wrong.' })
    }
  })
}

/** Builds the real dependencies from the environment. Whatever is not configured stays null and the API says so. */
export function depsFromEnv(env: NodeJS.ProcessEnv = process.env): ServerDeps {
  const store = new Store(env.DATA_FILE || undefined)
  const log = (m: string) => console.log(`[onramp] ${m}`)
  const usdToToken = Number(env.USD_TO_TOKEN || 1)
  let paypal: PayPalClient | null = null
  if (env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET) paypal = new PayPalClient({ clientId: env.PAYPAL_CLIENT_ID, clientSecret: env.PAYPAL_CLIENT_SECRET, webhookId: env.PAYPAL_WEBHOOK_ID })
  const service = paypal ? new OnrampService({ paypal, store, publicBaseUrl: env.PUBLIC_BASE_URL || 'http://localhost:8788', log }) : null

  let agent: AgentDeps | null = null
  if (env.AI_BASE_URL && env.AI_API_KEY && env.AI_MODEL && env.CUSTODIAL_PRIVATE_KEY) {
    const ai = openAiCompatible({ baseUrl: env.AI_BASE_URL, apiKey: env.AI_API_KEY, model: env.AI_MODEL })
    agent = {
      store,
      ai,
      usdToToken,
      log,
      runner: new SdkJobRunner({ privateKey: env.CUSTODIAL_PRIVATE_KEY as `0x${string}`, apiUrl: env.AGENTECO_API_URL || undefined, ai, log }),
      payout: { paypal: paypal ?? undefined, sellerEmail: env.DEMO_SELLER_PAYPAL_EMAIL || undefined },
    }
  }
  return {
    service,
    agent,
    store,
    config: { paypal: Boolean(paypal), webhook: Boolean(env.PAYPAL_WEBHOOK_ID), agent: Boolean(agent), payout: Boolean(paypal && env.DEMO_SELLER_PAYPAL_EMAIL), usdToToken },
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const deps = depsFromEnv()
  const port = Number(process.env.PORT || 8788)
  buildServer(deps).listen(port, () => console.log(`onramp-service on http://localhost:${port}`, deps.config))
}
