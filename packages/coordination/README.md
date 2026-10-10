# @pcc/coordination

> PCC autonomous-org coordination backend — the "agents do the work on the backend" half of the Unified Control-Plane (`ai/research/unified-control-plane/UI-COORDINATION.md` §9). Additive-only vertical slice: adopts the harness control-plane spine, never forks it.

**Status:** vertical slice on `feat/coordination-org-backend`. Additive-only — creates files only under `packages/coordination/**`; never edits another package, settlement/oracle code, or `.claude/*`.

---

## Design principles

- **Additive-only.** Every dependency this package has on the rest of the monorepo is a *read* of an already-public interface (`@pcc/a2a`'s message bus, `@pcc/workflow`'s durable-execution primitives). Nothing here edits another package.
- **Draft-first.** The Brain (`src/brain/supervisor.ts`) only ever *proposes*. `tick()` reads a snapshot, evaluates reactions, and enqueues durable queue items — it never dispatches, never calls a broker, never executes a mutate/exec/actuate/privileged action itself. Approval is a separate, human-in-the-loop step; dispatch is a separate module (`src/dispatch/workflow-dispatch.ts`) triggered only after approval.
- **Kill switch.** The Brain checks an env var (`PCC_COORDINATION_BRAIN_HALT=1`/`true`) or an optional sentinel file on every `tick()`. Either one halts cleanly — no throw, no side effects, no restart required to un-halt.
- **External-scheduler loop.** This package never schedules itself (no internal `setInterval`). Whatever embeds it — a gateway route, a cron, a queue worker — calls `brain.tick()` and `dispatcher.dispatchApproved()` on its own cadence.
- **`@pcc/workflow` durability.** Every dispatched action is a `@pcc/workflow` run: step-memoized, crash-recoverable, idempotent by construction. See [Acceptance](#acceptance--the-kill-resume-test) below for what that buys.
- **Adopts, never forks, the control-plane spine.** The three integration contracts below are the seams this package builds to, not a competing design.

---

## Module map

| File | Owns |
|---|---|
| `src/brain/supervisor.ts` | `Brain` — external-scheduler `tick()`: snapshot → react → enqueue. Kill switch. |
| `src/snapshot/facade-snapshot.ts` | `takeOrgSnapshot()` — read-only tap of 2-3 gateway-facade-shaped sources into one `OrgSnapshot`. Documents why it does NOT depend on `@pcc/gateway` directly (see file docblock). |
| `src/events/org-bus.ts` | `OrgBus` — thin wrapper over `@pcc/a2a`'s message-bus backend, `org.*` subjects. |
| `src/events/org-watch.ts` | `watchOrgEvents()` — contract (b): projects `org.*` as AG-UI-shaped frames via a swappable `frameFactory` seam. |
| `src/reactions/rule-engine.ts` | `ReactionRuleEngine` + the one shipped rule, `staleKernelRule`. |
| `src/queue/human-queue.ts` | `HumanQueueStore` — durable (own SQLite table) human-in-the-loop queue. Internal storage shape; see `org-approval-item.ts` for the wire contract. |
| `src/queue/org-approval-item.ts` | Contract (a): the exact `OrgApprovalItem` schema + `listApprovals()` / `resolveApproval()` — what a `GET /org/approvals` / `POST /org/approvals/:id/resolve` route calls. |
| `src/alerts/channel.ts` | `AlertChannel` + `ConsoleAlertChannel` — the one stub channel (no `@pcc/alerts` package exists). |
| `src/dispatch/workflow-dispatch.ts` | `WorkflowDispatcher` — contract (c) broker seam + the actual `@pcc/workflow` dispatch on approval. Owns the idempotency guarantee. |

---

## The three integration contracts

From `UI-COORDINATION.md` §9.1–9.2 — this package builds to these seams rather than inventing its own shapes where a contract already exists.

### (a) Durable human-queue — fully owned here

`src/queue/org-approval-item.ts` defines `OrgApprovalItem` exactly as specified and provides:

- `listApprovals(queue, { status?, persona? })` — the `GET /org/approvals?status&persona` handler body.
- `resolveApproval(queue, id, { approved, editedArgs?, resolvedBy })` — the `POST /org/approvals/:id/resolve` handler body.

The internal `HumanQueueStore` (`human-queue.ts`) keeps its own SQLite-backed shape (it predates, and is more detailed than, the wire contract — it also tracks `dispatchRunId`/`acknowledged` for dispatch-linkage that the wire contract has no slot for). `org-approval-item.ts` is a pure, additive mapping layer between the two, in the same spirit as `~/.claude/lib/genui/contracts.js`'s own `QueueItem` mappers. See that file's docblock for the exact field-derivation rules and the honestly-documented gaps (no `expired` status yet — no SLA/timeout poller exists in this slice).

### (b) `GET /org/watch` — SSE, seam only

`src/events/org-watch.ts`'s `watchOrgEvents(bus, onFrame, { frameFactory? })` subscribes to every `org.*` subject and projects each event through a `frameFactory`. The default (`stubFrameFactory`) produces dependency-free, "valid-enough" `STATE_SNAPSHOT`/`STATE_DELTA`/`CUSTOM` frames. A real deployment swaps in the harness's actual AG-UI frame factories (`~/.claude/lib/genui/{agui-events.js,agui-job.js}`, re-exported via `contracts.js`) by passing a `frameFactory` — this package intentionally does NOT import that absolute, cross-repo path itself (see the file's docblock for why: this package must stay buildable/testable/publishable on its own).

### (c) Brain → broker — intents only, never direct execution

The Brain (`brain/supervisor.ts`) emits intents into the durable queue (pre-Verdict) and never calls a broker directly for any `write`/`exec`/`network`/`credential`/`settlement` action. `src/dispatch/workflow-dispatch.ts`'s `WorkflowDispatcherOptions.dispatchViaBroker` is the seam a real harness tool-broker wires in later (action classification, allowlists, audit log — see `rules/library/security-pipeline.md`); the default implementation performs the local `@pcc/workflow` dispatch directly, since no such broker exists inside this vertical slice yet. The call site (`dispatchApproved()`) never changes when the seam is wired.

---

## Usage

```ts
import { Brain, WorkflowDispatcher } from '@pcc/coordination';

const dbPath = process.env.COORDINATION_DB_PATH ?? '/data/coordination-brain.sqlite';

const brain = new Brain({ dbPath /*, facadeSource: yourGatewayFacadeAdapter */ });
const dispatcher = new WorkflowDispatcher({ dbPath, bus: brain.bus });
await dispatcher.recover(); // resume any incomplete runs from a previous boot

// Whatever schedules this package's cadence (cron / queue worker / route):
setInterval(async () => {
  await brain.tick();               // snapshot -> react -> enqueue (draft-first)
  await dispatcher.dispatchApproved(); // process anything a human has approved since the last pass
}, 60_000);
```

`@pcc/coordination` reads no environment variables itself (same convention as `@pcc/workflow`) — the consumer decides `dbPath` and, optionally, `PCC_COORDINATION_BRAIN_HALT` for the kill switch.

---

## Acceptance — the kill-resume test

`src/__tests__/kill-resume.test.ts` is this package's definition of done: start a Brain, drive one tick to a pending queue item, enqueue + approve + dispatch a second item with a real action, confirm the resulting `@pcc/workflow` run is genuinely incomplete (durably blocked on a completion signal nothing has sent yet), simulate an ungraceful kill (drop every in-memory reference without closing anything), construct entirely new objects against the same SQLite file, and assert:

- the approved item and its `dispatchRunId` survive intact,
- `WorkflowEngine.recover()` finds and resumes the same run (not a new one),
- a second `dispatchApproved()` pass dispatches nothing new — no double-dispatch.

Run it:

```bash
pnpm --filter @pcc/coordination test
pnpm --filter @pcc/coordination typecheck
```

---

## Known gaps (documented, not silent)

- `OrgApprovalItem.status` never reaches `"expired"` — no SLA/timeout poller exists in this slice (`slaHours`/`defaultOnTimeout` are correspondingly never populated).
- `dispatchViaBroker`'s default implementation IS the local dispatch — there is no real cross-cutting broker to route through yet inside this vertical slice.
- `src/events/org-watch.ts`'s frames are AG-UI-*shaped*, not produced by `@ag-ui/core` or the harness's real frame factories — see that file's docblock for the swap-in pattern.
- `src/snapshot/facade-snapshot.ts` ships a `StubFacadeSource` (empty data) — wiring real `@pcc/gateway` facade reads (or their HTTP surface) is a follow-up; see that file's docblock for why this package doesn't depend on `@pcc/gateway` directly today.
