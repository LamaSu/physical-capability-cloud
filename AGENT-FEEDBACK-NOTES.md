# Agent bug-feedback feature — implementation notes

Branch: `fix/driver-agent-feedback` (off `origin/master`). **Build + test only — not deployed, not pushed.**

## Status: all three deliverables complete

1. **`POST /api/feedback`** (PUBLIC) + **`GET /api/admin/feedback`** (X-Admin-Token) — rewritten onto the `waitlist.ts` durable pattern. ✅
2. **`pcc_report`** tool re-pointed to `POST /api/feedback` with the canonical shape. ✅
3. **`system_prompt`** instructs agents to report bug/friction/idea via `pcc_report`. ✅

**Acceptance verified** by `packages/gateway/src/__tests__/feedback.test.ts` (11 cases, green): a cold/unauthenticated POST round-trips into storage and is readable via `GET /api/admin/feedback`; the served `agent-package.json` `system_prompt` instructs friction reporting.

## Important discrepancy surfaced (the task assumed a clean slate; it wasn't)

The task described agents as having "NO in-product way to report back." In fact **three pieces already existed**, which shaped the safest implementation:

- **`routes/feedback.ts`** already served `POST /api/feedback` (+ an auth-gated `GET /api/feedback`) for the **human dashboard bug-report modal** (`AgentChatPage.tsx`) and `install.html`. It stored a single rewritten JSON array at `PCC_FEEDBACK_PATH ?? "./data/feedback.json"` — a **relative path that is likely NOT on the mounted volume**, so those reports were probably lost on every redeploy. Shape: `{type, message, page, walletAddress, email}`.
- **`routes/agent-feedback.ts`** already served `POST /api/feedback/agent-report` (observability "piece 3"), persisting to the **audit log** (a temporary sink), with a `pcc_report` tool already pointing at it.
- `/api/feedback` was already in `apiGate` `PUBLIC_PREFIXES`.

Because Fastify rejects duplicate routes, I could not add a second `POST /api/feedback` — I had to **rewrite the existing `feedback.ts`**. Decisions made to satisfy the spec without breaking production:

- **Rewrote `feedback.ts`** to the exact `waitlist.ts` pattern: JSONL append on `DATA_DIR = dirname(PCC_DB_PATH)` (the mounted volume), honeypot, per-IP sliding-window rate limit, `adminOk` (X-Admin-Token === `WAITLIST_ADMIN_TOKEN`). This also **fixes the durability bug** above (feedback now lands on the volume, not an ephemeral relative path).
- **Backward compatibility kept**: the new route accepts the canonical agent shape `{type:bug|friction|idea, summary, detail, endpoint, traceId, severity, agentId}` AND the legacy dashboard shape (`message`→`summary`, `page`→`endpoint`) AND the agent-report aliases (`trace_id`, `last_endpoint`, `agent_kind`). Unknown types coerce to `bug` rather than 400 — a stuck agent's report is never rejected on a taxonomy quibble. The live dashboard modal + `install.html` (which only check `res.ok`) keep working.
- **Discord webhook preserved** (best-effort, no-op unless `DISCORD_WEBHOOK_URL` is set) so the team keeps getting live notifications.
- **`GET /api/feedback` (the old auth-gated read) was removed.** No GET consumer was found in the dashboard; the new `GET /api/admin/feedback` supersedes it, and removing it eliminates the surface a prior red-team flagged for leaking wallet addresses. A GET to `/api/feedback` now 404s.
- **`routes/agent-feedback.ts` (`/api/feedback/agent-report`) left untouched** — its 20-test suite still passes and removing it was out of scope. It is now orphaned by the tool list (no tool points at it) but still functions.

## Follow-ups for whoever deploys this (NOT done here — build+test only)

1. **Legacy data migration.** If `PCC_FEEDBACK_PATH` was set in prod to a real volume path, existing entries in that old single-JSON file are *not* read by the new admin export (different file + format: `${DATA_DIR}/feedback.jsonl`). A one-off script could convert old entries to JSONL lines if any are worth keeping. (If `PCC_FEEDBACK_PATH` was unset, the old path was ephemeral and there's nothing to migrate.)
2. **Two agent-feedback sinks now coexist**: the new durable `/api/feedback` (JSONL, admin-readable) and the older `/api/feedback/agent-report` (audit log + PostHog + OTel). Consider consolidating `agent-report` onto `/api/feedback` in a follow-up, or keep it for the OTel/PostHog telemetry it emits.
3. **`WAITLIST_ADMIN_TOKEN` must be set** in the environment for `GET /api/admin/feedback` to return data; it fails closed (403) when unset.
4. **`scripts/update-agent-package-v2.14-observability.mjs`** still contains the *old* `pcc_report` definition (endpoint `/api/feedback/agent-report`). It is idempotent (skips when `pcc_report` exists) so it will not revert this change, but it is now superseded by `scripts/update-agent-package-feedback.mjs`. Left as a historical record per the dated-migration-script convention.

## Tooling / test-scope notes

- **Spark was unavailable** in this environment (`spark-check` not found), so tests ran locally and tightly scoped.
- Changed-package tests run + green: `feedback.test.ts` (11), `agent-feedback.test.ts` (20, unchanged), `tool-search.test.ts` (9, reads the real `agent-package.json`). To run `tool-search.test.ts` I built `@pcc/spec` + `@pcc/tool-index` (cheap leaf packages; `dist/` is gitignored).
- The **full** `@pcc/gateway` vitest suite needs most workspace deps built first (e.g. `onboard-chat.test.ts` → `@pcc/store` via `db.js`); that is the "heavy turbo build" the task said to avoid, and it was not run here.

## Tunable env (new)

- `PCC_FEEDBACK_RATE_MAX` (default `60`) — max feedback POSTs per IP per window.
- `PCC_FEEDBACK_RATE_WINDOW_MS` (default `60000`) — the rate-limit window.
- Existing: `PCC_DB_PATH` (its dirname is the storage volume), `WAITLIST_ADMIN_TOKEN`, `DISCORD_WEBHOOK_URL`.
