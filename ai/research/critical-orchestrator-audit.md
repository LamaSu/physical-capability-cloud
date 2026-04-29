# Critical Orchestrator-SDK / Template-Contract / Ops Audit

**Auditor**: review-charlie (platform-orchestrator persona)
**Scope**: `@pcc/orchestrator-sdk`, `@pcc/template-physical-operator`, `@pcc/template-data-product`, gateway wiring, dashboard mirror, CI/CD, deployment artifact, runtime / observability / failure-mode posture.
**Date**: 2026-04-24
**Branch**: capture-verification-protocol (working tree)

This is an adversarial review from the POV of the team who has to *run* PCC: deploy templates, monitor agents, page on incidents, and absorb the cost when things go wrong. **Working code is the floor — the question is whether this thing survives one bad weekend.**

---

## 1. SDK Contract Findings

### 1.1 `templates/registry.ts` — `defineTemplate` + `TemplateRegistry`

The validator covers presence of `slug`, `display_name`, `description`, `system_prompt`, `flow` (function check), `produces.{kind,capability_class}` and the `physical|digital` enum. It rejects bad slugs with a regex (`^[a-z][a-z0-9-]*$`) and the registry rejects duplicate slugs in `register()`.

**What's not validated:**

- **Slug max length** is unbounded. A 10-KB slug is accepted as long as it matches the regex. Memory pressure if a malicious template is dynamically constructed.
- **`adapters` is structurally `any`** at runtime. `TemplateAdapters` is a TS-only shape — no runtime check that `adapters.chat?.required` is a boolean, or that `fallback` references a known adapter slug. A template can declare `adapters: { chat: { required: "yes please" } as any }` and pass.
- **`connectors_optional` is also unchecked.** Strings are accepted verbatim. No allowlist against known PCC connector kinds (`postgres`, `octoprint`, `modbus`...). Drift between template authors and the gateway is silent.
- **`flow`** is checked to be a function — not that it's a *deferred* import. A template could write `flow: () => { runRandomCodeNow(); return import("./x.js"); }` and the runtime side effect fires on registry walk.
- **Async loader exception path is undefined.** If `template.flow()` rejects (e.g., the lazy-imported file has a syntax error, missing dependency, or top-level `throw`), no caller of `template.flow` in the SDK catches it. It's the consumer's job — and right now there ARE no SDK consumers, so this is undocumented.
- **`system_prompt` is a free-form string with no length bound** and no sanitization. A template with a 100-KB system prompt or one containing prompt-injection text (instructions to leak the operator's wallet) is accepted as-is. Trust model is implicitly "the SDK trusts every registered template author."
- **Singleton `templates` registry is process-global**, mutable, and shared. Tests that forget to call `templates.clear()` between cases can leak state. The exported `_resetStoreForTests` only resets `OnboardSession` Map, not the template registry — separate concerns, easy to confuse.
- **Slug clash policy is hard-throw.** If two `@pcc/template-*` packages ship with the same slug (deliberate fork, accidental rename), `register()` throws synchronously at gateway startup. This crashes the whole gateway boot if a startup script registers templates eagerly. There's no "last writer wins" or "merge" or even a non-throwing `tryRegister`.

### 1.2 `core/snapshot.ts` — Deterministic Replay

`takeSnapshot` builds an `OrchestratorSnapshot` with `taken_at`, `session_id`, `state`, `events`, `extras`. `serialize()` deliberately drops `taken_at` by default to make hashing stable.

**Determinism gaps:**

- **Object key order from JSON.stringify is not guaranteed for nested objects.** `serialize()` orders the *top-level* fields explicitly but relies on V8's insertion-order semantics for everything beneath. Across Node versions this is *practically* stable, but it's not contract-stable. A future Node minor that re-orders Object.entries on Map-backed objects will change the hash silently.
- **`events` is shallow-copied** (`[...opts.events ?? []]`). The events themselves still reference the original objects — if the caller mutates `event.payload` after `takeSnapshot()`, the snapshot is corrupted retroactively. No `structuredClone`.
- **`extras` is shallow-copied** (`{ ...opts.extras }`). Same bug, one level deeper.
- **No state at all by default.** If the caller forgets `state`, the snapshot quietly serializes without it. There's no required-field check. A "blank" snapshot is structurally valid.
- **`deserialize` is unsafe**: cast to `Partial<OrchestratorSnapshot>` with no shape validation. Hand a JSON file from a prior version with a different schema and you get a runtime type that lies about its TypeScript shape. Use of `JSON.parse` directly without Zod or even a typeof-guard.
- **Replay runner does not exist.** Wave 3+ TODO. Today snapshots can be stored but nothing in the SDK consumes them — the "deterministic replay" promise is half-written. New developers may assume replay works because the type exists.

### 1.3 `core/state-machine.ts` — Session Store

Trivial in-memory `Map<id, OnboardSession>` with `startSession`, `getSession`, `advanceSession`. The TODO acknowledges Wave 4 swap to Postgres + RLS.

**Today's failure modes:**

- **Unbounded growth.** No eviction. Long-running gateway instances accrete sessions until process memory runs out. Even at 10 KB/session, 100k abandoned sessions = 1 GB.
- **No concurrency control.** Two simultaneous calls to `advanceSession(id, ...)` race: `current = store.get(id)` and `store.set(id, next)` are not atomic. Last writer wins; intermediate state lost. Comment claims `advanceSession` is "idempotent" but it is not — it overwrites with `Date.now()` and shallow-merged patch. Two callers transitioning the same session in parallel will produce one of two outcomes nondeterministically.
- **No cross-replica state.** Run two gateway pods behind a load balancer, sticky sessions optional, and you get ghost sessions: a user's `started` session lives on pod A, the next request hits pod B, gets `session not found`, restarts the flow. Nothing in the codepath flags this.
- **State invariant unenforced.** The state-machine type lists `started -> data_connected -> docs_ingested -> interview -> capabilities_drafted -> built` but `advanceSession` accepts ANY `to: OnboardState` argument. Caller can jump from `started` directly to `built`. There's no transition table consult (unlike `template-data-product/src/flow.ts`, which DOES define transitions but lives in a different package and isn't enforced here either).

### 1.4 `core/event-bus.ts` — Process-Global Log

Process-singleton ring buffer (`MAX = 500`), `emit`, `tail`, `snapshot`, plus `tracked()` for begin/end pairs.

**Operational concerns:**

- **Cross-tenant leak risk.** All events go in one global array. There is no tenant/session partition at the bus level — `tail()` returns *every* recent event. If a tool emits a payload containing a partial credential and the dashboard renders the global `tail()` to admins (or worse, to operators-in-onboarding), unrelated tenants see each other's events. **This is a Wave-4 RLS gap that bites today.**
- **Payload not redacted.** `tracked()` puts the resolved tool result into `payload` if it's an object. `createAgentWallet` returns `private_key_redacted: "0x123***abc"` — fine. But `extractStructured` could return scraped contact info, and `publishOperator` echoes the registration with the operator's contact email. Anything returned by a tool with a "secret-shaped" key WILL get logged. No deny-list.
- **No replay guarantee.** Bus is fire-and-forget. If a downstream subscriber (Wave-4 OTel exporter) is slow, events are dropped past the 500-entry MAX silently. No back-pressure, no metrics on drops.
- **Unbounded payload size.** A 500-entry bus with 10-MB payloads = 5 GB. No `JSON.stringify(payload).length` cap before `log.push`.

### 1.5 Tools (`pcc-discovery`, `web-extract`, `static-mirror`, `wallet`)

#### `pcc-discovery.ts`

- `MOCK_PCC_DISCOVERY` defaults to `true` (`!== "false"` check). That means in any environment that doesn't set it explicitly to `"false"`, the tool returns a *fake* registration with id `pcc-mock-reg-...`. Production safety: if Railway env doesn't set this, EVERY operator onboarded gets a mock registration and never reaches the live gateway. **Confirm `MOCK_PCC_DISCOVERY=false` is in Railway prod variables.** (Default in code is unsafe — it should be `=== "true"` like `MOCK_WEB_EXTRACT`.)
- Best-effort DHT announce swallows network errors and continues. Good for resilience, but failure is buried in `dht_error` — there's no retry, no Sentry breadcrumb, no metric.
- Hardcoded operator wallet `0x0000...0000`. The mint-wallet tool generates a real one but the discovery payload sends zeros. Not strictly wrong (the gateway clearly accepts it) but it means the on-chain operator address is set during a *separate* later flow, with no enforced ordering.

#### `web-extract.ts`

- `camoufoxFetch` spawns a subprocess with no timeout. If `camoufox` hangs (proxy dead, target site rate-limits), the promise never resolves. **Symptom: orchestrator session permanently stuck mid-extract; hung HTTP request to the gateway; no remediation path other than process kill.**
- HTML truncated to 100 KB, but token cost on the Anthropic call is unmetered. A pathological page (one giant inline blob) → 100 KB raw HTML → ~25 K tokens just for the page content per call. No guard against running this 100 times in a session.
- `Anthropic` client constructed per call (`new Anthropic()` inside `extractStructured`). Reads `ANTHROPIC_API_KEY` from env each invocation — if the env var is wrong/missing the error is "missing API key" which is FINE, but each call also incurs a TLS handshake to api.anthropic.com — no connection reuse.
- No model rate-limit handling. If Anthropic returns 429, the function rejects synchronously. The LLMAgent above will fold the error into a `tool_result is_error` block, but the TIMING (how long until retry, how to bypass) is invisible.

#### `static-mirror.ts`

- Output dir defaults to `<package>/public/operators/`. **Inside a Docker container this is an ephemeral path — files vanish on rolling restart.** Caller must override `outDir`. Nothing in the code enforces or warns on this.
- HTML escaping is hand-rolled (`escapeHtml`) and covers `& < > "`. **Missing single-quote escape.** If a value with `'` lands in an attribute context (it doesn't today, all interpolations use `"..."`-quoted attrs), this is a future XSS vector. Robust solution: use a templating library or canonical entity table.
- `slugify` truncates to 80 chars with no de-dup. Two operators named "Acme Manufacturing North" and "Acme Manufacturing South" produce slugs `acme-manufacturing-north` / `-south` (fine), but "Acme Manufacturing — Northern Division Inc." truncates differently than "Acme Manufacturing — Northern Division LLC" — they may collide depending on length. No collision detection at write time → silent overwrite.

#### `wallet.ts`

- `MOCK_CDP` defaults to `true` (`!== "false"`). Same trap as `MOCK_PCC_DISCOVERY`. **In production a bare deploy generates `0xmock...` addresses.**
- The "real" path generates a private key in-process, logs it (redacted) to the event bus, and returns it (redacted) to the caller. **The full key never leaves the function scope — it's discarded.** This means the operator never gets their key. It's literally lost the moment the function returns. This is presumably intentional for the demo flow, but as a "production wallet creation" path it is not usable: the operator can't sign anything later.
- `funded: false` always for the real path. There's no faucet integration. The wallet is born with zero ETH.

### 1.6 `agent-runtime/llm-agent.ts` — Tool-Use Loop

Default model `claude-sonnet-4-6`, `max_tokens` 4096, `maxTurns` 12. Tool errors are caught and folded into `tool_result is_error` blocks — this is correct.

**Cost / safety:**

- **No per-session budget cap.** The loop runs up to 12 turns but each turn is unbounded in tokens (only `max_tokens` per turn = 4096 output tokens). With a 100-KB HTML input on every web-extract round-trip, a single conversation can easily burn $0.50+ in API spend. Multiplied by 1000 abandoned sessions = $500/day baseline before any malicious user spam. No spend tracking, no throttle.
- **`maxTurns: 12` default is generous.** Twelve full Anthropic round-trips + 12 tool executions per `chat()` call. A LOT of leverage for a runaway agent.
- **No tool-name collision check.** If two tools register the same `name` in `toolCallers`, the later one wins silently.
- **Tool name validation absent.** A template can register a tool named `wallet_drain_via_typo` or anything — the LLM picks tools by name and there is no allowlist. **Trust boundary: the SDK trusts every template's tool list.** A malicious 3rd-party template that ships a tool named `fund_wallet` (looks legit) but executes a transfer to attacker address is fully runnable today, end-to-end, with no gate.
- `runAgent` factory creates a new LLMAgent per call — fine, cheap.
- **No timeout on the whole `.chat()`.** A flaky network on the Anthropic call hangs forever. Should pass `maxRetries` / `timeout` to the SDK constructor.

---

## 2. Template Contract Robustness

| Question | Answer | Severity |
|---|---|---|
| Could a 3rd-party template steal the wallet by registering `fund_wallet` collision? | YES — no allowlist, no name reservation. | **HIGH** |
| Could a 3rd-party template execute arbitrary code at module-import time? | YES — `defineTemplate` runs at top-level, side effects fire immediately on `import`. The "lazy `flow` import" pattern only protects flow-level code, not the manifest module. | **HIGH** |
| Two templates same slug? | Throws synchronously in `register()`. If gateway eagerly registers all templates at boot, the gateway crashes. | **MEDIUM** |
| `flow()` lazy import throws at runtime? | No defined error path. Caller (currently nobody) must catch. | **MEDIUM** |
| Template can override model choice? | YES — system_prompt can include `<model>` directives, and the OnboarderAgent constructor accepts `model`. A template author can pass any model id and burn the operator's quota. | **MEDIUM** |

---

## 3. Deployment + Observability Findings

### 3.1 The Wiring Gap (CRITICAL)

**The new SDK packages are not wired into the deployed gateway.**

Evidence:

- `packages/gateway/src/server.ts` line 35 imports `orchestratorRoutes` from `./routes/orchestrator.js`.
- `packages/gateway/src/routes/orchestrator.ts` is the OLD multi-instrument **transfer-graph** orchestrator — biotech lab kernel topology with mock samples, not the new SDK.
- `grep -rn "orchestrator-sdk\|@pcc/template-physical-operator\|@pcc/template-data-product" packages/gateway` returns nothing inside server.ts or any route file.
- `routes/onboard.ts` exists (legacy, used by dashboard) but is unrelated to `OnboarderAgent`.
- The dashboard's `apps/dashboard/src/routes/orchestrator/templates.ts` mirror points `data-product` at `/api/orchestrator/data-product` — **this route does not exist server-side.** A user clicking the "Data Product" tile will hit a 404.

**Net:** the new orchestrator-sdk code is dead code in production until someone explicitly wires `routes/orchestrator/templates.ts` and `routes/orchestrator/<slug>/*.ts` into Fastify and registers the manifests at boot. The SDK contract claims (and the Wave 1 design doc claims) auto-mounting; the implementation is not there.

### 3.2 Dockerfile Gap (CRITICAL)

The Dockerfile copies `package.json` files for ~25 packages individually for layer caching, then runs `pnpm install --frozen-lockfile`. **`packages/orchestrator-sdk/package.json`, `packages/agent-onboarder/package.json`, and `packages/template-data-product/package.json` are not in the COPY list.**

What this means:

1. The COPY-then-install strategy will succeed (`COPY . .` later overwrites with the full tree), but the early-stage `pnpm install` runs with an INCOMPLETE workspace and may produce cache misses or unexpected dependency resolution warnings.
2. More importantly, the explicit COPY list serves as documentation of "these packages need to be in the image." The new packages aren't documented. If a future cleanup removes the `COPY . .` step (a common optimization), the new packages vanish from the image.
3. The `npx turbo build --filter='!@pcc/dashboard' ...` line will build the new packages because turbo sees them via `pnpm-workspace.yaml` (`packages/*` glob), but their dist outputs aren't in the staged COPY block — fine for a `COPY . .` pattern, but inconsistent.

**Confirmed via `grep -n "orchestrator-sdk\|agent-onboarder\|template-data-product" Dockerfile` → no matches.**

### 3.3 No Deploy Hookup for `agent-onboarder`

The `agent-onboarder` package's directory is named `packages/agent-onboarder/` but the npm name is `@pcc/template-physical-operator`. **The Dockerfile, CI workflow, and Railway config all reference packages by directory name.** When grep-driven scripts later try to find this package by `@pcc/template-physical-operator`, they will miss the directory — and the inverse, looking for `agent-onboarder` directory but expecting the OLD `@pcc/agent-onboarder` package name, will also miss. **Naming drift.** The README acknowledges this: "(Package directory is still named agent-onboarder for git-history minimal diff; the npm name is the canonical identifier.)"

### 3.4 Templates Drift (Server vs Client)

`apps/dashboard/src/routes/orchestrator/templates.ts` is hand-mirrored from server-side manifests with a comment saying "Keep this in sync." There is no `GET /api/orchestrator/templates` endpoint to make it dynamic. **Today's risk:** any new template added to `@pcc/template-*` requires a manual dashboard edit. Forget once → 404 from the picker. Versioning concern: if the server changes `display_name` and the dashboard cache has the old one, users see different names depending on whether the chat page or the picker rendered first.

### 3.5 Observability — `:3457` Dashboard, Sentry, OTel

- The harness dashboard at `:3457` is local to the developer machine, not the deployed gateway. It does not surface deployed-agent activity.
- The new packages do **not** import `Sentry`, `otel`, or any production telemetry pipe. They emit only to the in-process event bus. Nothing escapes the process.
- Gateway DOES have `packages/gateway/src/sentry.ts`, `otel.ts`, `telemetry.ts`. These are not used by the orchestrator-sdk packages (and again, the SDK packages aren't wired into the gateway).
- Audit log path: `~/.claude/audit/tool-calls.jsonl` is harness-local; not for runtime. **Production agent failures do not surface anywhere visible to the team today.**

### 3.6 Per-Tenant Isolation in Logs

Event bus is a single global. No `tenant_id` or `operator_id` partition. If/when this is exposed to the dashboard for "live activity" rendering, all tenants see all events. Wave-4 RLS gap.

### 3.7 CI

- `ci.yml` runs `pnpm build --concurrency=1` + `pnpm -r test` + `pnpm -r exec tsc --noEmit`. The new packages WILL be picked up by `pnpm -r` because they're in the workspace glob. **Good.**
- `continue-on-error: true` on the test step is alarming — networked-bus tests have pre-existing WebSocket timeouts and the comment acknowledges it. The new SDK tests CAN regress and CI passes.
- No coverage threshold. No `--coverage` flag. **Coverage is unmeasured.**
- forge-tests run on Solidity contracts only.
- No security scanning step (Trivy / Gitleaks / Semgrep). The harness `/vet` flow is local-only.

### 3.8 `pnpm-lock.yaml`

`grep -c "orchestrator-sdk\|@pcc/template-data-product\|@pcc/template-physical-operator" pnpm-lock.yaml` → 5 matches. Lockfile knows about the new workspaces. No duplicate-version installs spotted in spot-check. ⚠ Not exhaustively verified.

### 3.9 Type Safety

Confirmed pre-existing typecheck errors in `apps/dashboard/src/routes/orchestrator/[slug]/chat/index.tsx` (12 errors) and `orchestrator/index.tsx` (1 error). New packages (`orchestrator-sdk`, `agent-onboarder`, `template-data-product`) all pass typecheck — those errors are in the dashboard, which renders the chat UI for the new templates. **Dashboard is BROKEN — `tsc --noEmit` exit status 2.** Vite build still succeeds because vite tolerates type errors, but every dashboard interaction with the new templates is on shaky type ground.

---

## 4. Failure-Mode Catalog (20 Scenarios)

### [P0] 1. Bad template ships, dashboard tries to render it
**Symptom:** dashboard `/orchestrator/<slug>/chat` page renders, user types a message, server returns 404 because no route exists.
**Root cause:** new SDK templates aren't wired to gateway routes. Section 3.1.
**Repair:** add `routes/orchestrator/templates.ts` (list manifests) + `routes/orchestrator/<slug>/chat.ts` (delegates to OnboarderAgent / data-product flow). Mount in server.ts.
**Effort:** 1 day, 1 implementer.

### [P0] 2. Two templates same slug
**Symptom:** gateway boot crashes with `TemplateRegistry: slug "X" already registered`.
**Root cause:** registry throws synchronously; if startup eagerly registers, no recovery.
**Repair:** wrap eager registration in `try/catch`, log + skip duplicates (or fail-closed if duplicate is from a known author list).
**Effort:** 30 min once eager-registration code exists.

### [P0] 3. Tool inside SDK throws unhandled
**Symptom:** the LLMAgent loop catches per-tool errors and folds them into `is_error` tool_results — **this is correct**. But if the *agent itself* throws (`new Anthropic()` fails because env var missing), the parent's Promise rejects, propagates up to Fastify, which returns 500 with stack trace. Stack trace may include API keys if logged un-redacted.
**Root cause:** no top-level catch in OnboarderAgent.chat, no error redaction.
**Repair:** wrap chat() in try/catch, return `{ ok: false, error: redacted }`.
**Effort:** 30 min.

### [P0] 4. State-machine in-memory Map fills up
**Symptom:** gateway memory grows linearly with onboarding sessions; OOM after weeks.
**Root cause:** §1.3 — no eviction. 100k abandoned sessions x ~10 KB = 1 GB.
**Repair:** evict sessions older than 24h; cap MAX_SESSIONS = 10k LRU.
**Effort:** 2 hours (interim) / 2 days (Wave-4 Postgres swap).

### [P0] 5. Agent runs away
**Symptom:** an LLM picks a tool every turn, hits maxTurns=12, throws — but each turn already cost ~10K input tokens × 12 = 120K tokens × $3/M = $0.36 per session. A spam loop of 1000 sessions = $360.
**Root cause:** §1.6 — no per-session $ cap, no token cap, no rate limit.
**Repair:** track input+output tokens per chat(); abort if > $1.00 budget.
**Effort:** 4 hours.

### [P1] 6. Snapshot file disk fills
**Symptom:** none today — snapshots aren't persisted to disk anywhere in the SDK.
**Root cause:** persistence isn't wired (Wave 3+ TODO).
**Repair:** none needed today; when Wave-3 lands, add rotation + GC.
**Effort:** 0 today / 4 hours when wired.

### [P1] 7. Anthropic API rate-limit / outage
**Symptom:** every onboarding session fails with cryptic 429 / 5xx error in the dashboard chat UI. No retry, no failover.
**Root cause:** §1.5 — no retry-with-jitter. SDK doesn't pass `maxRetries` to Anthropic client.
**Repair:** `new Anthropic({ maxRetries: 2 })`; catch 429 in LLMAgent and surface as friendly retry-after message; wire fallback to a secondary provider (Bedrock?).
**Effort:** 2 hours minimal / 1 week for full failover.

### [P1] 8. Camoufox subprocess hangs
**Symptom:** `extract_url` tool call never resolves; orchestrator session sits in a tool_use round forever; HTTP connection holds open until client/server timeout.
**Root cause:** §1.5 — no timeout on `spawn(camoufox)`.
**Repair:** add `setTimeout(() => proc.kill('SIGTERM'), 60_000)` and reject with "camoufox timed out after 60s".
**Effort:** 30 min.

### [P1] 9. Nexla session token expires mid-onboarding
**Symptom:** Nexla isn't actually integrated in the new SDK packages (we're in v2.5 reframe). N/A today.
**Root cause:** N/A.
**Repair:** when Nexla connector lands, design refresh-on-401 pattern.
**Effort:** 0 today.

### [P1] 10. PCC `/api/dht/announce` 5xx during onboarding
**Symptom:** `pcc-discovery.publishOperator` reports `dht_announced: false` with `dht_error: "HTTP 503 ..."` and continues. Operator is registered (step 1) but not discoverable by buyer agents until DHT recovers.
**Root cause:** best-effort design (§1.5), correct but not retried.
**Repair:** queue failed announces, retry every 60s for 1 hour. Or just log a metric and let manual reannounce handle it.
**Effort:** 4 hours.

### [P1] 11. Stale env vars from removed integrations
**Symptom:** old `.env.example` may reference `MOCK_INSFORGE`, `TINYFISH_API_KEY`, etc. Verified: **NONE of those names are present** in `packages/`, `apps/`, or `.env.example`. Schema drift between v1 and v2.5 is clean. ✓
**Root cause:** N/A.
**Repair:** none needed.
**Effort:** 0.

### [P0] 12. Operator data leaked to dashboard via shared in-memory state
**Symptom:** §1.4 — global event bus + global TemplateRegistry. If a future "live activity feed" panel queries `tail()` for admin view, all tenants' events show up. **Wave 4 RLS gap that bites today** if the dashboard adds such a panel.
**Root cause:** no tenant partition at the bus level.
**Repair:** partition events by `session_id` at emit time; require `session_id` in `tail()` filter.
**Effort:** 1 day.

### [P0] 13. Dashboard `templates.ts` mirror drifts
**Symptom:** server-side manifests change, client-side mirror doesn't, picker shows stale name; OR worse, server adds template, picker doesn't show it, user can't pick it.
**Root cause:** §3.4 — no `GET /api/orchestrator/templates` endpoint; mirror is hand-edited.
**Repair:** add the endpoint, fetch on dashboard mount, hydrate. Cache in-memory client-side for the session.
**Effort:** 4 hours.

### [P1] 14. Pipecat / dlt sidecars (Wave 3)
**Symptom:** Python sidecars don't exist yet.
**Root cause:** N/A.
**Repair:** see §5.
**Effort:** N/A.

### [P0] 15. Disaster recovery
**Symptom:** Spark dies mid-onboarding; in-memory session is lost; user reloads dashboard, has to start over.
**Root cause:** §1.3 — no persistence.
**Repair:** Wave 4 Postgres swap. Interim: serialize session JSON to disk every transition (but this still loses data on Spark/host failure).
**Effort:** 1 week (Wave 4).

### [P1] 16. Secret leakage in tool errors
**Symptom:** if Anthropic returns "invalid x-api-key: sk-ant-abc...", that key text lands in the tool_result error block, then in the event bus, then in any future log exporter.
**Root cause:** §1.5 — no error sanitization in catch blocks.
**Repair:** scrub `sk-ant-`, `pcc_live_`, `0x[a-f0-9]{40,}` patterns in the catch in LLMAgent.chat.
**Effort:** 2 hours.

### [P1] 17. Test coverage unmeasured
**Symptom:** orchestrator-sdk has 6 test files (~850 LoC), agent-onboarder has 1 (~245 LoC), template-data-product has 1 (~50 LoC). Registry contract is fully covered, snapshot has 46 lines (basic), llm-agent.test.ts is 9.9 KB. Coverage % not measured.
**Spot gaps:**
- `state-machine.ts` has zero tests (§1.3 race condition not exercised).
- `event-bus.ts` has zero tests (§1.4 cross-tenant not exercised).
- `pcc-discovery.ts` tests cover happy + DHT-fail paths but not malformed register response.
- No integration test that wires SDK + gateway end-to-end.
**Repair:** add coverage gate to CI (>=70% per package), write the missing unit tests, write one Fastify integration test.
**Effort:** 2 days.

### [P1] 18. CI doesn't run vitest with coverage
**Symptom:** §3.7 — `continue-on-error: true` on test step. Test failures don't fail CI.
**Root cause:** historical WebSocket timeout in a2a tests; mass exemption.
**Repair:** flake-quarantine the a2a tests specifically, remove the global continue-on-error.
**Effort:** 4 hours.

### [P1] 19. Lockfile integrity
**Verified:** lockfile mentions new workspaces (5 occurrences). Spot check shows no duplicate version installs. No issues found.
**Effort:** 0.

### [P0] 20. Dashboard typecheck broken
**Symptom:** §3.9 — `pnpm -r typecheck` exits non-zero. 13 errors across `orchestrator/[slug]/chat/index.tsx` and `orchestrator/index.tsx`. Vite build still passes (it doesn't run tsc), but the dashboard renders broken types in production.
**Root cause:** `useChat`/`ChatThreadProps`/`OnboardEvent` types changed underneath; chat/index.tsx wasn't updated.
**Repair:** fix the type signatures or the call sites. Likely a 30-min job per error.
**Effort:** 4 hours total.

---

## 5. Pre-Wave-3 Readiness Checklist

Wave 3 plans Pipecat (voice sidecar, Python) + dlt (data-load sidecar, Python).

### 5.1 SDK adapter contract — DOES NOT EXIST

The `TemplateAdapter` interface (`registry.ts` line 25) has shape `{ required: boolean; fallback?: string }`. **There is no protocol for what an adapter *is* in code.** No interface for "voice adapter exposes `transcribe()`, `synthesize()`, etc." No registry of adapter implementations. No way for the SDK to ASK an adapter "are you available?" before claiming to wire it.

### 5.2 Process management for Python sidecars — UNSPECIFIED

No plan for:
- How does Pipecat get launched? (separate Railway service? subprocess of gateway?)
- How does the gateway discover its address?
- Health checks?
- Restart policy?
- Resource limits?

### 5.3 Backpressure between Node ↔ Python — UNSPECIFIED

`web-extract.ts` already uses subprocess via spawn. Lessons learned (no timeout, no resource limit) need to be captured BEFORE Pipecat lands or the same gaps recur.

### 5.4 Auth between Node ↔ Python — UNSPECIFIED

How does Pipecat authenticate to the gateway? Shared secret? mTLS? Service mesh? Today the gateway has API-key auth for external callers — internal services need a different story.

### 5.5 Recommended pre-Wave-3 work

1. Define `Adapter<T>` interface in `orchestrator-sdk/src/adapters/index.ts` with `init()`, `health()`, `dispose()`. Make `TemplateAdapter.fallback` reference adapter slugs from a registry.
2. Spec out a sidecar process-management contract (subprocess vs separate Railway service, supervisor strategy, health probe interval).
3. Pick an internal-auth scheme (HMAC over a shared secret is fine for v1).
4. Codify the timeout / resource-limit pattern: every subprocess spawn must have a timeout and a memory cap.

---

## 6. Top Systemic Concerns

1. **The new SDK is shipped but not deployed.** The gateway doesn't import any of it. The dashboard mirror points at routes that don't exist. We are one product-marketing claim away from "the data-product template ships in v2.5" being false-in-production. Until §3.1 + §3.4 land, this is vapor.

2. **Trust boundary not codified.** `defineTemplate` accepts arbitrary system prompts, arbitrary tool names, and arbitrary `flow()` callbacks with no review gate. As long as templates ship in-tree, we trust the authors via code review. The moment a 3rd party publishes `@malicious/template-X`, an `npm install` is enough to take over the operator's wallet on next gateway boot. There is no "tool name reservation" or "review the system_prompt" gate.

3. **Observability is not deployed-ready.** Sentry exists in the gateway, but the SDK packages don't import it. The event bus is process-global and unredacted. There's no per-tenant log partition. When a real operator hits a bug in production, the SRE rotation has nothing to look at except `journalctl` on the Railway pod.

---

## 7. Where to Look Next

Files that warrant follow-up:

- `C:\Users\globa\physical-capability-cloud\packages\gateway\src\server.ts` (line 35 + 336) — re-purpose `routes/orchestrator.ts` OR add a separate `routes/orchestrator-sdk.ts` to wire the new templates.
- `C:\Users\globa\physical-capability-cloud\Dockerfile` (lines 13-39) — add the three new package COPY directives or replace the entire COPY block with `COPY packages/*/package.json packages/`.
- `C:\Users\globa\physical-capability-cloud\.github\workflows\ci.yml` (line 32) — remove `continue-on-error: true` for tests, quarantine the a2a flakes specifically.
- `C:\Users\globa\physical-capability-cloud\apps\dashboard\src\routes\orchestrator\[slug]\chat\index.tsx` — fix 12 type errors, or update `ChatThreadProps`/`OnboardEvent`/`useChat` to match.
- `C:\Users\globa\physical-capability-cloud\apps\dashboard\src\routes\orchestrator\templates.ts` — make this dynamic via `GET /api/orchestrator/templates`.

Test gaps worth filling first:

- `packages/orchestrator-sdk/src/core/state-machine.test.ts` (does not exist).
- `packages/orchestrator-sdk/src/core/event-bus.test.ts` (does not exist).
- One Fastify integration test that boots the gateway, registers both templates, and POSTs `/api/orchestrator/data-product/chat`.
