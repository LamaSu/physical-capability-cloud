# PCC v3 Evidence Signing — Round-6 Gateway-Boundary Re-Audit (ChatGPT "owner-gated call decisions")

Authoritative transcription of the round-6 re-audit. This is the source §A of the handoff is derived from.
The P0 below is ALREADY FIXED (`5294b15a`, monotonic finalize); A1–A5 remain open.

## Scope and verification basis
Reviewed: `audit/AUDIT-round6-lifecycle-resolution.md`; `code/round6-since-e5eb77b1.patch`; full source at HEAD
`c9d7c5a9`; `audit/round6-spark-verify-output.txt`; relevant Step-6 gateway tests. Package integrity passed
(ZIP CRC clean; 93 entries; round-6 patch exactly 439 lines across the claimed seven files; the source contains
the sticky-entry guard, atomic terminal transition, and whole-chain verification). The TS suite was not
independently executed; the Spark output is assessed under "Verification-evidence issue" below.

## Verdict
The three round-6 changes are real, but the Step-6 gateway boundary was still not closed at the audited HEAD
`c9d7c5a9`. The re-audit's most important finding was a **P0 lifecycle rollback** — an idempotent `finalize`
could change a job from `settled` / `completed` / `evidence_submitted` / `completing` / `settlement_hold` back to
`evidence_finalized`, reopening `/complete` and rerunning settlement — **now FIXED at `5294b15a`** (monotonic
status-guarded reconcile). The boundary REMAINS OPEN because terminal exact-retry idempotency, complete
receipt-field binding, mandatory terminal-state enforcement, low-level settlement-API enforcement, and reliable
verification evidence remain unresolved (A1–A5).

| Claimed boundary property | Result |
|---|---|
| Sticky async entry on ordinary `/complete` | Pass |
| Atomic terminal checkpoint/session transition | Pass on the live route |
| Reject genuinely new post-terminal checkpoints | Pass |
| Preserve exact-retry idempotency for terminal checkpoint | Fail |
| Whole-chain body↔receipt integrity | Partial |
| Fresh checkpoint/finalize lifecycle gates | Pass |
| Idempotent finalize preserves later job states | Fail — P0 (FIXED at `5294b15a`) |
| No new lifecycle regressions | Fail |
| Supplied Item-2 Spark proof | Incomplete |

## P0 — Idempotent finalize rewinds later job states and reopens settlement  [FIXED at 5294b15a]
The finalize route allows requests when a package already exists even if the job is uncollectable
(`evidence-async.ts` finalize-route guard exempts jobs with a package). The idempotent branch then
unconditionally `repos.jobs.update(jobId, { status: "evidence_finalized" })` (`evidence-async.ts:800–812`,
`839–852`). Path: finalize → /complete settles (status=settled) → POST /finalize again → existing package makes
it eligible → store returns idempotent → route changes settled→evidence_finalized → PUT /complete again →
evidence_finalized is an allowed pre-settlement state → completion claim succeeds → settlement runs again. Same
rollback defeats R-09 (settlement_hold→evidence_finalized) and the resume-settlement recovery
(evidence_submitted→evidence_finalized). A concurrent finalize during /complete can overwrite `completing`. The
completion claim excludes settled/completed/evidence_submitted/completing/settlement_hold but intentionally
allows evidence_finalized (`paid-job-flow.ts:950–957`).
**Required correction:** job lifecycle transitions must be monotonic. The idempotent branch returns the existing
package WITHOUT changing later lifecycle state; reconcile to evidence_finalized only from an explicit set of
stale pre-finalization states (executing, execution_complete, …) via compareAndSet. Never rewrite completing /
evidence_submitted / settlement_hold / settled / completed / cancelled / failed. Same rule for the first-finalize
branch (not an unconditional update).
**Required tests:** settled+idempotent finalize → package returned, status stays settled, later /complete 409;
completed+idempotent → stays completed; settlement_hold+idempotent → stays hold, later /complete 409;
evidence_submitted+idempotent → stays, recovery remains resume-settlement only; completing+concurrent idempotent
→ stays completing, in-flight settlement undisturbed; executing+committed package but lost job-status update →
reconciles to evidence_finalized.

## P1 — Exact retry of a terminal checkpoint is no longer idempotent
The receipt store still implements durable exact-retry idempotency, but the HTTP route rejects every request
when the session status is no longer `open` (`evidence-async.ts:598–605`). Accepting execution_completed /
fault_report atomically changes the session to terminal_success / terminal_fault, so an exact retransmission of
the terminal checkpoint never reaches `GatewayReceiptStore.record()`. Behavior: POST execution_completed →
commit → session terminal_success → response lost → client retransmits exact same checkpoint → session_not_open
→ 409. A regression from the protocol's existing exact-retry guarantee; the SDK receipt-read recovery mitigates
it for the official client, but protocol correctness should not depend on that.
**Required correction:** for a non-open session — (1) check whether a committed receipt exists at the submitted
seq; (2) if none, reject session_not_open; (3) if one exists, verify signature + canonical checkpoint normally;
(4) pass to the DB-authoritative exact-retry path; (5) return 200 idempotent for the exact terminal replay, 409
equivocation for different content at the committed seq, 409 session_not_open for a new later seq.
**Required tests:** terminal exact retry → 200 idempotent, same receipt, no additional rows; same seq diff
content → 409 equivocation; terminal then seq+1 → 409 session_not_open; terminal response lost → direct exact
POST retry works even without the GET recovery helper.

## P1 — Whole-chain verification is still structurally incomplete
The finalizer verifies equal body/receipt counts; contiguous seq; receipt.jobId===jobId; recomputed body hash;
body.checkpointHash===receipt.checkpointHash; body.prevCheckpointHash vs previous receipt's checkpointHash; no
non-last terminal (`milestone-package-store.ts:293–352`). It does NOT verify: body.jobId===jobId;
receipt.previousAcceptedHash===expectedPrev; body.prevCheckpointHash===receipt.previousAcceptedHash;
receipt.sessionId===sessionId; body.sessionId===sessionId. The most material omission is
receipt.previousAcceptedHash — a receipt can claim a different prior accepted hash while the body chain remains
internally continuous, and finalization still succeeds. The finalizer also does not verify receipt signatures
(may remain an oracle/registry responsibility, but then the round-6 claim should be limited to checkpoint-body
chain consistency, not full body↔receipt proof consistency).
**Required correction:** each iteration require body.sessionId/ receipt.sessionId===sessionId; body.jobId/
receipt.jobId===jobId; body.seq===receipt.seq; receipt.previousAcceptedHash===expectedPrev;
(body.prevCheckpointHash??null)===(receipt.previousAcceptedHash??null); recomputed===receipt.checkpointHash;
body.checkpointHash===receipt.checkpointHash → else failClosed().
**Required tests:** corruption tests for nonterminal body.jobId changed; receipt.previousAcceptedHash changed;
body prev and receipt prev disagree; receipt session changed; middle body missing; middle receipt missing; extra
body; extra receipt; reordered/spliced chain.

## P1/architecture — Terminal-state enforcement remains optional inside the core services
`GatewayReceiptStore` accepts `evidenceSessions` as an OPTIONAL dep (`gateway-receipt-store.ts:196–234`,
`433–449`); if omitted, accepting a terminal checkpoint does not transition the session. The live checkpoint
route supplies it (so production transitions), but `MilestonePackageStore.finalize()` still explicitly accepts an
`open` session (`milestone-package-store.ts:231–244`), retained for test seeders. The money-path invariant is
enforced by one route composition rather than by the services.
**Recommended correction:** make evidence-session persistence mandatory for live GatewayReceiptStore
construction; require terminal_success for a new successful finalization; permit terminal_fault only to return
the fault outcome; permit finalized only for the idempotent package lookup; reject `open` as
`terminal_state_missing`; update seeders to create the same terminal state the live route creates rather than
retaining a test-only bypass in production logic.

## Settlement-path scope qualification
The sticky guard correctly protects ordinary `PUT /api/jobs/:jobId/complete` and runs before the completion
claim (`paid-job-flow.ts:922–938`). `resume-settlement` can only reclaim `evidence_submitted`, and the begin
route rejects that state, so no separate legacy-fallback path was found there. However the gateway also exposes
lower-level `POST /api/settlement/release` and `POST /api/settlement/submit` (`settlement.ts:69–146`, `148–214`)
which accept caller-supplied settlement operations or oracle attestations and do not consult Step-6
session/package state. They do not synthesize the legacy gateway envelope (so not the same P0-1 bug), but the
resolution's phrase "sticky entry on every settlement path" is broader than what the new guard proves. Before
G2/G3 these endpoints must either ENFORCE privileged authentication/authorization or network isolation — WITH
tests proving ordinary callers cannot invoke them — OR validate the authoritative finalized package + verdict for
Step-6 jobs. Documentation alone is insufficient on a money path.

## Verification-evidence issue
The Spark log proves P0-1 (7 files, 106 tests passed) and Item 1 (11 files, 209 tests passed). For Item 2 the raw
log contains only the initial FAILING run (1 failed file, 7 passed files, 1 failed test, 144 passed tests, Exit
status 1); the file then states in prose that the corrected run passed 17/17 but does not include the successful
rerun command or summary. The wrapper printed `Done ✓` after the failed pipeline because it is piped through
`tail`, matching the documented Spark exit-code masking trap. Therefore the Item-2 source change is present but
the submitted raw file does not independently prove the claimed successful Item-2 rerun.
**Required discipline:** use `set -o pipefail` + `tee`, or redirect to a file + capture `$?` + tail; include the
successful post-fix Item-2 output, not only the earlier failed run plus a prose assertion.

## Results against the five round-6 falsification targets
1. Sticky entry on settlement paths — Pass for ordinary /complete; broad "every settlement path" claim requires
   qualification for the low-level release/submit APIs.
2. Terminal durability and atomicity — Pass for first acceptance on the live checkpoint route. Exact terminal
   replay idempotency regressed, and the service-level dependency remains optional.
3. Whole-chain internal consistency — Partial. Core checkpoint chain is checked, but receipt.previousAcceptedHash
   and corresponding job/session fields are not fully bound.
4. Job-lifecycle gates — Fail. Fresh operations are gated, but idempotent finalize can roll later states backward
   and reopen settlement. [FIXED at 5294b15a]
5. No new regressions — Fail. Job-state rollback [fixed] and terminal exact-retry failure are new lifecycle
   regressions.

## Corrected status
Sticky entry on /complete, live-route atomic terminal transition, new-checkpoint rejection after terminal state,
and broad checkpoint-chain recomputation are implemented; the P0 idempotent-finalize rollback is FIXED
(`5294b15a`). The boundary remains open because exact terminal retries no longer reach idempotency, whole-chain
receipt binding is incomplete, terminal-state enforcement is optional in the services, and the low-level
settlement APIs are not yet enforced (A1–A5).

## Correction order
1. P0: monotonic idempotent finalize + prove settled/held/evidence-submitted/completing cannot be rewritten. [DONE 5294b15a]
2. Restore exact-retry idempotency for the committed terminal checkpoint while rejecting genuinely new post-terminal checkpoints.
3. Complete structural body↔receipt field binding across the whole chain.
4. Make terminal-state persistence mandatory and reject fresh finalization from `open`.
5. Add adversarial tests for all four corrections.
6. Re-run the exact round-6 suite with reliable exit propagation and include the successful Item-2 log.
7. Explicitly classify or gate the low-level settlement release/submit APIs (ENFORCED, not just documented).
8. Then continue with Items 3–6 (B3–B6), B2 and Step 10.

**Keep the settlement gate closed. Do not mark the round-6 gateway-boundary audit closed yet.**
