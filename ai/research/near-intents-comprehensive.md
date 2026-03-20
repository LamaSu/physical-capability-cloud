# NEAR Intents — Comprehensive Research Report

**Date:** 2026-03-15
**Source:** https://www.near.org/intents + 15 supplementary sources

---

## 1. What Are NEAR Intents?

NEAR Intents is a **multichain intent-based transaction protocol** branded as "The Universal Transaction Layer for the AI Economy." Users and AI agents declare *what they want* (desired outcome) rather than specifying *how* to execute it. Third-party **solvers** compete to fulfill requests at the best price.

**Launched:** November 2024 by Defuse Labs (now under NEAR Foundation)
**Contract:** `intents.near` (Rust/WASM, open-source)
**Volume:** $1.8B+ in first year (Oct 2025), 3.6M+ swaps, 121 assets
**Target:** $10B/week by mid-2026

| Traditional Transaction | NEAR Intent |
|------------------------|-------------|
| Specify exact contract calls, gas, routes | Specify desired outcome (token diff) |
| User determines execution path | Competing solvers optimize execution |
| Single-chain, synchronous | Multi-chain, atomic via Verifier |
| Manual bridging required | Solvers handle routing transparently |
| MEV-exposed (mempool visible) | Off-chain quoting, on-chain settlement |

---

## 2. Technical Architecture

### 2a. The Verifier Contract (`intents.near`)

Central on-chain component. Functions as an **internal accounting ledger** using NEP-245 (multi-token standard, analogous to ERC-1155):

- Accepts deposits of NEP-141 (fungible), NEP-171 (NFT), NEP-245 (multi-token)
- Tracks internal balances with prefixed token IDs: `nep141:usdc.near`, `nep171:coolnfts.near:rock.near`
- Validates all intents cryptographically before execution
- Executes intent batches **atomically** — if any intent fails, none execute
- Swaps are just ledger updates inside the contract (extremely fast/cheap)

**Source:** [github.com/near/intents](https://github.com/near/intents)

### 2b. PoA Bridge (Defuse Labs)

Proof-of-Authority treasury bridge moving assets from external chains to NEAR:

1. User sends tokens to a **chain-signature-derived deposit address** on the external chain
2. Bridge detects finalized deposit → mints wrapped token on NEAR → deposits to `intents.near`
3. On withdrawal: burns token on NEAR → Chain Signatures MPC signs a native transaction on destination chain

### 2c. Solver Bus (Message Bus)

WebSocket relay at `solver-relay-v2.chaindefuser.com`:

- Broadcasts quote requests to all connected solvers simultaneously
- Collects responses within a **3-second window**
- Returns top competing quotes to the client
- **Not strictly required** — frontends can use custom quoting; solvers can index NEAR directly

**JSON-RPC Endpoint:** `POST https://solver-relay-v2.chaindefuser.com/rpc`

Three methods:
- **`quote`**: Request quotes (asset pair, exact_amount_in/out, optional deadline)
- **`publish_intent`**: Submit signed intent + accepted quote hash(es)
- **`get_status`**: Poll by intent hash → `PENDING` → `TX_BROADCASTED` → `SETTLED`

### 2d. Chain Signatures (MPC Layer)

NEAR's Multi-Party Computation infrastructure — the cryptographic backbone:

- No single party holds a full private key; shares distributed across MPC nodes
- Threshold cooperation required to sign any transaction
- Contracts request signatures for **any supported chain** (BTC, ETH, SOL, etc.)
- **Yield-and-resume** mechanism: contract pauses during multi-block MPC signing, resumes gas-free

### 2e. Three Foundational Primitives

1. **Yield and Resume**: Contracts pause during async operations (MPC signing) without burning gas
2. **True Async Execution**: Multiple intent flows run in parallel without blocking
3. **NEP-245 Multi-Token**: One contract manages all token types — eliminates per-asset deployments

---

## 3. Protocol Design & Message Format

### Signing Standards Supported

| Standard | Wallets |
|----------|---------|
| NEP-413 | Meteor, HOT, Intear, Near Mobile, Nightly |
| ERC-191 | MetaMask, Rabby, Rainbow, WalletConnect (all EVM) |
| Raw Ed25519 | Solana wallets |
| BIP-322 | Bitcoin wallets |
| TIP-191 | TRON wallets |
| TON Connect 2.0 | TON wallets |
| WebAuthn | Passkeys |
| SEP-53 | Stellar wallets |

### Payload Structure

```json
{
  "standard": "nep413",
  "payload": {
    "recipient": "intents.near",
    "nonce": "<256-bit base64>",
    "message": "{\"signer_id\":\"alice.near\",\"verifying_contract\":\"intents.near\",\"deadline\":\"2025-11-01T00:00:00Z\",\"intents\":[{\"intent\":\"token_diff\",\"diff\":{\"nep141:wrap.near\":\"-1000000000000000000000000\",\"nep141:usdc.near\":\"1000000\"}}]}"
  },
  "public_key": "ed25519:...",
  "signature": "ed25519:..."
}
```

### Intent Types

| Type | Description |
|------|-------------|
| `token_diff` | Exchange token sets; batched diffs must sum to zero per token |
| `transfer` | Move tokens between accounts within Verifier |
| `ft_withdraw` | Withdraw fungible tokens to external addresses |
| `nft_withdraw` | Withdraw NFTs |
| `mt_withdraw` | Withdraw multi-tokens |
| `native_withdraw` | Withdraw NEAR native currency |
| `add_public_key` | Register a key for intent signing (agent delegation) |
| `remove_public_key` | Deregister a key |
| `storage_deposit` | Pre-pay NEP-145 storage on token contracts |

### Nonce Management

Nonces = rotating salt (from `current_salt` view method) + unique per-intent value. Salt rotates periodically — always fetch fresh before constructing intents.

### Simulation

`simulate_intents` RPC call accepts `MultiPayload` but returns results without state modification. Returns: `intents_executed`, `logs` (DIP-4 events), `min_deadline`, `state` (fee + current salt).

**No testnet exists** — developers use mainnet with small amounts.

---

## 4. Supported Chains (31+)

**EVM (16):** Arbitrum, Aurora, Base, Bera, BNB Chain, Ethereum, Gnosis, Optimism, Plasma, Polygon, Avalanche, Monad, XLayer, Dash, Scroll, ADI

**Bitcoin ecosystem (5):** Bitcoin (Legacy/P2SH/Bech32/Taproot), Dogecoin, Zcash (transparent), Bitcoin Cash, Litecoin

**Other L1s (10):** Aleo, Cardano (partial), NEAR, Solana, Sui, Stellar, Starknet, TON, TRON, XRP

Recent additions: Starknet (Dec 2025), Bitcoin Cash (Dec 2025), Plasma (Jan 2026), Zcash (Feb 2026).

---

## 5. Solver Network

### How Solvers Work

1. Maintain WebSocket connections to the Solver Bus
2. Listen for `quote` RPC calls
3. Evaluate and return **signed quotes** within 3-second window
4. If selected: quote bundled with user's signed intent → `execute_intents` on `intents.near`
5. Verifier validates both signatures + zero-sum token diff → atomic execution

Solvers must **pre-fund** the Verifier with token balances. They manage inventory via the deposit/withdrawal service.

### MEV Protection

- Quote negotiation off-chain (not visible in mempool)
- Settlement atomic and verified on-chain
- Solver competition ensures competitive pricing
- Confidential Intents eliminate remaining information leakage

**Permissionless:** Any entity can become a solver — no registration required.

**Example Solver:** [github.com/defuse-protocol/near-intents-amm-solver](https://github.com/defuse-protocol/near-intents-amm-solver)

---

## 6. Developer Integration

### Three Levels

**Level 1 — 1Click Swap API (highest abstraction)**

REST API at `https://1click.chaindefuser.com/v0/`:
- `GET /tokens` — list supported tokens
- `POST /quote` — get swap quote
- User sends funds to returned deposit address → API auto-executes
- `GET /deposit/{txHash}/status` — monitor progress
- Auth via JWT (Partner Portal) avoids 0.2% surcharge

SDKs: [TypeScript](https://github.com/defuse-protocol/one-click-sdk-typescript), Go, Rust

**Level 2 — Solver Bus + Verifier (medium abstraction)**

npm: `@defuse-protocol/intents-sdk`

```javascript
import { IntentsSDK } from '@defuse-protocol/intents-sdk'
const sdk = new IntentsSDK({ referralCode: 'my-app', signer: intentSigner })
const quote = await sdk.getQuote({ tokenIn: 'nep141:wrap.near', tokenOut: 'nep141:usdc.near', amountIn: '1000000000000000000000000' })
const result = await sdk.executeIntent(quote)
```

**Level 3 — Direct contract interaction (lowest abstraction)**

Construct `MultiPayload` objects manually, sign, call `execute_intents` directly.

### React Widget

Embeddable cross-chain swap UI component — drop into any React app.

### Agent Skills

AI agent integration toolkit for cross-chain app building.

### Key Developer Resources

| Resource | URL |
|----------|-----|
| NEAR Intents docs | [docs.near-intents.org](https://docs.near-intents.org) |
| NEAR Foundation docs | [docs.near.org/chain-abstraction/intents/overview](https://docs.near.org/chain-abstraction/intents/overview) |
| LLMs.txt (full doc map) | [docs.near-intents.org/llms.txt](https://docs.near-intents.org/llms.txt) |
| JS/Rust examples | [github.com/near-examples/near-intents-examples](https://github.com/near-examples/near-intents-examples) |
| 1Click example | [github.com/nearuaguild/near-intents-1click-example](https://github.com/nearuaguild/near-intents-1click-example) |
| Python agent example | [github.com/near-examples/near-intents-agent-example](https://github.com/near-examples/near-intents-agent-example) |
| Contracts (Rust) | [github.com/near/intents](https://github.com/near/intents) |
| AMM solver example | [github.com/defuse-protocol/near-intents-amm-solver](https://github.com/defuse-protocol/near-intents-amm-solver) |
| npm SDK | [@defuse-protocol/intents-sdk](https://www.npmjs.com/package/@defuse-protocol/intents-sdk) |
| 1Click TypeScript SDK | [@defuse-protocol/one-click-sdk-typescript](https://github.com/defuse-protocol/one-click-sdk-typescript) |
| Bridge SDK | [@defuse-protocol/bridge-sdk](https://www.npmjs.com/package/@defuse-protocol/bridge-sdk) |
| Telegram support | [@near_intents](https://t.me/near_intents) |

---

## 7. AI Agent Integration

### Agent Architecture

Agents interact identically to human users at the protocol level: construct signed intents, query solvers, submit batches. The `add_public_key` intent enables **agent delegation** — agents sign intents on behalf of users, revocable via `remove_public_key`.

### Python Agent Example

```python
from ai_agent import AIAgent
agent = AIAgent("./account_file.json")
agent.deposit_near(1.0)
result = agent.swap_near_to_token("USDC", 1.0)
```

### NEAR AI Agent Market (launched Feb 5, 2026)

Generic intent marketplace for any task:
- Users post tasks with budgets/requirements (natural language)
- Agents bid with pricing proposals
- Selected agent executes → receives NEAR on delivery
- Dispute resolution via AI evaluator
- Task types: code review, data analysis, translation, asset management, physical services
- Supports: OpenClaw, Claude, Codex agents

### IronClaw AI Agent Runtime

Open-source runtime deploying agents in **encrypted TEE enclaves** on NEAR AI Cloud — hardware-enforced credential confidentiality.

### Open Agents Alliance (ETHDenver 2025)

Coalition: NEAR AI, Coinbase AgentKit, Eliza Labs, Aethir, Bitte Protocol, Akash, Phala Network, Hyperbolic, SWEAT Economy, HOT, Frax Finance, Arc, MotherDAO.

---

## 8. Confidential Intents (launched Feb 25, 2026)

NEAR token jumped 17% on announcement.

### Architecture

- Transaction instructions **encrypted locally** before network submission
- Encrypted data routes through a **dedicated private NEAR shard** (TEE bridge to mainnet)
- Validators verify mathematical validity in "black box" — confirm validity without seeing amounts/routes/balances
- Results published on mainnet only after finalization

### What's Hidden vs. Preserved

| Hidden | Preserved |
|--------|-----------|
| Asset amounts | Verifiable on-chain execution |
| Routing paths | Auditability (selective disclosure proofs) |
| Wallet balances | Full atomicity guarantees |
| Trade strategy | |

Currently supports: confidential transfers, deposits, withdrawals.

Underpinned by **Nightshade 3.0**: separation of consensus/execution, atomic cross-shard transactions, live private shard, path to 1M+ TPS.

---

## 9. Fee Structure

| Fee | Rate | Recipient |
|-----|------|-----------|
| Protocol fee | 0.0001% (1 pip) per tx | `intents.near` |
| Platform fee (near-intents.org) | 0.2% on swaps | Platform |
| NEAR/ZEC/STRK → Solana withdrawal | 0.1% | Protocol |
| 1Click API (unauthenticated) | +0.2% surcharge | Protocol |
| Partner app fee | Configurable via `appFees` | 50/50 split |

Partners get **50/50 revenue sharing** by default (negotiable via Partner Dashboard).

---

## 10. Token Economics

- NEAR = gas currency for all `execute_intents` calls (fractions of a cent)
- **Buy-and-burn mechanism** (Feb 2026): Intents revenue burns NEAR **2x faster** than inflation mints → net deflationary
- Total buyback: $1M+ in NEAR tokens
- Flywheel: more volume → more fees → more burns → reduced supply → higher NEAR price → better security → more chains → more volume

---

## 11. Ecosystem Integrations

| Partner | Category | Notes |
|---------|----------|-------|
| THORSwap | DEX aggregator | $132.8M+ in 4 months (Jun 2025) |
| SwapKit | Cross-chain SDK | Powers THORSwap, Ledger Live, Trust Wallet, Bitget, TokenPocket |
| Infinex | Consumer crypto | Chain Signatures + Intents; acquired Keypom |
| KyberSwap | DEX aggregator | Integrated Mar 5, 2025 |
| Starknet | L2 | Chain integration Dec 2025 |
| Sui | L1 | Cross-chain swaps |
| TRON | L1 | One-click stablecoin swaps Sep 2025 |
| Tachyon | Relayer | Won NEAR Infrastructure Committee RFP |

---

## 12. Comparison with Other Intent Systems

| Dimension | NEAR Intents | UniswapX | CoW Protocol | Anoma |
|-----------|-------------|----------|-------------|-------|
| Scope | Any asset, any chain, AI tasks | EVM token swaps | EVM batch auctions | General coordination |
| Chains | 31+ heterogeneous | EVM + bridges | Primarily EVM | Anoma chain |
| Settlement | NEAR (`intents.near`) | Ethereum | Ethereum | Anoma |
| Solver model | Off-chain WS bus, 3s | Dutch auction + RFQ | Batch auction | Counterparty matching |
| AI-native | Yes (first-class) | No | No | Theoretical |
| Cross-chain | MPC/Chain Signatures | Bridge integration | Single-chain | Programmable |
| Privacy | Confidential Intents (TEE) | None | None | Programmable |

**Key differentiator:** Only system handling genuinely heterogeneous chains (BTC, SOL, TRON, BTC forks) without bridges, using MPC chain signatures.

---

## 13. 2026 Roadmap

- MPC network expansion (greater decentralization)
- Sharded RPC nodes + cloud archival
- Privacy infrastructure for confidential AI apps
- $10B/week trading volume target by mid-2026
- 100M users target (Brave Nightly, Phala integrations)
- NEARCON 2026 in San Francisco (AI + scaling focus)

---

## 14. Security & Compliance

- Security audits available via docs
- Bug bounty program
- AML/compliance screening
- Treasury addresses published
- Risk & compliance documentation

---

## Sources

- [NEAR Intents Landing Page](https://www.near.org/intents)
- [NEAR Intents Docs](https://docs.near-intents.org)
- [NEAR Foundation Docs — Intents Overview](https://docs.near.org/chain-abstraction/intents/overview)
- [Deep Dive into NEAR Intents](https://docs.near.org/blog/near-intents-2026)
- [GitHub: near/intents](https://github.com/near/intents)
- [GitHub: near-intents-agent-example](https://github.com/near-examples/near-intents-agent-example)
- [GitHub: near-intents-examples](https://github.com/near-examples/near-intents-examples)
- [GitHub: one-click-sdk-typescript](https://github.com/defuse-protocol/one-click-sdk-typescript)
- [GitHub: near-intents-amm-solver](https://github.com/defuse-protocol/near-intents-amm-solver)
- [npm: @defuse-protocol/intents-sdk](https://www.npmjs.com/package/@defuse-protocol/intents-sdk)
- [NEAR AI Agent Market Announcement](https://near.ai/blog/introducing-near-ai-agent-market)
- [Confidential Intents — PR Newswire](https://www.prnewswire.com/news-releases/near-unveils-confidential-cross-chain-infrastructure-for-the-agentic-economy-302697292.html)
- [NEAR 2026 Roadmap — AInvest](https://www.ainvest.com/news/protocol-2026-roadmap-redefining-layer-1-capture-ai-intents-scalable-infrastructure-2601/)
- [THORSwap Integration](https://thorswap.medium.com/introducing-near-intents-thorswaps-new-revolutionary-cross-chain-provider-2a18bbf31dfe)
- [SwapKit Integration](https://swapkit.dev/near-intents/)
- [DefiLlama: NEAR Intents](https://defillama.com/protocol/near-intents)
- [IQ.wiki: NEAR Intents](https://iq.wiki/wiki/near-intents)
- [NEAR Infrastructure Committee 2026 Roadmap](https://blockonomi.com/near-infrastructure-committee-reviews-2025-progress-sets-2026-roadmap-for-scaling-chain-abstraction)
