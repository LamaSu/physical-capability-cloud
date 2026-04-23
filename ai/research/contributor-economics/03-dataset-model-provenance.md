# Landscape: Dataset + Model Attribution with Recursive Royalty Flow

**Agent:** scout-provenance-charlie
**Date:** 2026-04-22
**Mission:** Research how to implement recursive attribution for robotics datasets and AI models, so that when a robot executes a PCC job using ModelNFT M, payment flows through M's training manifest to DatasetNFT contributors pro-rata.

## Progress

- [x] 1a. Open-X Embodiment + RT-X
- [x] 1b. LeRobot v3 detail
- [ ] 1c. Robomimic / RoboTurk / BridgeData / Isaac Sim (pending)
- [x] 2a. HF Dataset Cards
- [x] 2b. MLflow artifact lineage
- [x] 2c. DVC
- [ ] 2d. W&B dataset artifacts (pending)
- [x] 3a. Story Protocol IP Graph
- [x] 3b. Ocean Protocol Data NFT/Datatoken
- [x] 3c. Audius
- [ ] 3d. Lens / Art Blocks (pending)
- [x] 4a. IPLD
- [x] 4b. C2PA
- [x] 4c. W3C PROV
- [ ] 4d. Ceramic / Arweave (pending)
- [ ] 5. Training-mix encoding on-chain (to synthesize)
- [x] 6a. EIP-7007
- [ ] 6b. EIP-7015 (pending)
- [x] 7a. OpenRAIL
- [ ] 7b. Hippocratic / Creative Commons ShareAlike (pending)
- [x] 8a. Gitcoin Passport
- [ ] 8b. did:ethr / ERC-4361 SIWE / ERC-725 (pending)
- [x] 9a. zkML (EZKL, Modulus, Giza)
- [x] 9b. ORA opML
- [x] 9c. Phala TEE
- [ ] 10a. FrodoBots / BitRobot
- [x] 10b. Sahara AI
- [ ] 10c. 1X / Tesla / Physical Intelligence / Skild (pending)

---

## 1. Robotics Datasets + Open Attribution

### 1.A Open-X Embodiment (Google DeepMind, Oct 2023)

**Sources:** [arXiv 2310.08864](https://arxiv.org/abs/2310.08864), [robotics-transformer-x.github.io](https://robotics-transformer-x.github.io/), [GitHub google-deepmind/open_x_embodiment](https://github.com/google-deepmind/open_x_embodiment), [HF dataset mirror](https://huggingface.co/datasets/jxu124/OpenX-Embodiment).

**Scale.** 1M+ real robot trajectories, **22 embodiments** (single arms, bimanual, quadrupeds), **527 skills**, **160,266 tasks**, **60 constituent datasets**, **21 contributing institutions**. A union of existing robotics datasets, not newly collected.

**License stack.**
- Software (training code, scripts, loaders): Apache-2.0
- Data (trajectories, all non-code material): CC-BY-4.0
- Individual constituent datasets retain their own licenses; users must check the dataset spreadsheet linked from the site for per-dataset citation + license.

**Attribution mechanism.** Users of RT-X (the model trained on OXE) are asked to cite the Open-X Embodiment paper AND every constituent dataset they specifically loaded. No on-chain mechanism. No royalty flow. Pure academic-citation attribution. This is the state of the art in open robotics data attribution, and it's still literally "cite us in your paper." PCC can materially improve on this with DatasetNFTs.

**RT-1-X vs RT-2-X.**
- RT-1-X: 35M params, trained only on the OXE robotics mixture.
- RT-2-X: 55B VLM (PaLI-X) co-fine-tuned with ~50/50 VLM + robotics data.

**Training mix composition.** The RT-X paper explicitly reports per-dataset sampling weights during training — the mixture is not uniform; high-quality datasets like RT-1 and Bridge are upweighted. This is exactly the weight-basis-points vector PCC's TrainingManifest needs to encode.

**Fit for PCC: 5/5.** This is the canonical robotics dataset to bootstrap a DatasetNFT catalog. If PCC wraps the OXE constituent datasets as 60 DatasetNFTs (original owner = institution), every future robotics model trained on OXE has a natural royalty destination list. The CC-BY license is commercially-permissive, so wrapping in an NFT is legal as long as attribution is preserved in the token metadata.

### 1.B LeRobot (HuggingFace)

**Sources:** [GitHub huggingface/lerobot](https://github.com/huggingface/lerobot), [v3 blog post](https://huggingface.co/blog/lerobot-datasets-v3), [v3 docs](https://huggingface.co/docs/lerobot/en/lerobot-dataset-v3).

**Format.** `LeRobotDataset` = Parquet (state/action/metadata) + MP4 (vision), hosted on the Hugging Face Hub, streaming-friendly. v3 (2025) packs multiple episodes per file, uses relational metadata for episode lookup (episode boundaries resolved via metadata, not filenames).

**License.** Software: Apache-2.0. Individual datasets on the Hub are per-dataset — some CC-BY, some CC-BY-SA, some Apache-2.0, some proprietary/research-only. **The Hub does NOT enforce a canonical license**; it's up to the uploader.

**Attribution.** HF Hub dataset cards (Markdown with YAML frontmatter) include `license:` (SPDX), citation (BibTeX), `dataset_info:` (size, splits, features), and custom fields (no standard for training-mix pointers).

**Fit for PCC: 4/5.** LeRobot is where the mass of robotics datasets lives. DatasetNFT should be able to **point to** a LeRobotDataset on HF Hub by `{repo_id, revision_sha}` rather than duplicating storage. Content-addressing: HF revisions are git-sha commits, so `(repo_id, revision_sha)` is a stable reference.

### 1.C Other robotics datasets (Robomimic, RoboTurk, BridgeData, Isaac Sim)

To be covered: same license pattern as above (CC-BY for data, Apache-2.0 for tools). Attribution is citation-based; no on-chain royalty flow in existence for any of these as of April 2026.

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
    - name: train
      num_bytes: 12345678
      num_examples: 10000
  download_size: 987654321
  dataset_size: 1234567890
configs:
  - config_name: default
    data_files: [data/train-*.parquet]
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
3. **No economic binding** — it's just documentation, no smart contract consumes it.

**Opportunity.** PCC's TrainingManifest can be a *superset* of HF card metadata: `(datasetId, revisionSha, weightBps, license)` tuples, committed on-chain with an IPFS-stored full manifest. Tooling that extracts from existing HF cards + adds weights is a natural ingestion pipeline.

**Fit for PCC: 4/5.** HF card format is the de-facto standard for model documentation. PCC should adopt it as-is and *add* the on-chain economic layer. The YAML frontmatter becomes a canonical "off-chain manifest" that the on-chain TrainingManifest commits to (via content hash).

### 2.B MLflow Dataset Tracking + Model Registry

**Sources:** [MLflow Dataset Tracking docs](https://mlflow.org/docs/latest/ml/dataset/), [Model Registry](https://mlflow.org/docs/latest/model-registry/), [SageMaker + DVC + MLflow e2e lineage](https://aws.amazon.com/blogs/machine-learning/end-to-end-lineage-with-dvc-and-amazon-sagemaker-ai-mlflow-apps/).

**Capabilities.**
- `DatasetSource` — linked lineage to the original source (S3 URL, Delta Table, URL).
- Log DVC commit hash as a parameter → model in MLflow registry → exact dataset recovery.
- Model Registry stores lineage: experiment → run → model, with versioning and aliases.

**Gap.** Pure off-chain. Not cryptographically verifiable. Trust-based.

**Fit for PCC: 2/5.** Useful as a pattern for the off-chain component of our manifest (the "training run fingerprint"). Not useful as a direct integration target — MLflow lineage has to be rebuilt on-chain to enable royalty flow.

### 2.C DVC (Data Version Control)

**Sources:** [DVC Home](https://doc.dvc.org/), [Pipelines](https://doc.dvc.org/user-guide/pipelines), [Defining Pipelines](https://doc.dvc.org/user-guide/pipelines/defining-pipelines).

**Model.** Pipeline stages (YAML in `dvc.yaml`) → DAG where nodes are stages, edges are dependencies. Each stage has `deps:` (files/dirs), `outs:` (outputs), `params:` (hyperparams). `dvc.lock` records MD5 hash of each output for change detection.

**Critical insight.** DVC's DAG model is structurally identical to what PCC's TrainingManifest needs. Stages = (parent model | dataset); deps = content hashes; outs = produced artifact hash. The whole pipeline is a Merkle-DAG.

**Fit for PCC: 4/5.** DVC's DAG-of-hashed-stages is the canonical off-chain representation that maps 1:1 to an on-chain TrainingManifest. Pattern to steal:
- Every ModelNFT commits to an IPFS hash of a `dvc.lock`-like manifest.
- The manifest enumerates `(stage: "pretrain-llama-3" | "finetune-on-dataset-X", inputs: [hash...], outputs: [hash...])`.
- On-chain, we store ONLY the training-mix weights + IPFS CID of the full manifest.
- Royalty flow doesn't need to traverse the full manifest — it only needs the weighted parent-list, which we surface on-chain.

### 2.D Weights & Biases Dataset Artifacts (pending detail — same pattern as MLflow, no cryptographic verifiability)

---

## 3. On-Chain IP / Attribution Systems

### 3.A Story Protocol — Programmable IP Blockchain (Key Reference)

**Sources:** [Story Foundation](https://www.story.foundation/), [whitepaper](https://www.story.foundation/whitepaper.pdf), [docs intro](https://docs.story.foundation/introduction), [Figment coverage](https://www.figment.io/insights/story-protocol-first-look-bringing-ip-on-chain/), [Oak Research](https://oakresearch.io/en/reports/protocols/story-protocol-ip-comprehensive-presentation-blockchain-intellectual-property).

**Thesis.** Story is a purpose-built Layer 1 blockchain for intellectual property. Core: Proof-of-Creativity (PoC). IP = first-class blockchain entity. IP assets are registered as NFTs (ERC-721 `IPAsset`s) and linked into a graph of parent-child (derivative) relationships, with licenses enforced by on-chain modules.

**Key primitives.**

1. **IPAsset** — the tokenization unit. Wraps any existing NFT (image, song, dataset, model) and gives it an IPAccount (smart-contract wallet per asset, ERC-6551-style) that can receive royalties.
2. **IPGraph** — the parent-child relationship graph. When you remix, fine-tune, or derive from a parent IPAsset, you register the derivative on-chain with a link to the parent.
3. **Programmable IP License (PIL)** — on-chain license terms (commercial/non-commercial, derivatives allowed, minimum royalty, fixed mint fee, etc.). PIL licenses are themselves NFTs (ERC-721 `LicenseToken`s) that can be minted by derivative creators.
4. **Royalty Module** — automates revenue flow between parent and child IPAssets. Two built-in policies:
   - **Liquid Absolute Percentage** (LAP): flat % of all derivative revenue to parent.
   - **Liquid Relative Percentage** (LRP): each hop takes % of what passed through.
   - Permissionless custom policies also supported.
5. **Dispute Module** — on-chain challenge of infringement claims.

**Royalty flow mechanism.** From docs: "Each parent IP Asset establishes a minimum royalty percentage that dictates the share of revenue that **direct derivative IP Assets in a derivative chain must allocate to their parent IPs**." Recursive by construction: a derivative of a derivative owes royalties up the whole chain (bounded by gas).

**Chain.** Story Mainnet launched Feb 13 2025 (EVM-compatible L1). The $IP token funds gas + governance.

**Fit for PCC: 5/5.** Story Protocol is **the reference implementation of recursive on-chain attribution**. PCC has two integration options:
- **(A) Deploy on Story directly.** Register every ContributorNFT, DatasetNFT, ModelNFT as Story IPAssets. Training manifests become IPGraph parent-child links. Use LAP policy for the "10% to training data" split. Story's Royalty Module handles recursive traversal automatically.
- **(B) Take inspiration, build native on Base.** Model our TrainingManifest on IPGraph semantics but keep it in our own contracts. More control, more implementation work. Already partially done: PCC's `/api/ip/*` endpoints already talk to Story Protocol for capability IP registration (per `pcc_ip_register_capability` MCP tool). Extending this to dataset/model IP is a natural next step.

**Recommendation:** **Option A + B hybrid.** Register DatasetNFTs + ModelNFTs as Story IPAssets (gets us recursive royalty for free). Keep the robot-job-payment origination on Base Sepolia (MilestoneEscrow). Bridge: when an escrow releases, call Story with a revenue event and let Story's Royalty Module distribute through IPGraph.

### 3.B Ocean Protocol — Data NFTs + Datatokens

**Sources:** [Data NFTs + Datatokens](https://docs.oceanprotocol.com/developers/contracts/datanft-and-datatoken), [Data NFTs detail](https://docs.oceanprotocol.com/developers/contracts/data-nfts), [v4 LinkedIn post](https://www.linkedin.com/posts/ocean-protocol_data-nfts-are-a-key-new-feature-in-ocean-activity-6918206044716314624-eTch).

**Two-token model.**
- **Data NFT (ERC-721)** — represents copyright/base IP of a data asset. One data NFT per dataset. Stores metadata, mint roles, fee roles, open key-value store for custom fields.
- **Datatoken (ERC-20)** — represents licenses to access the data. Holding 1.0 datatoken = one consumption right. Fungible, tradeable on DEXes. Multiple datatoken contracts can be minted from one Data NFT (each datatoken = different license terms).

**Why this matters for PCC.** The two-token pattern separates ownership from access. PCC's DatasetNFT should follow: **DatasetNFT (ERC-721) = who gets paid / who owns the data**; **DatasetAccessToken (ERC-20) = who is permitted to use it for training** (one AccessToken per training run). This cleanly enables:
- Royalty to DatasetNFT holder (even if ownership transfers, royalty follows the NFT)
- Permissioned training (burn one AccessToken per ModelNFT that includes this dataset)
- Different license tiers (a "for-profit training" AccessToken @ 1000 OCEAN; a "research training" AccessToken @ 10 OCEAN — distinct ERC-20s)

**Consumption flow.** When a consumer sends 1.0 datatoken to the publisher, Ocean's infrastructure (Provider + Aquarius) grants access to the underlying data URL, typically time-bound.

**Compute-to-Data (C2D).** Ocean's additional primitive: consumer sends datatokens, publisher's Provider *runs consumer's algorithm* on the data inside a TEE, returns only the result. Data never leaves the publisher. **PCC can adopt this for private training** — trainer's training job is run inside the dataset holder's sandbox, and training manifest is attested by the TEE. This directly answers the "how do we verify ModelNFT really used these DatasetNFTs?" question (see section 9).

**Fit for PCC: 5/5.** Ocean's design is the cleanest prior art for tokenized datasets with on-chain access control. We should adopt the two-token pattern and seriously consider C2D for private training.

### 3.C Audius — Decentralized Music + Royalty Splits

**Sources:** [Audius.org](https://audius.org/), [Protocol docs](https://docs.audius.org/learn/concepts/protocol/), [Music Reports partnership](https://www.musicbusinessworldwide.com/audius-partners-with-music-reports-to-power-rights-clearances-for-music-publishers1/), [artist payment launch](https://www.musicbusinessworldwide.com/audius-officially-launches-public-artist-payment-system-with-10-community-split/).

**Model.** Decentralized audio distribution + attribution + monetization. Artists paid AUDIO tokens per stream + fan engagement. Labels get no cut by default. Artists can set up splits with producers/co-writers.

**Royalty split.** On artist upload, an immutable record is created. Curators receive 90% in AUDIO, stakers supporting the network get 10%. Partnership with Music Reports (via Songdex Marketplace) provides traditional music-publisher licensing.

**What's useful for PCC.** The **split contract pattern**. When a ModelNFT pays out, the royalty is split among N contributors: base-model-creator (A%), dataset-contributors (B% distributed by training-mix weights), model-trainer (C%), PCC protocol fee (D%). This is conceptually identical to the Audius artist/producer/label split; the implementation pattern (0xSplits, Gnosis Safe, or a custom RoyaltyRouter) is well-understood.

**0xSplits.** Audius and many others use [0xSplits](https://splits.org/) under the hood — a battle-tested protocol for ERC-20 revenue distribution to a list of `(address, weight_bps)` tuples. **PCC should strongly consider using 0xSplits directly** for the primary split (creator + protocol + training-mix-pool), and then a custom RoyaltyRouter for the recursive training-mix-pool distribution.

**Fit for PCC: 4/5.** Audius itself doesn't add much over Ocean/Story, but the 0xSplits pattern it uses is a direct integration target for PCC.

### 3.D Lens Protocol / Art Blocks — Collect and ongoing royalty (pending detail)

---

## 4. Data Provenance + Content Addressing

### 4.A IPLD — InterPlanetary Linked Data

**Sources:** [IPLD home](https://ipld.io/), [spec repo](https://github.com/ipld/specs), [IPFS docs Merkle DAG](https://docs.ipfs.tech/concepts/merkle-dag/), [Filecoin IPLD Store](https://spec.filecoin.io/systems/filecoin_nodes/repository/ipldstore/).

**Overview.** IPLD is the data layer IPFS is built on. A series of standards/formats for describing data in a content-addressing-emphatic way. Goal: decentralized data-structures that are universally addressable and linkable (do for data what URLs/links did for HTML).

**Content Identifier (CID).** Identifying a data object by the hash of its value. Since the link IS the hash, you can always recompute and validate. Enables trustless p2p data exchange.

**Merkle DAG.** Each node's identifier is the hash of (its payload || child CIDs). Immutable — any change propagates up. **Two nodes with the same CID represent exactly the same DAG**, self-verifiably.

**Data model.** Booleans, integers, strings, nulls, byte arrays, lists, maps, and a native **link** primitive. Codecs: DAG-CBOR and DAG-JSON fully implement the Data Model.

**Fit for PCC: 5/5.** This is the ideal off-chain representation for PCC's TrainingManifest. Each manifest node is:
```
{
  "@type": "pcc.TrainingManifest/1",
  "model": {"standard": "pcc.ModelNFT", "tokenId": 42},
  "parents": [
    {"model": "<cid-of-parent-manifest>", "weight_bps": 7000},
    {"model": "<cid-of-another-parent>", "weight_bps": 1000}
  ],
  "datasets": [
    {"datasetNFT": 101, "content_cid": "<cid-of-dataset>", "weight_bps": 1500},
    {"datasetNFT": 207, "content_cid": "<cid-of-dataset>", "weight_bps": 500}
  ],
  "license_summary": {...},
  "training_attestation": {"type": "tee-sgx", "quote_cid": "<cid>"}
}
```
This is a DAG: each parent is a CID-link. The on-chain TrainingManifest stores just the top-level CID; any verifier can recursively fetch through IPFS. **This is the best off-chain representation story we have** — exactly what the problem needs.

### 4.B C2PA — Coalition for Content Provenance and Authenticity

**Sources:** [C2PA.org](https://c2pa.org/), [Content Authenticity Initiative](https://contentauthenticity.org/how-it-works), [spec 2.2 PDF](https://spec.c2pa.org/specifications/specifications/2.2/specs/_attachments/C2PA_Specification.pdf), [Content Credentials](https://contentcredentials.org/), [TechTarget overview](https://www.techtarget.com/whatis/definition/Coalition-for-Content-Provenance-and-Authenticity-C2PA).

**Consortium.** Adobe, Arm, BBC, Intel, Microsoft, Truepic (founders Feb 2021) + OpenAI, Google, Meta, Amazon, Sony, Publicis (added since). Royalty-free open technical specifications.

**Mechanism.** C2PA Manifest (aka Content Credential) = cryptographically signed metadata embedded IN the file. Records who made it, when, what tools, what source ingredients. Tampering breaks the signature.

**Assertions.** Manifests include assertions about:
- Content ingredients used to produce it (provenance chain)
- Date, time, location of production
- Device or software used

**Current status.** v2.2 published May 2025, v2.3 draft. C2PA Conformance Program launched (certified implementations). OpenAI uses C2PA on ChatGPT-generated images. Major camera manufacturers shipping C2PA-signed capture.

**Fit for PCC: 4/5.** C2PA's "ingredients" concept is structurally identical to PCC's training-mix: each ingredient has a hash + source + role. If a robotics dataset is captured through a C2PA-compliant camera, the DatasetNFT metadata can embed the C2PA manifest directly, inheriting cryptographic provenance from the hardware capture point. This is a **strong** story for evidence-grade datasets (Tier 2-3 jobs). Not as immediately applicable to simulation-generated data.

### 4.C W3C PROV Ontology

**Sources:** [W3C PROV Wikipedia](https://en.wikipedia.org/wiki/W3C_Prov), [PROV-FAQ](https://www.w3.org/2001/sw/wiki/PROV-FAQ).

**Core concepts.** entity / activity / agent. Past-tense relations:
- `prov:wasGeneratedBy` — entity was produced by an activity
- `prov:wasDerivedFrom` — one entity was influenced by another
- `prov:wasAttributedTo` — entity attributed to an agent
- `prov:used` — activity used an entity
- `prov:actedOnBehalfOf` — delegation between agents

**Data model + RDF mapping + OWL2 ontology + XML schema.**

**Fit for PCC: 3/5.** The vocabulary maps perfectly to our use case:
- ModelNFT = `prov:Entity`
- Training-job = `prov:Activity`
- Trainer = `prov:Agent`
- `ModelNFT prov:wasDerivedFrom DatasetNFT` (for each dataset in training mix)
- `ModelNFT prov:wasDerivedFrom ParentModelNFT`
- `TrainingJob prov:used DatasetNFT`

We should **export our TrainingManifest as PROV-compatible RDF** for interop with academic provenance tooling. Doesn't need to be the canonical format; just a secondary export.

### 4.D Ceramic Network, Arweave (pending detail)

---

## 5. Training-Mix Encoding On-Chain (SYNTHESIS SECTION — to be expanded)

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
Gas cost: high. Good for short mixes (<10 entries). Makes recursive traversal cheap in that every ModelNFT already has its mix on-chain.

**Option 2: On-chain hash + off-chain manifest.**
```solidity
struct TrainingManifestCommit {
  bytes32 manifestHash;   // sha256 of canonical JSON
  string manifestCid;     // IPFS CID
  address[] topLevelParents; // just the direct parents, for cheap traversal
  uint16[] topLevelWeightsBps;
}
```
Gas cost: low. Traversal requires fetching manifest from IPFS (cheap, cacheable). Verification: if dispute arises, anyone can re-hash the off-chain manifest and prove discrepancy.

**Option 3: Recursive traversal with gas cap.**
- Each ModelNFT stores only its direct parents with weights.
- At settlement, RoyaltyRouter does BFS up to depth-3 (or gas-cap).
- Deeper ancestors get their share "dropped" (or accumulated in a residual bucket that parents can claim manually).

**Option 4: Pre-computed flattened mix cache.**
- When a ModelNFT is minted, the protocol computes the flat (leaf-dataset, total_weight) list once and caches it.
- Cache is updated if any ancestor model updates (rare).
- At settlement, we iterate the cache, not the DAG.
- Gas: O(leaves), not O(depth × fanout).

**Recommendation: Option 2 + Option 4 hybrid.**
- Commit to IPFS manifest hash for full provenance (audit + dispute resolution).
- Pre-compute flattened (dataset, weight) list at mint-time and store on-chain.
- Direct-parent traversal only for cases where an upstream model is re-paid (rare).

### Recursive weight algebra

If ModelNFT M has parents P1(w1), P2(w2) and datasets D1(dw1), D2(dw2), and P1 itself has parents Q1(q1) and dataset DQ(qw), then the flattened mix of M is:

```
M.flat_datasets = [
  (D1, dw1),
  (D2, dw2),
  ... every dataset in P1.flat_datasets scaled by w1 ...
  ... every dataset in P2.flat_datasets scaled by w2 ...
]
```

In Solidity (pseudocode):
```solidity
function flatten(uint256 modelId) internal view returns (LeafDataset[] memory) {
    TrainingMix memory mix = trainingMix[modelId];
    LeafDataset[] memory result = new LeafDataset[](...);

    for (uint i = 0; i < mix.datasets.length; i++) {
        result.push(LeafDataset(mix.datasets[i], mix.tokenIds[i], mix.weightsBps[i]));
    }
    for (uint i = 0; i < mix.parentModels.length; i++) {
        LeafDataset[] memory parentFlat = flatten(mix.parentModelTokenIds[i]);
        for (uint j = 0; j < parentFlat.length; j++) {
            result.push(LeafDataset(
                parentFlat[j].dataset,
                parentFlat[j].tokenId,
                (parentFlat[j].weightBps * mix.parentWeightsBps[i]) / 10000
            ));
        }
    }
    return result;
}
```

We don't call this on-chain on every settlement. We call it **once at ModelNFT mint** (or on manual `recomputeFlatten(modelId)`) and store the result. Settlement is O(leaves).

---

## 6. Dataset NFT Specifications

### 6.A EIP-7007 — Verifiable AI-Generated Content Token

**Sources:** [EIP-7007 spec](https://eips.ethereum.org/EIPS/eip-7007), [ERCs repo master](https://github.com/ethereum/ercs/blob/master/ERCS/erc-7007.md), [Magicians discussion](https://ethereum-magicians.org/t/eip-7007-zkml-aigc-nfts-an-erc-721-extension-interface-for-zkml-based-aigc-nfts/14216), [ORA docs](https://docs.ora.io/doc/initial-model-offering-imo/erc-7007-verifiable-ai-generated-content-token).

**Overview.** ERC-721 extension for AI-Generated Content NFTs. Proposes interfaces for AIGC-NFT creation with on-chain verification.

**Key features.**
- `addAigcData` and `verify` function interfaces
- `AigcData` event
- Optional `Enumerable` and `Updatable` extensions
- JSON schema for AIGC-NFT metadata
- **zkML or opML** verification of the ML model → output relationship
- Supports validity proofs (zkML) + fraud proofs (opML)
- **tokenId = hash(prompt)** — deterministic, collision-resistant, prevents duplicate mints for same prompt

**Use case framing.** "Every input prompt and its resulting content can be securely verified on the blockchain, opening up opportunities for revenue-sharing mechanisms for all AIGC NFT sales."

**Fit for PCC: 4/5.** EIP-7007 is the right template for **ModelOutputNFT** (a per-job artifact NFT), not for ModelNFT itself. When a PCC robot produces output using a ModelNFT, the output itself could be wrapped as an EIP-7007 NFT with `tokenId = hash(prompt + model_commitment)`. This gives us:
- Cryptographic verification that output came from the claimed model
- Natural hook for royalty distribution (the NFT sale flows through our RoyaltyRouter)
- Interop with downstream AIGC tooling

**Note on prompt-as-id.** PCC jobs aren't usually "prompts" in the LLM sense — they're capability contracts with selections. But structurally, `tokenId = hash(contract + model_commitment)` is equivalent.

### 6.B EIP-7015 (to research)

### 6.C Privacy-preserving datasets with TEE attestation (see §9)

---

## 7. License Compatibility + Revenue Share

### 7.A OpenRAIL (and OpenRAIL-M for models)

**Sources:** [HuggingFace OpenRAIL blog](https://huggingface.co/blog/open_rail), [RAIL FAQ](https://www.licenses.ai/faq-2), [BigCode OpenRAIL-M](https://www.bigcode-project.org/docs/pages/bigcode-openrail/), [GitLab analysis](https://about.gitlab.com/blog/rail-m-is-an-imperfectly-good-start-for-ai-model-licenses/), [RAIL home](https://www.licenses.ai).

**Model.** RAIL = Responsible AI Licenses. OpenRAIL = the open subfamily. OpenRAIL-M = model variant.

**Mechanism.** Royalty-free open access + usage restrictions (no weapons, no disinformation, no deepfakes, etc.). Critically, restrictions propagate to derivatives: "downstream adoption of the use-based restrictions by subsequent re-distribution and derivatives."

**Examples.** BigScience BLOOM (first OpenRAIL-M), StarCoder (BigCode OpenRAIL-M), many Stability AI models.

**Fit for PCC: 3/5.** No royalty built in (open access = zero cost). But the **derivative-propagation** pattern is interesting for PCC's license composability story. If a DatasetNFT is minted with OpenRAIL-M-like terms, and a ModelNFT derives from it, the same terms bind the ModelNFT — enforced by the license field in the TrainingManifest. PCC should define its own license taxonomy (commercial-unlimited / commercial-capped-royalty / research-only / derivatives-must-share) that's on-chain-enforceable.

### 7.B Creative Commons + Hippocratic License (pending)

---

## 8. Identity for Pilots + Trainers

### 8.A Gitcoin Passport (Human Passport)

**Sources:** [Gitcoin Passport](https://go.gitcoin.co/passport), [Decentralised.co](https://www.decentralised.co/p/passport-please), [Ceramic blog integration](https://blog.ceramic.network/gitcoin-builds-passport-on-ceramic/), [Human Passport on Base](https://thedefiant.io/news/security/sybil-resistance-tool-human-passport-launches-new-features-for-base).

**Thesis.** Sybil defense + decentralized identity aggregator. Users collect "stamps" from Web2 (Google, Twitter, LinkedIn) + Web3 (ENS, GitHub commits, etc.) to prove humanity. Each stamp has a weight 1-7+ (easy-to-sybil vs hard-to-sybil).

**Privacy.** Passport stores only the Ethereum DID + Verifiable Credentials (VCs). Uses Ceramic for credential storage → portable across apps.

**Current status.** Score threshold: 20 to be "verifiably human." Integrated with EthStaker, Bankless Academy, Rabbithole, Snapshot, Guild. Rebranded Human Passport; launched on Base.

**Fit for PCC: 5/5.** PCC pilots need sybil resistance to prevent one human spinning up 100 pilot identities to pad training data. Minimum Passport score (e.g., ≥15) should be required before a user can mint a PilotContributorNFT. This doesn't require KYC — it just raises the sybil bar. Free integration (the tooling is open-source and hosted).

### 8.B did:ethr / ERC-4361 SIWE / ERC-725 (pending)

---

## 9. Training Attestation

### 9.A zkML — Zero-Knowledge Machine Learning

**Sources:** [ICME guide](https://blog.icme.io/the-definitive-guide-to-zkml-2025/), [Kudelski primer](https://kudelskisecurity.com/modern-ciso-blog/zkml-verifiable-machine-learning-using-zero-knowledge-proof), [World guide](https://world.org/blog/engineering/intro-to-zkml), [awesome-zkml](https://github.com/worldcoin/awesome-zkml), [EZKL benchmarks](https://blog.ezkl.xyz/post/benchmarks/), [1kx Medium](https://medium.com/1kxnetwork/zkml-evolving-the-intelligence-of-smart-contracts-through-zero-knowledge-cryptography-e6725412bbd1).

**Frameworks.**
- **EZKL** — Halo2-based, converts ONNX models to zk-SNARK circuits. Most production-ready.
- **Modulus Labs** — "The Cost of Intelligence" benchmarks, on-chain ML verification.
- **Giza** — Starknet-based, LuminAIR (STWO prover), used by Yearn for verifiable yield strategies.
- **RISC Zero zkVM** — general-purpose; can prove arbitrary Rust.

**Capabilities.**
- Prove: "this inference came from model with weights W on input X, yielding output Y" — without revealing W or X.
- Ideal for ModelNFT: a ModelNFT can emit zkML-verifiable outputs, letting anyone verify inference was done by the claimed model.

**Limitations (as of 2025).**
- Proving cost for large transformers: **hours to days**, not seconds.
- SNARK circuit size limits: small to medium models only (< 1B params typically).
- Precision: requires quantization (fp8 or int8) — some accuracy loss.

**Fit for PCC: 3/5 (inference) / 2/5 (training).** 
- zkML for *inference* is practical for small models (e.g., quality-control classifiers < 100M params).
- zkML for *training* (proving "I trained this model on those datasets") is **still experimental** and largely infeasible for deep networks as of 2025.

### 9.B ORA — opML (Optimistic Machine Learning)

**Sources:** [ORA OAO docs](https://docs.ora.io/doc/onchain-ai-oracle-oao/onchain-ai-oracle), [opML spec](https://docs.ora.io/doc/onchain-ai-oracle-oao/fraud-proof-virtual-machine-fpvm-and-frameworks/opml), [GitHub ora-io/OAO](https://github.com/ora-io/OAO), [opML README](https://github.com/ora-io/opml/blob/main/docs/OPML.md), [IMO Overview](https://docs.ora.io/doc/initial-model-offering-imo/imo-overview).

**Thesis.** opML = fraud-proof ML, similar to optimistic rollups. Service provider runs ML offchain, submits result + commitment. Validators have a challenge period to dispute. Single honest validator ensures correctness.

**Advantages over zkML.**
- Runs ANY size model (LLaMA 3, Stable Diffusion) without prohibitive proving cost.
- ~100x cheaper than zkML.
- Latency: challenge period is hours, not milliseconds — but real-time availability.

**Use cases:** AIGC NFTs, on-chain games, prediction markets, content verification.

**IMO (Initial Model Offering).** ORA's pattern: mint a ModelNFT, sell fractional ownership, holders earn from model usage. **Directly analogous to PCC's ModelNFT.**

**Fit for PCC: 5/5 (for ModelNFT verification).**
- MVP: trust-based (no attestation) — cheapest, good for v1.
- v2: opML verification of inference outputs — ORA-style.
- v3: zkML for small models (quality-critical use cases).

### 9.C Phala Network — TEE Attestation

**Sources:** [Phala Network docs](https://docs.phala.com/network/overview/phala-network), [GPU TEE deep dive](https://phala.com/posts/Phala-GPU-TEE-Deep-Dive), [Beyond SGX](https://phala.com/posts/beyond-sgx-embracing-gpu-tee-for-decentralized-ai-dagi), [WireTap response](https://phala.com/posts/response-to-wiretap-sgx-deprecation), [TEE primer](https://phala.com/learn/What-Is-TEE).

**Model.** "Don't Trust, Verify." TEE-based confidential compute with **Remote Attestation** — user can remotely verify hardware + software running in the Secure Enclave.

**Hardware stack (2025).**
- Intel SGX (deprecating post-WireTap vulnerability)
- **Intel TDX** (VM-level TEE, current gen)
- **AMD SEV-SNP**
- **NVIDIA H100/H200 Confidential Computing** (GPU TEE — *critical for ML*)

**TEE properties.** Confidentiality (memory encrypted), execution integrity (tamper-evident), remote attestation (verifiable from outside).

**Fit for PCC: 5/5.**
- **This is the right path for training attestation in 2026.** H100 Confidential Computing allows a trainer to prove "this ModelNFT was produced from a training run over these DatasetNFTs, inside an attested H100 enclave." Quote is on-chain-verifiable.
- Integration: add a TEE-attested `training_quote_cid` field to TrainingManifest. Verifier contract verifies the quote on-chain (Phala provides this).
- ORA also supports TEE-based AI attestation in newer versions.

**Recommended tier:**
- MVP: trust-based. Pilots self-report training mix; bad actors caught post-hoc via dispute module.
- v2: TEE-attested training on H100. Trainer runs inside Phala / AWS Nitro / Azure CC. Quote committed to manifest.
- v3: zkML for critical inference paths (small models).

---

## 10. Existing Robotics-Data Economy Projects

### 10.A FrodoBots / BitRobot Network

**Sources:** [FrodoBots-2K dataset on HF](https://huggingface.co/datasets/frodobots/FrodoBots-2K), [Chain of Thought coverage](https://chainofthought.xyz/p/the-robot-are-coming-frodobots), [Fabric Ventures thesis](https://medium.com/fabric-ventures/in-pursuit-of-embodied-agi-d7f47f624ebd), [Defiant PR](https://thedefiant.io/news/press-releases/frodobots-lab-raises-8m-to-launch-bitrobot-a-crypto-network-of-subnets-for-embodied-ai-research), [FrodoBots AI site](https://www.frodobots.ai/), [EarthRover Mini Plus on HF](https://huggingface.co/docs/lerobot/en/earthrover_mini_plus).

**Overview.** FrodoBots crowdsources teleoperation data by gaming ($250 sidewalk robots, remote-control via browser). FrodoBots-2K dataset: 2,000 hours, 10+ cities, camera + GPS + IMU + audio + human control.

**BitRobot Network.** $8M seed. Built on Solana (not Bittensor — but borrows subnet model from Bittensor). Subnets for different embodied AI tasks: Subnet 1 = navigation data, Subnet 2 = autonomous model contests. Each subnet has its own incentive mechanism.

**Attribution.** Dataset is CC-BY-esque on HF Hub. No on-chain royalty flow mentioned publicly. Token rewards go to pilots for teleop sessions, not recurring from downstream model usage.

**Gap FrodoBots doesn't fill.** Recursive attribution from *model usage* back to *pilot who collected data*. Their flow is: pilot plays → gets paid once → data is licensed CC-BY → anyone can train on it for free. **PCC's flow is superior**: pilot mints DatasetNFT → royalty follows token → every downstream ModelNFT pays through the training manifest.

**Fit for PCC: 5/5 — as a customer.** PCC can onboard BitRobot as a dataset source: BitRobot-aggregated data becomes a DatasetNFT, and the single NFT redistributes to pilots via BitRobot's internal ledger. PCC supplies the downstream royalty layer that BitRobot lacks.

### 10.B Sahara AI

**Sources:** [CoinMarketCap](https://coinmarketcap.com/currencies/sahara-ai/), [Sahara docs tokenomics](https://docs.saharaai.com/tokenomics), [Sahara blog token intro](https://saharaai.com/blog/sahara-token), [BingX explainer](https://bingx.com/en/learn/article/what-is-sahara-ai-decentralized-ai-blockchain), [Messari profile](https://messari.io/project/sahara).

**Overview.** L1 blockchain purpose-built for AI. Four platforms:
1. Data Services Platform (DSP) — data labeling marketplace; contributors earn SAHARA tokens per task.
2. AI Developer Platform — model creation/deployment tooling.
3. AI Marketplace — on-chain hub for datasets, models, agents, compute.
4. Sahara Blockchain — the L1.

**Attribution.** "Every contribution recorded on-chain so you can always verify who provided each piece of data and how it was used." "Fair revenue sharing and transparent attribution."

**Tokenomics.** 10B SAHARA total supply. 64%+ to community/ecosystem.

**Fit for PCC: 3/5 (as inspiration, not integration).**
- Sahara's attribution story is marketed well but the technical details on *how* recursive royalty from model usage flows back to labelers are not clearly published.
- PCC should aim for a **more concrete, auditable** training-manifest story with Solidity-verifiable royalty flow (not just "transactions recorded on chain").
- Sahara is a potential cross-chain partner: PCC DatasetNFT could be listed on the Sahara AI Marketplace.

### 10.C 1X / Tesla Optimus / Physical Intelligence / Skild AI (pending)

### 10.D ORA's IMO (Initial Model Offering) — (covered in §9.B)

---

## More sections to come — TEE detail, Ceramic, Arweave, Lens, W&B, detailed Solidity pseudocode.
