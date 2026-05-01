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

## Track B finding (production session-creation wiring — DEFERRED)

Investigation in W8 found there is **no production code path** that mints a `SettleableSession` from a capability — `state.sessions.set` is called only in `seedSettleableSessionForTests` (test-only). W2's centralized-substrate is currently test-driven.

The W7 B `capability.requiresApproval` / `capability.approvalThresholdUsd` fields are READY on both `CapabilitySchema` and `SettleableSession` (as `capabilityRequiresApproval` / `capabilityApprovalThresholdUsd`). Whoever builds the production session-creation path (likely a job-completion or commit-session flow) MUST snapshot the capability fields onto the session at creation time. The runtime decision in `shouldGateOnApproval` already reads from session fields.

Action item for the production-session-creation builder: see the `// Week 7 B` comments on `SettleableSession` in `packages/gateway/src/routes/centralized-settle.ts` for the snapshot expectation.

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
