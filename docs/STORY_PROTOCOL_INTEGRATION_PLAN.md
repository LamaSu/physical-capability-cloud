# Story Protocol Integration Plan for PCC

> **Date**: 2026-03-21
> **Status**: Plan — ready for implementation
> **Dependency**: `@story-protocol/core-sdk` (~1.3.0, peer dep `viem` already present)
> **Chain**: Story Network L1 (chain 1514) / Aeneid testnet (chain 1513)
> **Research**: `ai/research/story-protocol-integration.md` (1133 lines)

---

## Why Story Protocol

PCC settles jobs with milestone escrow: payment goes in, evidence comes out, money releases.
But that's a one-shot transaction. It doesn't capture:

- **Who designed the process?** The person who wrote the CSD (Capability StructureDefinition) created intellectual property. Every time someone uses that CSD, the designer should earn.
- **Who contributed labor?** In a multi-step workflow (CNC → anodize → inspect → ship), each operator contributed. Their contribution should persist as equity.
- **Who can remix?** If someone forks a CSD to make a better version, the original author should earn from the derivative.
- **Where did the design come from?** Provenance chains should be traceable: this part was made using that process, which was derived from that standard, which was authored by that person.

Story Protocol solves all of this with one primitive: **IP Assets with programmable royalties and derivative chains.**

---

## Concept Mapping

| PCC Concept | Story Protocol Concept | How They Connect |
|---|---|---|
| CSD (Capability StructureDefinition) | **IP Asset** | Publishing a CSD = registering IP. The CSD JSON is the IP metadata. |
| Capability Contract (booking) | **License** | Booking a capability = minting a license from the CSD's IP Asset. |
| Job Evidence Bundle | **Derivative IP Asset** | Each completed job is a derivative work of the CSD it was built from. |
| Multi-step Workflow | **IP Chain** (parent → child → grandchild) | Each step's evidence is a derivative of the previous step's. |
| MilestoneEscrow release | **Royalty Payment** | When escrow releases, a portion flows to the IP Royalty Vault. |
| CSD Fork | **Derivative IP** | Forking a CSD creates a derivative that pays royalties to the parent. |
| Operator Revenue | **Royalty Token holding** | Operators hold Royalty Tokens proportional to their contribution. |
| Challenge Window | **Dispute Module** | Story's UMA-based disputes can supplement PCC's challenge windows. |
| Capability Certificate (cNFT) | **IP Asset NFT** | The soulbound cNFT becomes the underlying NFT for the IP Asset. |

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                         PCC Network                          │
│                                                              │
│  ┌─────────┐  ┌──────────┐  ┌────────────┐  ┌───────────┐  │
│  │   CSD   │  │  Escrow  │  │  Evidence   │  │  Agents   │  │
│  │ Registry│  │(Base Sep)│  │(IPFS/Stor) │  │  (A2A)    │  │
│  └────┬────┘  └────┬─────┘  └─────┬──────┘  └─────┬─────┘  │
│       │            │              │                │         │
│       ▼            ▼              ▼                ▼         │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │                  StoryIPService                         │ │
│  │  registerCapabilityAsIP() — CSD → IP Asset              │ │
│  │  registerJobAsDerivative() — Evidence → Derivative IP   │ │
│  │  distributeRoyaltyTokens() — Split to collaborators     │ │
│  │  payJobRoyalty() — Escrow release → Royalty Vault       │ │
│  │  claimRevenue() — Collaborator claims their share       │ │
│  │  raiseDispute() — Challenge → UMA arbitration           │ │
│  └──────────────────────┬──────────────────────────────────┘ │
│                         │                                    │
└─────────────────────────┼────────────────────────────────────┘
                          │ @story-protocol/core-sdk
                          ▼
┌──────────────────────────────────────────────────────────────┐
│                    Story Network L1                           │
│                    (Chain 1514 / Aeneid 1513)                │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────┐  │
│  │ IPAssetReg   │  │ RoyaltyMod   │  │ PILicenseTemplate │  │
│  │ 0x7731...    │  │ 0xD2f6...    │  │ 0x2E89...         │  │
│  └──────────────┘  └──────────────┘  └───────────────────┘  │
│  ┌──────────────┐  ┌──────────────┐                         │
│  │ DisputeMod   │  │ LicenseReg   │                         │
│  │ 0x9b7A...    │  │ 0x529a...    │                         │
│  └──────────────┘  └──────────────┘                         │
└──────────────────────────────────────────────────────────────┘
```

**Two chains, connected by StoryIPService:**
- **Base Sepolia**: PCC escrow, settlement, identity (existing)
- **Story Network**: IP registration, licensing, royalties, disputes (new)

StoryIPService bridges them: when escrow releases on Base, it triggers a royalty payment on Story.

---

## Implementation Phases

### Phase 1: Foundation (files + types + chain config)

**Goal**: Get the SDK installed, types defined, and chain config ready.

#### 1a. Install SDK

```bash
cd packages/contracts && pnpm add @story-protocol/core-sdk
```

The SDK's only peer dep is `viem` which PCC already has.

#### 1b. Add Story types to `@pcc/spec`

Create `packages/spec/src/types/story.ts`:

```typescript
export interface StoryIPRegistration {
  ipId: string;                    // IP Account address (0x...)
  nftTokenId: string;             // Token ID of the underlying NFT
  licenseTermsId: string;         // PIL license terms ID
  txHash: string;                 // Registration transaction hash
  capabilityId: string;           // PCC capability ID this IP represents
  csdUrl: string;                 // CSD URI (pcc://capabilities/...)
  registeredAt: string;           // ISO timestamp
  chain: "story" | "story-aeneid";
}

export interface StoryRoyaltySplit {
  ipId: string;                    // Which IP Asset
  splits: Array<{
    address: string;              // Recipient wallet
    role: "designer" | "operator" | "verifier" | "assembler" | "curator";
    percentage: number;           // 1-100 (maps to Royalty Tokens)
    label: string;                // Human-readable: "CSD Author", "Machine Operator"
  }>;
  totalTokensDistributed: number;  // Should sum to 100
}

export interface StoryDerivativeLink {
  parentIpId: string;             // Parent IP Asset (the CSD)
  childIpId: string;              // Child IP Asset (the job evidence)
  licenseTokenId: string;         // License token used to create derivative
  jobId: string;                  // PCC job ID
  evidenceBundleHash: string;     // SHA-256 of the evidence bundle
  txHash: string;
  linkedAt: string;
}

export interface StoryRevenueSnapshot {
  ipId: string;
  vaultAddress: string;           // IP Royalty Vault contract
  totalRevenue: string;           // Total accumulated (in WIP/USDC)
  unclaimedRevenue: string;       // Available to claim
  tokenHolders: Array<{
    address: string;
    tokensHeld: number;           // Out of 100
    claimable: string;            // Amount this holder can claim
  }>;
  lastPaymentAt: string;
}

export interface StoryDispute {
  disputeId: string;
  ipId: string;
  initiator: string;
  evidenceHash: string;
  reason: string;
  status: "pending" | "resolved" | "cancelled";
  createdAt: string;
  resolvedAt?: string;
}
```

Export from `packages/spec/src/types/index.ts`.

#### 1c. Add Story chain to `chain-config.ts`

Add `story` and `story-aeneid` entries to the deployments map in
`packages/contracts/ts/chain-config.ts` with the contract addresses from the research.

#### 1d. Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `STORY_NETWORK` | No | `story-aeneid` | `story` (mainnet) or `story-aeneid` (testnet) |
| `STORY_RPC_URL` | No | Auto from network | Override Story RPC endpoint |
| `STORY_PRIVATE_KEY` | For real mode | None | Private key for Story chain transactions |
| `STORY_MOCK` | No | `true` | Set `false` to use real Story chain |

**Design decision**: Separate wallet for Story chain. The operator may want different keys
for Base Sepolia (escrow) and Story (IP). UnifiedKeychain can derive both from one mnemonic
but they're separate signing contexts.

---

### Phase 2: StoryIPService (core service)

**Goal**: Build the service that bridges PCC and Story Protocol.

Create `packages/contracts/ts/story-ip-service.ts`:

```typescript
export class StoryIPService {
  constructor(options?: { mock?: boolean });

  // ── IP Registration ─────────────────────────────────────

  // Register a CSD as an IP Asset on Story
  // Called when: operator publishes a CSD to the registry
  // Returns: ipId, nftTokenId, licenseTermsId
  async registerCapabilityAsIP(
    capability: { id: string; name: string; type: string; kernelId: string; description?: string },
    options: {
      designerAddress: string;
      designerName: string;
      commercialRevShare?: number;  // default 5% — parent earns 5% of all derivative revenue
      ipfsCid?: string;             // CSD metadata already on IPFS (from Storacha/Helia)
    }
  ): Promise<StoryIPRegistration>;

  // Register job evidence as a derivative of the CSD's IP Asset
  // Called when: job completes and evidence is finalized
  // Creates a parent→child IP link with automatic royalty flow
  async registerJobAsDerivative(
    parentIpId: string,             // CSD's IP Asset
    evidence: {
      jobId: string;
      evidenceBundleHash: string;
      operatorAddress: string;
      operatorName: string;
      ipfsCid?: string;
    }
  ): Promise<StoryDerivativeLink>;

  // ── Royalty Distribution ────────────────────────────────

  // Distribute Royalty Tokens to collaborators
  // Called when: CSD is first registered (set the revenue split)
  // 100 tokens total — each token = 1% of all revenue
  async distributeRoyaltyTokens(
    ipId: string,
    splits: StoryRoyaltySplit["splits"]
  ): Promise<{ txHash: string; distributed: number }>;

  // Pay royalty to an IP Asset's vault
  // Called when: MilestoneEscrow releases funds
  // The amount is the IP royalty portion (e.g., 5% of job value)
  async payJobRoyalty(
    ipId: string,
    amount: string,                 // In WIP token units
    payerAddress: string
  ): Promise<{ txHash: string }>;

  // Claim accumulated revenue from a vault
  // Called when: collaborator wants to withdraw their earnings
  async claimRevenue(
    ipId: string,
    tokenIds?: string[]             // Specific Royalty Token IDs, or all
  ): Promise<{ txHash: string; claimed: string }>;

  // Get revenue snapshot for an IP Asset
  async getRevenueSnapshot(ipId: string): Promise<StoryRevenueSnapshot>;

  // ── Disputes ────────────────────────────────────────────

  // Raise a dispute on Story (supplements PCC challenge window)
  async raiseDispute(
    ipId: string,
    evidence: { hash: string; reason: string }
  ): Promise<StoryDispute>;

  // ── Queries ─────────────────────────────────────────────

  // Get IP registration for a PCC capability
  async getIPRegistration(capabilityId: string): Promise<StoryIPRegistration | null>;

  // Get all derivatives (jobs) of an IP Asset
  async getDerivatives(ipId: string): Promise<StoryDerivativeLink[]>;

  // Get the full IP lineage chain (parent → children → grandchildren)
  async getLineage(ipId: string): Promise<{ ancestors: string[]; descendants: string[] }>;
}
```

**Mock mode**: When `STORY_MOCK=true` (default), all methods return plausible mock data
with deterministic IDs derived from inputs. No real chain transactions. Tests always use
mock mode.

**Real mode**: Uses `@story-protocol/core-sdk` via the StoryClient. Each method maps
to one or more SDK calls:

| Method | SDK Calls |
|---|---|
| `registerCapabilityAsIP` | `client.ipAsset.mintAndRegisterIpAssetWithPilTerms()` |
| `registerJobAsDerivative` | `client.ipAsset.registerDerivativeWithLicenseTokens()` |
| `distributeRoyaltyTokens` | Transfer ERC-20 Royalty Tokens via `client.ipAccount.execute()` |
| `payJobRoyalty` | `client.royalty.payRoyaltyOnBehalf()` |
| `claimRevenue` | `client.royalty.claimAllRevenue()` |
| `raiseDispute` | `client.dispute.raiseDispute()` |

---

### Phase 3: Gateway IP Routes

**Goal**: Expose Story Protocol operations via REST API.

Create `packages/gateway/src/routes/ip.ts`:

| Method | Path | Description |
|---|---|---|
| POST | `/api/ip/register-capability` | Register a CSD as Story IP Asset |
| POST | `/api/ip/register-job-evidence` | Register job evidence as derivative IP |
| POST | `/api/ip/distribute-royalties` | Set revenue split for an IP Asset |
| POST | `/api/ip/:ipId/pay` | Pay royalty to an IP vault |
| POST | `/api/ip/:ipId/claim` | Claim revenue from a vault |
| GET | `/api/ip/:ipId/revenue` | Get revenue snapshot |
| GET | `/api/ip/:ipId/lineage` | Get full IP lineage chain |
| GET | `/api/ip/capability/:capabilityId` | Get IP registration for a capability |
| POST | `/api/ip/:ipId/dispute` | Raise a dispute |

---

### Phase 4: Automatic IP Registration Pipeline

**Goal**: IP registration happens automatically, not manually.

#### 4a. CSD Publication → IP Registration

When a CSD is registered via `POST /api/csd`:
1. Validate and store the CSD (existing flow)
2. Upload CSD metadata to IPFS (Storacha/Helia, existing)
3. Call `storyIPService.registerCapabilityAsIP()` (new)
4. Store the `StoryIPRegistration` in the DB (new column on capabilities table)
5. CSD now has an `ipId` — it's an IP Asset on Story

#### 4b. Job Completion → Derivative IP

When a job completes (in `SettlementService.processEvidence()`):
1. Store evidence bundle (existing flow)
2. Submit evidence hash on-chain (existing flow)
3. Call `storyIPService.registerJobAsDerivative(capabilityIpId, evidence)` (new)
4. The job evidence is now a derivative IP Asset, linked to the CSD

#### 4c. Escrow Release → Royalty Payment

When escrow releases (in `SettlementService.releaseMilestone()`):
1. Release milestone funds on Base (existing flow)
2. Calculate IP royalty portion (configurable, default 5% of job value)
3. Call `storyIPService.payJobRoyalty(ipId, royaltyAmount)` (new)
4. Revenue accumulates in the IP Royalty Vault
5. All Royalty Token holders can claim their share

#### 4d. CSD Fork → Derivative IP

When a CSD is forked (via `POST /api/csd` with `baseDefinition` pointing to existing CSD):
1. Register the new CSD as a derivative IP of the parent CSD
2. The parent CSD's Royalty Vault automatically earns from the derivative's usage
3. This creates multi-generation IP chains (original → fork → fork-of-fork)

---

### Phase 5: Multi-Party Revenue Splits

**Goal**: Define who earns what in collaborative workflows.

#### 5a. Default Split for Single-Step Jobs

| Role | Tokens | Revenue Share | Who |
|---|---|---|---|
| CSD Designer | 10 | 10% | Person who authored the capability definition |
| Machine Operator | 70 | 70% | Person whose machine ran the job |
| Verifier | 10 | 10% | Person/subnet that verified evidence quality |
| Network Treasury | 10 | 10% | PCC protocol fee |

#### 5b. Multi-Step Workflow Splits

For a 4-step workflow (CNC → anodize → inspect → ship), each step has its own IP Asset
with its own Royalty Vault. The customer pays once; revenue flows through the chain:

```
Customer pays $100 for the workflow
├── Step 1: CNC Milling ($40)
│   ├── CNC CSD Designer: 10% ($4)
│   ├── CNC Operator: 70% ($28)
│   ├── CNC Verifier: 10% ($4)
│   └── Network: 10% ($4)
├── Step 2: Anodizing ($25)
│   ├── Anodize CSD Designer: 10% ($2.50)
│   ├── Anodize Operator: 70% ($17.50)
│   ├── ... etc
├── Step 3: Inspection ($15)
│   └── ... same split pattern
└── Step 4: Shipping ($20)
    └── ... same split pattern

PLUS: 5% of each step's revenue flows UP to parent CSD IPs
(if the CSD was derived from another CSD)
```

#### 5c. Custom Splits via Negotiation

The default splits can be overridden during contract negotiation:
- User agent proposes a split in the `build_contract` flow
- Broker agent negotiates with kernel agent
- Final split is encoded in the Story Protocol license terms
- Split is immutable once the job starts (on-chain commitment)

This is the "negotiation dashboard" the user mentioned — operators can:
- See proposed splits before accepting a job
- Counter-propose different percentages
- Set minimum revenue thresholds ("I won't run this job for less than $X")
- Lock in splits via on-chain license minting

---

### Phase 6: MCP Tools + A2A Intents

**Goal**: Agents can manage IP programmatically.

#### 6a. MCP Tools (add to `@pcc/mcp-server`)

| Tool | Description |
|---|---|
| `pcc_ip_register_capability` | Register a CSD as Story IP Asset |
| `pcc_ip_revenue_snapshot` | Get revenue for an IP Asset |
| `pcc_ip_claim` | Claim accumulated revenue |
| `pcc_ip_lineage` | View IP lineage chain |
| `pcc_ip_set_splits` | Configure revenue splits for collaborators |

#### 6b. A2A Intents (add to `@pcc/a2a`)

| Intent | Direction | Purpose |
|---|---|---|
| `ip_register` | request | Register IP for a capability |
| `ip_register_result` | response | Return ipId and registration details |
| `ip_revenue_query` | request | Query revenue for an IP |
| `ip_revenue_result` | response | Return revenue snapshot |
| `ip_claim_revenue` | request | Claim from vault |
| `ip_claim_result` | response | Return claim transaction |
| `ip_propose_split` | request | Propose revenue split in negotiation |
| `ip_split_response` | response | Accept/counter the proposed split |

---

### Phase 7: Dashboard Integration

**Goal**: Operators see their IP and revenue in the dashboard.

#### 7a. IP tab on Operator Dashboard (`/operator`)

- List all IP Assets owned by this operator
- For each: ipId, capability name, total revenue, unclaimed amount
- "Claim All" button
- Revenue chart over time (Recharts, already in dashboard)

#### 7b. IP Lineage on Evidence Explorer (`/evidence`)

- For each evidence bundle: show the IP chain
- Parent CSD → This Job → Derivatives (if the job's parameters were reused)
- React Flow visualization (already used for workflows)

#### 7c. Revenue Split on Contract Builder (`/build`)

- Show proposed revenue split during contract configuration
- Allow operator to adjust percentages
- Preview: "You'll earn $X per job at current pricing"

#### 7d. IP Registration on CSD Registry page (new or extend `/protocols`)

- Show Story Protocol ipId for each CSD
- "Register as IP" button for unregistered CSDs
- Royalty Token distribution status
- Fork history (derivatives)

---

### Phase 8: Database Schema

Add to `packages/db/src/schema/`:

```sql
-- IP registrations
CREATE TABLE story_ip_registrations (
  ip_id TEXT PRIMARY KEY,           -- Story IP Account address
  nft_token_id TEXT NOT NULL,
  license_terms_id TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  capability_id TEXT,               -- FK to capabilities (nullable for non-capability IPs)
  csd_url TEXT,                     -- CSD URI
  chain TEXT NOT NULL DEFAULT 'story-aeneid',
  registered_at TEXT NOT NULL,
  FOREIGN KEY (capability_id) REFERENCES capabilities(id)
);

-- Derivative links (job evidence → parent CSD IP)
CREATE TABLE story_derivative_links (
  id TEXT PRIMARY KEY,
  parent_ip_id TEXT NOT NULL,
  child_ip_id TEXT NOT NULL,
  license_token_id TEXT NOT NULL,
  job_id TEXT,                      -- FK to jobs
  evidence_bundle_hash TEXT,
  tx_hash TEXT NOT NULL,
  linked_at TEXT NOT NULL,
  FOREIGN KEY (parent_ip_id) REFERENCES story_ip_registrations(ip_id),
  FOREIGN KEY (job_id) REFERENCES jobs(id)
);

-- Royalty splits (who gets what percentage)
CREATE TABLE story_royalty_splits (
  id TEXT PRIMARY KEY,
  ip_id TEXT NOT NULL,
  address TEXT NOT NULL,
  role TEXT NOT NULL,
  percentage INTEGER NOT NULL,      -- 1-100
  label TEXT NOT NULL,
  FOREIGN KEY (ip_id) REFERENCES story_ip_registrations(ip_id)
);

-- Revenue claims (history)
CREATE TABLE story_revenue_claims (
  id TEXT PRIMARY KEY,
  ip_id TEXT NOT NULL,
  claimer_address TEXT NOT NULL,
  amount TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  claimed_at TEXT NOT NULL,
  FOREIGN KEY (ip_id) REFERENCES story_ip_registrations(ip_id)
);
```

---

## Execution Waves

| Wave | Phases | Parallel? | Dependencies |
|---|---|---|---|
| 1 | Phase 1 (types + chain config) | Single agent | None |
| 2 | Phase 2 (StoryIPService) + Phase 8 (DB schema) | Parallel | Wave 1 |
| 3 | Phase 3 (Gateway routes) + Phase 6 (MCP/A2A) | Parallel | Wave 2 |
| 4 | Phase 4 (Automatic pipeline) | Single agent | Wave 3 |
| 5 | Phase 5 (Revenue splits) + Phase 7 (Dashboard) | Parallel | Wave 4 |

**Estimated effort**: 5 waves, 8 implementer agents, ~150 new tests.

---

## Environment Setup (for development)

```bash
# Story Protocol (defaults to mock mode — no real chain needed)
STORY_MOCK=true

# For testnet (when ready to test on-chain):
STORY_MOCK=false
STORY_NETWORK=story-aeneid
STORY_PRIVATE_KEY=0x...  # Generate via: npx tsx scripts/generate-wallet.ts
# Get testnet IP tokens from Story faucet: https://faucet.story.foundation
```

---

## What This Enables — The Full Vision

1. **Designer in Detroit** creates a CSD for precision aluminum milling → registered as IP Asset
2. **Operator in Austin** forks the CSD for their Haas VF-2 → derivative IP, designer earns 5% forever
3. **Customer books the capability** → license minted, escrow funded
4. **Machine runs the job** → evidence bundle registered as derivative IP
5. **Escrow releases** → 70% to operator, 10% to designer, 10% to verifier, 10% to network
6. **Someone in Munich forks the Austin operator's profile** → Austin operator earns from that too
7. **Revenue accumulates in IP Royalty Vaults** → all parties claim whenever they want
8. **Dispute?** → Challenge window on Base + UMA arbitration on Story
9. **Years later**: the original Detroit designer still earns micropayments every time anyone uses a capability derived from their work. IP persists through on-chain work.

This is the endgame: **a global graph of physical capabilities where intellectual property flows like royalties in music, but for manufacturing processes.**
