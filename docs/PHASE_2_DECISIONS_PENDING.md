# Phase 2 — Decisions Pending Human Input

Aggregated open questions surfaced by the Phase 2 scoping research wave (2026-05-23 / 2026-05-25). Each question has a default-pick the implementer can use if no answer arrives, but most benefit materially from a human choice. Ordered by which scoping doc they came from.

For the full design context behind each question, read the corresponding scoping doc — paths are absolute.

---

## A. PLR Backend-Author Smart Contracts + Kill-Switch

Source: `C:\Users\globa\physical-capability-cloud\ai\scoping\plr-backend-author-economics-2026-05-25.md`

The 10 questions the design surfaces, ordered roughly by how blocking each is for shipping:

1. **Default rate-schedule preset for PLR authors** — proposal range was 1 to 25 bps per call. What's the suggested default if an author doesn't specify? Higher = stronger incentive to register, lower = stronger incentive for operators to adopt. Reasonable starting point: **5 bps flat-for-life** (matches existing `protocol-author` default if there is one — confirm).
2. **Registry chain placement** — Base mainnet (consistent with existing PCC contracts, ~$0.01-$0.05 per `register()` call) or a dedicated L3 (cheaper but adds bridging). Default: **Base mainnet for the registry**, payouts via existing MilestoneEscrow on Base.
3. **ERC-8004 agent identity depth** — Phase 1: simple "delegated agent address" stored on the BackendRecord. Phase 2: full ERC-8004 with attestation + reputation. Default: **Phase 1 first, Phase 2 when ERC-8004 mainnet is live and PCC has dogfooded its own usage**.
4. **Splits.org tooling vs point-at-Splits.org** — do we ship a one-click "deploy a 0xSplits contract for my co-authors" flow in the author-onboarding UI, or just link out to splits.org/docs and tell authors to bring a deployed address? Default: **link out for Phase 1; build the integration if 3+ authors ask for it**.
5. **Authorship-transfer timelock duration** — proposal is 7 days. Could be 24h (faster legitimate transfers) or 14 days (more public-notice safety). Default: **7 days**, matches the existing pattern in other PCC governance ops.
6. **Lost-wallet recovery** — author wallet lost, no recovery seed. Options: (a) no recovery ever (caveat emptor); (b) PCC governance can re-route after a 30-day public attestation window + multisig vote; (c) require multisig at registration (forces redundancy). Default: **(b)** with a tight + audited governance process — this matches DAO norms and avoids strict caveat-emptor.
7. **Kill-switch refund semantics** — when an author flips `enabled = false`, what happens to escrow on in-flight jobs targeting that backend? Options: (a) no refund, job continues to settlement; (b) automatic refund of unreleased milestones; (c) requester chooses at submission time. Default: **(a)** — forward-only kill-switch, in-flight jobs continue. Critical bugs go through existing dispute machinery, not the kill-switch.
8. **Earnings privacy** — should per-author earnings be public (auditable on-chain via splitPayout events) or hashable so only the author sees their totals? Default: **public** — matches existing PCC contributor-economics transparency and creates the leaderboard effect that attracts new authors.
9. **Outreach mechanics for getting initial PLR authors registered** — who does the cold-outreach to the PLR community (forum post, GitHub issue on PyLabRobot/pylabrobot, direct DM to top contributors)? Default: **public forum post + a "Claim your backend" page** on capability.network; let authors self-discover. Active outreach only after the page is live.
10. **`ipId` derivation when binding to Story Protocol IP** — does the PLR module path get used directly as the ipId, or do we mint a Story IP Asset first and use its ID? Story integration buys derivative-licensing primitives but ties us to Story's chain. Default: **direct hash of module path for Phase 1; optional Story IP overlay as a Phase 2 enhancement when an author opts in**.

**Bonus question that came up in conversation but isn't in the original 10:**

11. **NFT model** — mint a new `BackendAuthorNFT` contract per registration vs reuse the existing `ContributorNFT` with `role = "backend-author"` so NFT ownership = authority. Recommendation (informal): **reuse `ContributorNFT`**; the existing tuple `(role, scheduleHash, ipId, metadataUri)` already fits, the registry just queries `ContributorNFT.ownerOf()` instead of holding its own `authorAddress` field. Saves ~50 LOC, gives authors standard NFT-ecosystem affordances (transfer, marketplace, multisig ownership via Splits.org as the NFT owner). Bake this in before the registry contract gets written.

---

## B. Other Phase 2 Scoping Docs (open questions deferred to each doc's §)

Each of the 8 Phase 2 scoping deliverables from 2026-05-23 has its own open-questions section. Skim each before greenlighting the corresponding implementer wave:

| Scoping doc | Open-questions section | Doc path |
|---|---|---|
| **x402 micropayment gating** | §11 (10 questions) | `ai/scoping/x402-aggregator-gating-2026-05-23.md` |
| **Vespa hybrid ranking** | §9 (10 questions: weight defaults, denorm cadence, embedding provider strategy, shadow duration, profile inheritance, etc.) | `ai/scoping/vespa-hybrid-ranking-2026-05-23.md` |
| **On-chain receipt anchoring** | §11 (10 questions) | `ai/scoping/onchain-receipt-anchoring-2026-05-23.md` |
| **DCC4 TEE + DCC5 zkSNARK** | §13 (TEE platform mix + zkVM mix + opt-in vs auto-flow) | `ai/scoping/dcc4-dcc5-auto-flows-2026-05-23.md` |
| **A2A v1.0 extensions (gRPC + Signed Cards + webhooks)** | §5 (Q1 ERC-8004 binding, Q2 per-kernel card signing, Q4 webhook credential isolation, Q7 Railway gRPC proxy, Q8 PCC-intent visibility) | `ai/scoping/a2a-v1-extensions-2026-05-23.md` |
| **4-level federation** | §14 (13 questions incl. libp2p vs custom, Postgres replication mode, CRDT primitives in-house vs library, cross-region propagation budget) | `ai/scoping/4-level-federation-2026-05-23.md` |
| **AGNTCY ADS + OASF bridge** | §11 (12 questions incl. OIDC client registration with Outshift, OASF skill-taxonomy contribution PR for `manufacturing/*` + `biotech/*`, REST vs gRPC, DHT self-hosting timing) | `ai/scoping/agntcy-ads-oasf-bridge-2026-05-23.md` |
| **Demand-feed monetization** | §13 (10 questions incl. pricing anchors, federation with universal-tool-aggregator IndexedTool layer, optional tamper-evidence hash to oracle's on-chain log) | `ai/scoping/demand-feed-monetization-2026-05-23.md` |

---

## C. Admin / external actions (network infrastructure, separate from product decisions)

Tracked separately from product decisions because these are pure execution (no design call, just doing the thing). The original `AGENT_NETWORK_RUNBOOK.md` covered these but didn't survive a rebase earlier this session — re-listing minimally here:

1. **DNS SVCB record** at `_agents.capability.network` (DNS-AID compatibility — zero code, just a record in Cloudflare DNS)
2. **Submit PCC MCP server to 6 MCP directories** (Anthropic Official → Glama → mcp.directory → mcp.so → Smithery → PulseMCP)
3. **Submit OpenAPI spec to APIs.guru** (PR to github.com/APIs-guru/openapi-directory) — works now that `feat/openapi-spec` is merged as PR #30
4. **Submit `capability.network` to nothumansearch.ai** (form)
5. **Register ENS name** (`capability.eth` or fallback `pcc-network.eth`, ~$5/yr)
6. **Set ENSIP-25 text record** on the ENS name once held (binds ENS ↔ ERC-8004 agent identity)
7. **Promote ERC-8004 contracts from testnet to mainnet** (waits on canonical singletons deploying on Ethereum mainnet)
8. **Cross-list PCC lab capabilities on Opentrons Marketplace** (form submission)
9. **Decide PLR-backend-author registry's chain placement** (see A.2 above)
10. **Spark / Tailscale**: keep a stable connection so agents can offload heavy builds without auth-lapse interruptions (intermittent issue throughout 2026-05-24/25 sessions)

---

## D. Tracked-but-deferred features (not in any scoping doc)

Items raised in conversation but not yet scoped formally:

- **Mfg templates wave 2** — dmls (metal 3D) + urethane-casting. Held per user direction; ready when you greenlight. Catalog at `ai/research/manufacturing-capability-catalog-2026-05-23.md` §Top-5 has the full spec.
- **Tier 2 mfg templates** (16 templates: cnc-5axis, mjf, sls, carbon-dls, polyjet, binder-jet-metal, die-casting, metal-stamping, compression-molding, lsr, tube-bending, laser-tube-cut, plastic-extrusion, metal-extrusion, weldment-assembly, vapor-smoothing). Per same catalog doc.
- **PCC Android app** — full briefing at `C:\Users\globa\projects\pcc-android-app\BRIEFING.md`. Ready when you start that session.
- **Recreate `docs/AGENT_NETWORK_RUNBOOK.md`** — lost in this session's rebase chaos. Contents partially captured above in §C. Worth restoring as a standalone doc if you want a single canonical operator runbook.

---

## Update protocol

When a question gets answered, prefer:
1. Move the answer into the corresponding scoping doc's open-questions section (keeps the design + decisions together)
2. Strike the question from this doc with a `~~strikethrough~~` and a one-line note pointing at the answer location
3. If the answer requires code, open a follow-up task for the implementer to thread through

When new Phase 2+ scoping docs land, add their open-questions section to §B.
