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

## What's NOT done in W7

- iOS Widget Extension target / SwiftUI files / `NSSupportsLiveActivities` — needs Mac
- APNs push for remote Live Activity updates — needs Mac
- Live Activity UI Phases 2-8 (status changes, progress bar, deep-link, Dynamic Island) — W8 territory
- Capability-schema population path — capability spec has the new fields but the production session-creation site that copies them onto `SettleableSession.capabilityRequiresApproval` etc. needs to be wired wherever sessions are minted (likely a `sessions.ts` or escrow-create flow)

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
