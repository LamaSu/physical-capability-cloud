## MANDATORY: DGX Spark Offload

**ALWAYS check Spark availability (`spark-check`) at session start and offload ALL builds, tests, and heavy work to the DGX Spark (192.168.108.72, 119GB RAM).** The local machine has only 16GB RAM and WILL OOM on builds, parallel tests, and multi-agent workloads. Use `spark-run` for everything. No exceptions.

- `spark-run "cd ~/projects/physical-capability-cloud && pnpm build --concurrency=1"` — build
- `spark-run "cd ~/projects/physical-capability-cloud && pnpm --workspace-concurrency=1 -r test"` — test
- `spark-run "cd ~/projects/physical-capability-cloud && pnpm install"` — install
- If Spark is down, use `--concurrency=1` locally and warn the user about OOM risk.

## MANDATORY: Security — Gate A Vetting Pipeline

All new tools, MCP servers, npm packages, and external dependencies MUST pass through Gate A vetting before being approved for use in this project.

### How to Vet
- Run `/vet <package-path>` on any new tool/package before integration
- Runs up to 7 scanners: Trivy (vulns+SBOM), Gitleaks (secrets), ClamAV (malware), npm audit, pip-audit, Semgrep (SAST), prompt injection detection
- Scanners degrade gracefully if not installed. Prompt injection scanner always runs.

### Policy Thresholds (from `~/.claude/plugins/vetting-policy.json`)
- Critical vulnerabilities: 0 allowed (auto-reject)
- High vulnerabilities: max 2 (warn on any)
- Medium vulnerabilities: max 10
- Secrets in source: 0 allowed (auto-reject)
- Malware: auto-reject, no override
- Prompt injection signals: max 1 (warn on any)

### Verdicts
- **PASS**: Clean, auto-approved
- **WARN**: Suspicious findings, human reviews before use
- **FAIL**: Critical vulns, secrets, or malware — auto-rejected

### When to Vet
- Before adding any new npm dependency to any package
- Before integrating any MCP server
- Before running any third-party script
- After forging a new MCP server with `/forge`
- Reports saved to `ai/supervisor/forge_approvals/`

## MANDATORY: Action Classification

Every tool call is classified by the tool-broker into one of 5 action classes:

| Class | Tools | Gate |
|-------|-------|------|
| read | Read, Glob, Grep, WebSearch, WebFetch | Open |
| write | Write, Edit, NotebookEdit | Role-checked |
| exec | Bash, Agent/Task | Role-checked + keyword scan |
| network | WebFetch, WebSearch, mcp__* | Role-checked |
| credential | Detected via keyword scoring in args | Always flagged |

Dangerous keywords (rm -rf, git reset --hard, git push --force, drop table, curl | sh) are scored 0.0-1.0. Actions scoring >0.5 are dual-logged and may be denied per agent allowlist.

### Per-Agent Allowlists (from `~/.claude/plugins/action-policy.json`)

| Agent | Allowed Tools | Action Classes |
|-------|--------------|----------------|
| supervisor | all | all |
| implementer | Bash, Read, Edit, Write, Glob, Grep | read, write, exec |
| researcher | Read, Glob, Grep, WebFetch, WebSearch | read, network |
| wheel-scout | Read, Glob, Grep, WebFetch, WebSearch | read, network |
| forger | Bash, Read, Edit, Write, Glob, Grep, WebFetch | read, write, exec, network |
| vet-scanner | Bash, Read, Write, Glob, Grep | read, write, exec |
| test-writer | Read, Write, Bash, Glob, Grep | read, write, exec |
| memory-scribe | Read, Write | read, write |
| context-hydrator | Read, Glob, Grep | read |
| skill-router | Read | read |
| browser | mcp__chrome-devtools__* | network |

## MANDATORY: Deploy Pipeline (Build-Once, Deploy-Many)

PCC uses GHCR artifact promotion. **One** Docker image per master push is retagged through staging → prod without rebuilding. Full runbook: `docs/DEPLOY.md`. Any agent touching `.github/workflows/`, `Dockerfile`, or `railway.toml` MUST follow these rules.

### The pipeline
- **CI** (`.github/workflows/ci.yml`): `build-and-test` → `forge-tests` → `build-image` (pushes `ghcr.io/lamasu/physical-capability-cloud:<sha>` and `:latest`) → `deploy-staging` (retags `:sha` → `:staging`, smoke-checks `${{ vars.STAGING_URL }}/api/health` if set).
- **Prod promotion** (`.github/workflows/deploy-prod.yml`): `workflow_dispatch` with a `sha` input. Clicking "Run workflow" IS the gate (GH Free on a private repo can't enforce required-reviewer rules). Verifies the source tag exists, retags `:sha` → `:prod`, smoke-checks `https://capability.network/api/health`.
- **Release** (`.github/workflows/release.yml`): `release-please` watches Conventional Commits on master, maintains a rolling release PR, cuts `vX.Y.Z` + CHANGELOG on merge, retags GHCR image with the semver tag.

### Railway mapping (Ryan's `diplomatic-compassion` project)
| Railway env | Source (target) | GHCR tag watched |
|---|---|---|
| `production` | `Docker Image` (once switched) | `ghcr.io/lamasu/physical-capability-cloud:prod` |
| `staging` | `Docker Image` (once switched) | `ghcr.io/lamasu/physical-capability-cloud:staging` |

Both envs currently still use the Dockerfile builder — they will be switched to image-pull only after the first CI run populates each tag.

### Rules when touching CI/CD or Dockerfile

1. **Never rebuild when you can retag.** `docker buildx imagetools create --tag <new> <source>` is a manifest-level operation. No layers re-uploaded, no drift between envs.
2. **Never swap a Railway service's image source** to a tag that doesn't exist yet. Verify with `docker buildx imagetools inspect ghcr.io/.../...:<tag>` first. If the tag is missing, the service crashes on next deploy.
3. **Rollback = retag, not revert.** `docker buildx imagetools create --tag ghcr.io/lamasu/physical-capability-cloud:prod ghcr.io/lamasu/physical-capability-cloud:<prev-sha>` and Railway picks up the digest change in seconds.
4. **Prod promotion is always manual.** Do NOT add an automatic `push-to-master` → `:prod` path to `ci.yml` unless (a) the repo has upgraded to GH Pro AND (b) the `production` environment has a required-reviewer rule configured.
5. **Version bumps go through release-please.** Do NOT edit `package.json` `version`, `CHANGELOG.md`, or `.release-please-manifest.json` by hand. Merge the release PR instead.
6. **Conventional Commits are required.** `feat:` / `fix:` / `perf:` / `deps:` / `revert:` / `docs:` / `refactor:` / `ci:` / `chore:` / `test:` / `build:`. Without this, release-please classifies commits incorrectly and CHANGELOG entries go missing.
7. **Dockerfile is transitional.** The long-term path is GHCR-only on Railway. If you edit the Dockerfile, verify the resulting image still boots under the `:staging` tag before anyone promotes it to `:prod`.
8. **Staging secrets are duplicated from prod.** When the staging env was created, Railway cloned prod variables (DEPLOYER_PRIVATE_KEY, LIT_API_KEY, etc.). Treat staging with the same secret-handling care as prod until secrets are rotated.

## RECOMMENDED: Workflow Runtime (`@pcc/workflow`)

PCC ships a library-only durable execution package at `packages/workflow/` — embeddable in any TS Fastify monolith, no separate workflow server. RECOMMENDED (not MANDATORY) for new code that does on-chain calls, evidence uploads, or multi-step protocol orchestration. Opt-in — existing routes keep working unchanged until their migration PR lands.

- **What it is**: 5 primitives — `Activity` (idempotent wrapper for side effects with retry + 3-tier idempotency keys + semantic on-chain key helper), `Workflow` + `WorkflowEngine` (Inngest-style step memoization with crash recovery), `DataPort` (CID handoff), `getVersion` (Temporal-style versioning marker), `cwlExport` (CWL v1.2 YAML for external interop). Backed by one SQLite file. ~1,400 LOC, 146 tests, depends only on `better-sqlite3`, `yaml`, `zod`, `@pcc/spec`.
- **When to use it (vs raw async)**: any side effect that's expensive or dangerous to repeat (on-chain tx, payment, evidence upload, external API write); any place you want exactly-once-on-chain semantics across crashes; any multi-step flow where "lost on restart" is unacceptable. Don't bother for read-only HTTP, pure functions, or sub-ms operations — the SQLite INSERT overhead isn't worth it.
- **Docs**: `docs/WORKFLOW_RUNTIME.md` is the deep dive (architecture, adoption guide with worked migration sketch, FAQ). `packages/workflow/README.md` is the public-API quick-start. `ai/research/pcc-workflow-runtime-design.md` is the 1,800-line design spec.
- **Migration roadmap (3 phases, follow-up PRs after the Wave 3 PR merges)**:
  1. **Phase 1** — wrap `escrow.ts` `/fund`/`/release`/`/dispute` routes as Activities (~300 LOC + ~200 LOC route changes; LOW breaking risk; HTTP shape unchanged).
  2. **Phase 2** — replace `protocol-runner.ts` `runs: Map` with an EventStore-backed `Workflow` subclass (~500 LOC; MEDIUM breaking risk; in-flight runs need drain-before-deploy).
  3. **Phase 3** — add `GET /api/protocols/:id/cwl` endpoint via `cwlExport` (~80 LOC route + ~50 LOC adapter; ZERO breaking risk; new endpoint).
- **v0.1 limitations** (warn before adopting): `ctx.sleep(id, ms)` throws `NotImplementedError` (durable timers land in v0.2 — use `setTimeout` inside `ctx.step` for non-durable delays); no child workflows (`ctx.startChild` lands in v0.2); single-process signal delivery only (no horizontal scaling of the gateway against one SQLite file); no per-activity `timeoutMs` yet. Full list in `packages/workflow/CHANGELOG.md`.
- **Operational note**: `@pcc/workflow` reads NO env vars itself — consumers must pass `path` to `openSqliteStore({ path })`. Recommended convention: `process.env.WORKFLOW_DB_PATH ?? '/data/workflow.sqlite'` (gateway). Railway requires a mounted volume — see `docs/DEPLOY.md` for the deploy-side note.

# Physical Capability Cloud (PCC) — Agent Integration Guide

## 1. What Is PCC

PCC is AWS for the physical world. It is a cloud control plane for physical manufacturing capabilities.

- **Shop Kernels** = Availability Zones. Each kernel is a physical site (lab, workshop, factory) with equipment.
- **Capabilities** = billable units. Not machines — what machines can DO (3D printing, CNC milling, HPLC analysis).
- **Assurance Tiers** = SLAs. Evidence depth + liability + dispute rules, graded 0-3.
- **Settlement** = milestone escrow on-chain (Base Sepolia). Funds release only when evidence meets tier requirements.
- **Agents** = first-class citizens. Every operation is an API call. Human dashboards and AI agents use the same endpoints.

**Live gateway**: `https://capability.network`

---

## 2. Quick Start: Get Your Agent Running

### Step 1: Get an API key

```bash
curl -X POST https://capability.network/api/auth/provision \
  -H "Content-Type: application/json" \
  -d '{"email": "operator@example.com", "name": "My Workshop", "capability": "FDM 3D printing"}'
```

Response (201):
```json
{
  "api_key": "pcc_live_abc123...",
  "key_id": "key-uuid",
  "operator_id": "operator@example.com",
  "scopes": ["*"],
  "rate_limit": 100,
  "expires_at": null,
  "warning": "Save this API key now — it will not be shown again.",
  "usage": {
    "header": "Authorization: Bearer pcc_live_abc123...",
    "example": "curl -H \"Authorization: Bearer pcc_live_abc123...\" https://capability.network/api/capabilities/types"
  }
}
```

You can also provision with a wallet address instead of email:
```json
{"walletAddress": "0x1234...abcd", "name": "My Workshop"}
```

**Alternative**: If you have an invite code, use `POST /api/onboard/redeem` with `{inviteCode, email, password}` to get a key plus wallet, identity, and LLM proxy access in one call.

### Step 2: Authenticate all requests

Set `Authorization: Bearer <key>` on every request. Without it, all endpoints return 401.

### Step 3: Check what capabilities exist

```bash
curl -H "Authorization: Bearer $PCC_KEY" \
  https://capability.network/api/capabilities/types
```

Response:
```json
{"types": ["3d-printing", "cnc", "laser-cutting", "hplc", "pcb", "injection-molding", ...]}
```

### Step 4: Build a contract (discovery to escrow)

```bash
# 1. Get build options for a capability type
curl -X POST https://capability.network/api/build/options \
  -H "Authorization: Bearer $PCC_KEY" \
  -H "Content-Type: application/json" \
  -d '{"type": "3d-printing"}'

# 2. Calculate price with your selections
curl -X POST https://capability.network/api/build/price \
  -H "Authorization: Bearer $PCC_KEY" \
  -H "Content-Type: application/json" \
  -d '{"type": "3d-printing", "selections": {"material": "PLA", "infill": 20, "layer_height": 0.2}}'

# 3. Build the contract
curl -X POST https://capability.network/api/build/contract \
  -H "Authorization: Bearer $PCC_KEY" \
  -H "Content-Type: application/json" \
  -d '{"type": "3d-printing", "selections": {"material": "PLA", "infill": 20}, "assuranceTier": 1}'
```

---

## 3. Complete API Reference

All endpoints are under `https://capability.network`. All require `Authorization: Bearer <key>` except where noted as PUBLIC.

### Auth & Key Management

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/provision` | Create API key (PUBLIC). Body: `{email?, walletAddress?, name?, capability?}`. Returns `api_key`. |
| GET | `/api/auth/validate` | Validate current API key. Returns `{valid, operatorId}`. |
| GET | `/api/auth/keys` | List your active API keys with usage stats. |
| DELETE | `/api/auth/keys/:keyId` | Revoke an API key permanently. |
| GET | `/api/auth/nonce` | Get SIWE nonce for wallet login. |
| POST | `/api/auth/verify` | Verify SIWE signature, create session. |
| GET | `/api/auth/me` | Current session info. |
| POST | `/api/auth/logout` | Destroy session. |

### Discovery & Capabilities

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/capabilities/types` | List all capability type strings (PUBLIC). Returns `{types: string[]}`. |
| GET | `/api/capabilities/templates` | List all templates with pricing hints and parameter metadata. |
| GET | `/api/capabilities` | List all capability instances. Supports `?offset=&limit=`. Returns `PaginatedResult<CapabilityDTO>`. |
| GET | `/api/capabilities/by-kernel/:kernelId` | Capabilities for a specific kernel. Returns `{capabilities: CapabilityDTO[]}`. |
| GET | `/api/capabilities/by-type/:type` | Filter by capability type. Returns `{capabilities: CapabilityDTO[]}`. |
| GET | `/api/capabilities/search?q=` | Full-text search across names, types, materials. Returns `CapabilityDTO[]`. |
| GET | `/api/capabilities/:capId` | Single capability with full enrichment (reputation, availability, queue depth). |
| POST | `/api/capabilities` | Create/upsert a capability instance. Body: `{kernelId, type, name, ...}`. |
| GET | `/api/capabilities/:id/button` | Embeddable button (PUBLIC, CORS *). See Section 3.1 below. |

#### 3.1 Embeddable Button Endpoint

`GET /api/capabilities/:id/button?format=json|html|script&label=...&theme=dark|light`

Returns a button config that third-party sites can embed to let users launch PCC jobs directly.

- `?format=json` (default): Returns `{capability, button, html, embedScript}`.
- `?format=html`: Returns an `<claude-code-button>` HTML snippet.
- `?format=script`: Returns script tag + button HTML for drop-in embedding.

Example:
```bash
curl https://capability.network/api/capabilities/cap-123/button?format=script
```
```html
<script src="https://unpkg.com/claudebuttons/dist/index.js"></script>
<claude-code-button command="pcc negotiate --capability fdm --kernel kernel-abc" label="Run on Claude Code" context-url="https://capability.network/api/capabilities/cap-123"></claude-code-button>
```

### Contract Building

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/build/options` | Get config options for a capability type. Body: `{type, selections?, profileId?}`. |
| POST | `/api/build/price` | Calculate price for selections. Body: `{type, selections, profileId?}`. |
| POST | `/api/build/contract` | Build a complete contract. Body: `{type, selections, assuranceTier, profileId?}`. |

### Negotiation Sessions

State machine: `CREATED -> CONFIGURING -> QUOTED -> REVIEWING -> COMMITTED`. Sessions auto-expire after 30 minutes.

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/negotiate/session` | Create session. Body: `{userAgentId, kernelId, capabilityType}`. |
| GET | `/api/negotiate/session/:id` | Get session state with all params and quote. |
| PATCH | `/api/negotiate/session/:id` | Update session (add selections, advance state). |
| POST | `/api/negotiate/session/:id/commit` | Commit session (creates escrow + job). |

### Kernels (Physical Sites)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/kernels` | List all kernels. Optional `?status=` filter. Returns `{kernels: KernelDTO[]}`. |
| GET | `/api/kernels/:kernelId` | Get kernel with health snapshot. Returns `{kernel: KernelHealthSnapshot}`. |
| GET | `/api/kernels/:kernelId/devices` | List devices. Returns `{devices: DeviceStatusDTO[]}`. |
| GET | `/api/kernels/:kernelId/jobs` | List jobs for kernel. Returns `{jobs: JobDTO[]}`. |
| POST | `/api/kernels` | Register/upsert a kernel. Body: `CreateKernelInput`. |
| POST | `/api/kernels/:kernelId/heartbeat` | Send heartbeat. |
| POST | `/api/kernels/:kernelId/announce` | Announce capabilities to the network. |

### Jobs

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/jobs` | List jobs. Optional `?kernelId=&status=&offset=&limit=`. Returns `{jobs: JobDTO[]}`. |
| GET | `/api/jobs/:jobId` | Get job with evidence and timeline. Returns `{job: JobDetailDTO, evidence}`. |
| PATCH | `/api/jobs/:jobId/status` | Update job status. Body: `{status, progress?}`. |
| POST | `/api/jobs/submit` | Submit a job. Body: `{kernelId, capabilityId, params, assuranceTier}`. |

### Escrow & Settlement

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/escrow` | List escrows. Optional `?status=`. Returns `{escrows: EscrowSummaryDTO[]}`. |
| GET | `/api/escrow/:escrowId` | Get escrow by ID or on-chain address. |
| GET | `/api/escrow/chain/:address/events` | On-chain event log. Optional `?fromBlock=`. |
| GET | `/api/escrow/chain/token/:tokenAddress/balance/:account` | ERC-20 balance check. |
| POST | `/api/escrow/fund` | Fund an escrow with USDC. |
| POST | `/api/escrow/:id/release` | Release a milestone. |
| POST | `/api/escrow/:id/dispute` | File a dispute. |

### Evidence & Compliance

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/evidence` | List all evidence bundles. |
| GET | `/api/capabilities/:capabilityId/compliance` | Full compliance report. Returns `ComplianceReportDTO`. |
| GET | `/api/jobs/:jobId/drift-alerts` | Real-time drift alerts. Returns `DriftAlertDTO[]`. |
| GET | `/api/jobs/:jobId/evidence` | Evidence bundles for a job. Returns `EvidenceSummaryDTO[]`. |
| GET | `/api/compliance/evidence/:bundleId` | Facade-enriched evidence bundle. |
| GET | `/api/compliance/evidence/:bundleId/tier-compliance` | Tier compliance check. Returns `TierComplianceResult`. |
| POST | `/api/jobs/:jobId/attestations/aggregate` | Aggregate verifier attestations. Body: `{attestations}`. Returns `AggregatedAttestationDTO`. |

### Setup & Detection

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/setup/detect` | Auto-detect config state (env vars, DB, adapters, chain, storage, identity). |
| POST | `/api/setup/generate-config` | Generate `KERNEL_CONFIG` JSON. Body: `{devices, kernelId?, mockMode?}`. |
| POST | `/api/setup/validate` | Validate a kernel config. Body: `{config?}` (JSON string, or reads env). |
| POST | `/api/setup/register-device` | Register a device. Body: `{kernelId, deviceId, type, adapterType, ...}`. |
| POST | `/api/setup/test-job` | Submit test job, polls for completion. Body: `{kernelId?, deviceId?, assuranceTier?}`. |
| GET | `/api/setup/status` | Comprehensive status across 6 categories: gateway, database, adapters, chain, storage, identity. |

### Onboarding & Registration

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/onboard/analyze` | Upload doc, get AI capability analysis. Returns `DocumentAnalysisResult`. |
| POST | `/api/onboard/register` | Submit machine registration. Body: `MachineRegistration`. |
| GET | `/api/onboard/registrations` | List all registrations. |
| GET | `/api/onboard/registrations/:id` | Get registration detail. |
| POST | `/api/onboard/registrations/:id/approve` | Approve a registration (admin). |
| POST | `/api/onboard/registrations/:id/reject` | Reject a registration. Body: `{reason?}`. |
| POST | `/api/onboard/registrations/:id/activate` | Activate an approved registration. |
| POST | `/api/onboard/registrations/:id/prove` | Submit evidence for auto-approval (fast-track). See Section 4.4. |
| POST | `/api/onboard/redeem` | One-click agent onboarding with invite code. Body: `{inviteCode, email, password}`. |
| GET | `/api/onboard/check/:code` | Validate invite code before redeeming. |
| GET | `/api/onboard/status` | Check what the agent has provisioned (requires Bearer token from redeem). |

### Wizard Sessions

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/wizard/sessions` | Create wizard session. Body: `{track}` where track is `platform-setup`, `machine-onboarding`, or `device-builder`. |
| GET | `/api/wizard/sessions/:id` | Get session state with step data and progress. |
| PUT | `/api/wizard/sessions/:id/steps/:step` | Save step data. Body: `{data: {...}}`. Step is 0-indexed. |
| POST | `/api/wizard/sessions/:id/complete` | Complete wizard (orchestrates backend operations). All steps must be completed first. |
| DELETE | `/api/wizard/sessions/:id` | Abandon a wizard session. |

**Wizard tracks and their steps**:

- `platform-setup` (5 steps): environment-detection, chain-configuration, storage-configuration, identity-configuration, review-and-deploy
- `machine-onboarding` (7 steps): machine-info, document-upload, capability-definition, space-requirements, pricing-configuration, operator-profile, review-and-submit
- `device-builder` (5 steps): device-selection, adapter-configuration, capability-mapping, test-connection, register-device

Sessions expire after 24 hours. Step data is merged (not replaced) on updates.

### Payments & Fiat Ramp

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/fiat-ramp/wallet/balance` | USDC balance + pending deposits. |
| GET | `/api/fiat-ramp/funding-options` | Available fiat-to-crypto options. |
| POST | `/api/fiat-ramp/onramp/session` | Create Stripe funding session (card/ACH). |
| POST | `/api/fiat-ramp/onramp/yellowcard` | Mobile money in 34 emerging market countries. |
| GET | `/api/fiat-ramp/rates` | Live Yellowcard exchange rates. |
| POST | `/api/fiat-ramp/offramp/withdraw` | Withdraw USDC to local fiat. |
| POST | `/api/fiat-ramp/payout` | Wise enterprise bank payout (40+ currencies). |
| GET | `/api/fiat-ramp/activity` | Recent on/off ramp activity. |

### DePIN, IP & Governance

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/rewards/*` | DePIN epochs, certificates, claims, treasury. |
| GET/POST | `/api/ip/*` | Story Protocol IP registration, royalties, lineage, revenue splits. |
| GET/POST | `/api/swf/*` | Sovereign Wealth Fund governance, proposals, participant dashboard. |
| GET/POST | `/api/csd/*` | Capability StructureDefinition CRUD (FHIR-inspired schemas). |
| GET/POST | `/api/bounty/*` | Demand signals, bounties, leaderboard. |
| GET/POST | `/api/pool/*` | Investment pools, staking, earnings. |

### Agent Network

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/agents/status` | Agent subnet status + conversations. |
| POST | `/api/agents/heartbeat` | Agent liveness heartbeat. |
| GET | `/api/agents/health` | Health status of all monitored agents. |

### Other Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Gateway healthcheck (bare alias of `/api/health`; same JSON payload — not the SPA shell). |
| GET | `/api/status` | Detailed status. |
| GET | `/.well-known/agent-registration.json` | ERC-8004 Agent Registration File (PUBLIC). |
| GET | `/agent-package.json` | 254-tool agent package for any LLM (PUBLIC). |
| GET/POST | `/api/sensors/*` | Sensor channels, readings, anomalies. |
| GET/POST | `/api/zk/*` | ZK proof creation and verification. |
| GET/POST | `/api/logistics/*` | Shipments, bookings, installations. |
| GET/POST | `/api/spaces/*` | Equipment hosting spaces. |
| GET/POST | `/api/marketplace/*` | Capability marketplace listings. |
| GET/POST | `/api/discover/*` | Device discovery (mDNS/IPP) + auto-onboarding. |
| GET/POST | `/api/protocols/*` | Protocol templates (DAG workflows). |
| GET/POST | `/api/orchestrator/*` | Multi-instrument transfer graphs. |
| GET/POST | `/api/batches/*` | Batch manifests (HPLC, multi-sample). |

---

## 4. Operator Onboarding Guide

This section walks through onboarding a real device. Example: "I have a 3D printer running OctoPrint."

### 4.1 Provision an API key

```bash
curl -X POST https://capability.network/api/auth/provision \
  -H "Content-Type: application/json" \
  -d '{"email": "operator@myshop.com", "name": "PrintShop Alpha", "capability": "FDM 3D printing"}'
```

Save the `api_key` from the response. Set it for all subsequent requests:
```bash
export PCC_KEY="pcc_live_..."
```

### 4.2 Detect current state

```bash
curl -H "Authorization: Bearer $PCC_KEY" \
  https://capability.network/api/setup/detect
```

Returns a report of what is configured: env vars by category, DB state (kernels/devices/jobs), chain connectivity, storage type, identity status.

### 4.3 Generate kernel config and register

```bash
# Generate config for your printer
curl -X POST https://capability.network/api/setup/generate-config \
  -H "Authorization: Bearer $PCC_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "kernelId": "kernel_printshop_alpha",
    "devices": [{
      "name": "Prusa MK4",
      "type": "machine",
      "adapterType": "octoprint",
      "url": "http://192.168.1.50",
      "apiKey": "OCTOPRINT_API_KEY"
    }]
  }'
```

Returns `{config, envLine, configJson}`. The `envLine` is ready to paste into your `.env`.

Validate the config:
```bash
curl -X POST https://capability.network/api/setup/validate \
  -H "Authorization: Bearer $PCC_KEY" \
  -H "Content-Type: application/json" \
  -d '{"config": "{\"kernelId\":\"kernel_printshop_alpha\",\"devices\":[...]}"}'
```

Returns `{valid, checks[], errors[], warnings[]}`. Each check has a name, status (pass/warn/fail), and message.

Register the kernel:
```bash
curl -X POST https://capability.network/api/kernels \
  -H "Authorization: Bearer $PCC_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "PrintShop Alpha",
    "operatorAddress": "operator@myshop.com",
    "location": {"lat": 37.77, "lng": -122.42},
    "physicalAddress": "123 Maker St, SF CA",
    "maxAssuranceTier": 2
  }'
```

Register the device:
```bash
curl -X POST https://capability.network/api/setup/register-device \
  -H "Authorization: Bearer $PCC_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "kernelId": "kernel_printshop_alpha",
    "deviceId": "dev-prusa-mk4-001",
    "type": "machine",
    "model": "Prusa MK4",
    "adapterType": "octoprint",
    "adapterConfig": {"url": "http://192.168.1.50", "apiKey": "OCTOPRINT_API_KEY"},
    "capabilities": ["3d-printing"]
  }'
```

Valid adapter types: `octoprint`, `modbus`, `opcua`, `sila`, `generic-http`, `mock`.
Valid device types: `machine`, `sensor`, `camera`.

### 4.4 Run a test job

```bash
curl -X POST https://capability.network/api/setup/test-job \
  -H "Authorization: Bearer $PCC_KEY" \
  -H "Content-Type: application/json" \
  -d '{"kernelId": "kernel_printshop_alpha", "deviceId": "dev-prusa-mk4-001", "assuranceTier": 0}'
```

This submits a test job and polls for up to 10 seconds. Returns:
```json
{
  "jobId": "test-job-uuid",
  "deviceId": "dev-prusa-mk4-001",
  "status": "completed",
  "evidenceBundleId": "bundle-uuid",
  "duration": 5234
}
```

### 4.5 Prove and activate (fast-track)

If you registered via `/api/onboard/register`, you can skip manual approval by proving your device works:

```bash
curl -X POST https://capability.network/api/onboard/registrations/$REG_ID/prove \
  -H "Authorization: Bearer $PCC_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "evidence": {
      "bundleHash": "sha256:abc123def456...",
      "events": [
        {"type": "execution_completed", "timestamp": "2026-04-03T12:00:00Z", "payload": {"jobType": "test", "pagesCount": 1}},
        {"type": "camera_snapshot", "timestamp": "2026-04-03T12:00:01Z", "payload": {"description": "Photo of test print"}}
      ],
      "deviceHealth": {"status": "idle", "model": "Prusa MK4", "firmware": "6.0.0"},
      "photoBase64": "iVBORw0KGgo..."
    }
  }'
```

Evidence determines assurance tier:
- **Tier 0**: Device health only (self-attested).
- **Tier 1**: Bundle hash + events with completion event.
- **Tier 2**: Photo + device health + events (full proof).

On success, the registration is auto-approved and activated immediately. No manual review.

### 4.6 Check setup status

```bash
curl -H "Authorization: Bearer $PCC_KEY" \
  https://capability.network/api/setup/status
```

Returns per-category status (`ready`, `partial`, `unconfigured`) for: gateway, database, adapters, chain, storage, identity. Plus an `overall` status.

### 4.7 Alternative: Wizard flow

For a guided multi-step experience, use wizard sessions:

```bash
# Create a device-builder wizard
curl -X POST https://capability.network/api/wizard/sessions \
  -H "Authorization: Bearer $PCC_KEY" \
  -H "Content-Type: application/json" \
  -d '{"track": "device-builder"}'

# Save step 0 (device-selection)
curl -X PUT https://capability.network/api/wizard/sessions/$SESSION_ID/steps/0 \
  -H "Authorization: Bearer $PCC_KEY" \
  -H "Content-Type: application/json" \
  -d '{"data": {"deviceName": "Prusa MK4", "deviceType": "machine", "adapterType": "octoprint"}}'

# ... save steps 1-4 ...

# Complete — orchestrates registration
curl -X POST https://capability.network/api/wizard/sessions/$SESSION_ID/complete \
  -H "Authorization: Bearer $PCC_KEY"
```

### 4.8 Alternative: pcc-node (one-command onboarding)

For operators who prefer CLI:
```bash
pip install pcc-node
pcc-node start
```

This auto-detects hardware, generates Ed25519 keys, provisions an API key, registers the kernel, announces capabilities, and starts a daemon. Set `PCC_BASE` and `PCC_API_KEY` env vars if not using defaults.

---

## 5. DTOs & Response Shapes

All facade responses use the `Result<T>` pattern: `{success: true, data: T}` or `{success: false, error: {code, message, httpStatus, details?}}`. Routes serialize success as the DTO directly and errors as `{error, message}` with the appropriate HTTP status.

### CapabilityDTO

```typescript
{
  id: string;                        // Unique capability ID
  kernelId: string;                  // Which kernel offers this
  type: string;                      // "3d-printing", "cnc", "hplc", etc.
  name: string;                      // Human-readable name
  description?: string;
  materials: string[];               // Supported materials
  tolerances?: ToleranceSpec;        // Dimensional tolerances
  envelope?: WorkEnvelope;           // Build volume
  assuranceTiers: (0|1|2|3)[];       // Which tiers this supports
  pricing: PricingModel;             // {currency, baseCost, minimum, ...}
  location: {lat, lng};
  tags?: string[];
  // Enrichment (populated by facades):
  reputation?: number;               // 0-1000, from ERC-8004
  queueDepth: number;                // Jobs currently waiting
  available: boolean;                // Currently taking jobs?
  estimatedWaitMinutes?: number;
  kernelName?: string;
  kernelStatus?: "online"|"offline"|"maintenance"|"stale";
}
```

### JobDTO / JobDetailDTO

```typescript
{
  id: string;
  capabilityId: string;
  kernelId: string;
  status: "pending"|"queued"|"in_progress"|"paused"|"completed"|"failed"|"cancelled";
  progress?: number;                 // 0-100
  assuranceTier: 0|1|2|3;
  createdAt: string;                 // ISO timestamp
  updatedAt?: string;
  // Enrichment:
  kernelName?: string;
  capabilityType?: string;
  evidenceCount?: number;
  escrowStatus?: string;
  estimatedCompletion?: string;
  // JobDetailDTO adds:
  timeline: JobTimelineEvent[];      // [{type, timestamp, details}]
  evidenceBundles: EvidenceSummaryDTO[];
  escrow?: EscrowSummaryDTO;
}
```

### KernelDTO / KernelHealthSnapshot

```typescript
{
  id: string;
  name: string;
  operatorAddress: string;
  location: {lat, lng};
  physicalAddress: string;
  maxAssuranceTier: 0|1|2|3;
  status: "online"|"offline"|"maintenance"|"suspended";
  lastHeartbeat: string;
  version: string;
  // Enrichment:
  capabilityCount: number;
  capabilityTypes: string[];
  reputation?: number;               // 0-1000
  totalJobsCompleted: number;
  isStale: boolean;                  // Heartbeat >5min old while online
  activeJobCount?: number;
  // KernelHealthSnapshot adds:
  devices: DeviceStatusDTO[];
  recentJobs: JobDTO[];
  uptimePercent?: number;
}
```

### EscrowSummaryDTO

```typescript
{
  id: string;
  jobId: string;
  status: "created"|"funded"|"active"|"completed"|"disputed"|"refunded";
  totalAmount: string;               // USDC amount
  currency: string;
  milestoneCount: number;
  releasedCount: number;
  disputedCount: number;
  challengeWindowEnd?: string;
}
```

### ComplianceReportDTO

```typescript
{
  capabilityId: string;
  kernelId: string;
  satisfiedStandards: string[];      // ISO standards met
  alcoaStatus: ALCOAStatus;          // 10 boolean checks (see Section 7)
  tierCompliance: Record<0|1|2|3, boolean>;
  recentEvidence: EvidenceSummaryDTO[];
  driftAlerts: DriftAlertDTO[];
}
```

### DriftAlertDTO

```typescript
{
  type: "power_anomaly"|"temperature_excursion"|"duration_mismatch"|"sensor_gap";
  severity: "low"|"medium"|"high"|"critical";
  message: string;
  expectedValue?: string;
  actualValue?: string;
  timestamp: string;
}
```

### DeviceStatusDTO

```typescript
{
  id: string;
  type: string;                      // "machine", "sensor", "camera"
  model?: string;
  status: "idle"|"busy"|"error"|"offline"|"maintenance";
  healthStatus: "healthy"|"degraded"|"offline"|"unknown";
  adapterType?: string;
  capabilities: string[];            // Capability IDs this device serves
}
```

---

## 6. Facades & How They Work

Facades are a clean DTO layer between routes and the database. They handle enrichment (reputation scores, queue depths, compliance status) and return `Result<T>` — routes never throw.

### The 6 Facades

| Facade | Domain | Key Methods |
|--------|--------|-------------|
| CapabilityFacade | Discovery | `list()`, `listByKernel()`, `listByType()`, `search()`, `getById()`, `create()` |
| JobFacade | Execution | `list()`, `getById()`, `updateStatus()` |
| KernelFacade | Infrastructure | `list()`, `getById()`, `getDevices()`, `getJobs()`, `register()` |
| SettlementFacade | Payments | `listEscrows()`, `getEscrow()`, `getChainEvents()`, `getTokenBalance()` |
| ComplianceFacade | Compliance | `generateComplianceReport()`, `detectDrift()`, `getEvidenceForJob()`, `checkTierCompliance()`, `aggregateAttestations()` |
| AgentFacade | Identity/RBAC | Agent sessions, role permissions, Separation of Duties enforcement |

### PopulationContext

Control what enrichment facades perform by passing a PopulationContext:

```typescript
{
  viewerDid?: string;          // For personalized pricing/trust gates
  currency?: string;           // Price conversion currency
  includeReputation?: boolean; // Fetch ERC-8004 reputation scores
  includeCompliance?: boolean; // Include audit/compliance status
  includeHealth?: boolean;     // Real-time device health
  reputationCache?: Map;       // Pre-loaded scores (prevents N+1)
  queueDepthCache?: Map;       // Pre-loaded queue depths
  applyColdStartGate?: boolean; // Cap tier by reputation thresholds
}
```

---

## 7. Safety & Compliance

### Assurance Tiers

| Tier | Name | Evidence Required | Use Case |
|------|------|-------------------|----------|
| 0 | Self-Attested | Device health snapshot | Prototyping, non-critical |
| 1 | Verified | Bundle hash + completion events | Standard production |
| 2 | Certified | Photo + device health + event log + sensor data | Regulated manufacturing |
| 3 | Sovereign | Full evidence chain + ZK proofs + multi-verifier attestation + IPFS storage | Medical, aerospace, pharma |

### ALCOA+ Compliance (10 Principles)

Every evidence bundle is checked against these principles:

| Principle | Check |
|-----------|-------|
| **A**ttributable | source.deviceId + source.kernelId present |
| **L**egible | Data readable and hash-verifiable |
| **C**ontemporaneous | Timestamps within execution window |
| **O**riginal | Bundle from kernel (signature present, not test-signed) |
| **A**ccurate | Tier requirements satisfied, event hashes verified |
| **+C**onsistent | No high/critical duration_mismatch drift alerts |
| **+C**omplete | All required event types present, no sensor_gap alerts |
| **+C**redible | Verifier confidence >= 90% |
| **+E**nduring | Stored on IPFS/Storacha (durable reference) |
| **+A**vailable | Accessible via gateway and storage CID |

### Drift Detection

The compliance facade monitors for 4 drift types during job execution:
- `power_anomaly` — unexpected power consumption patterns
- `temperature_excursion` — temperature outside operational envelope
- `duration_mismatch` — job duration differs significantly from expected
- `sensor_gap` — missing sensor readings during execution

Check drift alerts:
```bash
curl -H "Authorization: Bearer $PCC_KEY" \
  https://capability.network/api/jobs/$JOB_ID/drift-alerts
```

### Constitutional Constraints

Every agent role has OWASP ASI01-10 hard rules that survive prompt injection. The SafetyGateway is the only path to hardware commands. Operations are classified into 4 classes:
- **READ** — always allowed
- **SAFE CONTROL** — allowed during active job (home, lights)
- **SCOPED WRITE** — requires an active execution scope
- **PRIVILEGED** — requires explicit operator approval

---

## 8. Settlement & Payments

### Escrow Lifecycle

```
CREATE -> FUND (deposit USDC) -> ACTIVE (job running) -> MILESTONES (evidence submitted)
  -> RELEASE (evidence meets tier) or DISPUTE (evidence insufficient)
```

Escrow contracts are on Base Sepolia (testnet). The protocol charges a 2.35% fee on every settlement, hardcoded in the smart contract.

### Default Payment Protocol (MPP)

MPP is the default payment rail. Milestone escrow with automatic release when evidence passes verification.

### Fiat On/Off Ramps

- **Stripe**: Visa/Mastercard/AMEX/ACH to USDC on Base
- **Yellowcard**: Mobile money in 34 emerging market countries to USDC
- **Wise**: Enterprise bank payouts in 40+ currencies (off-ramp)

---

## 9. MCP Server (77 Tools)

Connect the PCC MCP server to Claude Code or any MCP-compatible client.

> **Claude Max quickstart**: see `docs/quickstart/claude-desktop.md` (also linked at `https://capability.network/quickstart/claude-desktop` and visible on `https://capability.network/start`). Claude Code users with the PCC skill installed get a lighter-weight surface — see `docs/quickstart/claude-code.md`.

**Configuration** (add to Claude Code settings or `~/.claude/settings.json`):
```json
{
  "mcpServers": {
    "pcc": {
      "command": "node",
      "args": ["packages/mcp-server/dist/index.js"],
      "env": {"PCC_URL": "https://capability.network"}
    }
  }
}
```

**49 of the 77 MCP tools** (core set shown below; the capture + negotiate tool groups in `packages/mcp-server/src/tools/` complete the list):

| # | Tool | Description |
|---|------|-------------|
| 1 | `pcc_list_capabilities` | List registered capability types |
| 2 | `pcc_search_capabilities` | Search templates with details |
| 3 | `pcc_list_kernels` | List kernels, filter by status |
| 4 | `pcc_get_kernel` | Kernel details + devices |
| 5 | `pcc_list_jobs` | List jobs, filter by kernel/status |
| 6 | `pcc_get_job` | Job details + evidence bundles |
| 7 | `pcc_build_options` | Config options for a capability type |
| 8 | `pcc_calculate_price` | Calculate price for selections |
| 9 | `pcc_build_contract` | Build contract ready for escrow |
| 10 | `pcc_list_escrows` | List escrow contracts |
| 11 | `pcc_list_evidence` | List evidence bundles |
| 12 | `pcc_list_protocols` | List workflow templates |
| 13 | `pcc_depin_stats` | DePIN rewards, certificates, treasury |
| 14 | `pcc_subnet_status` | Agent network status |
| 15 | `pcc_get_agent_identity` | ERC-8004 identity for kernel/agent |
| 16 | `pcc_get_reputation` | Reputation scores by agent/tag |
| 17 | `pcc_list_sensors` | Sensor channels for a kernel |
| 18 | `pcc_get_sensor_data` | Sensor readings for a channel |
| 19 | `pcc_get_evidence` | Evidence bundle: IPFS CID, ZK proof, scores |
| 20 | `pcc_compile_workflow` | Compile DAG from steps |
| 21 | `pcc_agent_registration` | ERC-8004 Agent Registration File |
| 22 | `pcc_setup_detect` | Auto-detect configuration state |
| 23 | `pcc_setup_generate_config` | Generate KERNEL_CONFIG from descriptions |
| 24 | `pcc_setup_validate_config` | Validate kernel configuration |
| 25 | `pcc_setup_register_device` | Register a physical device |
| 26 | `pcc_setup_health_check` | Run device health checks |
| 27 | `pcc_setup_test_job` | Submit test job to verify pipeline |
| 28 | `pcc_setup_generate_env` | Generate .env file |
| 29 | `pcc_setup_status` | Comprehensive setup status |
| 30 | `pcc_csd_list` | List CSD documents |
| 31 | `pcc_csd_get` | Get CSD by URI |
| 32 | `pcc_csd_register` | Register a CSD document |
| 33 | `pcc_discover_scan` | Scan network for devices (mDNS/IPP) |
| 34 | `pcc_discover_onboard` | Discover, generate CSD, register in one call |
| 35 | `pcc_ip_register_capability` | Register CSD as Story Protocol IP |
| 36 | `pcc_ip_revenue_snapshot` | IP Royalty Vault balance |
| 37 | `pcc_ip_claim` | Claim accumulated royalties |
| 38 | `pcc_ip_lineage` | IP provenance graph |
| 39 | `pcc_ip_set_splits` | Configure revenue splits |
| 40 | `pcc_swf_summary` | Sovereign Wealth Fund overview |
| 41 | `pcc_swf_participant_dashboard` | SWF participant earnings |
| 42 | `pcc_swf_list_proposals` | List governance proposals |
| 43 | `pcc_get_wallet_balance` | USDC balance + pending + credits |
| 44 | `pcc_get_funding_options` | Fiat-to-crypto options |
| 45 | `pcc_create_onramp_session` | Create fiat funding session |
| 46 | `pcc_get_provider_rates` | Yellowcard exchange rates |
| 47 | `pcc_submit_withdrawal` | Withdraw USDC to fiat |
| 48 | `pcc_get_ramp_activity` | Recent ramp activity |
| 49 | `pcc_send_enterprise_payout` | Wise bank payout (40+ currencies) |

---

## 10. Agent Package (254 Tools)

The agent package is a single JSON file any LLM can consume, containing 254 tools with input schemas and endpoint mappings. It is the load-bearing piece of the **Claude Max front door**: drop the JSON into a Claude conversation and Claude can transact on the user's behalf without further hand-holding.

> **Claude Max quickstart**: visit `https://capability.network/start` for the three-card landing (Code / Desktop / Web). Per-surface walkthroughs live in `docs/quickstart/`.

**Fetch it**:
```bash
curl https://capability.network/agent-package.json
```

**Top-level shape** (v2.15+, polished 2026-06-19 for Claude Max front door):

| Field | Purpose |
|-------|---------|
| `title`, `description` | Human-friendly product framing |
| `system_prompt` | ~9000 chars. Claude-as-user-agent framing: two-step model (identify → post job-offer), composition pattern (pizza + courier), auth flow, verification ("executor success ≠ outcome success"), DO/DON'T list, 15-category taxonomy. Drop this verbatim into a Claude conversation and it can operate. |
| `tools` | 254 entries. Each has `name`, `description`, `input_schema` (JSON Schema), and `endpoint` (`{method, path}`). |
| `examples` | 3 worked examples — pizza, STL print, operator browse. Each lists user_request + step-by-step what_claude_does + tools_used. |
| `auth` | `modes`, `provision_endpoint`, `public_endpoints_no_auth`, `bearer_header`, `trace_header`. |
| `categories` | 15 PCC categories (C.1..C.15) with canonical `capabilityType` examples. |
| `quickstart` | Code snippets for Claude SDK + OpenAI SDK consumers. |

**How to use it**:
- **Claude Max (the easy path)**: paste the JSON URL into a conversation, or install the skill at `https://capability.network/skills/pcc.md`. The polished `system_prompt` plus the catalog + examples is enough context.
- **Other LLMs**: load the JSON, present `tools[].description` to your model, when it picks a tool make the corresponding HTTP request to `https://capability.network` + `endpoint.path`, passing input as JSON body (POST/PUT/PATCH) or query params (GET).

**Polish script**: `scripts/polish-agent-package-claude-max.mjs` rewrites the system_prompt + adds top-level fields. Idempotent. Re-run when the framing changes.

---

## 11. Environment Variables

These are the operator-facing environment variables for configuring a PCC node or gateway:

| Variable | Description | Default |
|----------|-------------|---------|
| `PCC_URL` | Gateway URL (for MCP server and clients) | `https://capability.network` |
| `PCC_BASE` | Gateway URL (for pcc-node Python CLI) | `https://capability.network` |
| `PCC_API_KEY` | Bearer token for gateway API | none |
| `KERNEL_ID` | Override kernel ID | auto-generated |
| `KERNEL_CONFIG` | Inline JSON kernel configuration | mock |
| `KERNEL_CONFIG_FILE` | Path to kernel config JSON file | none |
| `PCC_NETWORK` | Blockchain network name | `base-sepolia` |
| `ESCROW_CONTRACT_ADDRESS` | Deployed MilestoneEscrow address | none |
| `EVIDENCE_STORAGE` | Evidence backend: `local`, `helia`, `storacha` | `local` |
| `LIT_PROTOCOL_REAL` | Enable Lit Protocol encryption | `false` |
| `SSE_AUTH_REQUIRED` | Enforce auth on SSE streams | `false` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP endpoint for traces | none |
| `IDEMPOTENCY_TTL_MS` | Idempotency cache TTL in ms | `86400000` (24h) |

---

## 12. SSE Streams (Real-Time Events)

Subscribe to Server-Sent Events for real-time updates. Connect with `EventSource` or `curl`.

| Stream | URL | Events |
|--------|-----|--------|
| Job updates | `GET /sse/stream/job/:jobId` | Status changes, progress, evidence received |
| Kernel updates | `GET /sse/stream/kernel/:kernelId` | Heartbeat, device status, job assignments |
| Device updates | `GET /sse/stream/device/:deviceId` | Health changes, sensor readings |
| Batch updates | `GET /sse/stream/batch/:batchId` | Batch job progress |
| Notifications | `GET /sse/notifications` | Global notification stream |
| Camera stream | `GET /api/ot2/camera/stream` | Live camera frames from equipment |

Example:
```bash
curl -N -H "Authorization: Bearer $PCC_KEY" \
  https://capability.network/sse/stream/job/job-uuid-123
```

---

## 13. pcc-node (Python Operator Node)

`pcc-node` is a pip-installable Python CLI that turns any machine into a PCC operator node.

### Install and run

```bash
pip install pcc-node
pcc-node start
```

This single command:
1. Auto-detects connected hardware (printers, lab equipment, cameras)
2. Generates Ed25519 signing keys
3. Provisions an API key from the gateway
4. Registers a kernel and announces capabilities
5. Starts a daemon that processes jobs and emits evidence

### Commands

| Command | Description |
|---------|-------------|
| `pcc-node start` | Full auto-setup and daemon start |
| `pcc-node detect` | Hardware scan only (no registration) |
| `pcc-node status` | Check daemon status |
| `pcc-node import-job <file>` | Import G-code, STL, Opentrons protocol, or CSV plate layout |

### Configuration

Set these environment variables before running:
```bash
export PCC_BASE=https://capability.network
export PCC_API_KEY=pcc_live_...
export KERNEL_ID=my-kernel-001  # optional
```

---

## Agent Workflows (Quick Reference)

**New operator setup**:
`provision key` -> `setup detect` -> `generate config` -> `validate` -> `register kernel` -> `register device` -> `test job` -> `prove`

**Build a contract**:
`list capability types` -> `build options` -> `calculate price` -> `build contract` -> `fund escrow` -> `submit job`

**Monitor a job**:
`get job` (poll) or `SSE /sse/stream/job/:id` (real-time) -> `get drift alerts` -> `get evidence`

**Check compliance**:
`GET /api/capabilities/:id/compliance` -> review `alcoaStatus` and `driftAlerts`

**Embed a button**:
`GET /api/capabilities/:id/button?format=script` -> paste HTML into any website
