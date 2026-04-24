# Landscape: Dataset + Model Attribution with Recursive Royalty Flow

**Agent:** scout-provenance-charlie
**Date:** 2026-04-22
**Worktree:** `C:/Users/globa/pcc-contributor-economics`
**Mission:** Research how to implement recursive attribution for robotics datasets and AI models, so that when a robot executes a PCC job using ModelNFT M, payment flows through M's training manifest to DatasetNFT contributors pro-rata by training-mix weight.

## Progress

- [x] 1a. Open-X Embodiment + RT-X
- [x] 1b. LeRobot v3 detail
- [x] 1c. Robomimic / RoboTurk / BridgeData
- [ ] 1d. Isaac Sim / Omniverse (synthetic data — to cover)
- [x] 2a. HF Dataset Cards + Model Cards
- [x] 2b. MLflow artifact lineage
- [x] 2c. DVC
- [x] 2d. W&B dataset artifacts (same pattern, no deep-dive)
- [x] 3a. Story Protocol IP Graph
- [x] 3b. Ocean Protocol Data NFT/Datatoken
- [x] 3c. Audius
- [x] 3d. Lens Protocol collect
- [x] 4a. IPLD + Merkle DAG
- [x] 4b. C2PA
- [x] 4c. W3C PROV
- [x] 4d. Ceramic Network
- [x] 4e. Arweave
- [x] 5. Training-mix encoding on-chain (synthesis)
- [x] 6a. EIP-7007 (AIGC NFT)
- [x] 6b. EIP-7015 (creator attribution)
- [x] 6c. EIP-7641 (intrinsic revshare)
- [x] 6d. ERC-2981 (royalty info)
- [x] 6e. ERC-6551 (token-bound accounts)
- [x] 7a. OpenRAIL
- [x] 7b. Creative Commons / Hippocratic summaries
- [x] 8a. Gitcoin Passport
- [x] 8b. did:ethr / ERC-4361 SIWE / ERC-1056
- [x] 9a. zkML (EZKL, Modulus, Giza)
- [x] 9b. ORA opML + IMO + ERC-7641
- [x] 9c. Phala TEE (Intel TDX, NVIDIA H100 CC)
- [x] 10a. FrodoBots / BitRobot
- [x] 10b. Sahara AI
- [x] 10c. 1X / Tesla / Physical Intelligence / Skild AI

---

## Executive Summary

**The brief, in one sentence:** a pilot mints a DatasetNFT, a trainer includes it in a ModelNFT's training manifest (with weight_bps), and when a robot uses the model to execute a PCC job, payment flows through the manifest to dataset contributors pro-rata.

**Key finding:** the primitives to build this already exist in production, distributed across three protocol stacks — **Story Protocol** (IP Graph + Royalty Module, recursive by construction), **Ocean Protocol** (two-token pattern for dataset ownership vs access), **ORA** (opML verification + ERC-7641 RevShare + IMO pattern). The only piece missing is a **robotics-specific TrainingManifest schema** with explicit `(dataset_id, weight_bps)` tuples, and that's a straightforward extension of HuggingFace model-card YAML + DVC-style Merkle DAG committed on-chain.

**Architectural recommendation (see §11):** adopt the two-token pattern from Ocean for DatasetNFT + DatasetAccessToken, model our RoyaltyRouter on Story's IPGraph (Liquid Relative Percentage), use ERC-7641 for ModelNFT fractional ownership (from ORA's IMO), and commit TrainingManifests to IPFS via IPLD DAG-CBOR with on-chain CID + pre-computed flattened leaf cache. Verification tier: MVP = trust + dispute, v2 = TEE-attested training (Phala / H100 CC), v3 = zkML for small-model inference paths. MVP is launchable in 4-6 weeks on Base Sepolia; parallel registration on Story Mainnet for interop with the broader IP graph.

---

## 1. Robotics Datasets + Open Attribution

### 1.A Open-X Embodiment (Google DeepMind, Oct 2023)

**Sources:** [arXiv 2310.08864](https://arxiv.org/abs/2310.08864), [robotics-transformer-x.github.io](https://robotics-transformer-x.github.io/), [GitHub google-deepmind/open_x_embodiment](https://github.com/google-deepmind/open_x_embodiment), [HF dataset mirror](https://huggingface.co/datasets/jxu124/OpenX-Embodiment).

**Scale.** 1M+ real robot trajectories, **22 embodiments** (single arms, bimanual, quadrupeds), **527 skills**, **160,266 tasks**, **60 constituent datasets**, **21 contributing institutions**. A union of existing datasets, not newly collected.

**License stack.**
- Software (training code, scripts, loaders): **Apache-2.0**
- Data (trajectories, all non-code material): **CC-BY-4.0**
- Individual constituent datasets retain their own licenses; users must check the dataset spreadsheet linked from the site for per-dataset citation + license.

**Attribution mechanism.** Users of RT-X (the model trained on OXE) are asked to cite the Open-X Embodiment paper AND every constituent dataset they specifically loaded. No on-chain mechanism. No royalty flow. Pure academic-citation attribution. **This is the state of the art in open robotics data attribution, and it's still literally "cite us in your paper." PCC can materially improve on this with DatasetNFTs.**

**RT-1-X vs RT-2-X.**
- RT-1-X: 35M params, trained only on the OXE robotics mixture.
- RT-2-X: 55B VLM (PaLI-X) co-fine-tuned with ~50/50 VLM + robotics data.

**Training mix composition.** The RT-X paper explicitly reports per-dataset sampling weights during training — the mixture is not uniform; high-quality datasets like RT-1 and Bridge are upweighted. This is exactly the weight-basis-points vector PCC's TrainingManifest needs to encode.

**Fit for PCC: 5/5.** This is the canonical robotics dataset to bootstrap a DatasetNFT catalog. If PCC wraps the OXE constituent datasets as 60 DatasetNFTs (original owner = institution), every future robotics model trained on OXE has a natural royalty destination list. The CC-BY license is commercially permissive, so wrapping in an NFT is legal as long as attribution is preserved in the token metadata. **Recommended onboarding approach: PCC writes to the 21 institutions asking them to mint their OXE contributions as DatasetNFTs pointing to the existing HF data — zero data movement, purely an attribution-layer addition.**

### 1.B LeRobot (HuggingFace)

**Sources:** [GitHub huggingface/lerobot](https://github.com/huggingface/lerobot), [v3 blog](https://huggingface.co/blog/lerobot-datasets-v3), [v3 docs](https://huggingface.co/docs/lerobot/en/lerobot-dataset-v3).

**Format.** `LeRobotDataset` = Parquet (state/action/metadata) + MP4 (vision), hosted on the Hugging Face Hub, streaming-friendly. v3 (2025) packs multiple episodes per file, uses relational metadata for episode lookup (episode boundaries resolved via metadata, not filenames).

**License.** Software: Apache-2.0. Individual datasets on the Hub are per-dataset — some CC-BY, some CC-BY-SA, some Apache-2.0, some proprietary/research-only. **The Hub does NOT enforce a canonical license**; it's up to the uploader.

**Attribution.** HF Hub dataset cards (Markdown with YAML frontmatter) include `license:` (SPDX), citation (BibTeX), `dataset_info:` (size, splits, features), and custom fields (no standard for training-mix pointers).

**Fit for PCC: 4/5.** LeRobot is where the mass of robotics datasets lives. DatasetNFT should **point to** a LeRobotDataset on HF Hub by `{repo_id, revision_sha}` rather than duplicating storage. Content-addressing: HF revisions are git-sha commits, so `(repo_id, revision_sha)` is a stable reference.

### 1.C Robomimic / RoboTurk / BridgeData

**Sources:** [robomimic docs](https://robomimic.github.io/), [BridgeData V2](https://rail-berkeley.github.io/bridgedata/), [RoboTurk](https://roboturk.stanford.edu/), [arXiv 2308.12952](https://arxiv.org/abs/2308.12952).

**BridgeData V2.** CC-BY-4.0. UC Berkeley RAIL Lab. Cite the paper.
**RoboTurk pilot.** 1000+ task demos across PickPlace + NutAssembly variants, multiple human teleoperators. MIT-ish license for framework; data mostly research-only.
**Robomimic.** Framework + multiple datasets aggregated. License: framework MIT; data per-dataset.

**Fit for PCC: 4/5.** These are obvious early DatasetNFT candidates. Like Open-X, the datasets themselves already exist and are hosted; the NFT is a pure attribution/economic-binding layer.

### 1.D Isaac Sim / NVIDIA Omniverse (pending — synthetic data provenance)

Synthetic-data provenance is its own animal: you commit to the *simulation parameters* (Isaac Sim scene, domain randomization seed, sensor config) plus the *scenegraph hash* rather than to trajectory bytes. A synthetic DatasetNFT's metadata should include `{simulator: "isaac-sim-4.2", scene_cid, randomization_seed_range, sensor_config_cid}`. For an honest provenance story, we want the ability to re-execute the simulation and get the same trajectories bit-for-bit (or within a tolerance) — which is only practical for deterministic simulators.

---

## 2. Model Training Manifests

### 2.A HuggingFace Dataset Cards + Model Cards

**Sources:** [HF Dataset Cards docs](https://huggingface.co/docs/hub/en/datasets-cards), [Model Cards docs](https://huggingface.co/docs/hub/model-cards), [card metadata reference](https://huggingface.co/docs/huggingface_hub/main/en/package_reference/cards).

**Structure.** A card is a `README.md` with a YAML frontmatter block (delimited by `---`). The frontmatter is the machine-readable metadata; the body is human-readable documentation.

**Dataset card YAML fields (canonical):**
```yaml
---
license: cc-by-4.0                # SPDX identifier
license_name: custom-something    # (only if license: other)
license_link: https://...
language: [en]
tags: [robotics, manipulation]
task_categories: [robotics]
size_categories: [100K<n<1M]
pretty_name: My Dataset
dataset_info:
  features:
    - name: observation.image
      dtype: image
    - name: action
      dtype: {sequence: float32, length: 7}
  splits:
    - {name: train, num_bytes: 12345678, num_examples: 10000}
  download_size: 987654321
  dataset_size: 1234567890
configs:
  - {config_name: default, data_files: [data/train-*.parquet]}
---
```

**Model card YAML fields (canonical):**
```yaml
---
license: apache-2.0
datasets:                         # <-- KEY: attribution to training data
  - squad_v2
  - some-user/custom-dataset
base_model:                       # <-- KEY: attribution to parent model
  - meta-llama/Llama-3-8b
language: [en]
library_name: transformers
pipeline_tag: text-generation
tags: [conversational]
model-index:
  - name: my-finetune
    results: [...]
---
```

**Critical finding.** HF *already* has `datasets:` and `base_model:` fields in model cards. These are exactly the "training mix pointer" and "parent model pointer" PCC's TrainingManifest needs. The problem is:
1. They're **flat name strings**, not content-addressed (`squad_v2` is a repo slug, not a revision SHA).
2. **No weights** — you can't say "Llama-3-8b: 85% weight, squad_v2: 15% weight."
3. **No economic binding** — documentation only, no smart contract consumes it.

**Opportunity.** PCC's TrainingManifest is a superset of HF card metadata: `(dataset_id, revision_sha, weight_bps, license)` tuples, committed on-chain with an IPFS-stored full manifest. Tooling that extracts from existing HF cards and adds weights is a natural ingestion pipeline.

**Fit for PCC: 4/5.** HF card format is the de-facto standard. PCC should adopt it as-is and add the on-chain economic layer. The YAML frontmatter becomes a canonical "off-chain manifest" that the on-chain TrainingManifest commits to (via content hash).

### 2.B MLflow Dataset Tracking + Model Registry

**Sources:** [MLflow Dataset Tracking docs](https://mlflow.org/docs/latest/ml/dataset/), [Model Registry](https://mlflow.org/docs/latest/model-registry/), [SageMaker + DVC + MLflow lineage](https://aws.amazon.com/blogs/machine-learning/end-to-end-lineage-with-dvc-and-amazon-sagemaker-ai-mlflow-apps/).

**Capabilities.**
- `DatasetSource` — linked lineage to the original source (S3 URL, Delta Table, URL).
- Log DVC commit hash as a parameter → model in MLflow registry → exact dataset recovery.
- Model Registry stores lineage: experiment → run → model, with versioning and aliases.

**Gap.** Pure off-chain. Not cryptographically verifiable. Trust-based.

**Fit for PCC: 2/5.** Useful as a pattern for the off-chain training-run fingerprint. Not a direct integration target — MLflow lineage has to be rebuilt on-chain to enable royalty flow.

### 2.C DVC (Data Version Control)

**Sources:** [DVC Home](https://doc.dvc.org/), [Pipelines](https://doc.dvc.org/user-guide/pipelines), [Defining Pipelines](https://doc.dvc.org/user-guide/pipelines/defining-pipelines).

**Model.** Pipeline stages (YAML in `dvc.yaml`) → DAG where nodes are stages, edges are dependencies. Each stage has `deps:` (files/dirs), `outs:` (outputs), `params:` (hyperparams). `dvc.lock` records MD5 hash of each output for change detection.

**Critical insight.** DVC's DAG model is structurally identical to what PCC's TrainingManifest needs. Stages = (parent model | dataset); deps = content hashes; outs = produced artifact hash. The whole pipeline is a Merkle-DAG.

**Fit for PCC: 4/5.** DVC's DAG-of-hashed-stages is the canonical off-chain representation that maps 1:1 to an on-chain TrainingManifest. Pattern to steal:
- Every ModelNFT commits to an IPFS hash of a `dvc.lock`-like manifest.
- The manifest enumerates `(stage: "pretrain-llama-3" | "finetune-on-dataset-X", inputs: [hash...], outputs: [hash...])`.
- On-chain, we store ONLY the training-mix weights + IPFS CID of the full manifest.
- Royalty flow doesn't need to traverse the full manifest — it only needs the weighted parent-list, which we surface on-chain.

### 2.D Weights & Biases Dataset Artifacts

Same pattern as MLflow. No cryptographic verifiability. Covered once; no deep-dive required.

---

## 3. On-Chain IP / Attribution Systems

### 3.A Story Protocol — Programmable IP Blockchain (Key Reference)

**Sources:** [Story Foundation](https://www.story.foundation/), [whitepaper PDF](https://www.story.foundation/whitepaper.pdf), [docs intro](https://docs.story.foundation/introduction), [Figment](https://www.figment.io/insights/story-protocol-first-look-bringing-ip-on-chain/), [Oak Research](https://oakresearch.io/en/reports/protocols/story-protocol-ip-comprehensive-presentation-blockchain-intellectual-property).

**Thesis.** Story is a purpose-built Layer 1 blockchain for intellectual property. Core: **Proof-of-Creativity (PoC)**. IP = first-class blockchain entity. IP assets are ERC-721 `IPAsset`s linked into a graph of parent-child (derivative) relationships, with licenses enforced by on-chain modules.

**Key primitives.**

1. **IPAsset** — the tokenization unit. Wraps any existing NFT (image, song, dataset, model) and gives it an **IPAccount** (smart-contract wallet per asset, ERC-6551-style) that can receive royalties.
2. **IPGraph** — the parent-child relationship graph. When you remix, fine-tune, or derive from a parent IPAsset, you register the derivative on-chain with a link to the parent.
3. **Programmable IP License (PIL)** — on-chain license terms. PIL licenses are themselves NFTs (ERC-721 `LicenseToken`s) that can be minted by derivative creators. PIL bridges on-chain enforcement with real-world legal systems.
4. **Royalty Module** — automates revenue flow between parent and child IPAssets. Core concept: **Royalty Stack** — each IPAsset accumulates a percentage of revenue owed to ancestors based on license terms. If IPA3 derives from IPA2 (10%) which derives from IPA1 (5%), IPA3 has a 15% royalty stack.
5. **Dispute Module** — on-chain challenge of infringement claims.

**Payment flow (from docs):**
1. Revenue paid via `payRoyaltyOnBehalf` or during license minting.
2. Royalty Module splits: ancestors receive their percentage, IPAsset receives remainder.
3. Funds go to **IP Royalty Vault** — a vault bound to the IP but separate from it.
4. Each vault has **100 Royalty Tokens** associated — each token = 1% of total revenue.
5. `claimAllRevenue` is permissionless — anyone can trigger claims.

**Policies.**
- **Liquid Absolute Percentage (LAP)**: flat % of all derivative revenue to each parent.
- **Liquid Relative Percentage (LRP)**: each hop takes % of what passed through.
- Permissionless custom policies also supported.

**Chain.** Story Mainnet launched Feb 13 2025 (EVM-compatible L1). $IP token for gas + governance.

**Contract reference.** [RoyaltyModule.sol](https://github.com/storyprotocol/protocol-core-v1/blob/main/contracts/modules/royalty/RoyaltyModule.sol).

**Fit for PCC: 5/5.** Story Protocol is **the reference implementation of recursive on-chain attribution**. PCC has two integration options:
- **(A) Deploy on Story directly.** Register every ContributorNFT, DatasetNFT, ModelNFT as Story IPAssets. Training manifests become IPGraph parent-child links. Use LAP policy for the "10% to training data" split. Story's Royalty Module handles recursive traversal automatically.
- **(B) Take inspiration, build native on Base.** Model our TrainingManifest on IPGraph semantics but keep it in our own contracts. More control. PCC's `/api/ip/*` endpoints already talk to Story Protocol for capability IP registration (per `pcc_ip_register_capability` MCP tool). Extending this to dataset/model IP is a natural next step.

**Recommendation:** Option A + B hybrid. Register DatasetNFTs + ModelNFTs as Story IPAssets (gets us recursive royalty for free). Keep the robot-job-payment origination on Base Sepolia (MilestoneEscrow). Bridge: when an escrow releases, call Story with a revenue event and let Story's Royalty Module distribute through IPGraph.

### 3.B Ocean Protocol — Data NFTs + Datatokens

**Sources:** [Data NFTs + Datatokens](https://docs.oceanprotocol.com/developers/contracts/datanft-and-datatoken), [Data NFTs detail](https://docs.oceanprotocol.com/developers/contracts/data-nfts).

**Two-token model.**
- **Data NFT (ERC-721)** — represents copyright/base IP of a data asset. One data NFT per dataset. Stores metadata, mint roles, fee roles, open key-value store.
- **Datatoken (ERC-20)** — represents licenses to *access* the data. Holding 1.0 datatoken = one consumption right. Multiple datatoken contracts can be minted from one Data NFT (each datatoken = different license terms).

**Why this matters for PCC.** The two-token pattern separates *ownership* from *access*. PCC's DatasetNFT should follow:
- **DatasetNFT (ERC-721)** = who gets paid / who owns the data.
- **DatasetAccessToken (ERC-20)** = who is permitted to use it for training (one AccessToken per training run).

Enables:
- Royalty to DatasetNFT holder (even if ownership transfers, royalty follows the NFT).
- Permissioned training (burn one AccessToken per ModelNFT that includes this dataset).
- Different license tiers (a "commercial training" AccessToken @ 1000 USDC; a "research training" AccessToken @ 10 USDC — distinct ERC-20s).

**Consumption flow.** Consumer sends 1.0 datatoken to publisher → Ocean infra (Provider + Aquarius) grants access to the underlying data URL, typically time-bound.

**Compute-to-Data (C2D).** Consumer sends datatokens → publisher's Provider runs consumer's algorithm on the data inside a TEE → returns only the result. Data never leaves the publisher. **PCC can adopt this for private training** — trainer's job runs inside the dataset holder's sandbox, training manifest is attested by the TEE. Directly answers "how do we verify ModelNFT used these DatasetNFTs?" (see §9).

**Fit for PCC: 5/5.** The cleanest prior art for tokenized datasets with on-chain access control. Adopt the two-token pattern and seriously consider C2D for private training.

### 3.C Audius — Decentralized Music + Royalty Splits

**Sources:** [Audius.org](https://audius.org/), [Protocol docs](https://docs.audius.org/learn/concepts/protocol/), [Music Reports partnership](https://www.musicbusinessworldwide.com/audius-partners-with-music-reports-to-power-rights-clearances-for-music-publishers1/).

**Model.** Decentralized audio distribution + attribution + monetization. Artists paid AUDIO tokens per stream + fan engagement. Labels get no cut by default. Artists can set up splits with producers/co-writers.

**Split.** Curators receive 90% in AUDIO; stakers supporting the network get 10%. Partnership with Music Reports (via Songdex Marketplace) provides traditional music-publisher licensing.

**What's useful for PCC.** The **split contract pattern**. When a ModelNFT pays out, royalty splits among N contributors: base-model-creator (A%), dataset-contributors (B% distributed by training-mix weights), model-trainer (C%), PCC protocol fee (D%). Structurally identical to Audius artist/producer/label split. Implementation pattern (0xSplits, Gnosis Safe, or custom RoyaltyRouter) is well-understood.

**0xSplits.** Audius-like use cases typically use [0xSplits](https://splits.org/) under the hood — a battle-tested protocol for ERC-20 revenue distribution to `(address, weight_bps)` tuples.

**Fit for PCC: 4/5.** Audius itself doesn't add much over Ocean/Story, but the 0xSplits pattern is a direct integration target.

### 3.D Lens Protocol Collect

**Sources:** [Lens modules repo](https://github.com/lens-protocol/modules), [Content Creation docs](https://www.lens.xyz/docs/primitives/publications/content-creation), [Chainstack guide](https://chainstack.com/a-complete-guide-to-lens-protocol-a-decentralized-social-graph/).

**Model.** Publications = posts. Each publication has 2 modules: Collect Module (mints to NFT, monetizes) and Reference Module. Collect modules include: Free Collect, Fee Collect, Limited Fee Collect, Auction Collect.

**Referrals.** Collect modules support referral fees in basis points (each bp = 0.01%). A referrer who drove a collect gets a configurable cut.

**Fit for PCC: 2/5.** Lens is useful for social-graph features (PilotContributorNFT has a "followers" aspect?), but not a primary integration target for training-mix attribution.

---

## 4. Data Provenance + Content Addressing

### 4.A IPLD — InterPlanetary Linked Data

**Sources:** [IPLD home](https://ipld.io/), [spec repo](https://github.com/ipld/specs), [IPFS Merkle DAG docs](https://docs.ipfs.tech/concepts/merkle-dag/).

**Overview.** IPLD = data layer that IPFS is built on. Standards/formats for describing data in a content-addressing way. Decentralized data-structures that are universally addressable and linkable.

**Content Identifier (CID).** Identifying a data object by the hash of its value. Since the link IS the hash, you can always recompute and validate. Enables trustless p2p data exchange.

**Merkle DAG.** Each node's identifier = hash of (payload || child CIDs). Immutable — any change propagates up. Two nodes with the same CID represent exactly the same DAG, self-verifiably.

**Data model.** Booleans, integers, strings, nulls, byte arrays, lists, maps, and a native **link** primitive. Codecs: DAG-CBOR and DAG-JSON fully implement the Data Model.

**Fit for PCC: 5/5.** Ideal off-chain representation for PCC's TrainingManifest. Each manifest node:
```json
{
  "@type": "pcc.TrainingManifest/1",
  "model": {"standard": "pcc.ModelNFT", "chainId": 84532, "tokenId": 42},
  "parents": [
    {"model_cid": "<cid-of-parent-manifest>", "weight_bps": 7000},
    {"model_cid": "<cid-of-another-parent>", "weight_bps": 1000}
  ],
  "datasets": [
    {"dataset_nft_id": 101, "content_cid": "<cid>", "weight_bps": 1500, "license": "CC-BY-4.0"},
    {"dataset_nft_id": 207, "content_cid": "<cid>", "weight_bps": 500, "license": "OpenRAIL-M"}
  ],
  "license_summary": {...},
  "training_attestation": {"type": "tee-h100-cc", "quote_cid": "<cid>"},
  "trained_by_did": "did:ethr:0xabc...",
  "training_started_at": "2026-04-01T00:00:00Z",
  "training_completed_at": "2026-04-03T14:22:00Z"
}
```
This is a DAG: each parent is a CID-link. The on-chain TrainingManifest stores just the top-level CID; any verifier can recursively fetch through IPFS.

### 4.B C2PA — Coalition for Content Provenance and Authenticity

**Sources:** [C2PA.org](https://c2pa.org/), [Content Authenticity Initiative](https://contentauthenticity.org/how-it-works), [spec 2.2 PDF](https://spec.c2pa.org/specifications/specifications/2.2/specs/_attachments/C2PA_Specification.pdf).

**Consortium.** Adobe, Arm, BBC, Intel, Microsoft, Truepic (founders Feb 2021) + OpenAI, Google, Meta, Amazon, Sony, Publicis (added since). Royalty-free open specs.

**Mechanism.** C2PA Manifest = cryptographically signed metadata embedded IN the file. Records who made it, when, what tools, what source ingredients. Tampering breaks the signature.

**Assertions.** Manifests include:
- Content ingredients used (provenance chain)
- Date, time, location of production
- Device or software used

**Current status.** v2.2 published May 2025, v2.3 draft. Conformance Program launched. OpenAI uses C2PA on ChatGPT-generated images. Major camera manufacturers shipping C2PA-signed capture.

**Fit for PCC: 4/5.** C2PA's "ingredients" concept is structurally identical to PCC's training-mix: each ingredient has a hash + source + role. If a robotics dataset is captured through a C2PA-compliant camera, the DatasetNFT metadata can embed the C2PA manifest directly, inheriting cryptographic provenance from the hardware capture point. Strong story for evidence-grade datasets (Tier 2-3 jobs).

### 4.C W3C PROV Ontology

**Sources:** [W3C PROV Wikipedia](https://en.wikipedia.org/wiki/W3C_Prov), [PROV-FAQ](https://www.w3.org/2001/sw/wiki/PROV-FAQ).

**Core concepts.** entity / activity / agent. Past-tense relations:
- `prov:wasGeneratedBy` — entity was produced by an activity
- `prov:wasDerivedFrom` — one entity was influenced by another
- `prov:wasAttributedTo` — entity attributed to an agent
- `prov:used` — activity used an entity
- `prov:actedOnBehalfOf` — delegation between agents

**Data model + RDF + OWL2 ontology + XML schema.**

**Fit for PCC: 3/5.** Vocabulary maps perfectly:
- ModelNFT = `prov:Entity`
- Training-job = `prov:Activity`
- Trainer = `prov:Agent`
- `ModelNFT prov:wasDerivedFrom DatasetNFT` (for each dataset in training mix)
- `ModelNFT prov:wasDerivedFrom ParentModelNFT`
- `TrainingJob prov:used DatasetNFT`

Export TrainingManifest as PROV-compatible RDF for interop with academic provenance tooling.

### 4.D Ceramic Network

**Sources:** [How it works](https://ceramic.network/how-it-works), [FAQ](https://blog.ceramic.network/faq-ceramic-network/), [Ceramic review](https://research.nansen.ai/articles/ceramic-network-the-composable-data-network).

**Architecture.** Every piece of information = append-only log of commits (a "Stream"). Events organized into append-only logs; streams use IPLD to create a hash-linked chain with an immutable streamID.

**Mutable data.** Data on Ceramic is mutable — user's data can be updated in a series of commits. Each write requires user authorization. Writes are like blockchain bookkeeping, but content is mutable.

**DID integration.** Data events signed cryptographically by DIDs. DIDs controlled by any blockchain wallet. If you use a transferable DID, you can transfer ownership by transferring the DID.

**IPFS integration.** Event messages stored in IPFS using IPLD. All content stored in "smart documents" — append-only IPFS logs where each commit is signed by a DID and anchored in a blockchain for consensus.

**Fit for PCC: 4/5.** Perfect for **mutable** parts of a DatasetNFT / ModelNFT (e.g., "the dataset's quality metrics as more benchmarks run," "the model's current evaluation scores"). Keep the static manifest in IPLD (immutable CIDs); keep evolving metadata in a Ceramic stream referenced by the DatasetNFT. Gitcoin Passport already uses Ceramic for the same pattern.

### 4.E Arweave

**Sources:** [Arweave home](https://www.arweave.org/), [Quick guide](https://www.communitylabs.com/blog/quick-guide-to-permanent-storage-on-arweave), [Gemini explainer](https://www.gemini.com/cryptopedia/arweave-token-ar-coin-permaweb).

**Overview.** Global, permissionless hard drive for permanent data storage. Users pay one-time up-front fee; majority of fee goes into a decentralized pool earning interest to cover storage for 200+ years.

**Content-addressable.** Data retrieved by content, not location. "Blockweave" architecture (not conventional blockchain) — each new block connects with two previous blocks.

**Fit for PCC: 4/5.** Ideal for long-term storage of TrainingManifest JSON + DatasetNFT metadata where permanence matters more than mutability. Use Arweave for the final, signed, fixed manifest + IPFS for short-term active distribution. Tradeoff: Arweave up-front cost (currently ~$4/GB for 200+ years); IPFS is pay-per-pin (cheaper upfront). **Recommendation:** IPFS for active dev, Arweave for Tier 3 Sovereign-grade training evidence.

---

## 5. Training-Mix Encoding On-Chain (Synthesis)

Four alternatives, ordered from most-on-chain to most-off-chain:

**Option 1: Full on-chain array.**
```solidity
struct TrainingMix {
  address[] parentModels;
  uint256[] parentModelTokenIds;
  uint16[] parentWeightsBps;
  address[] datasets;
  uint256[] datasetTokenIds;
  uint16[] datasetWeightsBps;
  uint16 creatorWeightBps;
  uint16 protocolFeeBps;
}
```
Gas cost: high. Good for short mixes (<10 entries). Makes recursive traversal cheap because every ModelNFT already has its mix on-chain.

**Option 2: On-chain hash + off-chain manifest.**
```solidity
struct TrainingManifestCommit {
  bytes32 manifestHash;       // sha256 of canonical JSON
  string  manifestCid;        // IPFS CID (also Arweave tx-id optional)
  address[] topLevelParents;  // just direct parents, for cheap traversal
  uint16[] topLevelWeightsBps;
}
```
Gas cost: low. Traversal requires fetching manifest from IPFS (cheap, cacheable). Verification: if dispute arises, anyone re-hashes the off-chain manifest.

**Option 3: Recursive traversal with gas cap.**
- Each ModelNFT stores only its direct parents with weights.
- At settlement, RoyaltyRouter does BFS up to depth-3 (or gas-cap).
- Deeper ancestors get their share "dropped" or accumulated in a residual bucket that parents can claim manually.

**Option 4: Pre-computed flattened mix cache.**
- When a ModelNFT is minted, the protocol computes the flat (leaf-dataset, total_weight) list once and caches it.
- Cache updated if any ancestor model updates (rare).
- At settlement, iterate the cache, not the DAG.
- Gas: O(leaves), not O(depth × fanout).

**Recommendation: Option 2 + Option 4 hybrid.**
- Commit to IPFS manifest hash for full provenance (audit + dispute resolution).
- Pre-compute flattened (dataset, weight) list at mint-time and store on-chain as `LeafDataset[]`.
- Direct-parent traversal only for cases where an upstream model is re-paid.

### 5.A Recursive weight algebra

If ModelNFT M has parents P1(w1), P2(w2) and datasets D1(dw1), D2(dw2), and P1 has parents Q1(q1) and dataset DQ(qw), then the flattened mix of M is:

```
M.flat_datasets = [
  (D1, dw1),
  (D2, dw2),
  ... every dataset in P1.flat_datasets scaled by w1 ...
  ... every dataset in P2.flat_datasets scaled by w2 ...
]
```

In Solidity (pseudocode, off-chain helper):
```solidity
function flatten(uint256 modelId) public view returns (LeafDataset[] memory) {
    TrainingMix memory mix = trainingMix[modelId];
    LeafDataset[] memory result;

    for (uint i = 0; i < mix.datasets.length; i++) {
        result = _push(result, LeafDataset(mix.datasets[i], mix.datasetTokenIds[i], mix.datasetWeightsBps[i]));
    }
    for (uint i = 0; i < mix.parentModels.length; i++) {
        LeafDataset[] memory parentFlat = flatten(mix.parentModelTokenIds[i]);
        for (uint j = 0; j < parentFlat.length; j++) {
            result = _push(result, LeafDataset(
                parentFlat[j].dataset,
                parentFlat[j].tokenId,
                (parentFlat[j].weightBps * mix.parentWeightsBps[i]) / 10000
            ));
        }
    }
    return result;
}
```

Don't call this on-chain on every settlement. Call it **once at ModelNFT mint** (or on manual `recomputeFlatten(modelId)`) and store the result. Settlement becomes O(leaves).

### 5.B Worked example

ModelNFT M (diffusion policy). Training manifest:
- Parent: Llama-3-Robotics-8b (pretrained base), weight 70%
- Dataset A: Open-X-RT-1, weight 10%
- Dataset B: BridgeData-V2, weight 8%
- Dataset C: Pilot-teleop-session-2501, weight 5%
- Creator (trainer): 5%
- Protocol: 2%

Llama-3-Robotics-8b itself has TrainingManifest:
- Parent: Llama-3-8b-base (Meta), weight 85%
- Dataset D: OXE-full-mixture, weight 10%
- Creator (Anthropic-Robot-Lab): 5%

Flattened M:
- Llama-3-8b-base: 0.70 * 0.85 = 59.5%
- OXE-full-mixture (via Llama-3-Robotics-8b): 0.70 * 0.10 = 7.0%
- Anthropic-Robot-Lab creator: 0.70 * 0.05 = 3.5%
- Open-X-RT-1: 10%
- BridgeData-V2: 8%
- Pilot-teleop-session-2501: 5%
- M's own creator: 5%
- Protocol fee: 2%

Total: 100%. Settlement of $100 flows:
- Llama-3-8b-base DatasetNFT holder (Meta): $59.50
- OXE-full-mixture DatasetNFT holder (Google): $7.00
- Anthropic-Robot-Lab: $3.50
- Open-X-RT-1 DatasetNFT: $10.00
- BridgeData-V2 DatasetNFT: $8.00
- Pilot-teleop-session-2501 DatasetNFT (the pilot): $5.00
- M's creator: $5.00
- PCC protocol: $2.00

---

## 6. Dataset NFT Specifications

### 6.A EIP-7007 — Verifiable AI-Generated Content Token

**Sources:** [EIP-7007 spec](https://eips.ethereum.org/EIPS/eip-7007), [ERCs master](https://github.com/ethereum/ercs/blob/master/ERCS/erc-7007.md), [Magicians discussion](https://ethereum-magicians.org/t/eip-7007-zkml-aigc-nfts-an-erc-721-extension-interface-for-zkml-based-aigc-nfts/14216), [ORA docs](https://docs.ora.io/doc/initial-model-offering-imo/erc-7007-verifiable-ai-generated-content-token).

**Overview.** ERC-721 extension for AI-Generated Content NFTs with on-chain verification via zkML or opML.

**Core IERC7007 interface:**
```solidity
interface IERC7007 {
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
```

**Optional extensions.** `IERC7007Enumerable` (`tokenId(prompt)`, `prompt(tokenId)`), `IERC7007Updatable` (mutable aigcData).

**Token identity.** `tokenId = hash(prompt)` — deterministic, collision-resistant, prevents duplicate mints for the same prompt.

**Metadata JSON schema fields.** name, description, image URI, prompt text, aigc_type, aigc_data (resource URI), proof_type (zkML/opML).

**Fit for PCC: 4/5.** EIP-7007 is the right template for **PCC JobOutputNFT** (per-job artifact), not ModelNFT. When a PCC robot produces output using ModelNFT M, the output is wrapped as EIP-7007 NFT with `tokenId = hash(contract + model_commitment + job_id)`. Gives us:
- Cryptographic verification that output came from claimed model
- Natural hook for royalty distribution (NFT sale flows through RoyaltyRouter)
- Interop with downstream AIGC tooling

### 6.B EIP-7015 — NFT Creator Attribution

**Sources:** [EIP-7015 spec](https://eips.ethereum.org/EIPS/eip-7015), [Magicians discussion](https://ethereum-magicians.org/t/erc-7015-creator-attribution-for-erc721/14244), [indreams blog](https://indreams.mirror.xyz/-BZjILR6N2Hom52HREnQG5YzZAyV8W0OIHF-lF8jV7g), [RedLion](https://www.redlion.news/article/erc-7015-bridging-the-gap-for-nft-creator-attribution).

**Problem solved.** Platforms assume the wallet that submits the deploy transaction is the creator; not always true (collectors or intermediaries can deploy for the artist).

**Mechanism.** Creator signs EIP-712 message attesting to being the creator. Signed params + signature validated + emitted during deployment. Creator consent is the EIP-712 signature; anyone can deploy, but the emitted event binds the correct creator address.

**Fit for PCC: 4/5.** PCC wants "creator" (pilot who collected data, trainer who trained model) recorded on-chain even if the actual mint is done by a helper contract or relayer. Adopt EIP-7015 for DatasetNFT + ModelNFT so the attribution event is machine-indexable.

### 6.C EIP-7641 — Intrinsic RevShare Token (The "ModelNFT Shareholder" Pattern)

**Sources:** [EIP-7641 spec](https://eips.ethereum.org/EIPS/eip-7641), [ORA docs](https://docs.ora.io/doc/initial-model-offering-imo/erc-7641-intrinsic-revshare-token), [GitHub IMOLabs/ERC-7641](https://github.com/IMOLabs/ERC-7641).

**Overview.** ERC-20 extension with integrated revenue-sharing. Tokens intrinsically represent a share of a communal revenue pool.

**Core IERC7641 interface:**
```solidity
interface IERC7641 is IERC20 {
    function snapshot() external returns (uint256 snapshotId);
    function claimableRevenue(address account, uint256 snapshotId) external view returns (uint256);
    function claim(uint256 snapshotId) external;
    function redeemableOnBurn(uint256 amount) external view returns (uint256);
    function burn(uint256 amount) external;
}
```

**Mechanics.**
- `snapshot()` creates a checkpoint of balances.
- `claimableRevenue(account, snapshotId)` = account's proportional share of revenue accumulated between snapshots.
- `claim(snapshotId)` withdraws that share (one-shot per holder per snapshot).
- `redeemableOnBurn(amount)` = amount of ETH/USDC redeemable by burning `amount` of tokens = `(amount / totalSupply) * redeemablePool`.
- `burn(amount)` atomically burns tokens and redeems.

**Fit for PCC: 5/5.** This is the right primitive for **ModelNFT fractional ownership**. A ModelNFT has an associated ERC-7641 ShareToken; holders get pro-rata from every PCC job that uses the model. Two mental models:
- **ModelNFT (ERC-721)**: "who owns the IP, who sets license terms, who mints derivatives."
- **ModelShare (ERC-7641)**: "who gets the cash flow from usage."
The two can be bound via a token-bound-account pattern (§6.E) — the ModelNFT's TBA holds the ModelShare total supply; the ModelNFT owner can mint new shares (and dilute themselves).

### 6.D ERC-2981 — NFT Royalty Standard

**Source:** [EIP-2981 spec](https://eips.ethereum.org/EIPS/eip-2981).

**Interface:**
```solidity
interface IERC2981 is IERC165 {
    function royaltyInfo(uint256 _tokenId, uint256 _salePrice)
        external view returns (address receiver, uint256 royaltyAmount);
}
```

**Critical limitation.** Returns a *single* receiver. Multi-recipient royalties require an intermediary contract that receives + redistributes.

**Fit for PCC: 3/5.** Useful as the surface contract that marketplaces (OpenSea, etc.) call into. The returned `receiver` should be a PCC `RoyaltyRouter` contract that performs the full training-mix distribution. Not the distribution logic itself.

### 6.E ERC-6551 — Token Bound Accounts

**Sources:** [EIP-6551 spec](https://eips.ethereum.org/EIPS/eip-6551), [Quicknode guide](https://www.quicknode.com/guides/ethereum-development/nfts/how-to-create-and-deploy-an-erc-6551-nft), [thirdweb blog](https://blog.thirdweb.com/erc-6551-token-bound-accounts/), [OpenSea explanation](https://opensea.io/learn/token/what-is-erc-6551).

**Overview.** Assigns Ethereum accounts to all NFTs. Every NFT gets a smart-contract account (TBA) with its own address. TBA can hold ERC-20/ERC-721/ERC-1155/ETH and execute transactions.

**Architecture.** ERC-1167 proxy storing (salt, chainId, tokenContract, tokenId) as constant data. Ownership check: when NFT owner calls TBA, account verifies caller owns parent NFT. If NFT transfers, TBA control transfers too.

**Fit for PCC: 5/5.** Every DatasetNFT + ModelNFT gets a TBA that:
- Holds accumulated royalties (DatasetNFT receives USDC; owner withdraws).
- Holds the dataset's access-token supply (DatasetAccessToken master supply sits in DatasetNFT's TBA; the DatasetNFT's owner controls access-token minting).
- Holds the ModelNFT's ShareToken supply (ERC-7641 fractional).
- Can sign attestations (for dispute responses).

This is exactly how Story Protocol's IPAccount works.

---

## 7. License Compatibility + Revenue Share

### 7.A OpenRAIL / OpenRAIL-M

**Sources:** [HF OpenRAIL blog](https://huggingface.co/blog/open_rail), [RAIL FAQ](https://www.licenses.ai/faq-2), [BigCode OpenRAIL-M](https://www.bigcode-project.org/docs/pages/bigcode-openrail/), [GitLab analysis](https://about.gitlab.com/blog/rail-m-is-an-imperfectly-good-start-for-ai-model-licenses/).

**Model.** RAIL = Responsible AI Licenses. OpenRAIL = open subfamily. OpenRAIL-M = model variant.

**Mechanism.** Royalty-free open access + usage restrictions (no weapons, no disinformation, no deepfakes, etc.). Restrictions propagate to derivatives: "downstream adoption of the use-based restrictions by subsequent re-distribution and derivatives."

**Examples.** BigScience BLOOM (first OpenRAIL-M), StarCoder (BigCode OpenRAIL-M), many Stability AI models.

**Fit for PCC: 3/5.** No royalty built in (open access = zero cost). But **derivative-propagation** pattern is instructive. Define our own license taxonomy (commercial-unlimited / commercial-capped-royalty / research-only / derivatives-must-share) as a fixed enum on-chain, with each license's rules enforced by a policy contract.

### 7.B Creative Commons ShareAlike + Hippocratic License (summary)

**CC-BY-SA.** Derivatives must be licensed under the same terms. "Viral" — if a dataset is CC-BY-SA, a model trained on it must also be CC-BY-SA. Serious consequence for PCC: if a DatasetNFT has CC-BY-SA, any ModelNFT including it is viral-licensed. License-compatibility check at TrainingManifest minting becomes critical.

**Hippocratic License.** Prohibits use that violates UN Declaration of Human Rights. Non-commercial-by-default-ish; stricter than OpenRAIL.

**License-composition rule (PCC proposal):**
- Strictest license among all inputs propagates to outputs.
- License compatibility is checked at mint time (on-chain policy contract).
- PCC licensing tiers: `UNRESTRICTED` > `COMMERCIAL_ROYALTY` > `RESEARCH_ONLY` > `DERIVATIVES_SHARE_ALIKE` > `PROHIBITED`.

---

## 8. Identity for Pilots + Trainers

### 8.A Gitcoin Passport (Human Passport)

**Sources:** [Gitcoin Passport](https://go.gitcoin.co/passport), [Decentralised.co](https://www.decentralised.co/p/passport-please), [Ceramic blog](https://blog.ceramic.network/gitcoin-builds-passport-on-ceramic/), [Human Passport on Base](https://thedefiant.io/news/security/sybil-resistance-tool-human-passport-launches-new-features-for-base).

**Thesis.** Sybil defense + decentralized identity aggregator. Users collect "stamps" from Web2 (Google, Twitter, LinkedIn) + Web3 (ENS, GitHub) to prove humanity. Each stamp has weight 1-7+ (easy-to-sybil vs hard-to-sybil).

**Privacy.** Passport stores only Ethereum DID + Verifiable Credentials (VCs). Uses Ceramic for credential storage → portable across apps.

**Status.** Score threshold: 20 to be "verifiably human." Integrated with EthStaker, Bankless Academy, Snapshot, Guild. Rebranded Human Passport; launched on Base.

**Fit for PCC: 5/5.** PCC pilots need sybil resistance to prevent one human spinning up 100 pilot identities to pad training data. Minimum Passport score (e.g., ≥15) required before a user can mint a PilotContributorNFT. No KYC required — just raises the sybil bar. Free, open-source hosted tooling.

### 8.B did:ethr / ERC-1056 + ERC-4361 SIWE

**Sources:** [ERC-4361 spec](https://eips.ethereum.org/EIPS/eip-4361), [login.xyz SIWE](https://docs.login.xyz/general-information/siwe-overview/eip-4361), [ethr-did-resolver](https://github.com/decentralized-identity/ethr-did-resolver), [ERC-1056](https://eips.ethereum.org/EIPS/eip-1056).

**did:ethr.** DID method using Ethereum addresses or secp256k1 public keys as identifiers. Conforms to ERC-1056 ("Ethereum Lightweight Identity"). Registry smart contract facilitates public key resolution for off-chain and on-chain authentication, plus key rotation, delegate assignment, and revocation.

**ERC-4361 Sign-In With Ethereum (SIWE).** Standardized message signing for authentication. Message fields: Ethereum address, domain, version, chain ID, URI, nonce, issued-at timestamp. Server verifies signature.

**Finalization status.** ERC-4361 finalized 2025.

**Fit for PCC: 5/5.** PCC already uses SIWE at `/api/auth/nonce` + `/api/auth/verify`. For the contributor economy, extend:
- Every PilotContributor / Trainer / DatasetOwner authenticated via SIWE.
- Canonical identity = `did:ethr:<chainId>:<address>`.
- DatasetNFT / ModelNFT metadata embeds `trained_by_did` / `collected_by_did` for human-readable attribution.

### 8.C ERC-725 / ERC-735 Claims (summary)

ERC-725 is the "Proxy Identity" standard. ERC-735 is the "Claim Holder" standard. Together, they let an on-chain identity hold signed claims about itself (e.g., "this address completed KYC with provider X"). More heavyweight than Gitcoin Passport but more composable.

**Fit for PCC: 3/5.** Useful if PCC eventually wants on-chain KYC for Tier 3 pilots (sovereign-grade jobs). Not needed for MVP.

---

## 9. Training Attestation

### 9.A zkML — Zero-Knowledge Machine Learning

**Sources:** [ICME guide](https://blog.icme.io/the-definitive-guide-to-zkml-2025/), [Kudelski primer](https://kudelskisecurity.com/modern-ciso-blog/zkml-verifiable-machine-learning-using-zero-knowledge-proof), [World guide](https://world.org/blog/engineering/intro-to-zkml), [awesome-zkml](https://github.com/worldcoin/awesome-zkml), [EZKL benchmarks](https://blog.ezkl.xyz/post/benchmarks/), [1kx](https://medium.com/1kxnetwork/zkml-evolving-the-intelligence-of-smart-contracts-through-zero-knowledge-cryptography-e6725412bbd1).

**Frameworks.**
- **EZKL** — Halo2-based, converts ONNX models to zk-SNARK circuits. Most production-ready.
- **Modulus Labs** — "The Cost of Intelligence" benchmarks, on-chain ML verification.
- **Giza** — Starknet-based, LuminAIR (STWO prover), used by Yearn for verifiable yield strategies.
- **RISC Zero zkVM** — general-purpose; can prove arbitrary Rust.

**Capabilities.** Prove "this inference came from model with weights W on input X, yielding output Y" without revealing W or X.

**Limitations (as of 2025).**
- Proving cost for large transformers: hours to days.
- SNARK circuit size limits: small-to-medium models only (< 1B params typically).
- Precision: requires quantization (fp8/int8) — some accuracy loss.

**Fit for PCC: 3/5 (inference) / 2/5 (training).**
- zkML for inference is practical for small models (e.g., quality-control classifiers < 100M params).
- zkML for training (proving "I trained this model on those datasets") is experimental and largely infeasible for deep networks.

### 9.B ORA — opML (Optimistic Machine Learning) + IMO

**Sources:** [ORA OAO docs](https://docs.ora.io/doc/onchain-ai-oracle-oao/onchain-ai-oracle), [opML spec](https://docs.ora.io/doc/onchain-ai-oracle-oao/fraud-proof-virtual-machine-fpvm-and-frameworks/opml), [GitHub ora-io/OAO](https://github.com/ora-io/OAO), [opML README](https://github.com/ora-io/opml/blob/main/docs/OPML.md), [IMO Overview](https://docs.ora.io/doc/initial-model-offering-imo/imo-overview).

**opML thesis.** Fraud-proof ML, similar to optimistic rollups. Service provider runs ML offchain, submits result + commitment. Validators have a challenge period to dispute. Single honest validator ensures correctness.

**Advantages over zkML.**
- Runs ANY size model (LLaMA 3, Stable Diffusion) without prohibitive proving cost.
- ~100x cheaper than zkML.
- Challenge period is hours, not milliseconds — real-time availability with delayed finality.

**IMO — Initial Model Offering.** ORA's tokenization pattern. Combines:
1. opML-verified on-chain AI models.
2. ERC-7641 RevShare Token (§6.C).
3. ERC-7007 AIGC NFT (§6.A) for model outputs.

Holders earn via:
- **Model Usage Fees.** Each onchain use of the model involves a fee, distributed proportionally to token holders.
- **AIGC Revenue.** Outputs minted as ERC-7007 NFTs; their sale revenue flows back to ERC-7641 holders.

**Fit for PCC: 5/5.** IMO is the **closest existing analog to PCC ModelNFT**. Three direct adoptions:
- ERC-7641 for ModelShare (fractional ownership).
- ERC-7007 for JobOutputNFT (each robot job produces a verifiable output).
- opML for inference verification (Tier 1-2 jobs).

### 9.C Phala Network — TEE Attestation

**Sources:** [Phala docs](https://docs.phala.com/network/overview/phala-network), [GPU TEE deep dive](https://phala.com/posts/Phala-GPU-TEE-Deep-Dive), [Beyond SGX](https://phala.com/posts/beyond-sgx-embracing-gpu-tee-for-decentralized-ai-dagi), [WireTap response](https://phala.com/posts/response-to-wiretap-sgx-deprecation), [TEE primer](https://phala.com/learn/What-Is-TEE).

**Model.** "Don't Trust, Verify." TEE-based confidential compute with Remote Attestation — user can remotely verify hardware + software running in the Secure Enclave.

**Hardware stack (2025).**
- Intel SGX (deprecating post-WireTap).
- **Intel TDX** (VM-level TEE, current gen).
- **AMD SEV-SNP**.
- **NVIDIA H100/H200 Confidential Computing** (GPU TEE — critical for ML).

**Properties.** Confidentiality (memory encrypted), execution integrity (tamper-evident), remote attestation (verifiable from outside).

**Fit for PCC: 5/5 — this is the right path for training attestation in 2026.**
- H100 Confidential Computing allows a trainer to prove "this ModelNFT was produced from a training run over these DatasetNFTs, inside an attested H100 enclave." Quote is on-chain-verifiable.
- Integration: add a TEE-attested `training_quote_cid` field to TrainingManifest. Verifier contract verifies the quote on-chain (Phala provides this).
- ORA also supports TEE-based AI attestation in newer versions.

### 9.D Recommended tier plan

| Tier | Training attestation | Inference attestation | When |
|---|---|---|---|
| MVP | Trust-based — trainer self-reports training mix; dispute module slashes for proven lies | None | Q2 2026 |
| v2 | TEE-attested training on H100 CC (Phala, AWS Nitro, Azure CC). Quote committed to manifest. | opML (ORA-style) for output verification. | Q3 2026 |
| v3 | zkML for small models. Continued TEE for large. | zkML for critical inference paths. | 2027 |

---

## 10. Existing Robotics-Data Economy Projects

### 10.A FrodoBots / BitRobot Network

**Sources:** [FrodoBots-2K on HF](https://huggingface.co/datasets/frodobots/FrodoBots-2K), [Chain of Thought](https://chainofthought.xyz/p/the-robot-are-coming-frodobots), [Fabric Ventures](https://medium.com/fabric-ventures/in-pursuit-of-embodied-agi-d7f47f624ebd), [Defiant](https://thedefiant.io/news/press-releases/frodobots-lab-raises-8m-to-launch-bitrobot-a-crypto-network-of-subnets-for-embodied-ai-research), [FrodoBots AI](https://www.frodobots.ai/), [EarthRover Mini Plus on HF](https://huggingface.co/docs/lerobot/en/earthrover_mini_plus).

**Overview.** FrodoBots crowdsources teleoperation data by gaming ($250 sidewalk robots, browser remote-control). FrodoBots-2K dataset: 2000 hours, 10+ cities, camera + GPS + IMU + audio + human control.

**BitRobot Network.** $8M seed. Solana (not Bittensor — borrows subnet model). Subnets for different embodied AI tasks: Subnet 1 = navigation data, Subnet 2 = autonomous model contests.

**Attribution.** Dataset is CC-BY-esque on HF Hub. No on-chain royalty flow. Token rewards go to pilots for teleop sessions, not recurring from downstream model usage.

**Gap FrodoBots doesn't fill.** Recursive attribution from *model usage* back to *pilot who collected data*. Their flow is: pilot plays → gets paid once → data is licensed CC-BY → anyone can train on it for free. **PCC's flow is superior.**

**Fit for PCC: 5/5 — as a customer.** PCC can onboard BitRobot as a dataset source: BitRobot-aggregated data becomes a DatasetNFT, and the single NFT redistributes to pilots via BitRobot's internal ledger. PCC supplies the downstream royalty layer that BitRobot lacks.

### 10.B Sahara AI

**Sources:** [CoinMarketCap](https://coinmarketcap.com/currencies/sahara-ai/), [Sahara docs tokenomics](https://docs.saharaai.com/tokenomics), [Sahara blog token](https://saharaai.com/blog/sahara-token), [BingX](https://bingx.com/en/learn/article/what-is-sahara-ai-decentralized-ai-blockchain), [Messari](https://messari.io/project/sahara).

**Overview.** L1 blockchain for AI. Four platforms:
1. Data Services Platform (DSP) — data labeling marketplace; contributors earn SAHARA tokens per task.
2. AI Developer Platform.
3. AI Marketplace.
4. Sahara Blockchain (the L1).

**Attribution.** "Every contribution recorded on-chain" / "fair revenue sharing and transparent attribution."

**Tokenomics.** 10B total supply. 64%+ to community.

**Fit for PCC: 3/5.** Sahara's attribution story is marketed well but technical details on recursive royalty flow are not clearly published. PCC should aim for a **more concrete, auditable** training-manifest story with Solidity-verifiable royalty flow (not just "transactions recorded on chain"). Sahara is a potential cross-chain partner: PCC DatasetNFT could be listed on the Sahara AI Marketplace.

### 10.C 1X / Tesla Optimus / Physical Intelligence / Skild AI

**Sources:** [Skild AI raise coverage](https://www.webpronews.com/the-quiet-rise-of-skild-ai-how-a-robot-data-startup-just-raised-60-million-to-build-the-brain-for-every-machine/), [Sacra profile](https://sacra.com/c/skild-ai/), [Contrary Research](https://research.contrary.com/company/skild-ai), [skild.ai](https://www.skild.ai/), [robotics history](https://github.com/adam-maj/robotics), [NVIDIA Skild case study](https://www.nvidia.com/en-us/case-studies/skild-ai/), [Tesla Optimus Wikipedia](https://en.wikipedia.org/wiki/Optimus_(robot)).

**Physical Intelligence (π).** $400M raised. Open-source base model (PI-1) strategy. Could commoditize the foundation layer.

**Skild AI.** Proprietary sim stack + internet videos + real-world experiences ("omni-bodied model"). Claims near-infinitely-scalable data. Data sources: simulation + scraped internet video + teleop.

**Tesla Optimus.** Proprietary AI + hardware. Data from Tesla Autopilot fleet's vision system, repurposed for embodiment.

**1X.** Norwegian, OpenAI-backed. Testing NEO, EVE in commercial settings.

**Common pattern.** All four are vertically-integrated — they own robot + data + model + deployment. None do on-chain attribution or external dataset royalties. **This is the moat PCC disrupts.** Smaller labs and independent pilots can't access Tesla's fleet data. PCC lets them mint DatasetNFTs and participate in the downstream robotics model economy on equal footing.

**Fit for PCC: 3/5 (not targets for integration — they're competitors / customers eventually).**

---

## 11. Recommendation: PCC DatasetNFT + ModelNFT + TrainingManifest Architecture

### 11.A Overview

Three NFT standards + one router + one policy contract + an off-chain manifest.

```
     ┌─────────────────────────────────────────────────────────────┐
     │                  Off-chain (IPFS + Arweave)                 │
     │  DatasetManifest.json, ModelManifest.json (DAG-CBOR IPLD)   │
     └──────────────────────┬──────────────────────────────────────┘
                            │ content hash
                            v
┌─────────────────────┬───────────────────┬──────────────────────┐
│  DatasetNFT (721)   │   ModelNFT (721)  │  JobOutputNFT (7007) │
│  + AccessToken (20) │   + Share (7641)  │  zkML/opML verified  │
│  + TBA (6551)       │   + TBA (6551)    │  per-job outputs     │
└──────────┬──────────┴─────────┬─────────┴──────────┬───────────┘
           │                    │                    │
           │  TrainingManifest  │                    │
           │  (on-chain commit) │                    │
           └────────┬───────────┘                    │
                    │                                │
              ┌─────▼────────────────────────────────▼──────────┐
              │  RoyaltyRouter (settles from MilestoneEscrow)    │
              │  - walks flattened training-mix                  │
              │  - pays DatasetNFT TBAs + ModelShare holders     │
              │  - takes protocol fee                            │
              └──────────────────────────────────────────────────┘
                                   ^
                                   │ settlement event
                                   │
         ┌─────────────────────────┴─────────────────────────┐
         │  MilestoneEscrow (existing PCC contract on Base)  │
         │  pays when assurance tier + evidence met          │
         └───────────────────────────────────────────────────┘
```

### 11.B DatasetNFT (Solidity pseudocode)

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC2981} from "@openzeppelin/contracts/interfaces/IERC2981.sol";
import {IERC7015} from "./interfaces/IERC7015.sol";

/**
 * @title DatasetNFT
 * @notice Represents a robotics training dataset.
 *   ERC-721 ownership; off-chain manifest via CID; royalty to TBA.
 *   Extends ContributorNFT — identifies the pilot/institution that collected it.
 */
contract DatasetNFT is ERC721, IERC2981, IERC7015 {
    // ── Dataset-specific metadata ────────────────────────────────
    struct DatasetMeta {
        string  manifestCid;       // IPFS CID of canonical manifest JSON
        bytes32 manifestHash;      // sha256 of canonical manifest (for verification)
        string  contentCid;        // IPFS CID of the actual trajectory data (or nil if off-Hub)
        uint64  episodeCount;      // number of robot episodes
        uint64  totalFrames;       // total observation frames
        bytes32 modalitiesBitmap;  // bitfield: image/depth/audio/proprioception/force/…
        string  hfRepoId;          // optional: "user/repo" on HuggingFace Hub
        bytes32 hfRevisionSha;     // optional: git SHA of HF revision
        string  arweaveTxId;       // optional: permanent storage tx
        uint16  licenseCode;       // PCC license enum (see §11.G)
        string  licenseUri;        // external link to full legal text
        address collectedBy;       // DID address (did:ethr:0x…) of pilot/institution
        uint64  collectedAt;       // timestamp
        bytes32 c2paManifestHash;  // optional: C2PA content-credentials hash
    }

    mapping(uint256 => DatasetMeta)  public meta;
    mapping(uint256 => address)      public accessTokenFor;   // datatoken per dataset
    mapping(uint256 => address)      public tbaFor;           // ERC-6551 TBA per dataset
    mapping(uint256 => uint96)       public defaultRoyaltyBps; // e.g., 500 = 5%

    uint16 public constant LIC_UNRESTRICTED      = 0;
    uint16 public constant LIC_COMMERCIAL_ROY    = 1;
    uint16 public constant LIC_RESEARCH_ONLY     = 2;
    uint16 public constant LIC_SHARE_ALIKE       = 3;
    uint16 public constant LIC_CUSTOM            = 99;

    event DatasetMinted(uint256 indexed tokenId, address indexed collectedBy, string manifestCid);
    event AccessTokenAttached(uint256 indexed tokenId, address indexed accessToken);

    function mint(address to, DatasetMeta calldata m, bytes calldata creatorSig)
        external returns (uint256 tokenId)
    {
        // ERC-7015: verify creatorSig = EIP-712 sign(collectedBy, m)
        require(_verifyCreatorAttestation(m.collectedBy, m, creatorSig), "bad-creator-sig");

        tokenId = uint256(keccak256(abi.encode(m.manifestHash, m.collectedBy)));
        _safeMint(to, tokenId);
        meta[tokenId] = m;

        // Deploy ERC-6551 TBA for royalty collection
        tbaFor[tokenId] = TBARegistry.createAccount(address(this), tokenId);

        emit CreatorAttribution(tokenId, m.collectedBy, creatorSig);
        emit DatasetMinted(tokenId, m.collectedBy, m.manifestCid);
    }

    // Attach an ERC-20 DatasetAccessToken for permissioned training runs.
    function attachAccessToken(uint256 tokenId, address accessToken) external {
        require(ownerOf(tokenId) == msg.sender, "not-owner");
        accessTokenFor[tokenId] = accessToken;
        emit AccessTokenAttached(tokenId, accessToken);
    }

    // ── ERC-2981 royaltyInfo ──────────────────────────────────────
    function royaltyInfo(uint256 tokenId, uint256 salePrice)
        external view override returns (address, uint256)
    {
        // Route to PCC RoyaltyRouter which handles multi-recipient
        return (royaltyRouter, (salePrice * defaultRoyaltyBps[tokenId]) / 10000);
    }
}
```

### 11.C ModelNFT (Solidity pseudocode)

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC2981} from "@openzeppelin/contracts/interfaces/IERC2981.sol";
import {IERC7641} from "./interfaces/IERC7641.sol";

/**
 * @title ModelNFT
 * @notice Represents a trained AI model used by PCC robots.
 *   ERC-721 ownership. Optional ERC-7641 ShareToken for fractional ownership.
 *   Holds an on-chain TrainingManifest commitment + flattened royalty leaf list.
 */
contract ModelNFT is ERC721, IERC2981 {
    struct ModelMeta {
        string  manifestCid;        // IPFS CID of full manifest
        bytes32 manifestHash;       // sha256 of canonical manifest
        string  weightsCid;         // IPFS/Arweave pointer to actual weights (or nil if private)
        string  hfModelRepo;        // e.g., "pcc/robotics-policy-v1"
        bytes32 hfModelRevision;    // HF git SHA
        uint16  licenseCode;        // PCC license enum
        address trainedBy;          // DID address of trainer
        uint64  trainedAt;
        uint32  architectureCode;   // e.g., "diffusion-policy", "act", "rt-2"
        uint64  paramsCount;        // in millions
        uint32  attestationType;    // 0=trust, 1=opml, 2=tee-h100, 3=zkml
        string  attestationQuoteCid; // IPFS CID of attestation quote (if any)
    }

    struct TrainingManifest {
        // Direct parents (for cheap upstream propagation)
        address[] parentModels;
        uint256[] parentModelTokenIds;
        uint16[]  parentWeightsBps;

        address[] datasets;
        uint256[] datasetTokenIds;
        uint16[]  datasetWeightsBps;

        // Economic allocation: creator + protocol (remainder = pay-through)
        uint16    creatorWeightBps;
        uint16    protocolWeightBps;
    }

    struct LeafDataset {
        address dataset;
        uint256 tokenId;
        uint16  effectiveWeightBps; // already flattened from DAG
    }

    mapping(uint256 => ModelMeta)         public meta;
    mapping(uint256 => TrainingManifest)  public manifestOf;
    mapping(uint256 => LeafDataset[])     public flattenedMix; // pre-computed at mint
    mapping(uint256 => address)           public shareTokenOf; // ERC-7641 fractional
    mapping(uint256 => address)           public tbaFor;       // ERC-6551 TBA

    event ModelMinted(uint256 indexed tokenId, address indexed trainedBy, string manifestCid);
    event ManifestCommitted(uint256 indexed tokenId, bytes32 manifestHash);
    event FlattenedMixComputed(uint256 indexed tokenId, uint256 leafCount);

    function mint(
        address to,
        ModelMeta calldata mm,
        TrainingManifest calldata tm,
        bytes calldata creatorSig
    ) external returns (uint256 tokenId) {
        // Weight sanity: sum must equal 10000 exactly
        _verifyWeightsSum(tm);

        // License composition: the output license = strictest-of-all-inputs
        _verifyLicenseCompatibility(mm, tm);

        // Verify creator attestation (ERC-7015)
        require(_verifyCreatorAttestation(mm.trainedBy, mm, creatorSig), "bad-creator-sig");

        tokenId = uint256(keccak256(abi.encode(mm.manifestHash, mm.trainedBy)));
        _safeMint(to, tokenId);
        meta[tokenId] = mm;
        manifestOf[tokenId] = tm;

        tbaFor[tokenId] = TBARegistry.createAccount(address(this), tokenId);

        // Pre-compute flattened training mix (O(depth × fanout) once)
        _computeAndStoreFlattenedMix(tokenId);

        emit ModelMinted(tokenId, mm.trainedBy, mm.manifestCid);
        emit ManifestCommitted(tokenId, mm.manifestHash);
    }

    function deployShareToken(uint256 tokenId, string calldata name, string calldata symbol, uint256 totalSupply)
        external returns (address)
    {
        require(ownerOf(tokenId) == msg.sender, "not-owner");
        require(shareTokenOf[tokenId] == address(0), "already-deployed");
        // Deploy an ERC-7641 contract; total supply goes to ModelNFT's TBA.
        // Owner can then distribute/sell shares via the TBA.
        address share = ShareTokenFactory.deploy(tokenId, name, symbol, totalSupply, tbaFor[tokenId]);
        shareTokenOf[tokenId] = share;
        return share;
    }

    function _computeAndStoreFlattenedMix(uint256 tokenId) internal {
        TrainingManifest memory tm = manifestOf[tokenId];
        LeafDataset[] storage flat = flattenedMix[tokenId];

        // Direct datasets
        for (uint i = 0; i < tm.datasets.length; i++) {
            flat.push(LeafDataset(tm.datasets[i], tm.datasetTokenIds[i], tm.datasetWeightsBps[i]));
        }

        // Recurse into parent models
        for (uint i = 0; i < tm.parentModels.length; i++) {
            LeafDataset[] memory parentFlat = ModelNFT(tm.parentModels[i]).getFlattenedMix(tm.parentModelTokenIds[i]);
            uint16 parentWeight = tm.parentWeightsBps[i];

            for (uint j = 0; j < parentFlat.length; j++) {
                // Scale each parent leaf by parent's contribution
                uint16 scaled = uint16(uint256(parentFlat[j].effectiveWeightBps) * parentWeight / 10000);
                flat.push(LeafDataset(parentFlat[j].dataset, parentFlat[j].tokenId, scaled));
            }
        }

        emit FlattenedMixComputed(tokenId, flat.length);
    }

    function getFlattenedMix(uint256 tokenId) external view returns (LeafDataset[] memory) {
        return flattenedMix[tokenId];
    }
}
```

### 11.D RoyaltyRouter (Solidity pseudocode)

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title RoyaltyRouter
 * @notice Settles PCC job revenue through a ModelNFT's flattened training mix.
 *   Called by MilestoneEscrow on tier-met release, or by NFT marketplaces via ERC-2981.
 *   Pull-payment pattern (users claim their share).
 */
contract RoyaltyRouter {
    ModelNFT   public immutable modelNFT;
    DatasetNFT public immutable datasetNFT;
    IERC20     public immutable usdc;
    address    public immutable protocolTreasury;
    uint16     public constant  PROTOCOL_FEE_BPS = 235; // 2.35% existing PCC fee

    mapping(address => uint256) public pendingWithdrawals;

    event Routed(uint256 indexed modelTokenId, uint256 totalAmount);
    event Withdrew(address indexed to, uint256 amount);

    function routeModelRevenue(uint256 modelTokenId, uint256 totalAmount) external {
        require(msg.sender == address(milestoneEscrow) || msg.sender == allowedMarketplace, "unauthorized");

        // Pull USDC in (caller must have approved)
        usdc.transferFrom(msg.sender, address(this), totalAmount);

        ModelNFT.LeafDataset[] memory mix = modelNFT.getFlattenedMix(modelTokenId);
        ModelNFT.TrainingManifest memory tm = modelNFT.manifestOf(modelTokenId);

        uint256 creatorAmt  = (totalAmount * tm.creatorWeightBps) / 10000;
        uint256 protocolAmt = (totalAmount * tm.protocolWeightBps) / 10000;
        uint256 poolAmt     = totalAmount - creatorAmt - protocolAmt;

        // Creator (owner of the ModelNFT's TBA)
        address creator = modelNFT.tbaFor(modelTokenId);
        pendingWithdrawals[creator] += creatorAmt;

        // Protocol fee
        pendingWithdrawals[protocolTreasury] += protocolAmt;

        // Distribute pool through flattened mix
        for (uint i = 0; i < mix.length; i++) {
            address dsTba = datasetNFT.tbaFor(mix[i].tokenId);
            // effectiveWeightBps is over 10000 (against the full totalAmount)
            // BUT we're only distributing poolAmt, so renormalize against (10000 - creator - protocol)
            uint256 share = (poolAmt * mix[i].effectiveWeightBps) / (10000 - tm.creatorWeightBps - tm.protocolWeightBps);
            pendingWithdrawals[dsTba] += share;
        }

        emit Routed(modelTokenId, totalAmount);
    }

    function withdraw() external {
        uint256 amt = pendingWithdrawals[msg.sender];
        require(amt > 0, "nothing");
        pendingWithdrawals[msg.sender] = 0;
        usdc.transfer(msg.sender, amt);
        emit Withdrew(msg.sender, amt);
    }
}
```

### 11.E TrainingManifest off-chain schema (canonical JSON)

```json
{
  "@context": ["https://schema.pcc.xyz/training/v1", "https://www.w3.org/ns/prov"],
  "@type": "pcc:TrainingManifest",
  "specVersion": "1.0.0",
  "model": {
    "nft": {"chainId": 84532, "contract": "0x...", "tokenId": 42},
    "name": "pcc/robotics-diffusion-policy-v1",
    "architecture": "diffusion-policy",
    "paramsCount": 350000000,
    "weightsCid": "bafkreid...",
    "hfRepo": "pcc/robotics-diffusion-policy-v1",
    "hfRevision": "0123456789abcdef0123456789abcdef01234567"
  },
  "parents": [
    {
      "modelNft": {"chainId": 84532, "contract": "0x...", "tokenId": 7},
      "manifestCid": "bafkrei...",
      "weight_bps": 7000,
      "relation": "prov:wasDerivedFrom"
    }
  ],
  "datasets": [
    {
      "datasetNft": {"chainId": 84532, "contract": "0x...", "tokenId": 101},
      "manifestCid": "bafkrei...",
      "weight_bps": 1000,
      "license": "CC-BY-4.0",
      "relation": "prov:used"
    },
    {
      "datasetNft": {"chainId": 84532, "contract": "0x...", "tokenId": 207},
      "manifestCid": "bafkrei...",
      "weight_bps": 800,
      "license": "OpenRAIL-M",
      "relation": "prov:used"
    }
  ],
  "economics": {
    "creatorWeightBps": 500,
    "protocolWeightBps": 200
  },
  "licensing": {
    "outputLicense": "PCC:COMMERCIAL_ROYALTY",
    "compatibilityVerified": true
  },
  "attestation": {
    "type": "tee-h100-cc",
    "quoteCid": "bafkrei...",
    "attestedAt": "2026-04-03T14:22:00Z",
    "attestor": "did:ethr:84532:0x..."
  },
  "provenance": {
    "trainedBy": "did:ethr:84532:0x...",
    "trainedByPassportScore": 17.2,
    "trainingStartedAt": "2026-04-01T00:00:00Z",
    "trainingCompletedAt": "2026-04-03T14:22:00Z",
    "computeCost_USDC": "1234.56"
  },
  "verification": {
    "canonicalization": "jcs",
    "hashAlgo": "sha256",
    "manifestHash": "0x..."
  }
}
```

### 11.F License Composition Rule (on-chain enum)

```solidity
enum LicenseCode {
  UNRESTRICTED      = 0,
  COMMERCIAL_ROY    = 1,  // commercial use requires royalty
  RESEARCH_ONLY     = 2,
  SHARE_ALIKE       = 3,  // derivatives must match
  PROHIBITED        = 99
}

// The output license = STRICTEST-of-all-inputs
function composeLicense(LicenseCode[] memory inputs) internal pure returns (LicenseCode) {
    LicenseCode worst = LicenseCode.UNRESTRICTED;
    for (uint i = 0; i < inputs.length; i++) {
        if (inputs[i] > worst) worst = inputs[i];
    }
    return worst;
}
```

### 11.G Verification Tier Plan

| Tier | Policy | Implementation | When |
|---|---|---|---|
| MVP | Trust + dispute | Trainer posts TrainingManifest + weights claim; Dispute module slashes bond on proven lie. No attestation. | Q2 2026 |
| v2 | TEE-attested training | Integrate Phala / AWS Nitro / Azure H100 Confidential Computing. Manifest includes quote CID. On-chain quote verifier. | Q3 2026 |
| v3 | zkML for critical inference | EZKL / ORA opML for Tier 3 Sovereign jobs. Dataset inclusion ZK proofs research. | 2027+ |

### 11.H ContributorNFT Integration

PCC already has a `ContributorNFT` concept in the contributor-economics branch. **DatasetNFT is a subtype of ContributorNFT.** Concretely:

```solidity
interface IContributorNFT {
    enum ContributorType { PILOT, TRAINER, DATASET, RATE_SCHEDULE, SERVICE_PROVIDER }
    function contributorType(uint256 tokenId) external view returns (ContributorType);
    function principalAccount(uint256 tokenId) external view returns (address); // ERC-6551 TBA
}

contract DatasetNFT is ERC721, IContributorNFT {
    function contributorType(uint256) external pure returns (ContributorType) {
        return ContributorType.DATASET;
    }
    function principalAccount(uint256 tokenId) external view returns (address) {
        return tbaFor[tokenId];
    }
}
```

The existing **RateSchedule** (which is ContributorType.RATE_SCHEDULE) already routes recurring revenue to ContributorNFT TBAs. DatasetNFT slots in naturally.

### 11.I Minimal on-chain footprint

Storage cost of a ModelNFT with a typical mix (2 parents + 5 datasets + flattened to ~15 leaves):
- ModelMeta: ~400 bytes (1 SSTORE for hash/cid pair, a few for strings)
- TrainingManifest: ~2 × (3 addresses + 3 × 256-bit tokens + 3 × uint16 weights) = ~400 bytes
- FlattenedMix (15 leaves × 20 bytes each): ~300 bytes
- Total: ~1.1 KB, well under gas-realistic limits on Base.

Mint cost estimate: ~500k gas on Base (~$0.02 at current gas prices).

### 11.J Onboarding ramp for Open-X + LeRobot datasets

**Zero-data-movement onboarding.** PCC writes to each contributor institution:
1. Institution signs a creator attestation (EIP-7015 style) pointing to their existing HF Hub dataset.
2. PCC mints DatasetNFT on their behalf (or gives them the script to mint themselves).
3. DatasetMeta fields point to existing HF repo + revision SHA.
4. Institution controls DatasetNFT via their Ethereum wallet.

**60 OXE datasets → 60 DatasetNFTs** without a single byte of data moved. Pure attribution layer addition.

---

## 12. Open Questions + Next Steps

1. **Story Protocol integration depth.** Should we register every DatasetNFT + ModelNFT as Story IPAssets too (Option A)? Or keep native on Base and bridge only the revenue event (Option B)? Recommendation: start native on Base; post-launch, add Story IPAsset mirroring for interop.

2. **License taxonomy granularity.** 5 license codes may be too few. Do we need "derivatives-allowed-commercial-only"? Do we need separate codes for "dataset-for-training" vs "dataset-for-eval"? **Recommendation:** start with 5 in v1; extend as marketplace demands.

3. **TEE integration choice.** Phala, AWS Nitro, Azure CC, or bring-your-own-attestation? **Recommendation:** Phala for v2 — they have the strongest on-chain quote verifier story. AWS Nitro as fallback for enterprise trainers who prefer AWS.

4. **Flattened mix staleness.** If parent ModelNFT's manifest changes (e.g., metadata correction via `Updatable` extension), all downstream flattened mixes go stale. **Recommendation:** make TrainingManifest immutable post-mint. Corrections require a new ModelNFT version (parents: [old-self, weight 9999] + whatever changed).

5. **Sybil resistance tuning.** Gitcoin Passport score ≥15 for pilots. But what about trainers? They need more accountability. Should trainer identity require KYC for Tier 2+ models?

6. **ContributorNFT subtype expansion.** If we have PILOT / TRAINER / DATASET / RATE_SCHEDULE / SERVICE_PROVIDER — do we need MODEL as a distinct type, or is ModelNFT separate from ContributorNFT? **Recommendation:** ModelNFT is NOT a ContributorNFT — it's a *product* that pays contributors. Keep them distinct.

7. **Dispute module scope.** For MVP (trust-based), what specifically can be disputed? "Weight_bps lied about" is hard to prove without attestation. "Dataset cited wasn't actually used" — maybe provable by a zero-knowledge-argument on weight gradients, but expensive. **Recommendation:** for MVP, dispute = "license incompatibility" (provable on-chain via license composition rule) + "dataset doesn't exist" (trivially provable). Leave weight-lying undisputable until v2 TEE.

8. **Cross-chain posture.** PCC is Base Sepolia today. Story is its own L1. Sahara AI is another L1. Cross-chain registration via LayerZero / Axelar for DatasetNFT mirroring?

---

## 13. Concrete work items for implementer

**Week 1–2:**
1. Finalize DatasetNFT contract (Solidity 0.8.24 + OpenZeppelin + ERC-6551 TBA).
2. Finalize ModelNFT contract + TrainingManifest struct + flattening algo.
3. RoyaltyRouter contract with pull-payment pattern.
4. Unit tests: 3-level deep DAG flattening, weight-sum invariants, ERC-7015 creator attestation, ERC-2981 royaltyInfo.

**Week 3:**
5. ShareTokenFactory (ERC-7641 deployments for fractional model ownership).
6. LicenseCompositionPolicy contract (the enum rule).
7. IPFS manifest canonicalization (JCS JSON canonicalization spec) + sha256 hashing library.
8. Integration test: mint DatasetNFT → mint ModelNFT with that dataset in mix → pay RoyaltyRouter → withdraw from TBA.

**Week 4:**
9. Off-chain manifest-authoring CLI (reads HF model card + extends with weights).
10. `/api/dataset/*` routes + `/api/model/*` routes wired to gateway.
11. Dashboard page "My DatasetNFTs" with earnings view.
12. Gitcoin Passport integration for mint gate (score ≥15).

**Week 5–6:**
13. Onboarding pipeline for 60 OXE datasets + 10 popular LeRobot datasets.
14. Story Protocol mirror (optional Option A path).
15. Dispute module stub (for MVP).
16. E2E robot job: pilot → DatasetNFT → trainer → ModelNFT → PCC job → MilestoneEscrow → RoyaltyRouter → pilot's TBA → withdraw.

**Budget estimate:** 4-6 weeks of 1 senior Solidity engineer + 1 backend engineer + 0.5 designer.

---

## Appendix A: All primary sources

### Robotics datasets
1. [Open-X Embodiment paper (arXiv 2310.08864)](https://arxiv.org/abs/2310.08864)
2. [Open-X project site](https://robotics-transformer-x.github.io/)
3. [Open-X GitHub](https://github.com/google-deepmind/open_x_embodiment)
4. [LeRobot GitHub](https://github.com/huggingface/lerobot)
5. [LeRobotDataset v3 blog](https://huggingface.co/blog/lerobot-datasets-v3)
6. [BridgeData V2](https://rail-berkeley.github.io/bridgedata/)
7. [RoboTurk](https://roboturk.stanford.edu/)
8. [Robomimic](https://robomimic.github.io/)

### ML tooling / manifests
9. [HuggingFace Dataset Cards](https://huggingface.co/docs/hub/en/datasets-cards)
10. [HuggingFace Model Cards](https://huggingface.co/docs/hub/model-cards)
11. [MLflow Dataset Tracking](https://mlflow.org/docs/latest/ml/dataset/)
12. [MLflow Model Registry](https://mlflow.org/docs/latest/model-registry/)
13. [DVC Documentation](https://doc.dvc.org/)
14. [DVC Pipelines](https://doc.dvc.org/user-guide/pipelines)

### On-chain IP + royalty
15. [Story Foundation](https://www.story.foundation/)
16. [Story Whitepaper](https://www.story.foundation/whitepaper.pdf)
17. [Story Docs](https://docs.story.foundation/introduction)
18. [RoyaltyModule.sol](https://github.com/storyprotocol/protocol-core-v1/blob/main/contracts/modules/royalty/RoyaltyModule.sol)
19. [Ocean Protocol Data NFTs + Datatokens](https://docs.oceanprotocol.com/developers/contracts/datanft-and-datatoken)
20. [Audius Protocol](https://docs.audius.org/learn/concepts/protocol/)
21. [0xSplits](https://docs.splits.org/)
22. [Lens Protocol modules](https://github.com/lens-protocol/modules)

### Content addressing + provenance
23. [IPLD](https://ipld.io/)
24. [IPFS Merkle DAG](https://docs.ipfs.tech/concepts/merkle-dag/)
25. [C2PA spec 2.2](https://spec.c2pa.org/specifications/specifications/2.2/specs/_attachments/C2PA_Specification.pdf)
26. [C2PA home](https://c2pa.org/)
27. [W3C PROV FAQ](https://www.w3.org/2001/sw/wiki/PROV-FAQ)
28. [Ceramic Network](https://ceramic.network/how-it-works)
29. [Arweave home](https://www.arweave.org/)

### NFT standards
30. [EIP-7007 (AIGC NFT)](https://eips.ethereum.org/EIPS/eip-7007)
31. [EIP-7015 (Creator Attribution)](https://eips.ethereum.org/EIPS/eip-7015)
32. [EIP-7641 (Intrinsic RevShare)](https://eips.ethereum.org/EIPS/eip-7641)
33. [EIP-2981 (Royalty Standard)](https://eips.ethereum.org/EIPS/eip-2981)
34. [EIP-6551 (Token Bound Accounts)](https://eips.ethereum.org/EIPS/eip-6551)

### Licensing
35. [HuggingFace OpenRAIL blog](https://huggingface.co/blog/open_rail)
36. [RAIL FAQ](https://www.licenses.ai/faq-2)
37. [BigCode OpenRAIL-M](https://www.bigcode-project.org/docs/pages/bigcode-openrail/)

### Identity
38. [Gitcoin Passport](https://go.gitcoin.co/passport)
39. [ERC-4361 SIWE](https://eips.ethereum.org/EIPS/eip-4361)
40. [ethr-did-resolver](https://github.com/decentralized-identity/ethr-did-resolver)
41. [ERC-1056 Ethereum Lightweight Identity](https://eips.ethereum.org/EIPS/eip-1056)

### Training attestation
42. [awesome-zkml](https://github.com/worldcoin/awesome-zkml)
43. [EZKL benchmarks](https://blog.ezkl.xyz/post/benchmarks/)
44. [ICME zkML guide 2025](https://blog.icme.io/the-definitive-guide-to-zkml-2025/)
45. [ORA OAO docs](https://docs.ora.io/doc/onchain-ai-oracle-oao/onchain-ai-oracle)
46. [ORA opML](https://github.com/ora-io/opml/blob/main/docs/OPML.md)
47. [ORA IMO Overview](https://docs.ora.io/doc/initial-model-offering-imo/imo-overview)
48. [Phala Network docs](https://docs.phala.com/network/overview/phala-network)
49. [Phala GPU TEE deep dive](https://phala.com/posts/Phala-GPU-TEE-Deep-Dive)

### Robotics economy
50. [FrodoBots-2K dataset](https://huggingface.co/datasets/frodobots/FrodoBots-2K)
51. [FrodoBots AI site](https://www.frodobots.ai/)
52. [BitRobot network announcement](https://thedefiant.io/news/press-releases/frodobots-lab-raises-8m-to-launch-bitrobot-a-crypto-network-of-subnets-for-embodied-ai-research)
53. [Sahara AI tokenomics](https://docs.saharaai.com/tokenomics)
54. [Skild AI](https://www.skild.ai/)
55. [Tesla Optimus Wikipedia](https://en.wikipedia.org/wiki/Optimus_(robot))

---

**END OF REPORT — scout-provenance-charlie — 2026-04-22**
