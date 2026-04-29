# OpenClaw + PCC — Integration Spec

**Status**: Draft positioning + adapter spec, 2026-04-29.
**Authoring agent**: `impl-openclaw-bravo` on `feat/contributor-economics`.
**Audience**: Vincent Koc + the OpenClaw team; PCC implementers wiring the
  reference adapter; agent authors who want to compose the two protocols.

---

## 1. TLDR

OpenClaw runs cron-schedulable agents that do anything digital. PCC adds
physical capability — schedule a robot, mill a part, run an HPLC, settle
on-chain. This doc is how to wire them together.

---

## 2. The composition

OpenClaw and PCC compose along a clean seam: **digital substrate +
physical substrate**. Each side owns what it is best at and neither needs
to be retrofitted to make the integration work.

OpenClaw owns the trigger (cron, webhook, event), the LLM, the schedule
definition, the digital toolset (HTTP, email, file I/O, browser, every
existing MCP server) and the lifecycle of a long-running scheduled agent.
That is a complete substrate for "do anything digital."

PCC owns the four primitives that make a physical job billable and
verifiable: **discovery** (which physical capability is available, where,
at what price — DHT + agent-package + 218 tools), **execution** (the
kernel that actually runs the job on a real machine — OctoPrint, ROS,
SiLA, OPC-UA, Modbus, Opentrons, generic HTTP), **verification** (evidence
bundle + ALCOA+ checks + verifier attestation + drift detection +
photo/sensor capture with block-anchored nonce), and **settlement**
(USDC milestone escrow on Base, with `MilestoneEscrow.splitPayout` routing
funds to all attached contributors atomically).

Together: an OpenClaw agent that wakes up at 9 a.m. Monday, decides it
needs a 3D-printed prototype, submits a PCC job via
`pcc_submit_paid_job`, the kernel runs it, evidence comes back, USDC
settles. Fully autonomous, fully accountable, no humans in the critical
path.

This is not "PCC eats OpenClaw" or "OpenClaw eats PCC." It is one
agent runtime calling another agent runtime over a stable wire — same
shape as OpenClaw calling Stripe or GitHub today, except the side it is
calling can run a CNC mill.

---

## 3. The integration shape — three tiers

OpenClaw can integrate with PCC in three increasingly-coupled ways. Pick
the tier that matches the depth of integration you want; you can always
upgrade later without breaking earlier work.

### Tier 1 — REST integration (5 minutes)

The shallowest path. No new infra, no MCP plumbing, no schema work.

1. Once: have the OpenClaw agent fetch
   `https://capability.network/agent-package.json` and cache the 218
   tools (PUBLIC, no auth required).
2. Provision a PCC API key once via
   `POST /api/auth/provision` (returns `pcc_live_*`); store it as
   `PCC_API_KEY` in OpenClaw's secret store.
3. At schedule-fire time: call `pcc_submit_paid_job` with
   `{requestText, maxBudgetUsd, deadline}`. PCC handles discovery,
   negotiation, escrow funding, and execution scope creation in one shot.
4. Poll `pcc_job_settlement` until `paidAmount > 0` (success) or the
   deadline passes (timeout/dispute). Optionally subscribe to
   `GET /sse/stream/job/:jobId` for real-time progress.
5. Done. Each OpenClaw agent becomes a PCC requester with no further
   integration work.

This is the right tier if you want to prove value end-to-end before
investing in deeper coupling.

### Tier 2 — MCP integration (15 minutes)

The middle path. Reuses OpenClaw's existing MCP machinery; PCC's full
56-tool surface appears in OpenClaw's tool palette automatically.

1. Add the PCC MCP server (`packages/mcp-server`) to OpenClaw's bound
   MCP servers list:
   ```json
   {
     "mcpServers": {
       "pcc": {
         "command": "node",
         "args": ["packages/mcp-server/dist/index.js"],
         "env": {
           "PCC_URL": "https://capability.network",
           "PCC_API_KEY": "${PCC_API_KEY}"
         }
       }
     }
   }
   ```
2. OpenClaw's existing scheduling layer + tool-routing applies as-is.
   Schedules can pick from `pcc_submit_paid_job`, `pcc_capture_challenge`,
   `pcc_get_job`, `pcc_job_settlement`, plus the 52 other tools — no
   per-tool wiring required.
3. The trust gate stays where it should: OpenClaw decides which tools a
   given schedule may invoke; PCC decides what the gateway will accept.
   Two enforcement layers, no overlap.

This is the right tier if you have OpenClaw schedules that touch
physical work more than occasionally and want first-class tooling.

### Tier 3 — Native composition (1 day)

The deepest path. OpenClaw schedules become `CompositionManifest` entries
that earn lifetime royalties on every PCC job they orchestrate.

1. The OpenClaw schedule author publishes a sealed `RateSchedule` once via
   `POST /api/contributors/schedules` (e.g., flat 25 bps for life, or
   linear-decay 80→10 bps over 18 months — pick any of the 6 segment
   kinds in `packages/spec/src/types/rate-schedule.ts`).
2. They register a contributor profile with `role: "assembler"` (the
   role for "composed multiple capabilities into a workflow") via
   `POST /api/contributors`, binding their wallet address to that
   `scheduleHash`.
3. Optionally mint an on-chain `ContributorNFT` so the
   `(role, scheduleHash, ipId, metadataUri)` tuple is sealed on Base.
4. When PCC builds the payout map for any job whose
   `CompositionManifest` references that schedule's IP, the schedule
   author is automatically included in the on-chain `Payout[]` and gets
   paid in the same `release()` call that pays the operator.
5. Result: durable schedules that get reused = ongoing income, not just
   a one-time sale.

This is the alignment story. Schedule authors gain financially when
their schedules are durable and reused — the carrot for OpenClaw users
to write good, reusable physical-work compositions instead of one-shot
scripts.

Full mechanics in `docs/CONTRIBUTOR_ECONOMICS.md`. Deployment recipes in
`docs/DEPLOY_CONTRIBUTOR_ECONOMICS.md`. Adapter authoring economics live
in `docs/ADAPTER_BOUNTIES.md` (sister doc).

---

## 4. Worked example: the 9 a.m. Monday cron

A complete schedule, end-to-end. Adjust to actual OpenClaw syntax — the
shape is illustrative.

```yaml
# OpenClaw schedule definition (pseudocode)
schedule:
  name: "weekly-prototype-refresh"
  cron: "0 9 * * 1"               # 9 a.m. every Monday
  agent: "claude-sonnet-4-7"
  task: |
    Look at the design queue at internal://designs/queue.
    For each new design from the past week:
      1. Fetch the STL.
      2. Submit to PCC for FDM printing on PLA, white, 0.2mm layer
         height, within $30, ready by Friday EOD.
      3. Track until the evidence bundle is returned.
      4. Email the requester with photo + tracking URL.
      5. If any job fails or disputes, post to #ops Slack with the
         evidence-bundle ID for human review.
  pcc_integration:
    enabled: true
    method: tier-2-mcp
    pcc_url: https://capability.network
    pcc_api_key: ${PCC_API_KEY}
```

When this fires:

1. OpenClaw resolves the cron at 09:00 UTC Monday and instantiates the
   agent.
2. The agent reads the design queue, picks up new STLs.
3. For each STL, the agent calls (via Tier-2 MCP routing)
   `pcc_submit_paid_job` with:
   ```json
   {
     "requestText": "FDM print this STL in PLA white at 0.2mm layer height",
     "maxBudgetUsd": 30,
     "deadline": "2026-05-01T20:00:00Z",
     "stlUri": "ipfs://Qm.../prototype-rev3.stl"
   }
   ```
4. PCC runs discovery → negotiation → escrow funding → kernel dispatch
   → adapter execution (OctoPrint, in this case) → evidence capture
   (camera + sensor stream + block-anchored nonce) → ALCOA+ check → tier
   compliance → settlement.
5. The agent polls `pcc_job_settlement` (or subscribes to the SSE
   stream) until `paidAmount > 0`, then chains the email step using
   OpenClaw's native email tool.
6. Total agent compute time: ~30 seconds to schedule and dispatch;
   walk-clock time for the print itself is whatever the kernel takes
   (typically 2-6 hours for a small prototype).

The OpenClaw agent never touches the printer directly. The PCC kernel
never touches OpenClaw's secret store. The seam is one HTTP request
plus one SSE stream.

---

## 5. The OpenClaw author royalty path (Tier 3 detail)

The mechanics of "earn forever on a schedule you wrote once."

A schedule like the 9 a.m. Monday cron above represents real composition
work — the author decided what materials, what tier, what budget cap,
what failure escalation looked like. PCC's contributor economics treats
that composition as IP and pays it on every job that runs through it.

Walkthrough:

```bash
# 1. Publish a sealed RateSchedule. Server canonicalizes JSON, computes
#    sha256, returns the hash. Same JSON -> same hash, every time.
SCHEDULE_HASH=$(curl -s -X POST https://capability.network/api/contributors/schedules \
  -H "Authorization: Bearer $PCC_KEY" \
  -H "Content-Type: application/json" \
  -d '{
        "publishedBy": "0xYourSchedAuthorWallet",
        "schedule": {
          "version": 1,
          "segments": [
            {"kind":"constant","startTime":0,"endTime":null,"bps":25}
          ],
          "notes": "Flat 25bps assembler share for the weekly-prototype-refresh schedule"
        }
      }' | jq -r .scheduleHash)

# 2. Register a contributor profile bound to the schedule.
curl -X POST https://capability.network/api/contributors \
  -H "Authorization: Bearer $PCC_KEY" \
  -H "Content-Type: application/json" \
  -d "{
        \"address\": \"0xYourSchedAuthorWallet\",
        \"role\": \"assembler\",
        \"scheduleHash\": \"$SCHEDULE_HASH\",
        \"metadataUri\": \"https://openclaw.example/schedules/weekly-prototype-refresh\"
      }"

# 3. (Optional) Mint a ContributorNFT on-chain so anyone can verify
#    the schedule binding. See packages/contracts/script/MintContributor.s.sol
#    in docs/DEPLOY_CONTRIBUTOR_ECONOMICS.md.

# 4. Each PCC job submitted by your schedule attaches your contributor
#    profile to its CompositionManifest. At release(), splitPayout sends
#    your 25bps share directly to your wallet. No claiming, no off-chain
#    bookkeeping, no platform middleman.
```

A schedule that runs 50 jobs/week at $30 each = $1500/week throughput =
$3.75/week to the schedule author at 25 bps. Modest. The point is the
direction of incentive: ongoing reuse rewards good composition. A
schedule that runs 1000 jobs/day at $200 each becomes a meaningful
income stream for its author with no further effort.

The 10-role taxonomy supports this naturally — `assembler` exists
specifically for "composed multiple capabilities into a workflow." See
`docs/CONTRIBUTOR_ECONOMICS.md` §"Who earns what" for all 10 roles and
typical bps bands. There is **no OEM royalty class** by design — see
`docs/claros-layer4-amendment.md` for the rationale.

---

## 6. What PCC commits to (and what we are not)

**Commits**:

- Stable agent-package surface at `https://capability.network/agent-package.json`.
  Tools are added; existing tools' input schemas and endpoint paths do
  not change without versioning.
- Stable MCP tool names and shapes (`pcc_*`). 56 tools today, 7 of them
  contributor-economics primitives shipped 2026-04. Tool numbering may
  shift; tool names are forever.
- Apache-2.0 license on the core protocol, gateway, MCP server, and
  agent package. Adapters and examples land under the same license.
- Base Sepolia today; Base mainnet is the migration path. No chain swaps,
  no surprise rug.
- Public deploy artifacts: `ghcr.io/lamasu/physical-capability-cloud:prod`
  is reproducible from `master`; release-please cuts versions; rollback
  is retag-not-revert (see `docs/DEPLOY.md`).

**Not promising**:

- SLAs on the physical machines themselves. Those come from individual
  kernel operators per their reputation score (ERC-8004). PCC routes
  around bad actors; it does not insure against them at the protocol
  level.
- Legal indemnification. PCC publishes evidence bundles and verifier
  attestations; downstream legal claims (warranty, liability, IP) are
  the requester's, the operator's, and the integrator's to settle.
- Parity with OpenClaw's cadence of feature shipping. PCC ships when it
  ships; the integration is a stable wire, not a co-release commitment.
- Native UI inside OpenClaw. We work over HTTP and MCP — the surfaces.
  If OpenClaw wants a tile, OpenClaw owns that tile.
- Audit. The contributor-economics contracts have 40 forge tests
  passing; external audit (OpenZeppelin / Trail of Bits) is a v2 task
  before mainnet. Do not deploy to a chain handling real money without
  one.

---

## 7. Concrete asks of OpenClaw

Coordination items, ordered low-cost to high-cost:

1. **A first-class adapter in OpenClaw's tool registry** (Tier 2 MCP).
   Mount `packages/mcp-server` as a recommended PCC adapter. We will
   maintain the adapter and bump it on every breaking MCP version.
2. **A reference example in OpenClaw's docs** — "schedule a 3D print
   every Monday." Use the worked example from §4 as the seed; we'll
   review for accuracy.
3. **Co-marketing on a Tier 3 worked example** — an OpenClaw schedule
   that earns PCC royalties end-to-end. We can co-author a post showing
   `assembler`-role economics for schedule authors, with a real
   `ContributorNFT` on Base Sepolia.
4. **A 30-minute architectural call** with Vincent Koc and the PCC team
   to align on the integration shape, error semantics, idempotency
   keys, and the cross-link doc structure. The earlier the better.
5. **Mutual cross-link** in respective docs. PCC links to OpenClaw's
   adapter docs from this file; OpenClaw links back from the
   integration page. Both protocols benefit from being legible to the
   other's users.

---

## 8. What this looks like for OpenClaw users (in their voice)

> "You already use OpenClaw to schedule digital tasks. PCC adds physical
> capability with two API calls. If you write schedules that touch
> physical output — print parts, run lab assays, mill prototypes,
> orchestrate assembly — your scheduling work can now earn you per-job
> royalties for as long as people use it. The protocol is on Base, the
> integration is one MCP server connection, and the Apache-2.0 reference
> adapter ships in under 250 lines of TypeScript."

---

## 9. Footer + cross-links

- `docs/CONTRIBUTOR_ECONOMICS.md` — the full protocol primitives:
  10-role taxonomy, RateSchedule DSL, on-chain split mechanics
- `docs/AGENT_INTEGRATION.md` — the 218 agent-package tools + MCP
  server + REST surface
- `docs/DEPLOY_CONTRIBUTOR_ECONOMICS.md` — forge scripts, contract
  addresses, cast-send recipes for Base Sepolia
- `docs/ADAPTER_BOUNTIES.md` — sister doc on adapter-author economics
  (parallel: assembler/integrator royalty paths)
- `docs/AGENTIC_FUNDING.md` — agent funding, fiat ramps, USDC supply
- `https://capability.network/agent-package.json` — the live 218-tool
  package OpenClaw agents fetch and cache

**Date**: 2026-04-29
**Branch**: `feat/contributor-economics`
**Contact**: PCC Network Discord — https://discord.gg/CRFvvUgeV4
**License**: Apache-2.0 (protocol + adapter reference)
