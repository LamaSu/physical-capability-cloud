
---

## Appendix B: Additional robotics datasets deep-dive

### B.1 DROID (2024) — Distributed Robot Interaction Dataset

**Sources:** [DROID site](https://droid-dataset.github.io/), [arXiv 2403.12945](https://arxiv.org/abs/2403.12945), [RSS 2024 paper PDF](https://www.roboticsproceedings.org/rss20/p120.pdf), [Berkeley PDF](https://autolab.berkeley.edu/assets/publications/media/2024-RSS-DROID.pdf), [HF paper](https://huggingface.co/papers/2403.12945).

**Scale.** 76,000 demonstration trajectories / 350 hours / 564 scenes / 86 tasks. Collected by 50 data-collectors across **13 institutions in North America, Asia, and Europe**. 12 months of collection. 18 robots (all Franka Panda 7-DoF).

**Hardware stack.**
- Franka Panda arm (standardized across institutions).
- 2 x Zed 2 stereo cameras (adjustable).
- Wrist-mounted Zed Mini stereo camera.
- Oculus Quest 2 headset + controllers for teleoperation.

**Per-episode data.** 3 synchronized RGB streams, camera calibration, depth, natural-language instructions.

**Performance.** +22% absolute success in-distribution, +17% out-of-distribution vs next-best method.

**License.** CC-BY-4.0. Code, checkpoints, and hardware build guide released.

**Fit for PCC: 5/5.** DROID is the clearest "multi-institution distributed collection" precedent for PCC's contributor-economics story. Each of the 13 institutions collected data independently, so each is a natural DatasetNFT minter. PCC's DatasetNFT layer would give DROID contributors ongoing royalty from downstream robotics-model usage, which they currently have NONE of.

**Specific onboarding opportunity.** The 13 DROID institutions are a prime target for PCC outreach:
- Stanford, Berkeley, USC, MIT, CMU, TRI (Toyota Research), NVIDIA, U Washington, U Pennsylvania, Columbia, KAIST, Imperial College, ETH Zurich.
- Credentialed research groups with existing IP policies.
- DatasetNFT mint is a small administrative action — it doesn't modify the underlying data or license.
- They keep CC-BY-4.0 semantics; PCC adds a pay-it-forward economic layer on top.

### B.2 Octo (2024) — Open-Source Generalist Robot Policy

**Sources:** [Octo site](https://octo-models.github.io/), [Octo paper PDF](https://octo-models.github.io/paper.pdf), [arXiv 2405.12213](https://arxiv.org/abs/2405.12213), [RSS 2024 proceedings](https://www.roboticsproceedings.org/rss20/p090.pdf).

**Overview.** Open-source generalist robot policy. Trained on a mixture of **25 datasets from the Open X-Embodiment Dataset**.

**Training-mix weighting strategy (CRITICAL for PCC).**
- Datasets categorized into "more diverse" and "less diverse" based on task + environment variance.
- **More-diverse datasets get 2x weighting** during training.
- Datasets with many repetitive episodes get DOWN-weighted to avoid dominating the mixture.

**Performance.** Outperforms RT-1-X on natural-language tasks; comparable to RT-2-X (55B params) despite being smaller.

**Implications for PCC.** Octo's training-mix weighting is EXACTLY the `weight_bps` field PCC's TrainingManifest needs. Quantities:
- 25 datasets from OXE.
- Weights are set by researchers manually, not uniform.
- Some datasets upweighted 2x; some downweighted.

If Octo existed as a ModelNFT, its TrainingManifest would have 25 DatasetNFT entries with custom weight_bps. A robot job using Octo would pay each dataset holder proportionally.

**Octo team attribution would include:**
- Sergey Levine's lab (Berkeley).
- Plus the 21 institutions behind the 25 OXE datasets used.

### B.3 Research frontier: Proof-of-Training-Data

**Sources:** [Tools for Verifying Neural Models' Training Data (arXiv 2307.00682)](https://arxiv.org/abs/2307.00682), [Training Data Provenance Verification (arXiv 2503.09122)](https://arxiv.org/html/2503.09122), [Learning to Weight Parameters for Training Data Attribution (arXiv 2506.05647)](https://arxiv.org/html/2506.05647), [Data Provenance Auditing INRIA](https://inria.hal.science/hal-05293957v1/document).

**Proof-of-Training-Data (PoTD).** A protocol that allows a model trainer to convince a Verifier of the training data that produced a set of model weights. Verifies training compute, amount of data, presence of harmful / beneficial sources.

**Key research directions:**
1. **Gradient-based attribution.** Compute "influence functions" showing how each training example affected final weights. Scales poorly but mathematically grounded.
2. **Parameter-weight attribution (2025).** Learning parameter importance weights directly from data; attribution quality varies systematically by parameter group.
3. **Watermarking / canary methods.** Embed invisible Unicode canaries or signal patterns in dataset that appear in model outputs, detect via black-box prompting.
4. **Synthetic data provenance.** "Did your model train on MY generative model's output?" - active research area.

**PCC relevance.** For v2+ attestation, PoTD techniques become relevant. But the problem is asymmetric:
- It's easy to prove *inclusion* (a specific dataset was used).
- It's hard to prove *exclusion* (no OTHER dataset was used).
- It's very hard to prove *weighting* (dataset was 30% of training, not 10%).

**PCC's pragmatic answer.** MVP trusts the trainer. v2 adds TEE-attested training where the entire training run is sandboxed (Phala / H100 CC). The TEE enclave can attest "this training script loaded EXACTLY these bytes from these URLs." Stronger guarantee than research PoTD methods.

### B.4 Bridge V2 expanded notes

BridgeData V2 (arXiv 2308.12952, Berkeley RAIL) is the canonical "large-scale in-the-wild" robot manipulation dataset from the BAIR lab. 60,096 trajectories across 24 environments, 13 skills. Collected on a WidowX 250 arm. Designed specifically for generalization — the dataset intentionally spans diverse kitchens/tabletops with varying lighting, backgrounds, and object collections.

**License:** CC-BY-4.0.

**Why it matters for PCC.** BridgeData is consistently up-weighted in OXE-trained models (Octo 2x-weights it, RT-X up-weights it). If PCC mints a BridgeData DatasetNFT, it will earn outsized royalty because of its high effective weight across many downstream models. This is a great demo case: one well-crafted DatasetNFT with high training influence = large passive royalty stream.

### B.5 Isaac Sim / Omniverse — synthetic data provenance

**Sources:** NVIDIA Isaac Sim docs; Omniverse USD. (Research pending live URL; well-documented in NVIDIA developer site.)

Synthetic-data provenance is a distinct problem domain: you commit to the simulation *parameters* rather than the *trajectory bytes*. A synthetic DatasetNFT's metadata should include:
```json
{
  "type": "synthetic",
  "simulator": "isaac-sim-4.2",
  "scene_cid": "bafkrei...",         // USD scene file
  "randomization_config_cid": "bafkrei...",
  "sensor_config_cid": "bafkrei...",
  "seed_range": {"start": 0, "end": 10000},
  "determinism_attestation": "bit-for-bit" | "approximate"
}
```

For an honest provenance story, we want the ability to re-execute the simulation and get the same trajectories bit-for-bit (only practical for deterministic simulators). Isaac Sim is mostly deterministic; Unity ML-Agents and Brax are also deterministic. Sim2real transfer adds noise that synthetic data alone can't cover.

**Fit for PCC: 4/5.** Synthetic DatasetNFT is a real category. Different license treatment: the "owner" is the person/org that designed the simulation + DR config, not a pilot. License should be "derivative-allowed" by default because sim data is easy to re-generate.

---

## Appendix C: Comparison matrix — attribution approaches

| System | Attribution depth | Recursive? | Verification | Token standard | Fit for PCC |
|---|---|---|---|---|---|
| OXE academic citation | Flat (paper + spreadsheet) | No | Trust | None | Baseline to beat |
| LeRobot HF Hub license fields | Flat (license: field in YAML) | No | Trust | None | Starting metadata |
| C2PA manifests | 1-level (ingredients list) | Partial (via ingredient CIDs) | Crypto-signature | None (file metadata) | Capture-side provenance |
| W3C PROV | DAG (wasDerivedFrom + wasGeneratedBy) | Yes | Trust | None (RDF) | Export format for interop |
| DVC lock file | DAG (stages + hashes) | Yes | Hash-based | None | Off-chain manifest model |
| HF model card datasets: | Flat list | No | Trust | None | Starting point, add weights |
| MLflow Model Registry | Tree (experiment→run→model) | Partial | Trust | None | Off-chain baseline |
| Story Protocol IPGraph | DAG (parent-child) | **YES (built-in)** | Dispute + attestation | ERC-721 IPAsset | Primary reference |
| Ocean Protocol | Flat (1 NFT per dataset) | No | Datatoken access | ERC-721 + ERC-20 | Two-token pattern |
| Audius + 0xSplits | Flat (split table) | No | Trust | ERC-20 splits | Payout pattern |
| Lens Collect | Flat (collect + referral) | No | Trust | ERC-721 | Referral pattern only |
| ORA IMO | 1-level (model + holders) | No | opML | ERC-7641 + ERC-7007 | Fractional model ownership |
| FrodoBots / BitRobot | Flat (pay-once to pilot) | No | Trust | SOL token | Customer, not integration |
| Sahara AI | 1-level claim | Unclear | Unclear | SAHARA token | Possibly cross-chain partner |
| **PCC proposal (§11)** | **DAG (parents + datasets with weights)** | **YES** | **Trust → TEE → zkML (tiered)** | **ERC-721 + ERC-7641 + ERC-6551** | **Self** |

---

## Appendix D: Gas cost estimation

Baseline on Base L2 (~0.1 gwei gas cost, ~$2500 ETH):

| Operation | Estimated gas | USD cost |
|---|---|---|
| DatasetNFT mint | 300k | $0.08 |
| ModelNFT mint (5 datasets + 2 parents) | 550k | $0.14 |
| ModelNFT mint (20 datasets + 3 parents) | 1.1M | $0.28 |
| Deploy ERC-6551 TBA | 150k | $0.04 |
| Deploy ERC-7641 ShareToken | 600k | $0.15 |
| Flatten mix (on-chain compute at mint) | 200k per leaf | $0.05 per leaf |
| RoyaltyRouter.routeModelRevenue (10 recipients) | 300k | $0.08 |
| RoyaltyRouter.routeModelRevenue (50 recipients) | 1.2M | $0.30 |
| Withdraw (per recipient) | 60k | $0.02 |

**Conclusion.** Full pipeline (mint + route + withdraw) costs ~$0.50 end-to-end on Base. Dominated by per-leaf storage. Acceptable for MVP.

**Optimization paths if needed:**
- Use merkle-tree root for flattened mix (commit root on-chain; prove leaf inclusion during withdrawal).
- Batch withdrawals across multiple jobs.
- Move to Base L3 or similar when volume justifies.

---

## Appendix E: Attack vectors + mitigations

### E.1 Mix-lying (trainer reports fake weights)

**Attack.** Trainer claims Dataset X got 20% weight; really it was 2%. Dataset X holder gets paid 10x too much.

**Mitigation (MVP):** Trust + dispute. Trainer bonds 5% of expected lifetime royalty in USDC. Dispute window 30 days post-ModelNFT-mint. Challengers submit evidence → 3-of-5 PCC council votes → bond slashed to challenger if proven.

**Mitigation (v2):** TEE attestation. Training runs inside Phala / H100 CC. Dataset loading is measured — TEE attests to the actual byte-level consumption. No lying possible.

### E.2 Sybil dataset minting

**Attack.** Attacker mints 100 nearly-identical DatasetNFTs from the same source data; each gets 1% weight in a fake ModelNFT.

**Mitigation:**
- Gitcoin Passport ≥ 15 required to mint DatasetNFT (human gate).
- Content-hash deduplication: `(manifestHash, collectedBy)` is the tokenId. Re-minting with same hash reverts.
- Moderation: PCC reserves right to flag + disable payout to sybil-flagged tokens.

### E.3 Orphan flattened mix

**Attack.** ModelNFT M's flattened mix references DatasetNFT D. D gets burned or transferred to a bad-actor address. Royalty flow breaks or pays the wrong party.

**Mitigation:**
- DatasetNFT burn is DISABLED (cannot burn a DatasetNFT; can only set `active: false`).
- Royalty flows to DatasetNFT's TBA, not to a specified address. TBA ownership = NFT ownership, transfers cleanly.
- If a DatasetNFT becomes malicious-owned, the PCC council can set it to `deprecated: true`, which re-routes its share to the PCC treasury (then manually redistributed).

### E.4 License-incompatibility bypass

**Attack.** Dataset D has SHARE_ALIKE license. Trainer includes D in ModelNFT M but marks M as COMMERCIAL_ROY (less strict). ModelNFT is minted; downstream usage violates D's license.

**Mitigation:**
- On-chain license composition check (§11.F). The license of M's output = strictest-of-all-inputs. ModelNFT mint REVERTS if the manifest claims a weaker license than inputs require.
- Enforced at the Solidity layer in `ModelNFT.mint()`.

### E.5 Training-mix weight not 100%

**Attack / honest mistake.** Trainer submits weights that don't sum to 10000 (100%).

**Mitigation:**
- `_verifyWeightsSum` in `ModelNFT.mint()` reverts if `sum != 10000`.
- Sum includes parents + datasets + creator + protocol.

### E.6 Circular reference

**Attack / honest mistake.** ModelNFT M claims parent ModelNFT P; P claims parent M (introduced later).

**Mitigation:**
- TrainingManifest is IMMUTABLE post-mint. Can't introduce a new parent later.
- Mint-time flattening naturally detects cycles (would infinite-loop; revert with gas-out).
- Additionally, a depth-5 BFS cap in `_computeAndStoreFlattenedMix` prevents gas-griefing.

### E.7 MEV on settlement

**Attack.** Settlement transaction is frontrunable; attacker sees incoming revenue, reorders to steal withdrawal.

**Mitigation:**
- Pull-payment pattern (pendingWithdrawals mapping) — each address withdraws independently; no ordering-dependent state.
- `routeModelRevenue` is idempotent per (jobId, modelTokenId) pair; attempts to double-pay a job revert.

### E.8 Parent-model ownership transfer exploitation

**Attack.** Trainer builds ModelNFT M with parent P. Owns P. After M is widely-used, transfers P to another address (or burns P's TBA contents) to redirect royalty flow.

**Mitigation:**
- ModelNFT ownership transferable by default.
- Royalty routing is based on the CURRENT TBA of the NFT (which transfers atomically with the NFT).
- If trainer wants to guarantee long-term royalty allocation, they should deploy the ERC-7641 ShareToken and distribute tokens to trusted parties. Share holders' payouts cannot be redirected.

### E.9 Fake attestation (v2 risk)

**Attack.** Trainer generates a fake TEE quote, submits to TrainingManifest.

**Mitigation (v2):**
- Quote verification contract on-chain: the TEE provider (Phala, Intel, NVIDIA) signs attestation quotes with a hardware-root-of-trust key.
- PCC maintains a public registry of valid attestor keys.
- Quote verification = check signature against key in registry + verify measurement matches expected training-script hash.

---

## Appendix F: Glossary

**DatasetNFT.** PCC-specific ERC-721 representing ownership of a robotics training dataset. Subtype of ContributorNFT.

**ModelNFT.** PCC-specific ERC-721 representing ownership of a trained AI model. Has associated TrainingManifest + optional ERC-7641 ShareToken.

**TrainingManifest.** The canonical record of which datasets + parent models went into a ModelNFT, with per-input weight_bps. On-chain struct + off-chain IPLD DAG-CBOR JSON.

**Flattened mix.** Pre-computed list of leaf DatasetNFTs with effective weight (after recursive DAG propagation through parent ModelNFTs). Stored on-chain for O(leaves) settlement.

**RoyaltyRouter.** PCC contract that receives USDC from settled jobs + marketplace royalties and distributes to DatasetNFT TBAs + ModelShare holders + creator + protocol treasury.

**IPAsset (Story).** Story Protocol's ERC-721 for IP. Has IPAccount (ERC-6551 TBA) + IPGraph edges to parents/derivatives.

**IP Graph (Story).** Story's on-chain graph of parent-child IP relationships. Royalty flows through it automatically via the Royalty Module.

**PIL (Story).** Programmable IP License. NFT-represented license terms (commercial y/n, derivatives y/n, royalty %).

**IPAccount / TBA (ERC-6551).** A smart-contract wallet bound to an NFT. Whoever owns the NFT controls the wallet.

**Datatoken (Ocean).** ERC-20 representing access rights to a dataset. 1 datatoken = 1 consumption right.

**C2D / Compute-to-Data (Ocean).** Pattern where the consumer's algorithm is run inside the publisher's TEE; data never leaves publisher.

**C2PA Manifest.** Signed content-credentials metadata embedded in a file. Records creator, tools, ingredients.

**CID (Content Identifier).** IPFS address = hash of content. Self-verifying.

**DAG-CBOR.** IPLD codec — structured binary encoding for content-addressable data.

**Merkle DAG.** Directed acyclic graph where each node ID = hash of payload + child IDs. IPFS's native structure.

**did:ethr.** DID method using Ethereum addresses as identifiers (ERC-1056).

**SIWE (ERC-4361).** Sign-In With Ethereum. Standardized auth message signing.

**Gitcoin Passport / Human Passport.** Sybil-defense DID aggregator. Stamps prove humanity.

**zkML.** Zero-Knowledge Machine Learning. Prove inference/training without revealing weights/data. Expensive; small-model-only.

**opML.** Optimistic ML (ORA). Fraud-proof ML — compute offchain, challenge-window on-chain. Cheap; any-size model.

**TEE.** Trusted Execution Environment. Hardware-isolated compute with remote attestation. Intel SGX (deprecating), Intel TDX, AMD SEV, NVIDIA H100 CC.

**ALCOA+.** FDA's 10 data-integrity principles (Attributable, Legible, Contemporaneous, Original, Accurate, Complete, Consistent, Credible, Enduring, Available). Already used by PCC's compliance facade.

**OpenRAIL / RAIL.** Responsible AI Licenses. Open but with use restrictions that propagate to derivatives.

**IMO (Initial Model Offering).** ORA's pattern: tokenize an AI model as ERC-7641 RevShare. Holders earn from model usage.

**PoTD / Proof-of-Training-Data.** Research area: cryptographic / statistical protocols to verify a model's training corpus.

**JCS.** JSON Canonicalization Scheme (RFC 8785) — standard way to produce a unique, hashable canonical form of a JSON document.

---

## Appendix G: Comparison with existing PCC primitives

PCC already has several adjacent primitives. How does DatasetNFT/ModelNFT fit?

| Existing PCC primitive | Role | Overlap/relation with new primitives |
|---|---|---|
| CapabilityNFT (Story Protocol IP) | Represents a capability (3D-printing etc.) | Analogous. New primitives add training-data provenance on top. Consider unifying under Story IPGraph. |
| ContributorNFT (pilot, trainer, etc.) | Represents a human contributor with rate schedule | DatasetNFT = ContributorType.DATASET. Pilot who creates dataset holds both PilotContributorNFT AND DatasetNFT. |
| RateSchedule | Recurring revenue contract attached to ContributorNFT | DatasetNFT's royalty flow piggybacks on RateSchedule — just different event source (job completion vs scheduled). |
| MilestoneEscrow (Base Sepolia) | Holds USDC until evidence meets tier | Emits settlement event → RoyaltyRouter routes to DatasetNFT TBAs. Already exists; ADD a hook. |
| MPP (Milestone Payment Protocol) | Default payment rail | Unchanged. RoyaltyRouter is called AFTER MilestoneEscrow releases. |
| Sovereign Wealth Fund (SWF) | Governance + treasury | Receives protocol fee (2.35%). Unchanged. |
| Story Protocol integration (`/api/ip/*`) | Already talks to Story for CapabilityNFT IP | EXTEND to register DatasetNFT + ModelNFT as Story IPAssets (Option A path). |
| Evidence bundles + ALCOA+ | Job-level evidence with drift detection | Training evidence (TEE attestation) is a NEW category but could use the same bundle format. |
| ERC-8004 Agent Registration | Robot identity + reputation | Unchanged. ModelNFT is a separate concept (software IP) vs agent (deployed robot). |

**Key insight: we extend the ContributorNFT pattern, not replace it.** DatasetNFT, TrainerNFT (existing), PilotNFT (existing) are all ContributorType variants. RateSchedule routes ALL contributor payouts. RoyaltyRouter is the NEW component that does the recursive training-mix distribution for ModelNFT payouts specifically.

---

## Appendix H: Implementation risk assessment

| Risk | Severity | Mitigation |
|---|---|---|
| Story Protocol mainnet instability | MEDIUM | Launch native on Base first; add Story mirror as v1.1 feature. |
| TEE attestation complexity | HIGH | Defer to v2; MVP is trust + dispute. Start experimenting with Phala SDK in parallel. |
| License composition edge cases | MEDIUM | Conservative default: strictest-of-all wins. Manual override requires PCC council. |
| Gas cost on large training mixes (50+ datasets) | MEDIUM | Merkle-tree flattening as v1.1. Cap mix size at 20 for MVP. |
| Cross-chain DatasetNFT duplication | LOW | Content hash collision naturally prevents re-mint. Sahara / Story mirrors use same hash. |
| Pilot sybil attacks | MEDIUM | Gitcoin Passport gate + content-hash de-dup + moderation. |
| Trainer runs fake attestation | HIGH (v2) | Challenge-period dispute module. TEE attestor public-key registry. |
| Marketplace ERC-2981 compatibility | LOW | Return single receiver (RoyaltyRouter). Marketplaces treat as opaque. |
| Manifest canonicalization bugs | HIGH | JCS (JSON Canonicalization Scheme, RFC 8785) — well-specified, libraries exist. |
| IPFS availability | MEDIUM | Pin to Storacha + Pinata + Arweave permanent backup for Tier 3 bundles. |

---

## Appendix I: Alternative architectures considered and rejected

### I.1 Pure off-chain manifest + on-chain receipt

**Idea:** Store the full TrainingManifest off-chain (IPFS). On-chain, just commit a hash. Royalty distribution via off-chain coordinator that reads manifest, computes splits, submits distribution transactions.

**Rejected because:** Introduces a trusted off-chain coordinator. PCC's value prop is trustless on-chain settlement. Defeats the purpose of the ContributorNFT pattern.

### I.2 Flat single-level attribution (no recursion)

**Idea:** ModelNFT declares direct contributors only. Parent ModelNFT's own contributors are that parent-creator's problem to pay.

**Rejected because:** Breaks the "recursive royalty" requirement from the brief. A pilot who collected data that ended up in Llama-3-8b-base would never see a cent when a Llama-3-8b-finetune is used by a PCC robot. This is the exact failure mode we're correcting.

### I.3 Story Protocol as primary settlement layer (Option A alone)

**Idea:** Register ALL PCC DatasetNFTs + ModelNFTs as Story IPAssets. Story Royalty Module does the heavy lifting. PCC MilestoneEscrow bridges to Story on release.

**Rejected because:** Introduces Story Mainnet as a hard dependency. Story is ~14 months old; stability and ecosystem aren't proven enough. Bridge adds latency + bridge-risk. BETTER: build native on Base, register Story IPAsset mirrors as a second-class marketing/interop feature.

### I.4 Subgraph-only (The Graph) attribution, no on-chain state

**Idea:** Skip on-chain storage entirely. Use The Graph / Subgraphs to index TrainingManifest events. Settlement reads subgraph data.

**Rejected because:** Subgraphs are read-only views, not settlement truth. We need authoritative on-chain state for the flattened mix because settlement calls depend on it.

### I.5 SBT (Soulbound Token) for DatasetNFT

**Idea:** Make DatasetNFT non-transferable (Soulbound). Forever bound to the original pilot/institution.

**Rejected because:** Locks out legitimate ownership transfers (institution closes, pilot wants to sell). PCC can't impose transfer restrictions without a strong reason. Better: DatasetNFT is transferable; moderation flag handles bad actors.

### I.6 Quadratic funding for dataset contributions

**Idea:** Instead of training-mix weights, use quadratic funding (Gitcoin-style) to allocate royalty share. Community votes determine dataset value.

**Rejected because:** Training-mix weights are an objective technical fact (set during training by the trainer, verifiable by TEE). Quadratic voting introduces political/gaming surface. Maybe useful as a SECOND-level boost (community bonus layered on top of weight-bps distribution), but not the primary allocation mechanism.

### I.7 Single royalty pool (no per-dataset allocation)

**Idea:** All dataset contributors share a single pool pro-rata by stake (e.g., number of datasets they hold). Ignore training-mix weights.

**Rejected because:** Breaks the "pro-rata by training-mix weight" requirement. A pilot who collected a tiny dataset that happens to be HIGHLY-weighted in a popular model should earn much more than one who collected a larger low-weight dataset.

---

## Appendix J: Key decisions for PCC contributor-economics team

1. **Native-on-Base or Story-integrated first?** → Native on Base. Mirror to Story as v1.1.
2. **ERC-7641 for ModelShare?** → Yes. Adopt ORA's IMO pattern.
3. **ERC-6551 TBA for every DatasetNFT + ModelNFT?** → Yes. Clean royalty collection.
4. **Flatten mix at mint or on-demand?** → At mint. O(leaves) settlement is cheap; O(depth × fanout) once is acceptable.
5. **On-chain manifest or IPFS-only?** → Hybrid. Hash on-chain + IPFS storage + Arweave for Tier 3.
6. **License taxonomy size?** → 5 codes for v1 (UNRESTRICTED / COMMERCIAL_ROY / RESEARCH_ONLY / SHARE_ALIKE / PROHIBITED).
7. **TEE tier?** → MVP no TEE. v2 Phala / H100 CC.
8. **Dispute window?** → 30 days.
9. **Gitcoin Passport threshold?** → ≥ 15 for DatasetNFT mint. ≥ 20 for Tier 2+ TrainerNFT.
10. **Launch cadence?** → v1 in 4-6 weeks (Base Sepolia → Base mainnet when contributor count ≥ 10). v2 TEE in Q3 2026.

---

## Appendix K: Comparison with existing branch (`feat/contributor-economics`)

Based on the worktree structure, there's already a `01-royalty-nft-standards.md` from a prior scout. This document complements it:

- **01-royalty-nft-standards.md** — generic NFT royalty (EIP-2981, splits, etc.).
- **02-rate-schedule-marketplace.md** (assumed/expected) — marketplace + rate-schedule patterns.
- **03-dataset-model-provenance.md** (THIS doc) — dataset attribution, model training manifests, recursive royalty flow.

The three documents together form the contributor-economics landscape:
- General royalty infrastructure.
- Marketplace discovery + rate-setting.
- Training-mix provenance + recursive flow.

An implementer synthesizing from all three should have a complete picture.

---

## Appendix L: Solidity interfaces — reference library

### L.1 IERC6551Registry (Token Bound Account Registry)

```solidity
interface IERC6551Registry {
    event ERC6551AccountCreated(
        address account,
        address indexed implementation,
        bytes32 salt,
        uint256 chainId,
        address indexed tokenContract,
        uint256 indexed tokenId
    );

    error AccountCreationFailed();

    function createAccount(
        address implementation,
        bytes32 salt,
        uint256 chainId,
        address tokenContract,
        uint256 tokenId
    ) external returns (address account);

    function account(
        address implementation,
        bytes32 salt,
        uint256 chainId,
        address tokenContract,
        uint256 tokenId
    ) external view returns (address account);
}
```

**Deterministic address formula (CREATE2):**
```
address = keccak256(0xff || registryAddress || salt || keccak256(bytecode))
```
where bytecode = ERC-1167 minimal proxy with (implementation, salt, chainId, tokenContract, tokenId) appended as immutable data.

### L.2 IERC6551Account (the per-NFT smart wallet)

```solidity
interface IERC6551Account {
    receive() external payable;

    // Returns the NFT this account is bound to
    function token() external view returns (
        uint256 chainId,
        address tokenContract,
        uint256 tokenId
    );

    // Opaque state counter (increments on every execution)
    function state() external view returns (uint256);

    // EIP-1271-style signer validation
    function isValidSigner(address signer, bytes calldata context)
        external view returns (bytes4 magicValue);
}
```

PCC uses this as the recipient address for each DatasetNFT's and ModelNFT's royalty accumulation.

### L.3 IERC7007 (AIGC NFT for JobOutputs)

```solidity
interface IERC7007 is IERC721 {
    function addAigcData(
        uint256 tokenId,
        bytes calldata prompt,
        bytes calldata aigcData,
        bytes calldata proof
    ) external;

    function verify(
        bytes calldata prompt,
        bytes calldata aigcData,
        bytes calldata proof
    ) external view returns (bool success);

    event AigcData(
        uint256 indexed tokenId,
        bytes indexed prompt,
        bytes indexed aigcData,
        bytes proof
    );
}

interface IERC7007Enumerable {
    function tokenId(bytes calldata prompt) external view returns (uint256);
    function prompt(uint256 tokenId) external view returns (bytes memory);
}

interface IERC7007Updatable {
    function update(bytes calldata prompt, bytes calldata aigcData) external;
    event Update(uint256 indexed tokenId, bytes indexed prompt, bytes indexed aigcData);
}
```

### L.4 IERC7641 (Intrinsic RevShare — for ModelShare)

```solidity
interface IERC7641 is IERC20 {
    // Create a new revenue snapshot (admin-controlled frequency)
    function snapshot() external returns (uint256 snapshotId);

    // Query claimable amount for account at a specific snapshot
    function claimableRevenue(address account, uint256 snapshotId)
        external view returns (uint256);

    // Claim accumulated revenue for a snapshot
    function claim(uint256 snapshotId) external;

    // Query burn-redeemable amount
    function redeemableOnBurn(uint256 amount) external view returns (uint256);

    // Burn tokens + redeem pool share
    function burn(uint256 amount) external;
}
```

### L.5 IERC2981 (Marketplace royalty surface)

```solidity
interface IERC2981 is IERC165 {
    function royaltyInfo(uint256 _tokenId, uint256 _salePrice)
        external view returns (address receiver, uint256 royaltyAmount);
}
```

PCC returns the RoyaltyRouter as `receiver` for all NFT sales; the Router then does multi-recipient distribution internally.

### L.6 IPCCDatasetNFT (new)

```solidity
interface IPCCDatasetNFT is IERC721, IERC2981, IERC7015 {
    struct DatasetMeta {
        string  manifestCid;
        bytes32 manifestHash;
        string  contentCid;
        uint64  episodeCount;
        uint64  totalFrames;
        bytes32 modalitiesBitmap;
        string  hfRepoId;
        bytes32 hfRevisionSha;
        string  arweaveTxId;
        uint16  licenseCode;
        string  licenseUri;
        address collectedBy;
        uint64  collectedAt;
        bytes32 c2paManifestHash;
    }

    function mint(address to, DatasetMeta calldata m, bytes calldata creatorSig)
        external returns (uint256 tokenId);

    function attachAccessToken(uint256 tokenId, address accessToken) external;

    function meta(uint256 tokenId) external view returns (DatasetMeta memory);
    function tbaFor(uint256 tokenId) external view returns (address);
    function accessTokenFor(uint256 tokenId) external view returns (address);

    event DatasetMinted(uint256 indexed tokenId, address indexed collectedBy, string manifestCid);
    event AccessTokenAttached(uint256 indexed tokenId, address indexed accessToken);
}
```

### L.7 IPCCModelNFT (new)

```solidity
interface IPCCModelNFT is IERC721, IERC2981 {
    struct ModelMeta {
        string  manifestCid;
        bytes32 manifestHash;
        string  weightsCid;
        string  hfModelRepo;
        bytes32 hfModelRevision;
        uint16  licenseCode;
        address trainedBy;
        uint64  trainedAt;
        uint32  architectureCode;
        uint64  paramsCount;
        uint32  attestationType;  // 0=trust, 1=opml, 2=tee-h100, 3=zkml
        string  attestationQuoteCid;
    }

    struct TrainingManifest {
        address[] parentModels;
        uint256[] parentModelTokenIds;
        uint16[]  parentWeightsBps;

        address[] datasets;
        uint256[] datasetTokenIds;
        uint16[]  datasetWeightsBps;

        uint16    creatorWeightBps;
        uint16    protocolWeightBps;
    }

    struct LeafDataset {
        address dataset;
        uint256 tokenId;
        uint16  effectiveWeightBps;
    }

    function mint(
        address to,
        ModelMeta calldata mm,
        TrainingManifest calldata tm,
        bytes calldata creatorSig
    ) external returns (uint256 tokenId);

    function deployShareToken(
        uint256 tokenId,
        string calldata name,
        string calldata symbol,
        uint256 totalSupply
    ) external returns (address);

    function meta(uint256 tokenId) external view returns (ModelMeta memory);
    function manifestOf(uint256 tokenId) external view returns (TrainingManifest memory);
    function getFlattenedMix(uint256 tokenId) external view returns (LeafDataset[] memory);
    function shareTokenOf(uint256 tokenId) external view returns (address);
    function tbaFor(uint256 tokenId) external view returns (address);

    event ModelMinted(uint256 indexed tokenId, address indexed trainedBy, string manifestCid);
    event ManifestCommitted(uint256 indexed tokenId, bytes32 manifestHash);
    event FlattenedMixComputed(uint256 indexed tokenId, uint256 leafCount);
}
```

### L.8 IPCCRoyaltyRouter (new)

```solidity
interface IPCCRoyaltyRouter {
    function routeModelRevenue(uint256 modelTokenId, uint256 totalAmount) external;
    function routeDatasetSale(uint256 datasetTokenId, uint256 salePrice) external;
    function withdraw() external;

    function pendingWithdrawals(address account) external view returns (uint256);

    event Routed(uint256 indexed modelTokenId, uint256 totalAmount);
    event Withdrew(address indexed to, uint256 amount);
}
```

---

## Appendix M: Step-by-step implementation plan

### Phase 1 (Week 1-2): Core contracts

1. `DatasetNFT.sol` — ERC-721 with DatasetMeta struct + ERC-6551 TBA + ERC-7015 creator sig.
2. `ModelNFT.sol` — ERC-721 with ModelMeta + TrainingManifest + flattened mix.
3. `RoyaltyRouter.sol` — pull-payment multi-recipient router.
4. `LicenseCompositionPolicy.sol` — on-chain enum rule.
5. `TBARegistry.sol` — already exists (ERC-6551 standard).

### Phase 2 (Week 3): Economics primitives

6. `ShareTokenFactory.sol` — deploys ERC-7641 per ModelNFT.
7. `DatasetAccessTokenFactory.sol` — deploys ERC-20 access tokens per DatasetNFT.
8. `DisputeModule.sol` — trust-based dispute for MVP.
9. `ManifestCanonicalization.sol` — JCS-compatible hash helper.

### Phase 3 (Week 4): Gateway integration

10. `/api/dataset` routes — mint, metadata, transfer.
11. `/api/model` routes — mint, manifest commit, flatten.
12. `/api/royalty` routes — pending withdrawal view.
13. Dashboard pages: "My DatasetNFTs", "My ModelNFTs", "Training Manifest Builder".

### Phase 4 (Week 5): Onboarding pipeline

14. Gitcoin Passport integration (score check at mint).
15. HF Hub data-card importer (YAML parser + hash generator).
16. CLI `pcc mint-dataset --from-hf user/repo:revision --license cc-by-4.0 --weight 1.0`.
17. Bulk onboarding script for 60 OXE + 13 DROID datasets.

### Phase 5 (Week 6): E2E + Story bridge

18. Full E2E test: pilot → DatasetNFT → trainer → ModelNFT → PCC job → MilestoneEscrow → Router → withdrawal.
19. Story Protocol mirror: `registerAsIPAsset(datasetNFT, tokenId)`.
20. Documentation + example scripts.

### Estimated team

- 1 Senior Solidity engineer (4-6 weeks, FT)
- 1 Backend engineer (4 weeks, FT)
- 0.5 Frontend engineer (3 weeks, dashboard)
- 0.25 Designer (2 weeks)
- 0.25 Protocol lead (oversight)

---

## Appendix N: Open-X Embodiment constituent datasets (for onboarding)

From the OXE paper, the 60 constituent datasets. Not all are currently hosted on HF; some are behind institution download forms. Top candidates for early DatasetNFT minting (well-documented, permissively licensed, high training influence):

1. RT-1 Robot Action (Google) — CC-BY-4.0
2. Bridge V2 (Berkeley RAIL) — CC-BY-4.0
3. Berkeley Cable Routing (Berkeley)
4. Roboturk (Stanford)
5. NYU Door Opening
6. Viola (UT Austin)
7. Berkeley Autolab UR5
8. TOTO (CMU)
9. Columbia Cairlab Pusht
10. Stanford Hydra
11. Austin Buds
12. NYU Franka Play
13. CMU Franka Exploration
14. Berkeley Rot
15. Jaco Play (Columbia)
16. Berkeley Mvp
17. Kuka (Google)
18. Taco Play (Stanford)
19. Stanford Kuka Multimodal
20. NYU Rot (NYU)
21. MAPLE (UT Austin)
22. ALOHA Sim
23. FMB (Berkeley)
24. Droid (multi-institution — see §B.1)
25. Plex RoboSuite

(Full list has 60 entries; see the OXE paper's Table 1 and linked spreadsheet for per-dataset license, citation, and weight used in RT-X training.)

**Onboarding priority:** start with the top 10-15 most-cited + highest-training-influence datasets. Those contribute most to future robotics models trained on OXE + their royalty claim is largest.

---

## Appendix O: External ecosystem signals (April 2026)

**Story Protocol.** Mainnet live 14 months. Solidity contracts mature. $IP token trading. Recent partnerships: Disney-like IP registrations, music publisher deals. Status: production-ready for PCC integration.

**Ocean Protocol.** V4 stable. C2D in pilot phase. Data market live. Lower adoption than hyped in 2021; still technically sound. Status: integrate datatokens pattern; may or may not deploy on Ocean's chain.

**ORA.** OAO on Ethereum mainnet + Arbitrum. IMO token (IMO Labs) live. ERC-7641 adoption growing. Status: integrate ERC-7007 + ERC-7641 standards (which they drive).

**Phala Network.** Post-WireTap transitioning off SGX. H100 CC support live. GPU TEE production-ready. Status: integrate for v2 (Q3 2026).

**Gitcoin / Human Passport.** Rebranded Human Passport. Base support native. Score 20 threshold standard. Status: integrate for MVP (sybil resistance).

**Base (L2).** PCC already deployed. Gas cheap. Ecosystem large. Status: primary chain.

**Huge Face / LeRobot.** v3 stable. Dataset Hub growing (5000+ robotics datasets). Status: primary off-chain storage target for DatasetNFT content.

**FrodoBots / BitRobot.** Solana-based. Subnet 1 live (navigation data). Status: potential dataset source, bridgeable.

**Sahara AI.** L1 mainnet live. Token TGE complete. Data marketplace growing. Status: possible cross-chain partner, not dependency.

---

## Appendix P: Answer to the brief — direct summary

From the brief: "A pilot mints a DatasetNFT, a trainer includes it in a ModelNFT's training manifest, and when a robot uses the model to execute a PCC job, payment flows through the manifest to dataset contributors pro-rata by training-mix weight."

**Implementation summary:**

1. **Pilot mints DatasetNFT** (§11.B):
   - ERC-721 with DatasetMeta (manifest CID, content CID, HF repo pointer, license code, `collectedBy` DID).
   - ERC-7015 creator signature ties the pilot to the token regardless of deploy caller.
   - ERC-6551 TBA provisioned automatically — royalty recipient.
   - Gitcoin Passport ≥ 15 required.

2. **Trainer mints ModelNFT with training manifest** (§11.C):
   - ERC-721 with ModelMeta + TrainingManifest struct.
   - Manifest: `{parentModels[], parentWeightsBps[], datasets[], datasetWeightsBps[], creatorWeightBps, protocolWeightBps}` summing to 10000 bps.
   - `_computeAndStoreFlattenedMix()` runs at mint — recursive DAG walk up to depth 5, produces LeafDataset[] with effective weights.
   - License composition rule: output license = strictest-of-all-inputs (reverts if trainer claims weaker).
   - Optional: deploy ERC-7641 ShareToken for fractional ownership (IMO-style).

3. **Robot executes PCC job with ModelNFT M** (existing flow):
   - Capability discovery → negotiation → contract build → MilestoneEscrow fund.
   - Job executes; evidence uploaded; ALCOA+ checked; tier met.
   - MilestoneEscrow releases USDC.

4. **Payment flows through manifest** (§11.D):
   - MilestoneEscrow calls `RoyaltyRouter.routeModelRevenue(modelTokenId, amount)`.
   - Router reads `flattenedMix[modelTokenId]` — the pre-computed list of LeafDatasets.
   - For each leaf: `share = poolAmt * leaf.effectiveWeightBps / (10000 - creatorBps - protocolBps)` into `datasetNFT.tbaFor(leaf.tokenId)`.
   - Creator + protocol get their fixed shares.
   - All payments are pull (`pendingWithdrawals` mapping); each recipient withdraws independently.

5. **Pro-rata by training-mix weight:**
   - If DatasetNFT D had direct weight 1000 bps in M, D earns 10% of the pool (minus creator + protocol fees).
   - If D was in grandparent model G (weight 800) which was parent of P (weight 600) which was parent of M (weight 7000), D's effective weight = 800 × 0.06 × 0.7 / 10000 = 33.6 bps. D earns 0.336% of pool.
   - Recursion handled by flattening DAG at mint; settlement is O(leaves).

**This is the system.** Four weeks of Solidity work to ship on Base Sepolia.

---

**FINAL VERSION — scout-provenance-charlie — 2026-04-22**
