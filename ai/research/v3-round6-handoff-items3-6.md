# v3-evidence-signing — Round-6 handoff for a fresh agent

**You are picking up the PCC v3 evidence-signing Step-6 lifecycle work.** A round-6 RE-AUDIT of the gateway
boundary (ChatGPT "owner-gated call decisions") found it **NOT yet closed**: one P0 (already FIXED — see below)
plus several P1 boundary corrections that are STILL OPEN. Per the re-audit's own correction order, **do the
boundary corrections (§A below) FIRST, THEN items 3–6 (§B).** Do NOT treat items 3–6 as startable until the
boundary corrections land + re-verify. Read this whole doc first — it is self-contained. HEAD is now `5294b15a`.

## Environment (money-path; read before touching anything)
- **Worktree:** `C:\Users\globa\pcc-v3-evidence`, branch `feat/v3-evidence-signing`, HEAD **`5294b15a`**.
  Branch-only, NOT merged, NOT deployed, Base Sepolia testnet only. **Settlement gate stays CLOSED** (SEAM-2 off).
- **This tablet has NO node_modules** — you CANNOT run vitest/tsc locally. All build/test is on the DGX Spark:
  `spark-run "cd ~/projects/physical-capability-cloud && pnpm --filter @pcc/gateway test <files...> 2>&1 | tail -14"`
  (spark-run full-syncs your worktree source to Spark, which has installed Linux deps). Tailscale SSH may need
  re-auth (`ssh dgx-spark` returns a login URL → the user must approve it in a browser).
- **The tail pipe MASKS the exit code** — always READ the vitest summary lines (`Tests N passed / M failed`), never
  trust exit 0. Run each verify in the background (`run_in_background: true`) and read the output file.
- **9 pre-existing gateway test-failures + 1 timed-out file are NOT yours**: `mcp-apps.test.ts` (7 — the
  `_meta.ui.resourceUri` unpatched-harness.exe TODO) + `job-status-ownership.test.ts` (2) = the **9 failed TESTS**;
  `settlement-keeper.fork.test.ts` is a SEPARATE 60s FILE timeout (its 3 tests never count as assertion failures, so
  they are NOT in the 9). They fail at
  baseline `36a6ecc4` too. Run the AFFECTED test files, not the whole gateway suite, to stay clear of this noise.

## Discipline (non-negotiable, this is a money path)
- **Verify-per-fix on Spark BEFORE you commit.** Never commit unverified. Never claim "done" you didn't watch pass.
- **Commit each verified item** with a descriptive message ending `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- **RULE-18 (no test-gaming):** make a check pass by making the CODE correct. If a fix changes intended behavior,
  update the test to assert the NEW correct behavior (an honest reclassification) and SAY so — never weaken/skip/hardcode.
- **The internal order (per the round-6 re-audit) is:** A0 monotonic finalize (done, `5294b15a`) → A1 terminal exact-retry → A2 complete chain field binding → A3 mandatory terminal state → A4 classify/gate low-level settlement APIs → A5 reliable passing verification logs → THEN B3 SDK recovery → B4 hold tests → B5 package field reconciliation → B6 baseline comparison. **§A MUST land + re-verify before §B.**

## What's already DONE (verified + committed — do not redo)
| Item | Commit | Summary |
|---|---|---|
| P0-1 sticky step-6 | `d7fff6d4` | `/complete` 409s if a session exists but no finalized package (legacy fallback unreachable once async entered) |
| Item 1 lifecycle | `4924a1ac` | atomic terminal transition in `record()`'s txn (`terminal_success`/`terminal_fault`) + post-terminal rejection + job-lifecycle gates on checkpoint/finalize |
| Item 2 whole-chain (INITIAL) | `c9d7c5a9` | INITIAL whole-chain verification: count, sequence, hash recomputation, checkpoint-hash binding, body previous-hash continuity, terminal positioning. **A2 completes the remaining receipt-field bindings** (receipt.previousAcceptedHash, session/job) — NOT redundant |

Full detail: `C:\Users\globa\pcc-audit-package\audit\AUDIT-round6-lifecycle-resolution.md`. The FULL round-6
re-audit — the authoritative source for §A, with every file:line cite + required-test — is transcribed LOCALLY at
`C:\Users\globa\pcc-v3-evidence\ai\research\v3-round6-REAUDIT-chatgpt.md`. Read it alongside §A; the §A summaries
below are faithful, and the transcribed re-audit governs on any detail. (This handoff is self-contained — no
external paste needed.)

---

# §A — Round-6 boundary CORRECTIONS (DO THESE FIRST — the boundary is NOT closed)

The round-6 re-audit found these after items 1–2. They are gateway-boundary corrections (same lane as items
1–2) and MUST precede items 3–6. Verify-per-fix on Spark + commit each. NOTE: A1 (checkpoint route) and A3
(terminal-state) both touch session-status handling — design them together.

## A0 (P0) — monotonic idempotent finalize — ✅ DONE (`5294b15a`)
The finalize reconcile unconditionally set `evidence_finalized`, so a repeat idempotent finalize on a
settled/held/completing job rolled it back → /complete re-ran settlement. FIXED: both reconcile sites use an
atomic status-GUARDED update (`NOT IN` the /complete exclusion set); only a pre-settlement job is reconciled.
Test: settled + repeat finalize → stays settled + second /complete 409. Verified 8 files/149 tests. Do not redo.

## A1 (P1) — restore exact-retry idempotency for a committed terminal checkpoint
**Regression from item-1's transition.** The checkpoint route blanket-rejects a non-open session up front
(`evidence-async.ts` ~line 603 `if (session.status !== "open") → 409 session_not_open`). Accepting a terminal
checkpoint now flips the session to `terminal_success`/`terminal_fault`, so an EXACT retransmission of that
terminal checkpoint (lost-response retry) never reaches `GatewayReceiptStore.record()`'s DB-authoritative
idempotency — it 409s instead of returning the committed receipt.
- **Fix:** for a non-open session, do NOT blanket-409. Check whether a committed receipt exists at the submitted
  seq (`repos.gatewayReceipts.findById(\`grcpt-${sessionId}-${seq}\`)`); if none → `409 session_not_open` (a
  genuinely new later seq); if one exists → verify the signature + canonical checkpoint normally and route to
  record()'s exact-retry path → `200 idempotent` for the exact replay, `409 equivocation` for different content.
- **Ordering is load-bearing (A1 ↔ A3 ↔ the item-1 job-lifecycle gate):** resolve the existing receipt FIRST —
  BEFORE both the session-status gate AND the job-lifecycle gate. An exact committed replay is effectively a
  read/reissue and must succeed even if another caller has since finalized OR settled the job; only a NEW
  acceptance is lifecycle-gated:
  ```
  Resolve existing receipt at (sessionId, seq) first.
  Existing receipt   → fully verify + evaluate exact-retry / equivocation (return the committed receipt).
  No existing receipt → enforce job AND session lifecycle gates for a NEW acceptance.
  ```
- **Tests:** terminal exact retry → 200 idempotent (same receipt, no new rows); same seq diff content → 409
  equivocation; terminal then seq+1 → 409 session_not_open; lost terminal response → direct exact POST retry
  works WITHOUT the GET-recovery helper.

## A2 (P1) — complete whole-chain body↔receipt field binding
Item-2's loop (`milestone-package-store.ts` ~293–352) checks count/seq/recompute/`body==receipt` hash/
prev-continuity/`receipt.jobId`/no-non-last-terminal. It does NOT bind `body.sessionId`, `receipt.sessionId`,
`body.jobId`, and — most materially — `receipt.previousAcceptedHash` (a receipt can claim a different prior hash
while the body chain stays internally continuous, and finalize still succeeds).
- **Fix:** add per-iteration checks for every field that EXISTS on the rows: `body.sessionId === sessionId`,
  `receipt.sessionId === sessionId`, `body.jobId === jobId` (VERIFY the body row carries jobId — it is keyed by
  sessionId and may not), `receipt.previousAcceptedHash === expectedPrev`, and body-prev == receipt-prev. If a
  field genuinely doesn't exist, DON'T fabricate it — narrow the round-6 CLAIM to "checkpoint-body chain
  consistency" and say so. finalize does NOT verify receipt SIGNATURES (that's the oracle's job) — keep the claim scoped.
- **Tests:** corruption tests for nonterminal `body.jobId` changed, `receipt.previousAcceptedHash` changed, body-prev
  vs receipt-prev disagree, receipt session changed, middle body missing, middle receipt missing, extra body, extra
  receipt, reordered/spliced chain (corrupt rows via `store.db.update(schema.checkpointBodies|gatewayReceipts)…`).

## A3 (P1/arch) — make terminal-state enforcement mandatory, not optional
`GatewayReceiptStore.evidenceSessions` is OPTIONAL (`gateway-receipt-store.ts` ~196–234) and
`MilestonePackageStore.finalize` still accepts an `open` session (`milestone-package-store.ts` ~231–244) for test
seeders — so the invariant is enforced by ONE route composition, not the services.
- **Fix:** require evidence-session persistence for LIVE construction; in finalize require `terminal_success` for a
  NEW success, permit `terminal_fault` only to return the fault, `finalized` only for the idempotent lookup, REJECT
  `open` as a new `terminal_state_missing` reason. Update seeders to create the same terminal state the live route does.
- **Tests:** finalize on a never-transitioned `open` session → rejected terminal_state_missing; seeders updated.

## A4 (scope) — classify/gate the low-level settlement APIs
The resolution's "sticky entry on EVERY settlement path" is broader than the guard proves (it covers only
`PUT /api/jobs/:jobId/complete`). `POST /api/settlement/release` + `POST /api/settlement/submit`
(`settlement.ts` ~69–146, ~148–214) accept caller-supplied ops / oracle attestations and do NOT consult Step-6
session/package state (they don't synthesize the legacy envelope, so NOT the P0-1 bug). Before G2/G3 — on a money
path, DOCUMENTATION is insufficient. EITHER (a) **ENFORCE** that only a privileged/internal caller can invoke
them — real authN/authZ or network isolation — **with tests proving an ordinary caller is rejected**; OR (b)
validate that a job with a Step-6 session releases only against its authoritative finalized package + verdict.
Marking them "privileged/internal" in prose ALONE does NOT close this. Also correct the resolution's "every
settlement path" wording.

## A5 (evidence) — re-run round-6 with reliable exit propagation
The item-2 evidence file held only the FAILED first run + a prose "17/17" assertion (the `tail` pipe masks the exit
code — the wrapper printed `Done ✓` after a failed pipeline). Re-run the FULL round-6 suite with `set -o pipefail`
+ `tee` (or redirect → capture `$?` → tail) and put the SUCCESSFUL post-fix logs (item-2 + A1–A4) into `pcc-audit-package/audit/`.

---

# §B — B3–B6: SDK / tests / renames / docs (ONLY after §A lands + re-verifies)

## B3 — SDK recovery (`packages/kernel-sdk/src/checkpoint-client.ts`)
Round-5 re-audit P1-4. Three parts:

**(a) Distinguish `404 receipt_not_found` from transient/network in `tryFetchReceipt`** (~line 433). Today it does
`try { … if (status===200 && receipt) return receipt; return null } catch { return null }` — a clean 404 (checkpoint
genuinely NOT committed) and a transient network error BOTH collapse to `null`. The `get()`/`post()` helpers THROW on
network error and return `{status, body}` on any HTTP status. Change `tryFetchReceipt` to return a discriminated result
(e.g. `{found} | {absent} | {uncertain}`): a clean 404 body `{error:"receipt_not_found"}` ⇒ `absent`; a throw / 5xx /
status 0 ⇒ `uncertain`.

**(b) Retry read-only recovery before authority-dependent action** in `recoverUncertain` (~line 331). On `uncertain`,
retry the read-only GET (bounded, e.g. 2–3 attempts) BEFORE calling `begin()` (which post-S6-3 rejects an expired
delegation). Only on definitive `absent` fall through to begin/resubmit. Failure mode to close: checkpoint committed
just before expiry → response lost → recovery GET hits one transient error → today it reports "absent" → begin after
expiry → begin rejects → the committed receipt is unrecoverable.

**(c) `finalizePackage` usable after restart WITHOUT `begin()`** — `finalize()` (~line 516) starts with
`if (!this.sessionId) throw "begin_not_called"`. The evidence sessionId is DETERMINISTIC: `evs-<jobId>-<milestoneIndex>`.
`this.jobId` + `this.milestoneIndex` are constructor fields (verify). Derive `const sessionId = this.sessionId ??
\`evs-${this.jobId}-${this.milestoneIndex}\`` and use it for the reveal calls (~line 531); the finalize POST (~line 538)
already uses only `milestoneIndex`. After a restart `payloadsBySeq` is empty (memory-only) — that's fine, payloads-out
means finalize needs no payloads; the device re-reveals separately. Consider exposing an explicit
`finalizePackage(jobId, milestoneIndex)` entry as the audit names it.

**(d) Tests** (`packages/kernel-sdk/src/__tests__/async-evidence.test.ts`): extend `FakeGateway` to simulate
(i) begin-rejects-after-expiry while GET-receipt still 200s → recovery succeeds via the read-only path; (ii) a first
transient GET failure then success → still recovers (doesn't falsely conclude absent); (iii) restart (fresh client,
no begin) → derive sessionId → finalize succeeds. Mirror the REAL server semantics in the fake (fake-masks-reality is a
known trap here — the fake already had to be corrected once for payloads-out).

Verify: `spark-run "… pnpm --filter @pcc/kernel-sdk test 2>&1 | tail -8"`.

## B4 — hold + regression tests
Round-5 re-audit M1. The `settlement_hold` guard is in source (`paid-job-flow.ts:938` NOT-IN list + the begin
`EVIDENCE_UNCOLLECTABLE_STATUSES` set) but has no direct test. Add (in `evidence-async-settlement.test.ts` or a
paid-job-flow test): (1) a held job → second `/complete` → 409; (2) concurrent `/complete` where one enters hold →
`[hold, 409]`; (3) a job with an open session that went to hold → ordinary checkpoint/finalize rejected. Note P0-1 +
item-1 gates likely already enforce (3) — assert it. Verify on the `/complete`-flow cluster.

## B5 — package field renames / reconciliation (`packages/gateway/src/services/milestone-package-store.ts`)
Round-5 re-audit M2. Rename in `FinalMilestonePackage`: `sessionId` → **`evidenceSessionId`**, `receiptIds` →
**`gatewayReceiptIds`** (the step-10 spec already uses these names — this reconciles code↔spec).
- **DEFER `acceptedEnvelopeHash`** — owner directive: add it ONLY once its authoritative input + ownership are settled;
  do NOT hash a reconstructed or partial envelope merely to complete the field. (finalize does not currently have the
  mutually-accepted job envelope threaded in — leave it out until that plumbing is designed.)
- Ripple: the package is stored as a JSON `body` blob (renames are transparent to the DB — no migration). But
  `packageHash = canonicalSha256(pkg)` CHANGES (new field names). Update: the assembly, `idempotentFromRow`, the served
  package (GET `/api/evidence/:hash` in `settlement.ts`), and any test asserting `.sessionId`/`.receiptIds` on the
  package (grep tests for `package.sessionId` / `package.receiptIds` / `servedPkg.`). Keep the `PackageReceipt`'s own
  `sessionId` field as-is unless the audit asked otherwise — it's a distinct object.
- Verify the finalize + `/complete` + served-package surface.

## B6 — baseline evidence (documentation for the re-audit)
Round-5 re-audit M3. Prove the 9 pre-existing failed TESTS (+ the 1 timed-out fork FILE) are IDENTICAL at baseline, not just equal in count. Capture the
full failing-test names + assertions at BOTH commits:
- Baseline: `git -C C:/Users/globa/physical-capability-cloud checkout 36a6ecc4` → `spark-run "… pnpm --filter
  @pcc/gateway test 2>&1 | grep -E 'FAIL|×|❯ src'"` → `git checkout feat/v3-evidence-signing`. (The worktree specs in
  `ai/research/` are gitignored so checkout won't touch them; commit or stash any code WIP first.)
- Current: same grep at the current HEAD (`5294b15a` or later). Diff the two failing-test lists; write the result into
  `C:\Users\globa\pcc-audit-package\audit\` and reference it from the round-6 resolution doc.

---

## When §A + B3–B6 are done: refresh the re-audit package
1. `bash C:/Users/globa/pcc-v3-audit/export-audit.sh` (exports the branch code at the new HEAD).
2. `cp -r C:/Users/globa/pcc-v3-audit/physical-capability-cloud/code/packages C:/Users/globa/pcc-audit-package/code/packages`
   + copy its `MANIFEST.md` + `physical-capability-cloud.patch` into `pcc-audit-package/code/`.
3. New patch — base is the post-P0 HEAD `5294b15a` for the fresh agent's incremental work:
   `git -C C:/Users/globa/physical-capability-cloud diff 5294b15a <newHEAD> > pcc-audit-package/code/round6-boundary-and-items.patch`.
   (Use `36a6ecc4` as the base instead ONLY if you intentionally want the full aggregate delta since the round-4 HEAD.)
4. Write a resolution doc covering **§A (A1–A5) + B3–B6** under `pcc-audit-package/audit/`; update `README.md` + regenerate `MANIFEST.md`.
5. `Compress-Archive -Path C:\Users\globa\pcc-audit-package\* -DestinationPath C:\Users\globa\pcc-audit-package.zip -Force`.
6. Hand the zip to the user for the ChatGPT "owner-gated call decisions" re-audit.

## After Step-6 is fully closed (NOT your item — context only)
Step-10 (spec corrected round-5) + B2 remain. B2 is REFRAMED (round-5 re-audit P1-1): it is the **AcceptedCheckpointArtifact**
API the oracle needs (checkpoint content + session signature + receipt + optional revelation), a HARD Step-10 dependency —
NOT just a payload store. P0-2 (oracle must not mint an EAS attestation for hold/reject on the interim v2 rail), P1-5
(reveal/supplement deadlines), R-08, full R-09 also remain. Specs: `ai/research/v3-step10-achieved-tier-spec.md`,
`ai/research/v3-round5-payloads-out-spec.md`; frozen authority: `C:\Users\globa\.claude\shared\pcc-evidence-signing-architecture-design.md`.
