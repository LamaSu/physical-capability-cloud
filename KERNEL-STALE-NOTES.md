# Kernel staleness fix — notes

Branch: `fix/driver-kernel-stale`

## Problem

Kernels went `isStale: true` / `available: false` on their own after just **5
minutes** without a heartbeat, while `status` was still `online`. Low-traffic
operators who onboard and create a listing but don't run a heartbeat daemon
silently dropped out of buyer-facing results five minutes later. Only a manual
heartbeat revived them.

Staleness was computed in **two** places, each with its own `5 * 60 * 1000`
magic number:
- `facades/populators/kernel.populator.ts` → `KernelDTO.isStale`
- `facades/populators/capability.populator.ts` → `CapabilityDTO.kernelStatus = "stale"` → `available = false` (the buyer-facing path)

## Fix (server-side, no operator daemon required)

New single source of truth: `facades/populators/staleness.ts`.

- `isKernelStale(status, lastHeartbeat, hasActiveListing, now?)` — only `online`
  kernels can be stale. A kernel **with an active listing (≥1 capability)** gets
  a **24h keepalive grace** before going stale; a kernel with no listing keeps
  the bare **5-minute** threshold. The grace is finite, so a genuinely dead
  listed kernel is still flagged eventually.
- `kernel.populator.ts` passes `capabilityCount > 0` as `hasActiveListing`.
- `capability.populator.ts` passes `true` — the capability being populated *is*
  an active listing, so its kernel qualifies for the grace. This is what keeps
  listings `available` past 5 minutes.

Both magic numbers are gone; both call sites now share `staleness.ts` (this also
removes the drift risk that produced two copies of the rule in the first place).

### Why a 24h grace (vs. "never stale" or just widening to e.g. 30m)
- Directly satisfies acceptance: a listed kernel stays available well past 5 min
  with no manual heartbeat.
- Finite, so staleness stays meaningful — a kernel dead for >24h is still
  flagged. (`status: offline/maintenance` remains the explicit "take me down"
  switch; those are never reported stale.)
- A single constant (`ACTIVE_LISTING_GRACE_MS`) — trivial to tune later.

## Acceptance — met & verified by tests that RUN

- `__tests__/populators/staleness.test.ts` (NEW, included, green) — rule unit
  tests incl. "active listing stays NOT stale well past the 5-minute threshold"
  and the 24h ceiling, deterministic via injectable `now`.
- `__tests__/populators/capability-populator.test.ts` (included, green) — added
  "active listing stays available past the 5-minute threshold (keepalive grace)"
  asserting `available === true` for a 1h-old heartbeat, plus a >24h ceiling
  case. This is the buyer-facing acceptance.
- `__tests__/capability-facade.test.ts` (included, green, 36 tests) — no
  regression through the facade + seeded store.

Scoped run used (Spark was unavailable; these are light, not turbo builds):
```
pnpm --filter @pcc/spec build && pnpm --filter @pcc/store build   # worktree deps
pnpm --filter @pcc/gateway run test src/__tests__/populators/      # 82 passed
pnpm --filter @pcc/gateway run test src/__tests__/capability-facade.test.ts  # 36 passed
```

## Caveat / gap (not a gap in the fix)

`__tests__/populators/kernel-populator.test.ts` is in the pre-existing
`vitest.config.ts` `exclude` list ("Temporarily excluded — facade rewrite
changed route behavior … Fix in follow-up session"). I added kernel-level grace
tests there (kernel with active listing + >5-min heartbeat → `isStale: false`;
+ 24h ceiling) and verified the file in isolation: **25/26 pass, including all
my new tests.** The single failure is **pre-existing and unrelated** to
staleness — `expect(dto.capabilities).toEqual(dto.capabilityTypes)` (line 86):
the `KernelDTO.capabilities` backward-compat alias was dropped in the facade
rewrite (the populator has a dangling comment but no `capabilities` field), so
`dto.capabilities` is `undefined`.

I left `vitest.config.ts` untouched and did **not** re-enable the file, so the
package suite stays green. The kernel-level `isStale` behavior is still verified
by `staleness.test.ts` (which runs). The grace tests in `kernel-populator.test.ts`
will run once that file is un-excluded.

### Suggested follow-ups (out of scope here)
1. Restore the `KernelDTO.capabilities` alias (or delete the stale assertion),
   then drop `kernel-populator.test.ts` from the `exclude` list — my grace tests
   then run in CI. (The alias may be a real dashboard-contract regression worth
   its own look.)
2. Once `protocol-fixes.test.ts` is un-excluded, add a "Fix 3" integration
   assertion: an online, listed kernel with a >5-min-old heartbeat is still
   `available` / not `isStale` over `GET /api/kernels` + capability listings.
3. Doc copy still says "Heartbeat >5min old while online" in
   `docs/AGENT_INTEGRATION.md`, root `CLAUDE.md`, and
   `apps/dashboard/src/types/dto.ts` — update to mention the active-listing
   grace. (The authoritative gateway DTO doc in `facades/types.ts` is updated.)
