# Approval flow — end-to-end (W5 + W6 + W7)

A walkthrough of how an operator-confirmation settlement flows through the
PCC mobile + gateway as of Week 7. v1 ships JS-side only — iOS native
Widget Extension + APNs are deferred to a Mac-equipped session.

## Happy path (timeline)

```
gateway                              mobile
─────────────────────────────────────────────────────────────────
POST /api/sessions/:id/settle
  shouldGateOnApproval(session, body)
   → true
  publishApprovalRequest({
    id, approvalId, capability,
    amountUsd, operatorName,
    evidenceHash, requestedAt
  })  ──── SSE ───►  approval-listener.ts onmessage
                     setPendingApproval(payload)
                     startApprovalActivity({...})
                     ┌──────────────────────────────┐
                     │  ApprovalSheet renders       │
                     │  "Approve with Face ID"      │
                     │  user taps → biometric       │
                     │  signed receipt produced     │
                     └──────────────────────────────┘
                     handleApprove(signed)
                     postApprovalDecision({
                       sessionId, approvalId,
                       sessionToken, decision: "approve",
                       body: { signature: ... }
                     })

POST /api/sessions/:id/approval/:aid/approve  ◄────
  resolveApprovalGate(sessionId, approvalId, "approve")
   → resolves the awaitApprovalDecision promise

  ledger.release(...)
  signedReceipt = sign(...)
  log.append(receipt)
  return 200 + receipt + Merkle proof  ──── HTTP ───►  ReceiptDetail
                                                       verifies proof on-device
```

## Key points by week

- **W5**: SSE plumbing — server `approval` topic + `publishApprovalRequest` + mobile `EventSource` w/ exponential backoff + token-as-channel-id v1.
- **W6**: Gate close — `awaitApprovalDecision` blocks settle until POSTed back. 60s timeout → 408. Capability-spec field deferred. Channel-id decoupled (mobile mints opaque id via `/subscribe`, falls back to W5 path on failure). Live Activity scaffold for one-phase iOS UI (native bits Mac-pending).
- **W7 A**: Loop close — App.tsx now actually POSTs the decision back. `postApprovalDecision()` returns `{success, status, errorCode?, error?, authError?}`. Approve rethrows on error so ApprovalSheet stays open + Live Activity stays running. Decline fires-and-forgets (W6 timeout catches a server-side miss).
- **W7 B**: Capability schema — `requiresApproval?: boolean` and `approvalThresholdUsd?: number` on `CapabilitySchema`. Snapshotted onto `SettleableSession` at session-creation. New override hierarchy:

  1. body.requireApproval explicit (true/false win)
  2. session.requiresApproval (W6)
  3. session.capabilityRequiresApproval (W7 B per-capability default)
  4. session.capabilityApprovalThresholdUsd (W7 B per-capability rule)
  5. env APPROVAL_THRESHOLD_USD (W6 fallback)
  6. default false

## Failure modes & UX

| Server status | Mobile behavior | Live Activity |
|---|---|---|
| 200 | dismiss sheet | end with outcome=approve |
| 401 (auth) | rethrow → sheet shows "re-enroll passkey + retry" | stay running |
| 404/409 (stale) | treat as success (idempotent) | end |
| network/5xx | rethrow → sheet shows error | stay running |
| 408 timeout (server side) | (no client signal) | (Live Activity will time out via expiresAt) |

## What W8 added

- **Phase 2** (status transitions): `updateApprovalActivity` calls walk the lock-screen state through waiting → approved → settling → done. `handleApprove` rolls back to waiting on POST failure so the lock-screen state matches reality.
- **Phase 4** (tap/dismiss subscribers): `onApprovalActivityTap` + `onApprovalActivityDismiss` registered in App.tsx. Tap re-shows ApprovalSheet from sessionStorage cache. Dismiss ends activity locally without server POST (W6 timeout catches it server-side).
- **Phase 5** (cold-start deep-link): `pcc-mobile://approval/<sid>` custom-scheme parsing + `?approval=` query fallback. New `APPROVAL_CACHE_KEY` in sessionStorage holds the pending approval across JS process recycling. Activity is only RESTARTED on explicit deep-link (warm-start with stale cache rehydrates the sheet only — avoids double-start).
- **Phase 8** (expired state): client-side timer mirrors W6's server-side `APPROVAL_TIMEOUT_MS`. 408 from `postApprovalDecision` is detected and dispatched as `outcome: "expired"` not as a generic error.

## What W9 added

- **Track A — gateway settle-progress events**: gated centralized-settle now emits a 4-step `settle-progress` event ladder on the existing approval SSE topic:

  ```
  release    → 0.25  (after ledger.release)
  sign       → 0.50  (after signed receipt composed)
  log_append → 0.75  (after log.append returns)
  done       → 1.0   (just before reply.send)
  ```

  Un-gated settles are silent. Rejected gates are silent (settle short-circuits before release). Dual-publishes to both session-id AND channel-id topics, mirroring the W6 A3 publishApprovalRequest pattern.

  `SettleProgressPayload` exported from `packages/gateway/src/routes/centralized-settle.ts`. 5 new tests in `centralized-settle-progress.test.ts`.

- **Track B — mobile consumption**: `startApprovalListener` now accepts `onProgress?: (payload) => void` callback. Approval-listener dispatches `settle-progress` named events through it after shape-checking the payload. `App.tsx` wires the callback to `updateApprovalActivity({phase: "settling", progress: payload.progress})` so the lock-screen Live Activity reflects real-time progress.

  4 new tests in `approval-listener.test.ts` + 2 new tests in `App.test.tsx`. Phase 3 (real progress source) — DONE for the gateway side.

- **Track C — iOS scaffold prep doc**: `apps/mobile/IOS-SETUP.md` (~520 lines) walks through every step of the Mac session: prerequisites, `npx cap add ios`, Widget Extension target creation, Info.plist additions, full SwiftUI skeleton with all 4 Dynamic Island layouts (compact-leading, compact-trailing, expanded, minimal) + lock-screen view, APNs Auth Key generation, push token registration, simulator + device testing, TestFlight, App Store Connect setup. Includes verify-back checklist for when iOS bits land.

  Phase 6 (Dynamic Island layouts) and Phase 7 (push-update wiring) — recipes ready, awaiting Mac session.

- **Track D — test fixture builder**: `@pcc/spec/test-fixtures/capability` exposes `buildTestCapability(overrides?)` and `buildTestSession({capability, amountCents, overrides})`. Both apply sensible defaults (W7 B fields included: `requiresApproval: false`, `approvalThresholdUsd: undefined`). `buildTestSession` snapshots W7 B fields from the capability onto the session, mirroring the production session-creation contract documented on `SettleableSession` in `centralized-settle.ts`.

  17 new tests in `test-fixtures.test.ts`. The Capability TS interface now has the W2/W7 B fields surfaced (previously they were only on the schema).

## Track B (production session-creation wiring) — DONE in W10

W10 closes the loop the W8 finding flagged. Two new helpers in `packages/gateway/src/routes/centralized-settle.ts`:

- `buildSettleableSessionFromCapability` — snapshots `capability.requiresApproval` → `session.capabilityRequiresApproval`, `capability.approvalThresholdUsd` → `session.capabilityApprovalThresholdUsd`, and `capability.settlementMode` (via `resolveSettlementMode`) → `session.settlementMode`. Mirrors the W9 D fixture builder's contract.
- `registerSettleableSession` — production equivalent of `seedSettleableSessionForTests` with typed errors (`SessionAlreadyRegisteredError`, `InvalidSettleableSessionError`) and explicit invariants (id non-empty, state==committed, amountCents>0, capability non-empty).

Wired at `POST /api/negotiate/session/:id/commit` in `packages/gateway/src/routes/negotiation.ts`: after `createJobFromSession` succeeds, look up the capability via `repos.capabilities.findByKernel` (existing pattern from `paid-job-flow.ts`), build a `SettleableSession`, register it. Best-effort: failures here MUST NOT block the commit. Coverage: 11 unit tests (`session-registration.test.ts`) + 3 e2e tests (`negotiate-commit-settle-e2e.test.ts`) prove the W7 B → W6 → W7 A loop works from real session creation through to the runtime gate decision.

Note: the DB schema (`packages/db/src/schema/capabilities.ts`) does not yet persist `requiresApproval` / `approvalThresholdUsd` / `settlementMode` columns. The snapshot reads whatever is present and passes `undefined` otherwise; the gate hierarchy treats `undefined` as "do not fire". When the schema is extended (separate work), the snapshot picks up the values automatically with no further wiring.

## What's still NOT done (deferred to W9+ / Mac session)

- iOS Widget Extension target / SwiftUI files / `NSSupportsLiveActivities` — needs Mac
- APNs push for remote Live Activity updates — needs Mac
- Phase 6 (Dynamic Island compact/expanded/minimal layouts) — SwiftUI, needs Mac
- Phase 7 (push-update payload shape + APNs delivery) — overlaps with APNs work
- Phase 3 (real progress / ETA from gateway settle progress events) — gateway doesn't emit progress events yet; client structure ready but no signal source

## Testing pattern

- Mobile: `apps/mobile/src/sse/approval-decision.test.ts` (unit, mock fetch via DI), `apps/mobile/src/App.test.tsx` (integration, smart-fetch mock that switches on URL: `/subscribe`, `/approval/.../{approve,reject}`).
- Gateway: `packages/gateway/src/__tests__/centralized-settle-approval.test.ts` (W6 + W7 B hierarchy, 14 tests covering each layer of `shouldGateOnApproval`).

## Reference paths (absolute)

- `C:\Users\globa\physical-capability-cloud\packages\gateway\src\routes\approval-request.ts` — server publish + gate
- `C:\Users\globa\physical-capability-cloud\packages\gateway\src\routes\centralized-settle.ts` — settle path + `shouldGateOnApproval`
- `C:\Users\globa\physical-capability-cloud\apps\mobile\src\sse\approval-listener.ts` — EventSource subscriber
- `C:\Users\globa\physical-capability-cloud\apps\mobile\src\sse\approval-decision.ts` — POST decision back
- `C:\Users\globa\physical-capability-cloud\apps\mobile\src\components\ApprovalSheet.tsx` — bottom-sheet UX
- `C:\Users\globa\physical-capability-cloud\apps\mobile\src\App.tsx` — wires everything together
- `C:\Users\globa\ai\research\agentic-commerce-vision\17-MOBILE-APP-HANDOFF.md` — full handoff doc with W1-W7 scope
