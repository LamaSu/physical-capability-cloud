# Job-status vocabulary reconciliation — notes

## The bug

`PATCH /api/jobs/:id/status` rejected `"running"` with
*"Status must be one of: pending, queued, in_progress, paused, completed, failed, cancelled"*,
yet the JobDTO type and the agent docs/CLAUDE.md advertised `"running"`. A client
following the docs got a 400.

## What was fixed (this branch)

Picked the **API's canonical set** as the single source of truth:

```
pending | queued | in_progress | paused | completed | failed | cancelled
```

- **`packages/gateway/src/config/job-status.ts`** (new) — one source of truth:
  `JOB_STATUSES`, `isJobStatus()`, `normalizeJobStatus()`. `running` is a
  tolerated **input alias** → normalised to `in_progress`; it is never stored or
  echoed back.
- **`routes/jobs.ts`** — `PATCH /api/jobs/:id/status` validates+normalises
  through the module. `in_progress` works; `running` works (aliased); the stored
  value is always canonical.
- **`routes/operator-relay.ts`** — `POST /api/operator/job-status` (the
  alternative update path) used the *opposite* vocabulary (accepted `running`,
  rejected `in_progress`). Now shares the same module.
- **`routes/capabilities.ts`** — the WoT TD job-result `status` enum now lists
  the canonical set.
- **Docs** — `CLAUDE.md`, `docs/AGENT_INTEGRATION.md` (JobDTO union), and the
  served `apps/dashboard/public/agent-package.json` + root `agent-package-test.json`
  tool catalogs (list_jobs / update_job_status / operator_update_job_status).
- **`apps/dashboard/src/types/dto.ts`** — client `StepStatus` mirror aligned to
  the canonical set (was the only DTO type that literally claimed `running`).

### Tests
- New `packages/gateway/src/__tests__/job-status-vocab.test.ts` (transitions:
  `in_progress` accepted, `running` alias → `in_progress`, every canonical
  status accepted, unknown rejected 400, persistence).
- Updated `operator-relay.test.ts` to assert the normalised value.
- **Full `@pcc/gateway` vitest suite green** (97 files / 1705 tests). The two
  `capture*.test.ts` files needed `@pcc/verifier` built (unrelated to this change —
  `@pcc/verifier` has no `exports` map so vitest's source-aliasing can't redirect
  its deep `dist/capture/*` imports); built `@pcc/spec` + `@pcc/verifier` and they
  pass.
- `apps/dashboard/src/types/dto.ts` is pure types (standalone `tsc --noEmit`
  passes); the removed members have no comparison consumers in the dashboard.

## Intentionally OUT OF SCOPE (pre-existing divergences, not the `running` bug)

There are **three** other job-status vocabularies in the repo. They were left
alone because reconciling them is a larger migration than the documented bug, and
none of them re-introduces the `running`-gets-a-400 problem:

1. **`@pcc/spec` `StepStatus`** (`packages/spec/src/types/common.ts`) — the type
   the gateway's *real* JobDTO uses. It is
   `pending | scheduled | in_progress | awaiting_verification | verified | disputed | completed | failed | cancelled`.
   It already uses `in_progress` (no `running`), so it does **not** trigger the
   bug — but it lacks `queued`/`paused` (which the route accepts) and adds states
   the route rejects (`scheduled`/`awaiting_verification`/`verified`/`disputed`).
   **Not changed:** huge blast radius — `packages/spec/src/types/packml.ts` does an
   exhaustive `switch` over `StepStatus` with a compile-time exhaustiveness guard,
   and it is consumed across many packages. Converging it on the route's set is a
   dedicated migration.

2. **DB / seed runtime vocabulary** — seeds store `"executing"`
   (`packages/db/src/seed/jobs.ts`), and the dashboard pulse map also knows
   `preparing` / `collecting_evidence` / `awaiting_pickup`. The job populator
   passes the stored status through verbatim
   (`model.status as JobDTO["status"]`), so a seeded job still surfaces
   `"executing"`, not a canonical value. **Not normalised at the populator:** that
   would be a one-alias half-measure; the real fix is to converge the runtime
   vocabulary and add a data migration for legacy `executing` / `running` rows.

3. **Protocol-run status** (`binding | ready | running | paused | …`) — a
   *different domain* (`/api/protocols/*`, `ProtocolRunStepStatus`). It
   legitimately uses `running`; intentionally untouched (including its enum in the
   agent-package catalogs).

## Recommended follow-up (if a full reconciliation is wanted)

Pick ONE canonical job-status union; converge `@pcc/spec` `StepStatus` + the
routes + the seed + the populator on it; update the PackML mapping + exhaustive
switch; add a DB migration that rewrites legacy `executing` → `in_progress`
(and any stray `running` → `in_progress`).
