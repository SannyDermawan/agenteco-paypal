# Deploying AgentEco (multi-chain)

Status: **this is how the stack was deployed on 13 October 2026** (Railway: api, keeper and host from this repository's root; Supabase for the database; Vercel for the website, now at [www.agenteco.web.id](https://www.agenteco.web.id), API at `https://agenteco-multichain-production.up.railway.app`). It was written as a checklist and then followed; where a dashboard differs from a step, the dashboard wins. Back to the [README](../AGENTECO.md); the chain settings come from [MULTICHAIN.md](MULTICHAIN.md) ("Serving every deployed chain").

What exists today and stays as it is: the BNB edition (`agenteco-bnb.vercel.app` and its Railway API), which reads its own database. **Do not point the multi-chain backend at that database**: the multi-chain schema adds `chainId` to most tables, and the old API would stop working. Deploy the multi-chain stack next to it, with its own database.

## 1. Database

1. Create a new Postgres (for example a second Supabase project). Note the pooled connection string (`DATABASE_URL`) and the direct one (`DIRECT_URL`).
2. From your machine, once: `cd backend`, set `DIRECT_URL` in your environment, run `npx prisma db push`. It creates the schema; nothing is carried over from BNB.
3. The new database starts empty: no agents, orders or ratings. `npm run seed:sellers` (from `backend/`, with `AGENTECO_API_URL` pointing at the new API) creates the platform's demo hosted sellers, which are funded with gas on the default chain.

## 2. Backend (Railway)

Three processes, from the **repository root** (Node 22.9 or newer). The backend imports code from `agent-runtime/`, which has its own dependencies, so the backend cannot be built from `backend/` alone (a backend-only install fails at start with `Cannot find package 'zod'`, checked on a fresh clone). The root `package.json` was written for this: its `postinstall` installs `agent-runtime` and `backend`, and `npm start` starts the API. So on Railway or any similar host: **leave Root Directory empty**, keep the default install (`npm install`), and give each service only its start command:

| Service | Start command | What it does |
|---|---|---|
| api | `npm start` | the REST API the website and the CLI talk to |
| keeper | `npm run start:keeper` | claims timeouts (permissionless; needs a funded `KEEPER_PRIVATE_KEY`) |
| host | `npm run start:host` | hosted agents and the AI arbiter |

Look at how your existing BNB services are set up (Settings, Build and Deploy) before copying: they were built from another repository layout.

Settings every service needs (public values, from MULTICHAIN.md):

```
CHAINS=bsc-testnet,base-sepolia,ethereum-sepolia,arbitrum-sepolia,tempo-moderato,bot-testnet
AGENT_ECO_ADDRESS__eip155_84532=0xF8448762AeCE0039f1072Da74477fbFAD629fDB8
DEPLOYMENT_BLOCK__eip155_84532=48021794
AGENT_ECO_ADDRESS__eip155_11155111=0x3048b1a3CeeE4f1AF09485e49f059d094EF6f865
DEPLOYMENT_BLOCK__eip155_11155111=11901363
AGENT_ECO_ADDRESS__eip155_421614=0xaf77570B25D2EAD24a53Eead61deEB0bc21a83ea
DEPLOYMENT_BLOCK__eip155_421614=318529770
AGENT_ECO_ADDRESS__eip155_42431=0x2620424C73A39624bDcd3fa43aABF425d6Da997e
DEPLOYMENT_BLOCK__eip155_42431=39319911
AGENT_ECO_ADDRESS__eip155_968=0xaf77570B25D2EAD24a53Eead61deEB0bc21a83ea
DEPLOYMENT_BLOCK__eip155_968=26642374
EVM_STALE_RETRIES=3
DATABASE_URL=...        # secret
DIRECT_URL=...          # secret
```

Do **not** set `RPC_URL__eip155_84532=https://sepolia.base.org` for the servers: that node answers `eth_getLogs` only over 200 blocks, so the rating index fails every minute. The default (PublicNode, with sepolia.base.org as the fallback) serves 45,000 blocks per call; `EVM_STALE_RETRIES` covers a lagging node. (The proof runs used the official node alone, because they sent transactions in quick succession.)

Only the **api** serves Solana (it needs no key); add `solana-devnet` to its `CHAINS` and `AGENT_ECO_PROGRAM__solana_EtWTRABZaYq6iMfeYKouRu166VU2xqa1=3GEEC3dQH1tP2YTZD9Jv915Yj8hcSN6WE8nQZiLJcgHE`. Leave Solana out of the keeper's `CHAINS`: its Solana keeper wants a keypair **file** (`SOLANA_KEEPER_KEYPAIR`), which a Railway service does not have.

Per service, on top of the above:

- **api:** `FRONTEND_ORIGIN` (comma-separated, each exactly as the browser shows it: `https://agenteco.web.id,https://www.agenteco.web.id,https://<project>.vercel.app`, so the custom domain and the `*.vercel.app` address both work; also the origin a signed-in session may name), `PUBLIC_API_URL` (this API's own public URL), `AGENT_KEY_ENCRYPTION_SECRET` (a long random secret, never changed afterwards or hosted agents' keys become unreadable), and the model keys (`GROQ_API_KEY`, `GEMINI_API_KEY`) if it runs AI checks.
- **keeper:** `KEEPER_PRIVATE_KEY`, a wallet with gas on every EVM chain in its `CHAINS` (test ETH, test BNB, BOT; Tempo needs no gas token). Start with fewer chains if funding all of them is a chore: anyone can claim a timeout, so a chain without a keeper is not stuck.
- **host:** `ARBITER_PRIVATE_KEY` (the proof runs used one wallet as a member of every chain's council, so the AI arbiter can rule on all of them), `AGENT_KEY_ENCRYPTION_SECRET` (the same value as the api), the model keys, `PUBLIC_API_URL`, `AGENTECO_API_URL` (the api's URL). Hosted agents need gas on the chain they trade on, so keep hosted agents to `bsc-testnet` unless you fund the others.

All secrets stay in Railway's variables; nothing above is to be committed. `backend/.env.example` lists every setting with its comment.

Check after the first deploy: `GET <api>/health` answers `{"ok":true,"db":"connected"}`, `GET <api>/chains` lists the chains you set (it answers 404 on the BNB-only API), and `GET <api>/device-links` answers something other than 404 (the one-prompt CLI needs it).

### A free route for the api only: Render

For the demo only the **api** is needed (the keeper and the host are optional, see above). Render's free web service needs no card; the figures below come from comparison sites in October 2026, so check Render's pricing page:

- It **sleeps after 15 minutes without traffic** and takes about a minute to wake on the next request; 750 free instance hours a month, enough for one service to stay up all month.
- `render.yaml` at the root of this repository describes the service (**New, Blueprint**, pick the repository). It lists the public settings; the secrets (`DATABASE_URL`, `DIRECT_URL`, `AGENT_KEY_ENCRYPTION_SECRET`) are asked for in the dashboard and never stored in the file. After the first deploy, set `FRONTEND_ORIGIN` and `PUBLIC_API_URL` to the real addresses.
- To keep it awake, a free uptime monitor (UptimeRobot, cron-job.org) can request `<api>/health` every 5 minutes. `/health` also queries the database, which keeps a free Supabase project from pausing for inactivity. Check Render's and the monitor's terms before relying on it.
- Without the pinger, open the API's `/health` a minute before a demo or a video take.

A paid Railway Hobby plan (about US$5 a month, check its page) avoids the sleep and uses the same install and start commands.

## 3. Website (Vercel)

1. **Add New, Project**, import `SannyDermawan/agenteco-multichain`, framework Next.js, **Root Directory** `frontend`. Keep "Include source files outside of the Root Directory" on: the website imports `agent-runtime/src/shared`, and `npm install` there also installs `agent-runtime`.
2. Environment variables (all baked in at build time; change one, redeploy):

```
NEXT_PUBLIC_API_URL=https://<your multi-chain api>
NEXT_PUBLIC_NETWORK=bsc-testnet
NEXT_PUBLIC_CHAINS=bsc-testnet,base-sepolia,ethereum-sepolia,arbitrum-sepolia,tempo-moderato,bot-testnet,solana-devnet
NEXT_PUBLIC_AGENT_ECO_ADDRESS__eip155_84532=0xF8448762AeCE0039f1072Da74477fbFAD629fDB8
NEXT_PUBLIC_DEPLOY_BLOCK__eip155_84532=48021794
NEXT_PUBLIC_AGENT_ECO_ADDRESS__eip155_11155111=0x3048b1a3CeeE4f1AF09485e49f059d094EF6f865
NEXT_PUBLIC_DEPLOY_BLOCK__eip155_11155111=11901363
NEXT_PUBLIC_AGENT_ECO_ADDRESS__eip155_421614=0xaf77570B25D2EAD24a53Eead61deEB0bc21a83ea
NEXT_PUBLIC_DEPLOY_BLOCK__eip155_421614=318529770
NEXT_PUBLIC_AGENT_ECO_ADDRESS__eip155_42431=0x2620424C73A39624bDcd3fa43aABF425d6Da997e
NEXT_PUBLIC_DEPLOY_BLOCK__eip155_42431=39319911
NEXT_PUBLIC_AGENT_ECO_ADDRESS__eip155_968=0xaf77570B25D2EAD24a53Eead61deEB0bc21a83ea
NEXT_PUBLIC_DEPLOY_BLOCK__eip155_968=26642374
NEXT_PUBLIC_AGENT_ECO_PROGRAM__solana_EtWTRABZaYq6iMfeYKouRu166VU2xqa1=3GEEC3dQH1tP2YTZD9Jv915Yj8hcSN6WE8nQZiLJcgHE
```

   `bsc-testnet` keeps its built-in deployment, so it needs no address. **The build fails** if a listed network has no address or block. Copy the other `NEXT_PUBLIC_*` settings (timers, demo mode, minimum gas) from your BNB project so the two sites behave alike.
3. Deploy, and test the site on its `*.vercel.app` address before touching any domain: connect a wallet, switch chains with the picker, open an agent, and look at the browser console for failed requests (CORS errors mean `FRONTEND_ORIGIN` on the api does not match the site).

## 4. Moving `agenteco.web.id`

The registrar (Arxan) already delegates the domain to Vercel (`ns1.vercel-dns.com`, `ns2.vercel-dns.com`), so **nothing changes at Arxan**: the DNS records live in Vercel, and a domain is attached to a project there. (Only if the nameservers were ever set back to the registrar's own would you need an `A` record to `76.76.21.21` and a `CNAME` for `www` to `cname.vercel-dns.com`.)

Moving the domain from the old project (the one connected to the earlier repository) to the new one:

1. Finish section 3 and check the new project on its `*.vercel.app` address.
2. Old project, **Settings, Domains**: remove `www.agenteco.web.id` (and `agenteco.web.id` if it is listed). The old project keeps working on its own `*.vercel.app` address, so it stays available for reference and as a way back.
3. New project, **Settings, Domains**: add `agenteco.web.id` and `www.agenteco.web.id`; pick which one redirects to the other. Vercel verifies them at once, because it already holds the DNS.
4. Open the domain in a private window. If it still shows the old site, wait a few minutes (cached DNS) and hard-reload.

To go back: remove the domain from the new project and add it to the old one again.

The simpler variant, **reconnecting the old project to the new repository** (Settings, Git, Disconnect, then connect `agenteco-multichain` and set the Root Directory to `frontend`), keeps the domain in place but replaces the old site at the next production deploy and loses the easy way back, so it is not recommended; the old BOT Chain mainnet deployment (an earlier contract) is not served by the new site either way.

## 5. After it is live

- Done on 13 Oct 2026: the website and API addresses are in the README and the "not deployed publicly" notes were changed. Still to do by hand: the addresses in the Colosseum form.
- `npx @agenteco/cli doctor` with `AGENTECO_API_URL` set to the new API should stop warning about `/chains` and `/device-links`.
- Real wallets on Solana (Phantom and others) have not been tried: try one before saying it works.
