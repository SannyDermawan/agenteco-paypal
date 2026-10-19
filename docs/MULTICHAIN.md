# Multi-chain

Status: **implemented for EVM chains** (BSC Testnet, BOT Chain, Base Sepolia, Ethereum Sepolia, Arbitrum Sepolia and Tempo Moderato presets; BOT Chain Testnet and the last four are deployed and each ran a three-deal proof run, §4). Solana: the escrow program and `SolanaAdapter` are built and tested locally ([SOLANA.md](SOLANA.md)), the backend can serve a Solana chain for self-hosted agents (§5), the SDK, CLI and MCP server trade on it, and the website connects a Solana wallet and hires, settles, disputes and rates on it; the program is deployed on devnet and a three-deal proof run passed there (13 Oct 2026, [SOLANA.md](SOLANA.md#proof-run-on-devnet)); the multi-chain API and website are live since 13 Oct 2026 ([www.agenteco.web.id](https://www.agenteco.web.id), [API](https://agenteco-multichain-production.up.railway.app/health)) and serve every network above, Solana for self-hosted agents. Back to the [README](../AGENTECO.md).

One backend, one database and one SDK run the same escrow, dispute and reputation flow on several chains at once. With no new settings, everything behaves exactly as the single-chain BNB version did.

## 1. What was single-chain, and what replaced it

| Before | Now |
|---|---|
| `network.ts` exported the contract, token, RPC and explorer of one `NETWORK` as module constants | `ChainRegistry` (`agent-runtime/src/chain/registry.ts`): any number of chains, each an `EvmChainConfig`; `NETWORK` stays the primary chain |
| Escrow logic called viem directly in ~20 files | `ChainAdapter` interface, `EvmAdapter` implementation; business logic calls the adapter |
| `escrowId` unique on its own | unique per `(chainId, escrowId)` |
| 18 decimals assumed | the token's own `decimals()` (tested with a 6-decimal token) |
| one keeper / host loop | one loop per served chain; a failing chain does not stop the others |

## 2. Chain identity

Every chain is a [CAIP-2](https://chainagnostic.org/CAIPs/caip-2) id. Network names, aliases and bare EVM chain ids are accepted wherever a chain is named.

| Chain | `chainId` | names |
|---|---|---|
| BSC Testnet | `eip155:97` | `bsc-testnet`, `97` |
| BOT Chain Testnet / Mainnet | `eip155:968` / `eip155:677` | `bot-testnet` (`testnet`) / `bot-mainnet` (`mainnet`) |
| Base Sepolia | `eip155:84532` | `base-sepolia`, `84532` |
| Ethereum Sepolia | `eip155:11155111` | `ethereum-sepolia`, `11155111` |
| Arbitrum Sepolia | `eip155:421614` | `arbitrum-sepolia`, `421614` |
| Tempo Testnet (Moderato) | `eip155:42431` | `tempo-moderato`, `42431` |
| Solana devnet | `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` (genesis-hash prefix) | `solana-devnet`, `solana` (served once its program is configured, §4) |

## 3. `ChainAdapter`

The chain-neutral surface, in `agent-runtime/src/chain/types.ts`:

```ts
type ChainId = string // CAIP-2
type EscrowId = bigint // a uint256 on EVM chains, a u64 on Solana: both fit

interface ChainAdapter {
  readonly chainId: ChainId
  readonly family: 'evm' | 'solana'
  readonly signer: string | null // the wallet that signs writes; null = read-only adapter
  readonly nativeSymbol: string
  readonly explorer: { name: string; txUrl(hash: string): string; addressUrl(address: string): string }

  normalizeAddress(address: string): string // EVM: lowercase hex; Solana: base58 as is
  isValidAddress(address: string): boolean
  verifySignature(p: { address: string; message: string; signature: string }): Promise<boolean> // EVM: EIP-191; Solana: ed25519, base58
  token(): Promise<{ address: string; symbol: string; decimals: number }>
  head(): Promise<bigint>
  nativeBalance(address: string): Promise<bigint>
  tokenBalance(address: string): Promise<bigint>

  // writes (need a signer)
  createAndFundEscrow(p: { seller: string; amount: number | string; taskHash: Hash32 }): Promise<EscrowId>
  startExecution(id: EscrowId): Promise<void>
  markDelivered(id: EscrowId, resultHash: Hash32): Promise<void>
  acceptAndSettle(id: EscrowId): Promise<void>
  raiseDispute(id: EscrowId, reasonHash: Hash32): Promise<TxHash>
  submitDisputeResponse(id: EscrowId, responseHash: Hash32): Promise<TxHash>
  rateSeller(id: EscrowId, score: number): Promise<TxHash>
  resolveDispute(id: EscrowId, toSeller: boolean, rationaleHash: Hash32): Promise<TxHash> // arbiter wallet
  ruleDispute(id: EscrowId, toSeller: boolean, rationaleHash: Hash32): Promise<RulingOutcome> // wallet or council vote
  claimTimeout(id: EscrowId, action: TimeoutAction, hooks?: TimeoutClaimHooks): Promise<TimeoutClaim> // permissionless, simulated first
  transferToken(to: string, amount: bigint): Promise<TxHash>
  sweepNative(to: string): Promise<TxHash | null>

  // reads
  getEscrowBasic(id: EscrowId): Promise<EscrowBasic>
  getEscrowStatus(id: EscrowId): Promise<number>
  getResultHash(id: EscrowId): Promise<Hash32>
  getEscrowHashes(id: EscrowId): Promise<EscrowHashes>
  getEscrowTimestamps(id: EscrowId): Promise<EscrowTimestamps>
  getEscrowWindows(id: EscrowId): Promise<EscrowWindows>
  getEscrowDisputeInfo(id: EscrowId): Promise<EscrowDisputeInfo>
  readTimeoutFlag(id: EscrowId, flag: TimeoutFlag): Promise<boolean>
  getArbiterSetup(id?: EscrowId): Promise<ArbiterSetup>
  escrowIds(opts?: { currentOnly?: boolean }): Promise<EscrowId[]>
  readEscrowBasics(ids: EscrowId[]): Promise<EscrowBasic[]>
  listEscrows(opts?: { currentOnly?: boolean }): Promise<EscrowBasic[]>
  getReputation(seller: string): Promise<OnchainReputation>
  timerLimits(): Promise<TimerLimits>
  ratingsInTx(txHash: string): Promise<RatingEvent[]>
  ratings(fromBlock: bigint, toBlock: bigint): Promise<RatingEvent[]>
}
```

`TxHash` is a `string`: an EVM transaction hash or a Solana signature. Status codes are the contract's state machine, in order: `CREATED, FUNDED, EXECUTING, DELIVERED, DISPUTED, SETTLED, REFUNDED`. Amounts are base units; `createAndFundEscrow` takes a decimal amount and converts it with the token's real decimals. Hashes stay keccak256 of the committed preimage (`agent-runtime/src/shared/hashes.ts`) on every chain.

Rules: no chain-specific branching outside adapters; signing keys are handed to an adapter, never read from `process.env` inside it.

**`EvmAdapter`** (`chain/evm.ts`, viem) holds all escrow, arbiter-council, escrow-index, keeper, reputation, token and rating-event logic, plus ERC-8004 (section 6). It has no module state: the deployment comes in as an `EvmChainConfig`, the wallet as `EvmClients`. The older helpers (`onchain/escrow.ts`, `arbiter.ts`, `escrowIndex.ts`, `host/reputation.ts`) remain as thin wrappers over the primary chain, with unchanged signatures.

**`SolanaAdapter`** (`chain/solana.ts`, `@solana/kit` over the Anchor program in `solana/`): implements the whole interface with the same state machine, `u64` ids, SPL token accounts, ed25519 `verifySignature`, base58 addresses and rating events. It runs behind a `SolanaBackend`: litesvm in tests, `SolanaRpcBackend` (`chain/solana-rpc.ts`) for a cluster. One conformance scenario runs on `EvmAdapter` and on `SolanaAdapter` (litesvm, and a local validator). The backend serves it through `chain/multi.ts` (§5). Not done: any run on devnet, a real wallet extension on the website, a council program (a Squads vault is the decided arbiter). Details and limits in [SOLANA.md](SOLANA.md).

## 4. Configuration

### Backend and runtime

```
NETWORK=bsc-testnet                      # the primary chain; unsuffixed settings are its, as before
CHAINS=bsc-testnet,base-sepolia          # served chains, the default first; empty = NETWORK alone
AGENT_ECO_ADDRESS__eip155_84532=0x…      # every other chain: same setting names + CAIP-2 suffix
DEPLOYMENT_BLOCK__eip155_84532=…
# optional per chain: RPC_URL__…, RPC_FALLBACK_URLS__…, USDT_ADDRESS__…, LOG_RANGE_BLOCKS__…,
# HOSTED_MIN_GAS__…, LOW_GAS_WARN__…, ERC8004_IDENTITY_REGISTRY__…, ERC8004_REPUTATION_REGISTRY__…
```

A Solana chain is listed in `CHAINS` like any other (`CHAINS=solana-devnet,bsc-testnet`; the first is the default, of either family) and configured by the same suffix rule:

```
AGENT_ECO_PROGRAM__solana_EtWTRABZaYq6iMfeYKouRu166VU2xqa1=<program id>   # required: no default deployment
# optional: RPC_URL__… (default the public devnet RPC), TOKEN_MINT__… (default devnet USDC), FIRST_ESCROW_ID__…
SOLANA_KEEPER_KEYPAIR=/path/keypair.json                                   # the keeper's key for Solana chains (a Solana CLI keypair file)
```

`KEEPER_PRIVATE_KEY` is required only when an EVM chain is served. The suffix is the CAIP-2 id with the colon as an underscore. A served chain without a deployment address, or an RPC that reports another chain id (for Solana: another genesis hash), stops the process at startup. Escrow timers (`EXECUTION_WINDOW_SECONDS`, …) are shared and checked against every chain's contract.

### Frontend

```
NEXT_PUBLIC_NETWORK=bsc-testnet                          # primary; unsuffixed NEXT_PUBLIC_* are its
NEXT_PUBLIC_CHAINS=bsc-testnet,base-sepolia              # offered networks, the default first
NEXT_PUBLIC_AGENT_ECO_ADDRESS__eip155_84532=0x…
NEXT_PUBLIC_DEPLOY_BLOCK__eip155_84532=…
```

A Solana network is offered the same way (`NEXT_PUBLIC_CHAINS=solana-devnet,…`); its settings are `NEXT_PUBLIC_AGENT_ECO_PROGRAM__solana_<genesis prefix>` (required: no default deployment), `NEXT_PUBLIC_TOKEN_MINT__…`, `NEXT_PUBLIC_RPC_URL__…`, `NEXT_PUBLIC_RPC_FALLBACK_URLS__…` and `NEXT_PUBLIC_FIRST_ESCROW_ID__…` (see [SOLANA.md](SOLANA.md) §12).

Read at build time; the build fails if an offered network lacks its deployment. With more than one network, the top bar shows a picker: the choice is remembered in the browser and the app reloads on it. Every API call names the selected chain (`lib/api/base.ts`). The `/app` pages render in the browser only, so they never disagree with a server render; the landing page always describes the default network (`lib/web3/landingNetwork.ts`).

### Base Sepolia

Preset values were checked against the public RPC: chain id 84532, Circle's test USDC `0x036CbD53842c5426634e7929541eC2318f3dCF7e` (6 decimals), Multicall3 present. PublicNode is the primary RPC because `sepolia.base.org` limits `eth_getLogs` to 200 blocks; it stays as the fallback. Deploy with the existing script:

```
USDT_ADDRESS=0x036CbD53842c5426634e7929541eC2318f3dCF7e FIRST_ESCROW_ID=1 \
forge script script/DeployV3.s.sol --rpc-url base_sepolia --broadcast
```

then set `AGENT_ECO_ADDRESS__eip155_84532` / `DEPLOYMENT_BLOCK__eip155_84532` (and the `NEXT_PUBLIC_…` pair).

**Deployed on 12 October 2026** (the command above, `FIRST_ESCROW_ID=1`, fee 250 bps, treasury = the deployer, council members = the arbiter wallet and the deployer, ruling threshold 1, admin threshold 2):

| | |
|---|---|
| AgentEco v3 | [`0xF8448762AeCE0039f1072Da74477fbFAD629fDB8`](https://base-sepolia.blockscout.com/address/0xF8448762AeCE0039f1072Da74477fbFAD629fDB8?tab=contract), deployed at block `48021794` |
| ArbiterCouncil | [`0x3048b1a3CeeE4f1AF09485e49f059d094EF6f865`](https://base-sepolia.blockscout.com/address/0x3048b1a3CeeE4f1AF09485e49f059d094EF6f865?tab=contract), holds the arbiter role (checked on-chain) |
| Settlement token | Circle test USDC `0x036CbD53842c5426634e7929541eC2318f3dCF7e` (6 decimals) |
| Deployer / treasury | `0xFC2F38db21394C2dF0f1A690a154ad303311B644` |

Both contracts are source-verified on Blockscout (`forge verify-contract … --verifier blockscout --verifier-url https://base-sepolia.blockscout.com/api/`, no API key needed). The deployment transactions are in `broadcast/DeployV3.s.sol/84532/run-latest.json`.

**Proof run on 12 October 2026** (`agent-runtime/scripts/proof-run.ts base-sepolia`, real transactions, test wallets, the arbiter wallet voting through the council). Three deals through the chain-neutral adapter, with every balance checked against the contract's rules after each step:

| Escrow | What happened | Money |
|---|---|---|
| #6 | settled, then rated 90 | 0.4 USDC: 0.39 to the seller, **0.01 fee** to the treasury |
| #7 | the buyer disputed, the seller answered, the council ruled **for the buyer** | 0.4 USDC refunded, **no fee** |
| #8 | the buyer disputed, the seller answered, the council ruled **for the seller** | 0.3 USDC: 0.2925 to the seller, **0.0075 fee** |

Transactions: [dispute #7](https://sepolia.basescan.org/tx/0x1ca52b4a9ca921cb6540e3b7cef362637c5166034e1fe16227968d146fbfeadb), [response #7](https://sepolia.basescan.org/tx/0xad54c78d65e17016ca2a884cdfa14743ac29ce663b61dcc3049464277ebcb465), [ruling #7](https://sepolia.basescan.org/tx/0xfc08dffe172ee0342575f5f5cc85e8d369573d2c639dd8aa1932ca7cc4d57c7c), [dispute #8](https://sepolia.basescan.org/tx/0x844b7234828b867bfbcbaa1d7a2bdec85b33a47c7966ab67dfe82a5212a88cdf), [response #8](https://sepolia.basescan.org/tx/0xa184635e061cc8e14ac6570a2c6efdaa19fb5b8d21da1469c6e72835257793f7), [ruling #8](https://sepolia.basescan.org/tx/0xd3621793cfa599ce1d5d662f25eba53a4d4d82900018322544786f426f55f51f), [rating #6](https://sepolia.basescan.org/tx/0xa565d84f57460dc9313c5aebe13e4b8e05913cdac7b3853d351f7e4878b211ef). The seller's on-chain reputation after the run: 2 completed jobs, 0 failed, rating 90.

Escrows #1 to #5 are from the first attempts. They exposed a real problem, now fixed: a load-balanced public RPC can simulate the next call on a node that lags the previous transaction, so a call reverts ("Not executing", "Escrow does not exist", "transferFrom failed") while the chain is already in the right state. `EvmAdapter` now waits for an approval to be visible, and retries such a revert when `EVM_STALE_RETRIES` is set (the proof run sets 10; default 0, so a genuinely wrong call still fails at once). #1 and #2 were created but never funded; #4 settled normally; #3 and #5 were funded and left open, and are refunded by the permissionless timeout claims.

This is a run of the contract through the adapter, not a run of the whole product: negotiation, the hosted agents and the AI arbiter ran on BNB Smart Chain Testnet; the live multi-chain API and website, deployed afterwards, serve this chain, but no deal has gone through them here yet.

### Ethereum Sepolia

Chain id 11155111, Circle's test USDC `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` (6 decimals, checked on-chain), Multicall3 present, the official ERC-8004 registries present. PublicNode is the RPC; it serves `eth_getLogs` over 10,000 blocks and only about 50,000 blocks of history, so the preset's `logRange` is 9,000.

**Deployed on 13 October 2026** with the same script (`FIRST_ESCROW_ID=1`, fee 250 bps, treasury = the deployer, council = the arbiter wallet and the deployer, ruling threshold 1, admin threshold 2):

| | |
|---|---|
| AgentEco v3 | [`0x3048b1a3CeeE4f1AF09485e49f059d094EF6f865`](https://eth-sepolia.blockscout.com/address/0x3048b1a3CeeE4f1AF09485e49f059d094EF6f865?tab=contract), deployed at block `11901363` |
| ArbiterCouncil | [`0x2620424C73A39624bDcd3fa43aABF425d6Da997e`](https://eth-sepolia.blockscout.com/address/0x2620424C73A39624bDcd3fa43aABF425d6Da997e?tab=contract), holds the arbiter role |

Both are source-verified on Blockscout. **A real problem on this chain:** code deposit is priced far above the usual 200 gas per byte here (about 1,570 gas per byte, measured with `eth_estimateGas` on test contracts of 1 to 20 KB), so AgentEco (13.7 KB) needed about 20 million gas, and Foundry's default gas limit, taken from its local simulation (3.8 million), made the creation run out of gas twice (two failed transactions in the deployer's history; no contract came of them). `--gas-estimate-multiplier 800` fixed it. The deployment transactions are in `broadcast/DeployV3.s.sol/11155111/run-latest.json`.

**Proof run (13 October 2026, `agent-runtime/scripts/proof-run.ts ethereum-sepolia`)**, the same three deals as on Base, balances checked after every step:

| Escrow | What happened | Money |
|---|---|---|
| #1 | settled, then rated 90 | 0.4: 0.39 to the seller, **0.01 fee** to the treasury |
| #2 | the buyer disputed, the seller answered, the council ruled **for the buyer** | 0.4 refunded, **no fee** |
| #3 | the buyer disputed, the seller answered, the council ruled **for the seller** | 0.3: 0.2925 to the seller, **0.0075 fee** |

Transactions: [dispute #2](https://sepolia.etherscan.io/tx/0x923ba63df140169a76c9e2b55ba596b40ccbaeb84a30b5a055ad044bd6fed6e0), [response #2](https://sepolia.etherscan.io/tx/0x02ce12fa4149f8d37bce54c4aa1eaa6fc750abdacfb33408321b60577607a94c), [dispute #3](https://sepolia.etherscan.io/tx/0x2c88d44b126c5c2845b02006d53b30062682091c49fd1767b63af846966ea0b6), [response #3](https://sepolia.etherscan.io/tx/0xbf7a564a6a6b7c2ebbd5f4045bf34b1a6dcdc3fa75332a1adcc2aa34453ed25c), and the [rating of #1](https://sepolia.etherscan.io/tx/0xb3633ecd418cdb476221ce1caa704ebd60eb0aeabd230f7c7b4f91177b710d1c). **ERC-8004 ran live** on the official registries (`scripts/erc8004-proof.ts ethereum-sepolia`): the seller registered agent [#10853](https://sepolia.etherscan.io/tx/0xbdf07d22d8da4a5a2fa707714409eb76aa044d3603a377c96e8c4e4dd921fe5c), the buyer published [feedback](https://sepolia.etherscan.io/tx/0xe6889f37525eb7c2e8472797acb7399ba59090452083d93a3905f68d46ad3633) (value 90, tag `agenteco:eip155:11155111:1`) and read it back, and the registry refused the owner reviewing its own agent.

### Arbitrum Sepolia

Chain id 421614, Circle's test USDC `0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d` (6 decimals, checked on-chain), Multicall3 and the official ERC-8004 registries present. PublicNode is the RPC (50,000 blocks per `eth_getLogs`); the official sequencer RPC is the fallback, and what the deploy and the proof run use. Gas came from Ethereum Sepolia through the official Delayed Inbox (`depositEth`; the address is from docs.arbitrum.io and its `bridge()` matched the Arbitrum Sepolia bridge).

**Deployed on 13 October 2026** (same parameters; Foundry needs `--skip-simulation` here, so the gas limit comes from the node, which prices in the L1 data cost):

| | |
|---|---|
| AgentEco v3 | [`0xaf77570B25D2EAD24a53Eead61deEB0bc21a83ea`](https://sepolia.arbiscan.io/address/0xaf77570B25D2EAD24a53Eead61deEB0bc21a83ea#code), deployed at block `318529770` |
| ArbiterCouncil | [`0xF8448762AeCE0039f1072Da74477fbFAD629fDB8`](https://sepolia.arbiscan.io/address/0xF8448762AeCE0039f1072Da74477fbFAD629fDB8#code), holds the arbiter role |

Both are verified through Sourcify (`exact_match`); the Blockscout instance of this chain sits behind a Cloudflare challenge that `forge` cannot pass. Transactions: `broadcast/DeployV3.s.sol/421614/run-latest.json`.

**Proof run (13 October 2026, `proof-run.ts arbitrum-sepolia`):**

| Escrow | What happened | Money |
|---|---|---|
| #1 | settled, then rated 90 | 0.4: 0.39 to the seller, **0.01 fee** to the treasury |
| #2 | the buyer disputed, the seller answered, the council ruled **for the buyer** | 0.4 refunded, **no fee** |
| #3 | the buyer disputed, the seller answered, the council ruled **for the seller** | 0.3: 0.2925 to the seller, **0.0075 fee** |

Transactions: [dispute #2](https://sepolia.arbiscan.io/tx/0x1a76ba6c6afc9957286a83255dd5a9d9dee8d89bb5003162c90f6e98166eab7e), [response #2](https://sepolia.arbiscan.io/tx/0xf40c25b00556213b71c2e273e70cb5aba663a734f473b9c775e2ccf6202bacf0), [dispute #3](https://sepolia.arbiscan.io/tx/0x4a22626215c5a0af3c3f73e52d4f7d8bd14193d66ffb0535021985d448129053), [response #3](https://sepolia.arbiscan.io/tx/0x3b70c8c25a9e947b5091315f8751a25f41ac69763d044fb3b67bac59401a4c3e), and the [rating of #1](https://sepolia.arbiscan.io/tx/0xcaf91f26b0704b4a99773246e33604d90cb6e8d8127f91a4df71d84e3f866ac4). **ERC-8004 ran live** (`erc8004-proof.ts arbitrum-sepolia`): the seller registered agent [#283](https://sepolia.arbiscan.io/tx/0x38041ce75c7c30b2e357e0d04ac3242797485710c1315462747369786a68f9ca), the buyer published [feedback](https://sepolia.arbiscan.io/tx/0x91805f89aff776207c2dfee2381d9ff5d50aa630c6c80cb56d58b9b6490ef91f) (value 90, tag `agenteco:eip155:421614:1`), read back, and the self-review was refused.

### Tempo Testnet (Moderato)

Chain id 42431, RPC `https://rpc.moderato.tempo.xyz`, explorer `https://explore.testnet.tempo.xyz`, Multicall3 present. Tempo has **no native gas token**: fees are paid in a TIP-20 stablecoin, and `eth_getBalance` returns a placeholder, so the preset has no gas thresholds. The test stablecoins (pathUSD `0x20c0…0000`, AlphaUSD `0x20c0…0001`, BetaUSD, ThetaUSD; 6 decimals) come from the chain's own faucet, programmatically (`tempo_fundAddress`, no captcha): 1,000,000 of each per address when the proof wallets were funded. No ERC-8004 registries are known for Tempo, so none are configured.

**The settlement token is AlphaUSD, not pathUSD, on purpose.** Which token pays a transaction's fee follows the account's `FeeManager` preference and otherwise the call. Measured here: an AlphaUSD transfer from an account with no preference charged its fee in AlphaUSD (0.000169 on top of the 1 sent), which would break every exact balance check. After `setUserToken(pathUSD)` on the `FeeManager` precompile (`0xfeec…0000`) the same transfer moved exactly 1.000000 AlphaUSD and the fee came out of pathUSD. So each test wallet sets its fee token to pathUSD once before use; an account that does not would see small fee deductions in the settlement token, not a failure.

**Deployed on 13 October 2026** (same parameters, settling in AlphaUSD; stock Foundry works with `--skip-simulation --gas-estimate-multiplier 150`; state creation is expensive here (TIP-1000): AgentEco used 14.6 million gas, the council 7.2 million):

| | |
|---|---|
| AgentEco v3 | [`0x2620424C73A39624bDcd3fa43aABF425d6Da997e`](https://explore.testnet.tempo.xyz/address/0x2620424C73A39624bDcd3fa43aABF425d6Da997e), deployed at block `39319911` |
| ArbiterCouncil | [`0xD57E5c283853e61cFc83BD2e3b19cFe444F5e42A`](https://explore.testnet.tempo.xyz/address/0xD57E5c283853e61cFc83BD2e3b19cFe444F5e42A), holds the arbiter role |

Both are verified on Tempo's Sourcify instance (`match`). `forge verify-contract` could not resolve that host from this machine, so the standard JSON input was posted to `/v2/verify/42431/<address>` directly. Transactions: `broadcast/DeployV3.s.sol/42431/run-latest.json`.

**Proof run (13 October 2026, `proof-run.ts tempo-moderato`; the script prints "USDC" for the settlement token, here AlphaUSD):**

| Escrow | What happened | Money |
|---|---|---|
| #1 | settled, then rated 90 | 0.4: 0.39 to the seller, **0.01 fee** to the treasury |
| #2 | the buyer disputed, the seller answered, the council ruled **for the buyer** | 0.4 refunded, **no fee** |
| #3 | the buyer disputed, the seller answered, the council ruled **for the seller** | 0.3: 0.2925 to the seller, **0.0075 fee** |

Transactions: [dispute #2](https://explore.testnet.tempo.xyz/tx/0x1a83a93442a33c68f116d3a68d57ecb6f334f34f115c245ca40a272e81c4ae26), [response #2](https://explore.testnet.tempo.xyz/tx/0x5d920f6b82f7a1ec5d22a99667ad6bfb94e3b1ff48472090be1c2aa0d4ab6fa3), [dispute #3](https://explore.testnet.tempo.xyz/tx/0x978b55568f99b3e9a0e68dc8dd8044a0ebf54a1eaee2ae1106e8fce91806c5d2), [response #3](https://explore.testnet.tempo.xyz/tx/0x10a53c19b0e37dd6f412fffa2b77f811eaab597ff266399b4b62f692c9567499), and the [rating of #1](https://explore.testnet.tempo.xyz/tx/0xca7a0c990d00fe823c15708bd10ec8eb630648e6ad3ba1248e98927154e3581e). The buyer ended 0.7 lower, the seller 0.6825 higher and the treasury 0.0175 higher, the rules' figures exactly.

These runs, like Base's, are the contract through the adapter: negotiation, hosted agents and the AI arbiter ran on BNB Smart Chain Testnet; the live multi-chain API and website, deployed afterwards, serve this chain, but no deal has gone through them here yet.

### Serving every deployed chain (copy-paste)

The deployments of this repository, as the settings a backend and a website need to serve them. The default chain stays BNB (`bsc-testnet`, its deployment is built in); every other chain is listed in `CHAINS` and configured with its suffix. Values are public addresses and block numbers, no secrets.

```
# backend
CHAINS=bsc-testnet,base-sepolia,ethereum-sepolia,arbitrum-sepolia,tempo-moderato,bot-testnet,solana-devnet
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
AGENT_ECO_PROGRAM__solana_EtWTRABZaYq6iMfeYKouRu166VU2xqa1=3GEEC3dQH1tP2YTZD9Jv915Yj8hcSN6WE8nQZiLJcgHE
EVM_STALE_RETRIES=3                              # retries a revert caused by such a lagging node

# website (build-time, NEXT_PUBLIC_ prefix, same values)
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

This is what a public multi-chain deployment needs besides a database (`npx prisma db push`, section 5) and the hosting itself; it has not been done, so the CLI's account links and the chain picker are only tested locally.

### BOT Chain Testnet

Chain id 968, RPC `https://rpc.bohr.life` (it serves `eth_getLogs` over 500,000 blocks), explorer `https://scan.bohr.life` (a Blockscout), native token BOT at about 20 gwei. The settlement token is the chain's test USDT `0x75edC9335175Fc0552D51D48439F229c10420fe3` ("Tether USD", 6 decimals); it cannot be minted by anyone, so it comes from the chain's faucet (`faucet.botchain.ai`, which asks a person to pass a robot check; up to 10 BOT per 24 hours, plus the test token). Multicall3 is not deployed here, so the preset has none. Code deposit is priced normally (about 220 gas per byte, measured like on Ethereum Sepolia), so the default Foundry estimate with a 2x multiplier was enough.

**Deployed on 13 October 2026** (same parameters as the other chains):

| | |
|---|---|
| AgentEco v3 | [`0xaf77570B25D2EAD24a53Eead61deEB0bc21a83ea`](https://scan.bohr.life/address/0xaf77570B25D2EAD24a53Eead61deEB0bc21a83ea?tab=contract), deployed at block `26642374` |
| ArbiterCouncil | [`0xF8448762AeCE0039f1072Da74477fbFAD629fDB8`](https://scan.bohr.life/address/0xF8448762AeCE0039f1072Da74477fbFAD629fDB8?tab=contract), holds the arbiter role |

Both are source-verified on the BOT Chain explorer (Blockscout verifier, no key). Transactions: `broadcast/DeployV3.s.sol/968/run-latest.json`. This is the **testnet**; the mainnet deployment (chain 677, `0x3d3b68bC66e51721e3294E9EaA04Dd7921B043b2`) is the first, earlier version of the contract, deployed for a side entry in Build Week Hackathon Vol. 2 (on GMT) (escrow only, no disputes, council or fee) and was **not** redeployed: v3 is unaudited and the mainnet holds real value.

**Proof run (13 October 2026, `proof-run.ts bot-testnet`; the script prints "USDC" for the settlement token, here USDT):**

| Escrow | What happened | Money |
|---|---|---|
| #1 | settled, then rated 90 ([rating](https://scan.bohr.life/tx/0x4d572dc4e38618554557dc44e40693df024830c03a10a066d6089aa19512c90f)) | 0.4: 0.39 to the seller, **0.01 fee** to the treasury |
| #2 | the buyer [disputed](https://scan.bohr.life/tx/0xe555282dbb0f6c2ca7ca487d388c8bf91a718d29fcac34964fdb7d406b8ea864), the seller [answered](https://scan.bohr.life/tx/0xa82ae27cb754dd049952b8875050cdc8a2db8963a7a06da85a59b48109d49c6a), the council ruled **for the buyer** | 0.4 refunded, **no fee** |
| #3 | the buyer [disputed](https://scan.bohr.life/tx/0xd8c054c6c243672b4720f52e3eef5c8dce9b97b2f82222631099256def6e3336), the seller [answered](https://scan.bohr.life/tx/0xc54864f6706b65caa5d164beeaa4c1b18830e0661cbe645ade7ea2332606bda1), the council ruled **for the seller** | 0.3: 0.2925 to the seller, **0.0075 fee** |

Final balances: buyer 999.3, seller 0.6825, treasury 0.0175, the rules' figures exactly. No ERC-8004 registries are configured for this chain.

## 5. Database and API

New database, created with a plain `prisma db push` (no data is carried over from BNB).

| Model | Change |
|---|---|
| `Agent` | `chainId`, `groupId?`, `erc8004AgentId?`; one row per agent **per chain** |
| `Negotiation`, `Order` | `chainId` (order unique per `(chainId, escrowId)`) |
| `Task`, `EscrowResult`, `Verification`, `Rating`, `Dispute` | `chainId`; unique per `(chainId, escrowId)` |
| `Rating` | `erc8004FeedbackTx?` |
| `Capability`, `Report`, `Appeal`, `ModerationVote`, `AiCall` | unchanged |

`groupId` links one owner's listings of the same agent across chains (any UUID the owner sets); there is deliberately no `agent_chains` table yet. For a database that ever imports BSC Testnet data, the backfill value is `eip155:97`.

**API.** Every escrow-keyed route names its chain with `?chain=` (or `chainId` in a JSON body); without one it means the default chain, so older clients keep working. An unknown or unserved chain is a 400, never a silent fallback. Listings (`GET /agents`), orders, negotiations and the arbiter's dispute list accept `?chain=` as a filter. `GET /chains` lists the served chains with contract, token, explorer and ERC-8004 registries. A buyer and a seller on different chains cannot open a negotiation. Website sign-ins may be signed on any served chain. Listing moderation is one council for all chains: the default chain's.

**SDK.** `hire({ chain })` buys only from sellers on that chain; `createSellerAgent({ chain })` trades on it (an attached listing brings its own chain). Omitted: an attached listing's chain, else `NETWORK`. `privateKey` is an EVM key (`0x…`) or a Solana secret key (`Uint8Array`, 64 bytes); a key is used only on a chain of its own family, and a Solana key without `chain` trades on Solana devnet. The CLI keeps one key per family and `--chain solana-devnet` selects the Solana one ([SOLANA.md](SOLANA.md) §11).

**Solana chains.** `GET /chains` carries a `family` (`evm` | `solana`) per chain; a Solana entry has `evmChainId: null`, the program under `agentEco` and `erc8004: null`. What works on a Solana chain: wallet sign-in with ed25519 (`x-owner-wallet` is a base58 address, `x-signature` a base58 signature of the same `AgentEco:<wallet>:<timestamp>` text), registering and listing self-hosted agents, tasks (the link to an escrow is checked against the program), results, disputes (the reason hash is checked against the one the buyer committed), ratings (read from the program's `SellerRated` event, reported by signature or found by the periodic scan), access rules, the arbiter list, and the keeper (`SOLANA_KEEPER_KEYPAIR`). Wallet addresses are stored and compared by family: EVM lowercase, Solana exactly as given (`shared/wallets.ts`), and `POST /tasks` refuses a buyer or seller of the wrong family for the chain. **Not available on a Solana chain** (each answers 400): hosted agents (custodial keys are EVM keys), ERC-8004, and device links. The hosted-agent hosts and the gas watch run on the EVM chains only; the AI arbiter host also serves a Solana chain when its key is the program's arbiter (devnet, from 13 Oct 2026), otherwise a Solana dispute is ruled by the program's arbiter signer ([SOLANA.md](SOLANA.md) §4).

**Local database.** `npm run db:local` (backend) runs an embedded Postgres (PGlite) on port 54330 with its data in `backend/.pglite` (gitignored); with `DATABASE_URL`/`DIRECT_URL` at `postgresql://postgres:postgres@127.0.0.1:54330/postgres?sslmode=disable` (the generated `backend/.env` has them), `npm run db:local:init` creates the schema. Prisma's own `db push` cannot talk to PGlite, so the script applies the SQL `prisma migrate diff` generates for the same schema; for the online database (Supabase) a plain `npx prisma db push` stays the way. PGlite serves one connection at a time: the tests set `DB_POOL_MAX=1`, which `src/db.ts` honours.

## 6. Identity and reputation: ERC-8004

[ERC-8004](https://eips.ethereum.org/EIPS/eip-8004) (status: Draft) defines per-chain Identity, Reputation and Validation registries. Their addresses are not in the EIP, so each chain has them configured: the presets carry the official ones for BSC Testnet and Base Sepolia, and `ERC8004_IDENTITY_REGISTRY` / `ERC8004_REPUTATION_REGISTRY` (both or neither, suffixed per chain) override them. A chain with none known has no ERC-8004 features.

| Chain | Identity Registry | Reputation Registry |
|---|---|---|
| BSC Testnet, Base Sepolia | `0x8004A818BFB912233c491871b3d84c89A494BD9e` | `0x8004B663056A597Dffe9eCcC1965A193B7388713` |

Checked on both chains on 10 Oct 2026: both contracts exist (proxies), the Reputation Registry's `getIdentityRegistry()` returns the Identity address, and the Identity Registry answers `name()` = `AgentIdentity`, `symbol()` = `AGENT`.

**Identity.**
- Every seller listing has a registration file at `GET /agents/:id/registration.json` (type `…#registration-v1`, services, `active`, `registrations`, `supportedTrust: ["reputation"]`). It needs `PUBLIC_API_URL` to be stable.
- A hosted seller's host registers it once (`register(agentURI)`) from the agent's own wallet, which then owns the identity.
- A self-hosted seller registers with `createSellerAgent({ erc8004: true })`, then reports the transaction to `POST /agents/:id/erc8004`. The API trusts nothing but the hash: the `Registered` event must come from that chain's Identity Registry, be owned by the agent's wallet (or its owner), and point at this listing's registration file.
- `setAgentWallet` (EIP-712) is not used: the agent wallet is the identity's owner.

**Reputation.** After a deal is settled and rated, the **buyer's wallet** calls `giveFeedback`:

| Field | Value |
|---|---|
| `value`, `valueDecimals` | the rating, 1–100 (stars × 20, the number `rateSeller` stores), decimals `0` |
| `tag1` | the capability id |
| `tag2` | `agenteco:<chainId>:<escrowId>` |
| `endpoint`, `feedbackURI`, `feedbackHash` | empty |

Hosted buyers do it automatically; `hire()` does it unless `erc8004Feedback: false`. Ratings between two agents of one owner are never published (and the registry refuses the agent's own owner anyway). Each deal is published once; the transaction is kept on the rating.

**Possible later:** the AgentEco contract publishing feedback itself (only paid escrows could then produce it — needs a contract change); the Validation Registry for AI verification scores and council rulings (0–100).

AgentEco's own on-chain reputation stays the ranking source inside AgentEco; ERC-8004 is the portable, public copy.

**Run live on Base Sepolia (13 October 2026, the official registries, `agent-runtime/scripts/erc8004-proof.ts`).** The proof-run seller registered agent [#9662](https://sepolia.basescan.org/tx/0xb0c7ec826e5dd2ed803e02df8ad2f74b4923f07a5449b79fec674c8d0f2b46a7) (the identity NFT is owned by the seller wallet; the registration file is a `data:` URI, so nothing is hosted). The buyer then published [feedback](https://sepolia.basescan.org/tx/0x5160176d4580b323197a1f384fb394dfb3cdf44571dffbccd19108579405fafa) for settled escrow #6: `value` 90, `tag1` `translation`, `tag2` `agenteco:eip155:84532:6`, read back from the Reputation Registry. The registry refused the owner reviewing its own agent, as the EIP says. The backend's automatic registration and feedback publishing are covered by the local suites; this live run used the adapter's methods directly.

## 7. Testing

All on-chain suites run on throwaway local chains (anvil) with the real contracts from `out/` (`forge build`) and skip themselves when anvil or the build output is missing. Database suites run on an in-memory Postgres (PGlite) with the Prisma schema.

- **Regression:** `agent-runtime/src/onchain/escrow.chain.test.ts` and `backend/src/keeper/escrowKeeper.chain.test.ts` were written against the single-chain code before any refactor and pass unchanged: the whole escrow lifecycle, wallet-arbiter and council rulings, the escrow index, every keeper timeout, on-chain reputation. The original suites (forge 97, backend 76, agent-runtime 53) are unchanged.
- **Adapter and registry:** `chain/evm.test.ts` (explicit config, two deployments on one chain), `chain/default.test.ts` (the primary chain matches `network.ts`), `chain/registry.test.ts` (`CHAINS`, suffixes, aliases, fail-fast), `chain/erc8004.test.ts` (registration, feedback, owner refused).
- **Schema:** `backend/src/db.schema.test.ts` — the same escrow id on two chains, every escrow-keyed table unique per `(chain_id, escrow_id)`.
- **Solana:** `agent-runtime/src/chain/multi.test.ts` (names, environment settings, `CHAINS` across families, fail-fast), `agent-runtime/src/shared/wallets.test.ts`, and `backend/src/solana.e2e.test.ts` — the API with a Solana chain as its default next to an EVM one: ed25519 sign-in and its case sensitivity, agents, a deal, results, a dispute, ratings and the scanner, the keeper, and the refusals above. It runs on litesvm by default and on a real `solana-test-validator` with `SOLANA_LOCAL_VALIDATOR=1` (about 2 minutes; then the chain is built from the environment through `SolanaRpcBackend`, as in production). `backend/src/sdk.solana.e2e.test.ts` and `cli/test/solana.e2e.test.ts` run the SDK, the CLI and the MCP server on Solana the same way. `backend/src/frontend.solana.e2e.test.ts` drives the built website in Chromium against a local validator with a mock wallet-standard wallet (opt-in, `SOLANA_BROWSER_E2E=1`, about a minute). Details in [SOLANA.md](SOLANA.md) §6, §11 and §12.
- **End to end:** `backend/src/multichain.e2e.test.ts` — the API serving two local chains (chain id 97 with an 18-decimal token, 84532 with a 6-decimal token): escrow #1 on both without mixing, access per chain, disputes per chain arbiter, ratings read from the right chain, cross-chain negotiation refused, ERC-8004 registration checks and deal feedback.
- Test-only ERC-8004 registries: `test/mocks/ERC8004Registries.sol` (implements just what AgentEco calls; not the reference implementation).

## 8. Local setup pitfall: `npm ci` in `frontend/`

`frontend/package.json` has a `postinstall` that runs `npm install --prefix ../agent-runtime --omit=dev` (the app imports the SDK's sources). That **removes agent-runtime's devDependencies** (`tsx`, `typescript`), so afterwards `npm test` in `agent-runtime` fails with `Cannot find package 'tsx'` for every test file. The same happens when the packages are installed in parallel and the frontend finishes last. After installing the frontend, run `npm ci` in `agent-runtime` again (and, if `agent-runtime/package-lock.json` shows a four-line metadata change from npm 11, `git checkout` it). The backend and the standalone agents are not affected.

## 9. Work order

1. `ChainAdapter` and `EvmAdapter` with no behaviour change. **Done.**
2. `chainId` in the schema, every query scoped by it, `groupId`. **Done.**
3. Chain registry in backend, runtime and frontend; chain picker; `chain` in the SDK. **Done.**
4. ERC-8004 identity and feedback on EVM chains. **Done** (registries per chain by configuration).
5. Base Sepolia: preset, 6-decimal handling, deploy command. **Done and deployed** (12 Oct 2026, §4). Ethereum Sepolia, Arbitrum Sepolia and Tempo Moderato followed with the same contracts: presets, deployment, verification and a three-deal proof run each (13 Oct 2026, §4), plus ERC-8004 live on the first two.
6. `SolanaAdapter` and the Anchor program. **Built and tested locally** (litesvm and a local validator) and **deployed on devnet** on 12 Oct 2026 ([SOLANA.md](SOLANA.md) §8).
7. The backend serves Solana chains next to EVM ones, for self-hosted agents. **Done** and tested, on litesvm and on a local validator; **not run against devnet**.
8. The SDK (`hire` and its stages, `createSellerAgent`, `registerCapability`), the CLI and the MCP server on Solana. **Done** and tested the same way ([SOLANA.md](SOLANA.md) §11); **not run against devnet**.
9. The website on Solana: wallet connection, a read session signed once, hiring from an agent's page with one wallet-signed transaction, the order page (settle, dispute, rate), balances and faucet pointers. **Done** and tested in a real browser against a local validator with a mock wallet ([SOLANA.md](SOLANA.md) §12); **not tried with a real wallet extension, a public RPC or devnet**. Hosted agents, the AI arbiter host, the arbiter console, ERC-8004, `tx_explainer` and device links on Solana: **not done**.

## 10. Open questions

- The council on Solana is a Squads multisig vault as the program's one arbiter signer; the vault-signed ruling is not tested ([SOLANA.md](SOLANA.md) §4).
