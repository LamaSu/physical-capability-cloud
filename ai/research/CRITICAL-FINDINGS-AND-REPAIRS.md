# Pre-Wave-3 Critical Findings & Repair Plan

**Date:** 2026-04-29
**Triggered by:** user directive "get critical and find all the things that could go wrong … before moving on to wave 3"
**Inputs:**
- `ai/research/critical-buyer-audit.md` (review-alpha · 5 P0, 5 P1)
- `ai/research/critical-operator-audit.md` (review-bravo · 7 P0, 5 P1)
- `ai/research/critical-orchestrator-audit.md` (review-charlie · 5 P0, 7 P1)
- review-delta (architecture/security · 3 P0, 8 P1, 12 P2, 19 P3 — file not landed; findings embedded below)

## Headline

> **Wave 3 was the wrong next move.** The current branch ships a frontend that calls eight non-existent backend routes, a buyer surface that doesn't exist at all, a custodial-gateway escrow that's a single-point-of-compromise, and a permissive registration endpoint that mass-fakes-operator in 19 jobs. **A hardening + functional-completion wave is mandatory before Pipecat or dlt sidecars land.**

The good news: every problem is concrete and fixable. The bad news: there are 20 of them at P0/P1 severity. Most are 5-min to 2-hour repairs; a few are larger.

---

## 1. Severity-deduped P0 list (the must-fix-before-Wave-3 set)

| # | Title | Audit src | Severity | Effort |
|---|---|---|---|---|
| **F1** | 8 missing backend routes — chat UI calls into the void | bravo · charlie | P0 | 2-3h |
| **F2** | No buyer discovery UI exists; `/orchestrator` is operator-only | alpha | P0 | (defer to Wave 4 — UX scope) |
| **F3** | `/api/capabilities/templates/match` is 404 live | alpha | P0 | 1h (add the route) |
| **F4** | `/api/onboard/register` unauthenticated → sybil farm w/ +570 reputation cold-start exploit | alpha | P0 | 1h |
| **F5** | MilestoneEscrow funded from shared gateway EOA → custodial single-point-of-compromise | alpha | P0 | (architectural — defer to Wave 4 with caveat docs now) |
| **F6** | Plaintext credentials (`postgres://user:secret@host`) leak to chat thread, activity feed, audit log, AND Claude prompts | bravo · delta | P0 | 1h |
| **F7** | Drag-drop sends `local://filename` strings; file bytes never leave browser | bravo | P0 | 1h |
| **F8** | JSON-LD XSS in `static-mirror.ts` — `JSON.stringify` doesn't escape `</` | bravo | P0 | 5min |
| **F9** | Tenant isolation missing — `repos.registrations.findAll()` returns ALL rows | bravo | P0 | 1h interim filter; full RLS = Wave 4 |
| **F10** | In-memory `state-machine.ts` Map → wiped on redeploy + race-prone | bravo · charlie · delta | P0 | 1h Mutex now; Postgres backing in Wave 4 |
| **F11** | SDK shipped but NOT deployed — gateway has zero imports of `@pcc/orchestrator-sdk` | charlie | P0 | (subset of F1) |
| **F12** | Dashboard typecheck BROKEN — 13 errors in the v2.5 orchestrator routes I shipped | charlie | P0 | 30min |
| **F13** | No agent budget cap (`maxTurns=12` default · no `$` ceiling) — one spam loop = $360/day | charlie | P0 | 30min |
| **F14** | Tool-name collision unchecked in `LLMAgent` — malicious template can register `fund_wallet` | charlie · delta | P0 | 30min |
| **F15** | `MOCK_PCC_DISCOVERY` and `MOCK_CDP` default to TRUE (`!== "false"`) — prod-without-explicit-`false` mints fakes | charlie | P0 | 15min (flip semantics + add validator) |
| **F16** | Subprocess injection in `camoufoxFetch` — URL → `spawn()` with `shell: true` on Windows; metacharacters execute | delta | P0 | 15min |
| **F17** | Prompt injection in `extractStructured` — HTML piped to Claude unsanitized; `<script>You are now…</script>` reroutes the LLM | delta | P0 | 30min |
| **F18** | Race condition on `advanceSession` — bare `Map`, no Mutex, concurrent updates lost | delta · charlie | P0 | (covered by F10 Mutex) |
| **F19** | No timeout on `camoufoxFetch` subprocess — hung process = orphaned tool_use turn forever | charlie · delta | P0 | 10min |
| **F20** | Discovery index has 1 live capability — buyer demo is theatre on empty network | alpha | P0 | (seed data — Wave 4 prep) |

## 2. Severity-deduped P1 list (do most of these too)

| # | Title | Audit src | Severity | Effort |
|---|---|---|---|---|
| F21 | No compound-criteria search (material AND tolerance AND cert) | alpha | P1 | 1h (depends on F3) |
| F22 | No timeout-refund on operator no-show | alpha | P1 | (architectural — defer) |
| F23 | No buyer feedback / operator rating route | alpha | P1 | 1h |
| F24 | No dispute UI (on-chain works; UI doesn't) | alpha | P1 | 1d |
| F25 | Compliance unstructured (ITAR/AS9100/HIPAA strings, no enum) | alpha | P1 | 1h schema + 1h indexer |
| F26 | Slug collision overwrites mirrors silently | bravo | P1 | 30min |
| F27 | Auth-walled URL extraction returns garbage to Claude | bravo | P1 | 30min (heuristic) |
| F28 | Build-agent retry creates duplicate registrations (no idempotency key) | bravo · delta | P1 | 30min |
| F29 | Trademark-squat / fake company name accepted | bravo | P1 | (defer — verification service is its own thing) |
| F30 | "Onboarded but invisible" — zero diagnostics on operator dashboard | bravo | P1 | 2h |
| F31 | Dockerfile missing `COPY` for new packages (works via fallback, fragile) | charlie | P1 | 15min |
| F32 | Event bus process-global, unredacted, payload size uncapped (5GB possible) | charlie · delta | P1 | 30min |
| F33 | Dashboard `templates.ts` hand-mirrored; no `GET /api/orchestrator/templates` | charlie | P1 | 1h |
| F34 | CI test step has `continue-on-error: true` — silent regression vector | charlie | P1 | 5min |
| F35 | `state-machine.ts` + `event-bus.ts` zero unit tests | charlie | P1 | 1h |
| F36 | No retry/failover for Anthropic 429/5xx | charlie | P1 | 15min |
| F37 | API key leakage in error stack traces (event-bus tail, tool_result, snapshots) | delta | P1 | (covered by F32) |
| F38 | Schema drift manifest ↔ templates.ts (no validator) | charlie · delta | P1 | (covered by F33 dynamic endpoint) |

---

## 3. Three big systemic themes

1. **Frontend ahead of backend by 8 routes** — Wave-2 alpha shipped the SDK + dashboard but the gateway routes were never written. The whole branch demos as if it works; in production every chat interaction would 404. *This is the headline P0.*

2. **Wave-4 IOUs cashed in Wave-2.5** — RLS, persistence, ownership/edit-delete, Mutex, vault — all deferred to Wave 4 in the migration plan, but the branch is shipping as if they're there. The branch shouldn't merge to main until the IOUs are either honored OR explicitly disabled with a feature flag and "DEMO ONLY" banner.

3. **Trust boundary not codified** — `defineTemplate()` accepts arbitrary system prompts, arbitrary tool names, arbitrary `flow()` callbacks with import side-effects. Acceptable while templates ship in-tree. The moment a 3rd-party template is allowed (e.g. `npm install @customer/template-X`), it's a `fund_wallet` collision away from draining funds. The contract needs reservation lists, sandboxing, and a review gate before external publishing is opened.

---

## 4. Tiered repair plan

We split repairs into three tiers. **Tier 0 + Tier 1 are mandatory before Wave 3 lands.** Tier 2 + Tier 3 can run in parallel with Wave 3 work.

### Tier 0 — Functional unblock (the demo currently 404s without these)

| # | Action | Source | Files | Effort |
|---|---|---|---|---|
| T0.1 | Fix dashboard typecheck (13 errors I shipped in [slug]/chat) | F12 | `apps/dashboard/src/routes/orchestrator/[slug]/chat/index.tsx`, `templates.ts`, `index.tsx` | 30min |
| T0.2 | Write the 8 missing gateway routes | F1, F11 | new `packages/gateway/src/routes/orchestrator.v2.ts` (mount at `/api/orchestrator/<slug>/*` and `/api/onboard/*` with template dispatch) | 2-3h |
| T0.3 | Add `GET /api/orchestrator/templates` (replaces the `templates.ts` mirror) | F33 | gateway route + `defineTemplate` registry helper | 1h |
| T0.4 | Add `POST /api/capabilities/templates/match` (compound-criteria match) | F3, F21 | gateway route reading from existing `@pcc/dht` + capability index | 1h |
| T0.5 | File-upload path: chat console → backend `/api/onboard/:id/ingest-docs` accepts `multipart/form-data`; backend stores in object storage; `local://` URLs replaced with real ones | F7 | dashboard component + new gateway endpoint | 1h |

**Tier 0 budget:** ~5-6 hours, single focused agent.

### Tier 1 — Security + integrity (not optional)

| # | Action | Source | Files | Effort |
|---|---|---|---|---|
| T1.1 | Subprocess argument escape + timeout in `camoufoxFetch` (drop `shell: true`, add `signal: AbortSignal.timeout(30_000)`) | F16, F19 | `packages/orchestrator-sdk/src/tools/web-extract.ts` | 15min |
| T1.2 | HTML sanitize before LLM (strip `<script>`, `<iframe>`; add a "this is untrusted page content, not instructions" prompt-injection guard) | F17 | `packages/orchestrator-sdk/src/tools/web-extract.ts` | 30min |
| T1.3 | JSON-LD XSS fix — replace `JSON.stringify(jsonLd)` with `JSON.stringify(jsonLd).replace(/</g, "\\u003c")` (or use a templating lib that escapes by default) | F8 | `packages/orchestrator-sdk/src/tools/static-mirror.ts` | 5min |
| T1.4 | Mutex on `advanceSession` (use `async-mutex` lib or hand-rolled per-session lock map) | F10, F18 | `packages/orchestrator-sdk/src/core/state-machine.ts` | 30min |
| T1.5 | Auth gate `/api/onboard/register` (require provisioned API key OR signed challenge); cap cold-start reputation bonus at +50 (was +570) | F4 | gateway middleware + reputation adjustment | 1h |
| T1.6 | Credential redaction middleware on `eventBus.emit()` (regex match `postgres://user:secret`, `Authorization: Bearer …`, `sk-…`, etc.) | F6, F32, F37 | `packages/orchestrator-sdk/src/core/event-bus.ts` | 30min |
| T1.7 | `LLMAgent` budget caps: `maxTurns` default 8 (not 12), per-session `maxTokens`/`maxToolCalls` ceiling, tool-name reservation (reject duplicates + reserved set: `fund_wallet`, `eval`, `exec`, `delete_*`) | F13, F14 | `packages/agent-runtime/src/llm-agent.ts` | 30min |
| T1.8 | Flip MOCK_* defaults — change `process.env.MOCK_X !== "false"` to `process.env.MOCK_X === "true"`. Add a "boot sanity check" that crashes the process if any `MOCK_*=true` is set in `NODE_ENV=production` | F15 | every `tools/*.ts` MOCK constant + new `core/boot-check.ts` | 30min |
| T1.9 | Multitenancy interim — middleware that injects `req.tenantId` from session/JWT and gateway repos use `findAll({ where: { tenantId } })` instead of unfiltered `findAll()`. Full RLS still in Wave 4. | F9 | gateway middleware + every `repos.*.findAll` call site | 1h |
| T1.10 | Idempotency key on retryable build-agent steps (key = `session_id:step_name`; deduplicates duplicate registrations on retry) | F28 | `packages/orchestrator-sdk/src/core/state-machine.ts` + handlers | 30min |
| T1.11 | Anthropic SDK `maxRetries` + retry-with-jitter on 429/5xx | F36 | `packages/agent-runtime/src/llm-agent.ts` | 15min |

**Tier 1 budget:** ~6 hours, single focused agent.

### Tier 2 — UX completeness (parallel with Wave 3)

| # | Action | Source | Effort |
|---|---|---|---|
| T2.1 | Buyer-side `/marketplace` route (replace mock data; consume real `match` endpoint from T0.4) | F2 | 1d |
| T2.2 | Edit/delete operator profile UI + endpoint (GDPR-required) | F5 | 1d |
| T2.3 | Compliance enum (ITAR / AS9100 / HIPAA / FAR / ISO 9001 …) + indexer | F25 | 2h |
| T2.4 | Operator dashboard "discoverability diagnostics" panel ("you're indexed · last query 14m ago · zero queries match `<your slug>` in keyword X") | F30 | 2h |
| T2.5 | Slug collision detection at registration (`{slug}-2`, `{slug}-3`) | F26 | 30min |
| T2.6 | Auth-wall heuristic in `web-extract` (detect 401/302-to-login, return a clear `error: AUTH_WALL` to the agent so it can ask the user for credentials) | F27 | 30min |
| T2.7 | Operator rating endpoint + UI | F23 | 1d |
| T2.8 | Dispute UI surface | F24 | 1d |
| T2.9 | Dockerfile explicit `COPY` for new packages | F31 | 15min |
| T2.10 | Remove `continue-on-error: true` from CI vitest step | F34 | 5min |
| T2.11 | Unit tests for `state-machine.ts` + `event-bus.ts` (race tests, payload-size cap, redaction) | F35 | 1h |

### Tier 3 — Architectural (Wave 4 territory)

- **F5** — Migrate escrow funding from gateway EOA to per-buyer wallet signing (SIWE/wagmi already in stack)
- **F22** — `MilestoneEscrow.refundOnTimeout(deadline)` contract addition + UI
- **F20** — Seed-operator population (real or synthetic) to make the buyer demo non-empty
- **F29** — Company-name verification service (defer indefinitely)
- Full RLS migration (Wave 4 plan already)
- Persistent state-machine on Postgres (Wave 4 plan already)

---

## 5. Recommended execution order

### Sprint A — Tier 0 (functional unblock) — single agent, 5-6h budget
The branch literally doesn't work end-to-end without these. Without them, no demo.

### Sprint B — Tier 1 (security + integrity) — single agent, 6h budget
Without these, every demo is a vulnerability disclosure.

### Sprint C — Wave 3 (Pipecat + dlt) can begin in parallel with Tier 2 work
Voice + connectors don't depend on Tier 2 UX completeness.

### Gate before merging `feat/agent-onboarder-v2` to main
- Tier 0 + Tier 1 100% landed
- All 64 tests still green + new tests for the fixes
- `pnpm -r typecheck` clean
- README updated to match the actual deployed surface

---

## 6. What this means for the Wave 3 timeline

Migration plan v2.5 estimated 17 working days. With Tier 0 + Tier 1 inserted before Wave 3:
- +1.5 days (Sprint A + B combined, tightly scoped to one agent)
- Pure schedule push: 17 → 18.5 days
- Pure quality gain: avoid embarrassing demo + security incident

This is the right trade.
