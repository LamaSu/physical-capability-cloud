# Landscape: Dataset + Model Attribution with Recursive Royalty Flow

**Agent:** scout-provenance-charlie
**Date:** 2026-04-22
**Mission:** Research how to implement recursive attribution for robotics datasets and AI models, so that when a robot executes a PCC job using ModelNFT M, payment flows through M's training manifest to DatasetNFT contributors pro-rata.

## Progress

- [x] 1a. Open-X Embodiment + RT-X
- [ ] 1b. LeRobot v3 detail
- [ ] 1c. Robomimic / RoboTurk / BridgeData / Isaac Sim
- [ ] 2. Model training manifests (HF cards, MLflow, W&B, DVC)
- [x] 3a. Story Protocol IP Graph
- [x] 3b. Ocean Protocol Data NFT/Datatoken
- [ ] 3c. Lens / Audius / Art Blocks
- [ ] 4. Data provenance + content addressing (IPLD, Ceramic, Arweave, PROV, C2PA)
- [ ] 5. Training-mix encoding on-chain
- [ ] 6. Dataset NFT specifications (Ocean, Story, EIP-7007, EIP-7015)
- [ ] 7. License compatibility + revenue share
- [ ] 8. Identity for pilots + trainers
- [ ] 9. Training attestation (TEE, zkML)
- [ ] 10. Existing robotics-data economy projects

---

## 1. Robotics Datasets + Open Attribution

### 1.A Open-X Embodiment (Google DeepMind, Oct 2023)

**Source:** arXiv 2310.08864. Website: https://robotics-transformer-x.github.io/. Paper: https://arxiv.org/abs/2310.08864. GitHub: https://github.com/google-deepmind/open_x_embodiment. Dataset: https://huggingface.co/datasets/jxu124/OpenX-Embodiment.

**Scale.** 1M+ real robot trajectories, **22 embodiments** (single arms, bimanual, quadrupeds), **527 skills**, **160,266 tasks**, **60 constituent datasets**, **21 contributing institutions**. Assembled as a union of existing robotics datasets, not newly-collected.

**License stack.**
- Software (training code, scripts, loaders): **Apache-2.0**
- Data (trajectories, all non-code material): **CC-BY-4.0**
- Individual constituent datasets retain their own licenses; users must check the **dataset spreadsheet** linked from the site for per-dataset citation + license.

**Attribution mechanism.** Users of RT-X (the model trained on OXE) are asked to:
1. Cite the Open-X Embodiment paper.
2. Cite every constituent dataset they specifically loaded.

No on-chain mechanism. No royalty flow. Pure academic-citation attribution. **This is the state of the art in open robotics data attribution, and it's still literally "cite us in your paper."** PCC can materially improve on this with DatasetNFTs.

**RT-1-X vs RT-2-X.**
- RT-1-X: 35M params, trained *only* on the OXE robotics mixture.
- RT-2-X: 55B VLM (PaLI-X) co-fine-tuned with ~50/50 VLM + robotics data.

**Training mix composition.** The RT-X paper explicitly reports per-dataset sampling weights during training — the mixture is not uniform; high-quality datasets like RT-1 and Bridge are upweighted. This is exactly the weight-basis-points vector PCC's TrainingManifest needs to encode.

**Fit for PCC: 5/5.** This is the canonical robotics dataset to bootstrap a DatasetNFT catalog. If PCC wraps the OXE constituent datasets as 60 DatasetNFTs (with original owner = institution), every future robotics model trained on OXE has a natural royalty destination list. The CC-BY license is commercially-permissive, so wrapping in an NFT is legal as long as attribution is preserved in the token metadata.

### 1.B LeRobot (HuggingFace)

**Source:** https://github.com/huggingface/lerobot. v3 blog: https://huggingface.co/blog/lerobot-datasets-v3.

**Format.** `LeRobotDataset` = Parquet (state/action/metadata) + MP4 (vision), hosted on the Hugging Face Hub, streaming-friendly. v3 (2025) packs multiple episodes per file, uses relational metadata for episode lookup (episode boundaries resolved via metadata, not filenames).

**License.** Software: Apache-2.0. Individual datasets on the Hub are per-dataset — some CC-BY, some CC-BY-SA, some Apache-2.0, some proprietary/research-only. **The Hub does NOT enforce a canonical license**; it's up to the uploader.

**Attribution.** HF Hub dataset cards (Markdown with YAML frontmatter) include:
- `license:` field (SPDX identifier)
- Citation (BibTeX) in the card body
- `dataset_info:` — size, splits, features
- Custom fields (no standard for training-mix pointers)

**Fit for PCC: 4/5.** LeRobot is where the mass of robotics datasets lives. DatasetNFT should be able to **point to** a LeRobotDataset on HF Hub by `{repo_id, revision_sha}` rather than duplicating storage. Content-addressing: HF revisions are git-sha commits, so `(repo_id, revision_sha)` is a stable reference.

### 1.C Other robotics datasets to cover

TO RESEARCH: Robomimic / RoboTurk / BridgeData / Isaac Sim — attribution practices, license structure, whether any enforce chain-level attribution (spoiler: none do).

---

## 3. On-Chain IP / Attribution Systems

### 3.A Story Protocol — Programmable IP Blockchain (Key Reference)

**Source:** Story Foundation (https://www.story.foundation/). Whitepaper: https://www.story.foundation/whitepaper.pdf. Docs: https://docs.story.foundation/introduction. Background: https://www.figment.io/insights/story-protocol-first-look-bringing-ip-on-chain/. Overview: https://oakresearch.io/en/reports/protocols/story-protocol-ip-comprehensive-presentation-blockchain-intellectual-property.

**Thesis.** Story is a **purpose-built Layer 1** blockchain for intellectual property. The core innovation: **Proof-of-Creativity (PoC)**, an open Programmable IP protocol treating IP as a first-class blockchain entity. IP assets are registered as NFTs (ERC-721 `IPAsset`s) and linked into a graph of parent-child (derivative) relationships, with licenses enforced by on-chain modules.

**Key primitives.**

1. **IPAsset** — the tokenization unit. Wraps any existing NFT (image, song, dataset, model) and gives it an IPAccount (smart-contract wallet per asset, ERC-6551-style) that can receive royalties.
2. **IPGraph** — the parent-child relationship graph. When you remix, fine-tune, or derive from a parent IPAsset, you register the derivative on-chain with a link to the parent.
3. **Programmable IP License (PIL)** — on-chain license terms (commercial/non-commercial, derivatives allowed, minimum royalty, fixed mint fee, etc.). PIL licenses are themselves NFTs (ERC-721 `LicenseToken`s) that can be minted by derivative creators.
4. **Royalty Module** — automates revenue flow between parent and child IPAssets. Two built-in policies:
   - **Liquid Absolute Percentage** (LAP): flat % of all derivative revenue.
   - **Liquid Relative Percentage** (LRP): each hop takes % of what passed through.
   - Permissionless custom policies also supported.
5. **Dispute Module** — on-chain challenge of infringement claims.

**Royalty flow mechanism.** Key insight from docs: "Each parent IP Asset establishes a minimum royalty percentage that dictates the share of revenue that **direct derivative IP Assets in a derivative chain must allocate to their parent IPs**." This is *recursive by construction*: a derivative of a derivative owes royalties up the whole chain (bounded by gas).

**Chain.** Story Mainnet launched Feb 13 2025 (EVM-compatible L1). The $IP token funds gas + governance.

**Fit for PCC: 5/5.** Story Protocol is **the reference implementation of recursive on-chain attribution**. PCC has two integration options:
- **(A) Deploy on Story directly.** Register every ContributorNFT, DatasetNFT, ModelNFT as Story IPAssets. Training manifests become IPGraph parent-child links. Use LAP policy for the "10% to training data" split. Story's Royalty Module handles recursive traversal automatically.
- **(B) Take inspiration, build native on Base.** Model our TrainingManifest on IPGraph semantics but keep it in our own contracts. More control, more implementation work. Already partially done: PCC's `/api/ip/*` endpoints already talk to Story Protocol for capability IP registration (per `pcc_ip_register_capability`). Extending this to dataset/model IP is a natural next step.

**Recommendation:** **Option A + B hybrid.** Register DatasetNFTs + ModelNFTs as Story IPAssets (gets us recursive royalty for free). Keep the robot-job-payment origination on Base Sepolia (MilestoneEscrow). Bridge: when an escrow releases, call a Story pre-compile that records the revenue event and lets Story's Royalty Module distribute.

### 3.B Ocean Protocol — Data NFTs + Datatokens

**Source:** Ocean Protocol docs (https://docs.oceanprotocol.com/developers/contracts/datanft-and-datatoken). Also: https://docs.oceanprotocol.com/developers/contracts/data-nfts.

**Two-token model.**
- **Data NFT (ERC-721)** — represents *copyright/base IP* of a data asset. One data NFT per dataset. Stores metadata, mint roles, fee roles, open key-value store for custom fields.
- **Datatoken (ERC-20)** — represents *licenses* to *access* the data. Holding 1.0 datatoken = one consumption right. Fungible, tradeable on DEXes. Multiple datatoken contracts can be minted from one Data NFT (each datatoken = different license terms).

**Why this matters for PCC.** The two-token pattern *separates ownership from access*. PCC's DatasetNFT should follow: **DatasetNFT (ERC-721) = who gets paid / who owns the data**; **DatasetAccessToken (ERC-20) = who is permitted to use it for training** (one AccessToken per training run). This cleanly enables:
- Royalty to DatasetNFT holder (even if ownership transfers, royalty follows the NFT)
- Permissioned training (burn one AccessToken per ModelNFT that includes this dataset)
- Different license tiers (a "for-profit training" AccessToken @ 1000 OCEAN; a "research training" AccessToken @ 10 OCEAN — distinct ERC-20s)

**Consumption flow.** When a consumer sends 1.0 datatoken to the publisher, Ocean's infrastructure (Provider + Aquarius) grants access to the underlying data URL, typically time-bound. This is the **compute-to-data** pattern when the data is too sensitive to download.

**Compute-to-Data (C2D).** Ocean's additional primitive: consumer sends datatokens, publisher's Provider *runs consumer's algorithm* on the data inside a TEE, returns only the result. Data never leaves the publisher. PCC can adopt this for private training — trainer's training job is run inside the dataset holder's sandbox, and training manifest is attested by the TEE. This directly answers the "how do we verify ModelNFT really used these DatasetNFTs?" question (see section 9).

**Fit for PCC: 5/5.** Ocean's design is the cleanest prior art for tokenized datasets with on-chain access control. We should adopt the two-token pattern and seriously consider C2D for private training.

### 3.C Lens / Audius / Art Blocks — other attribution / royalty patterns

TO RESEARCH — especially Audius's split-pay model (artists + producers + labels), since it's structurally identical to "model creator + dataset contributors + base-model creator."

---

## Continuing research…
