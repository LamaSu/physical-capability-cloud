# Evidence contract — `document.print-and-mail` (v1, rescued)

> **Provenance.** This is the evidence lane's contract of record for the print-and-mail composite, written 2026-08-27 → 2026-09-08 and kept until now only on a working machine. It is committed here verbatim except that private-oracle commit ids, other lanes' session ids and coordination-bus references were replaced by roles, and the oracle is described only at its interface. Private oracle internals, VCR internals and the atlas are not part of this document.
>
> **Current state (2026-09-24).**
> - §0–§7: the composite rule and the carrier-provenance contract stand. Stage ids and program hashes are pinned by the committed-program goldens on `feat/v3-evidence-signing` (PR #270, unmerged; §8 lists the v4 hashes).
> - §8–§9: the print-leg success signal is `execution_completed` with `execution_failed` absent. `printer_job_verified` is supporting log-chain evidence only. This is also encoded in `evidenceLevelOf` (PR #345), where `printer_job_verified` proves no level.
> - §10: the pcc-node emitter defect is fixed. PR #333 adds the failure path and the closed-vocabulary guard. PR #343 records device acceptance as `execution_progress` at level `submitted` and never as `execution_completed`.
> - Every Ed25519 signature over an evidence digest covers `signingPreimage(digest)`: the 71 UTF-8 bytes of `sha256:<hex>` (LO-EV-1, PR #338).
> - A device bundle anchors settlement only when its signed digest opens to events that commit the job and the accepting kernel (LO-EV-9, PR #341).

**Owner**: the evidence lane. **Evaluator**: the private oracle (this document binds it at the interface only).
**Status**: DRAFT 2026-08-27 — every algorithm below is read from source at the cited ref, not from memory.
Sections marked `PENDING` are being filled from `lamasu/master` / `lamasu/feat/v3-evidence-signing`.

## 0. The one-line rule (fail-closed)

`release` iff **(a)** the PRINT leg's evidence satisfies the declared verification program at the required assurance tier,
**and (b)** a CARRIER SCAN `EvidenceEvent` exists whose `payload.trackingCode` equals the pre-execution
`ShipmentCommitment.trackingCode` **and** whose `payload.commitmentHash` equals `ShipmentCommitment.hash`,
**and (c)** that commitment's `labelHash` equals the label hash carried by the print leg.
Anything else — a photo, an operator "done", a scan for an uncommitted tracking code, a commitment made
*after* handoff, a missing leg — is **`dispute`**, never `release`. There is no third verdict.

Why (cross-family review, verbatim): *"a carrier scan proves only that SOME labelled parcel entered the
carrier network."* The **commitment is the bridge**: it is the only object that names the job, the destination,
the tracking code and the label together, and it is hashed **before** any human touches the envelope
(`routes/carrier.ts:2-11`, 79d777dc). A scan alone is not evidence of *this* job; a scan that matches a
prior commitment is.

## 1. Interfaces this binds to (existing code — nothing here is invented)

### 1.1 `ShipmentCommitment` — `packages/gateway/src/services/easypost-client.ts:52-59,99-115` @ `lamasu/feat/carrier-integration` 79d777dc
```
sha256Hex(s)      = hex(SHA-256(utf8(s)))
destinationHash   = sha256Hex(canonicalAddressForHash(toAddress))     // fixed field order (:92-97)
labelHash         = sha256Hex(labelUrl || trackingCode)               // v1 CAVEAT: URL-bound, see §5
commitment.hash   = sha256Hex([jobId, destinationHash, trackingCode, labelHash, committedAt].join("|"))
ShipmentCommitment = { hash, jobId, destinationHash, trackingCode, labelHash, committedAt }
```
Computed in BOTH real and mock modes before `createLabel` returns (:193). Mock tracking codes are `EZMOCK` + 10 digits (:249)
and carry through to `EvidenceEvent.source.simulated = true` (§1.2) — **a simulated source never satisfies (b)**.

### 1.2 Carrier `EvidenceEvent` — `packages/gateway/src/routes/carrier.ts:72-97` @ 79d777dc
```
type      = "courier_pickup_confirmed"   (tracker status -> in_transit)
          | "courier_delivery_confirmed" (tracker status -> delivered)     // return_to_sender / failed -> NO event (null)
timestamp = TrackerWebhookEvent.occurredAt   (EasyPost updated_at, or receipt time if absent — easypost-client.ts:329)
source    = { deviceId: "easypost:"+trackingCode, deviceType: "courier_api", kernelId, simulated: record.mock }
payload   = { jobId, trackingCode, trackerId, carrier, commitmentHash: commitment.hash }
hash      = hashEvent({ type, timestamp, source, payload })           // @pcc/spec, §1.4
id        = randomUUID()   (NOT hashed — hash covers type/timestamp/source/payload only)
```
Admission (`carrier-shipment-store.ts` `recordCarrierEvent`): webhook HMAC verified first
(`x-hmac-signature` = `"hmac-sha256-hex=" + hex(HMAC-SHA256(webhookSecret, rawBody))`, `timingSafeEqual`, :273-303);
event appended **only** on an evidentially meaningful transition; **idempotent on EasyPost event id** (retries never
duplicate); a scan for a tracking code with no prior commitment is logged and **dropped** (`unknown_tracking_code`) —
*"must never be treated as evidence for one"* (store comment). These three admission rules are part of the evidence
definition, not implementation detail: the verdict may assume them and the evaluator MUST re-check (a), (b), (c) anyway.

### 1.3 Print-leg `EvidenceEvent`s — existing types in `packages/spec/src/types/evidence.ts:23-99` @ master
Existing `EVIDENCE_EVENT_TYPES` already cover the print leg; **no new event type is introduced**:
- `printer_job_verified` — the kernel's own confirmation that job `jobId` printed document `documentHash` (REQUIRED, all tiers)
- `printer_log_captured`  — raw printer log/hash-chain entry (tier ≥1)
- `photo_captured` (+ `photo_anti_spoof_check`, `photo_comparison_result`) — human-with-a-phone capture of the printed piece (tier ≥2, or the ONLY print evidence when the executor is a human with no printer kernel — then tier is capped, §3)
- `custody_handoff_confirmed` — the executor's handoff-to-carrier event; **informational only**, never closes the mail leg

Print-leg payload contract (the printer kernel / human-adapter MUST emit; evidence pins it, kernel owners build it):
```
printer_job_verified.payload = { jobId, documentHash: sha256 of the printed document bytes,
                                 labelHash: <same derivation as ShipmentCommitment.labelHash, §5>,
                                 pages, printerId }
```

### 1.4 `hashEvent` / `hashBundle` — `packages/spec/src/util/canonical.ts` @ master — `PENDING`
### 1.5 Bundle + verdict chain on master — `evidence.ts:142-180`
`EvidenceEvent.hash` → `EvidenceBundle{ id, jobId, stepId, kernelId, assuranceTier, events[], bundleHash, kernelSignature, sessionKeyAuthorization?, createdAt }`
→ `O5Verdict.evidenceBundleHash` → `releaseFromEvidence()` (`VNextSettlementEscrow.sol`). `O5Verdict` fields: `PENDING`.
The composite produces **ONE bundle per leg** (print bundle signed by the printer kernel / human-adapter session key;
carrier bundle signed by the gateway's carrier kernelId) — the verdict is over the **pair**, see §2.

### 1.6 Verification program — `packages/spec/src/types/verification-program.ts` @ feat/v3-evidence-signing
`computeVerificationProgramHash({version, schemaHash, stages})` = `"0x"+hex(SHA256(canonicalize(...)))` (confirmed earlier).
Stage schema: `PENDING`. Stage ids MUST match the composition DAG vocabulary — asked on the bus.

## 2. The composite program `document.print-and-mail` (provisional stage ids)

| stage | leg | required events (AND of OR-groups, per `TierEvidenceRequirements`) | closes on |
|---|---|---|---|
| `print` | print | `[execution_completed]` + tier extras (§3); program ALSO requires event-absent `execution_failed` (§8, fail-closed) | kernel-signed print bundle |
| `commit` | bridge | `ShipmentCommitment` exists with `committedAt` **<** first `custody_handoff_*` timestamp and **<** first carrier event timestamp | commitment hash pinned in verdict |
| `handoff` | print | `[custody_handoff_confirmed]` (informational) | — never gates release |
| `mail` | carrier | `[courier_pickup_confirmed, courier_delivery_confirmed]` with `simulated=false`, `trackingCode` == commitment, `commitmentHash` == commitment.hash | carrier bundle |
| `proof` | verdict | (a)∧(b)∧(c) | `release`; else `dispute` |

Which carrier event closes `mail` is a **capability parameter** (`closeOn: "pickup" | "delivery"`), pinned into the program
hash — the demo document says the mail leg closes on the carrier **scan**, i.e. `pickup`; `delivery` is the
stricter option for higher tiers.

## 3. Assurance tiers for the composite (extends `DEFAULT_TIER_REQUIREMENTS`, evidence.ts:233-278, which is 3D-print-shaped)
- **T0**: `execution_completed` (print success, §8) + `courier_pickup_confirmed`(committed). minimumEvents 2. Program ALSO requires event-absent `execution_failed` (fail-closed) — an evaluator predicate, NOT a producible required event (§8; only the positive event is counted toward minimumEvents).
- **T1**: T0 + `printer_log_captured` (kernel log chain); `printer_job_verified` bindable here as SUPPORTING log-chain integrity evidence (§8), not the success signal. minimumEvents 3.
- **T2**: T1 + `photo_captured` of the sealed, labelled envelope showing the tracking barcode + `photo_anti_spoof_check`. minimumEvents 5.
- **T3**: T2 + `courier_delivery_confirmed` (closeOn=delivery) + `tee_attestation` where the kernel has one. minimumEvents 7.
- **Human-with-a-phone executor (no printer kernel)**: print evidence is `photo_captured`+`photo_anti_spoof_check` signed by the
  executor session key only → **tier capped at T0-equivalent**, and (c) can only be checked if the photo capture carries the
  label barcode = trackingCode (barcode decode by the digital oracle). The mail leg is unchanged — the carrier scan is the
  same strength regardless of who printed.

## 4. Drift signals → verdict input
Carried as evidence, never as a gate by themselves: gap between `committedAt` and pickup scan (> capability `maxHandoffSeconds` → dispute),
`return_to_sender`/`failed` tracker statuses (no event is emitted for them — the evaluator must read the **store status**, not only events: absence of a
pickup event is ambiguous between "not yet" and "failed"; the record's `status` disambiguates), duplicate-tracking-code commitments (impossible by
construction: `byTrackingCode` map, one jobId per code), `simulated=true` on any carrier event (mock mode) → verdict `dispute` with reason `simulated_evidence`.

## 5. Known caveat (v1) — `labelHash` is URL-bound
`labelHash = sha256Hex(labelUrl || trackingCode)` hashes a string EasyPost controls, not the label bytes. Consequence: rule (c) in v1 is satisfiable
only if the print leg hashes the **same string** (the labelUrl it fetched), which proves "printed the label at that URL", not "printed these bytes".
Asked the carrier lane to hash the fetched bytes instead (v1.1). Until then the verdict treats (c) as `labelUrl`-equality and the real binding strength is
(b) — trackingCode + commitmentHash — which is still sufficient against that puncture because the commitment predates handoff.

## 6. Goldens (to be emitted, cross-confirmed with oracle byte-for-byte as with 0xcb30733c)
1. `ShipmentCommitment.hash` for a fixed {jobId, address, trackingCode, labelUrl, committedAt} — reproduces `buildCommitment` exactly.
2. Carrier `EvidenceEvent.hash` for a fixed pickup event — reproduces `hashEvent` (§1.4).
3. Print + carrier bundle hashes — `hashBundle` (§1.4).
4. `computeVerificationProgramHash` for the T0 composite program with `closeOn: pickup`.
5. Negative vectors: uncommitted tracking code; committedAt after pickup; simulated=true; photo-only mail leg → each MUST evaluate `dispute`.

## 7. v1.1 addendum — carrier-scan PROVENANCE (R5, 2026-09-05→06; evidence half delivered)

**Status**: emitter gap CLOSED by carrier PR #323 (both legs emit the two fields in the hashed payload); oracle evaluator built and tested against these goldens (private; confirmed at the interface); evidence contract + program + goldens DELIVERED (golden `packages/verifier/test-vectors/composite-provenance-golden.cjs` @ 293c47b4, 11/11; posted on the lane bus). Open only on: oracle's stage-name confirm for the byte-exact programHash, and the #323 merge SHA for the mailEvent.hash re-bind.

A SECOND operator (Lob, `routes/lob.ts` @ master `73877834`) emits the SAME `courier_*` vocabulary as EasyPost but is an OPERATOR SELF-REPORT, not an independent third-party scan. A cross-family review of PR #316 escalated the settlement-side rule to evidence+oracle: **an event-present mail leg MUST NOT `release` on a self-reported courier event as if it were an independent carrier scan.** This closes the v1 hole where rule (b) accepted ANY non-simulated matching carrier event regardless of who authored it — a Lob `courier_pickup_confirmed` matching the commitment would have released.

### 7.1 Field contract (evidence pins; every `courier_*` emitter MUST conform, INSIDE the hashed payload so `hashEvent` covers it)
```
provenance             : "independent_carrier_scan" | "operator_self_report"
independentCarrierScan : boolean
```
CONSISTENCY, fail-closed: `independentCarrierScan === true`  IFF  `provenance === "independent_carrier_scan"`. Any other combination — field ABSENT, `operator_self_report` + `independentCarrierScan:true` (self-asserting independence it disclaims), or a bare `true` with no provenance — is **CONTRADICTORY/UNDECLARED** and the event is treated as NON-independent (never upgraded to independent).
- **Lob** (master `lob.ts:149-150`): `provenance:"operator_self_report"`, `independentCarrierScan:false` — conforms, honestly non-independent.
- **EasyPost carrier** (master `carrier.ts`): emits NEITHER field today = **ABSENT**. **EMITTER GAP → carrier lane**: independence must be ASSERTED, not inferred from absence (same fail-closed posture as §0). EasyPost's genuine third-party scan must POSITIVELY emit `provenance:"independent_carrier_scan"`/`independentCarrierScan:true` in the hashed payload, or its scans are treated as non-independent and cannot satisfy an independence-requiring tier either.

### 7.2 Tier → independence requirement
Capability parameter `requiresIndependentCarrierScan: boolean`, pinned into the program hash, declares whether the mail-leg tier claims physical-mail independence.
- `true` (independence-claiming tier): rule (b) closes ONLY on a carrier event with consistent provenance AND `independentCarrierScan === true`. An `operator_self_report` event → `dispute`.
- `false` (the honest-asymmetry tier framed for Lob): an `operator_self_report` event satisfies the leg, but the verdict + receipt MUST record `mailProvenance:"operator_self_report"` so a consumer can never read it as an independent scan.
- CONTRADICTORY provenance (§7.1) → `dispute` at EVERY tier — a forgery signal, not a tier question.

### 7.3 Rule (b), amended
(b): a carrier-scan `EvidenceEvent` exists whose `trackingCode`==commitment AND `commitmentHash`==commitment.hash AND `simulated===false` AND provenance is CONSISTENT (§7.1) AND — when the program's `requiresIndependentCarrierScan` is true — `independentCarrierScan===true`.

### 7.4 Ownership split (mirrors the anti-swap split; the oracle evaluates)
- **EVIDENCE (this lane)**: §7.1 field contract + §7.2 tier rule + §7.5 goldens. Owns the canonical event schema so provenance is part of `hashEvent` and cannot be stripped/forged.
- **ORACLE**: the evaluator/release-predicate that reads provenance from the AUTHENTICATED event and enforces §7.2/§7.3 — the actual `release`/`dispute` decision.
- **CARRIER**: close the EasyPost emitter gap (§7.1).

### 7.5 Goldens — EMITTED: `packages/verifier/test-vectors/composite-provenance-golden.cjs` @ 293c47b4 (11/11, standalone node:crypto)
- **BINDING**: five provenance variants (independent / self_report / boolean-contradiction / bare-true / absent) hash DISTINCTLY → provenance is in `hashEvent`'s preimage → tamper-evident under `kernelSignedEventsRoot` + the kernel signature (the property that makes "read provenance from the AUTHENTICATED event" sound).
- **VERDICT** table matches the oracle's known-answer test at both tiers: `requiresIndependentCarrierScan:true` → independent release-eligible, {self_report, contradiction, absent} dispute; `:false` → {self_report, absent, independent} release-eligible (verdict records `mailProvenance`), contradiction dispute.
- **PROGRAM**: proposed `programHash = 0xe1cac43536cae93c76510c76fa99ca234ad0113e4464a1bd0cd4c9f7d16ff100` for the independence-tier composite (oracle confirms stage field names for the byte-exact value).
- **BYTE-TARGETS** (vs #323 branch 18d97b52, re-confirm on merge SHA): `mailEvent.hash[independent] = sha256:8160d8cd..`, `[self_report] = sha256:3c30ee39..`.

## 8. CORRECTION — print-leg success signal (2026-09-06)

§1.3/§2/§3 above are WRONG about `printer_job_verified`. Verified from the real producer `packages/kernel/src/adapters/printer-log-adapter.ts` `stopRecording()` (:164-208): **`printer_job_verified` is a LOG-CAPTURE SUMMARY emitted UNCONDITIONALLY** — payload `{jobId, chainLength, headHash, tailHash, summary}` (+ `mock:true` only for the simulated provider). Its `summary` "…completed with N log entries" means the log stream ENDED, **not** that the print physically succeeded. It carries **no success field**. So the §2 print stage (bare `event-present printer_job_verified`) passes a REAL failed print (log captured, no mock marker, no success signal) — the leg would release a failed job .

**Corrected print-leg contract** — key on the EXISTING execution lifecycle, not the log summary:
- Success signal = **`execution_completed`** (EVIDENCE_EVENT_TYPES evidence.ts:31; already required by DEFAULT_TIER_REQUIREMENTS :238-268). Failure = **`execution_failed`** (:32).
- Committed print leg = **event-present `execution_completed` AND event-absent `execution_failed`** (fail-closed). A failed print emits `execution_failed` and/or no `execution_completed` → DISPUTE.
- `printer_job_verified` is RE-SCOPED to what it actually is: **log-chain integrity evidence** (tier ≥1 supporting), NOT the success signal.
- EMITTER (pcc-node / kernel owner): the device result must drive `execution_completed` (real success) vs `execution_failed` (failure); the job_executor.py:215-230 fall-through (a `status:failed`/`printed:false` result returning normally → `completed`) must route to `execution_failed` and the bundle must carry it. Same is-fabricated caveat + the no-independent-print-oracle kernel-key root as §7 (this leg makes the success assertion explicit + program-checked; it does not beat a lying kernel — that is tier/attester territory).
- Program impact: the print stage changes → **programHash re-goldens**. STATUS (corrected 2026-09-08): **WRITTEN + PUSHED on `feat/v3-evidence-signing`, UNMERGED to master** — verified `git merge-base --is-ancestor 3e449b95 lamasu/master` = false (exit 1). NOT "landed"; merge to master is operator-gated. Downstream (composition PR #330, gateway) must not treat the new programHash as on-master (R-01). Golden v4 `composite-provenance-golden.cjs` @ 3e449b95 (17/17) — committed print leg = and(event-present `execution_completed`, event-absent `execution_failed`). NEW hashes **independence 0xd229c8daa76cb3022041b6ff076d30a5ecb614d71f50a07f80f680629dcc2b86 / honest-asym 0x6e00cad1095c6a2913671e30969436897bd12ce60b3957f7b259f56875c863e0** supersede 0xe1cac435 / 0x2acdff54. The oracle cross-confirmed the event-absent predicate at the interface. Composition audit: ZERO programHash pins in-tree — the two new values flow through v3 (#327) unchanged when plans select programs; the production re-pin is a plan-instance value (oracle/evidence own it), mostly G2-gated.

**Vocabulary-map ruling (evidence → composition, 2026-09-07)**: (a) the CSD tier-success bind moves `printer_job_verified` → `execution_completed` at every tier (§2/§3 above reconciled); `printer_job_verified` stays as tier≥1 SUPPORTING log-chain evidence. (b) event-ABSENCE (`execution_failed` absent) is NOT producible CSD evidence — the CSD binds only the POSITIVE producible event; the committed program owns the fail-closed absence check (the committed program's event-absent predicate). CSD rebind is composition's PR; the absence check is never expressed in a CSD tier.

## 9. Primitive ↔ event-type map (the "pair-to-pair" map; evidence-owned; supersedes the printer_job_verified print pairing, 2026-09-07)

The `document-print-and-mail` CSD (composition, `packages/spec/src/csds/`) binds each leg → an evidence PRIMITIVE (print = `machine.execution_log{logKind:job_log}` + `receipt.kernel_signed{capability:document-printing}`; handoff = `capture.photo_nonced`+`artifact.hash`; mail = `confirm.target_system`; proof = `confirm.target_system`+`confirm.recipient_signature`). The committed program + goldens check raw EVENT TYPES. This section is the bridge composition rebinds against — the answer to composition's part (a). `receipt.kernel_signed` carries NO event binding in `primitives.ts:382` (it is semantic — "a registered kernel executed a capability and commits to its output, Ed25519-signed"), so which event-type substantiates it is this evidence-owned decision.

**Print leg — CHANGED:**
| CSD primitive (leg = print) | substantiating event-type | tier | note |
|---|---|---|---|
| `receipt.kernel_signed{capability:document-printing}` | **`execution_completed`** (present) — WAS `printer_job_verified` | T0+ (all) | the kernel's signed SUCCESS receipt = `execution_completed` (evidence.ts:31), NOT the log summary |
| `machine.execution_log{logKind:job_log}` | `printer_log_captured` (present) **+ `printer_job_verified`** now pairs HERE as SUPPORTING log-chain integrity | T1+ | `printer_job_verified` re-scoped per §8 — a log-capture summary, not a success signal |

**Program-side predicate (NOT a CSD primitive binding — the answer to part (b)):** `execution_failed` must be ABSENT (fail-closed). Event-absence is not producible evidence, so it is NEVER a CSD tier binding — it is the committed program's event-absent predicate. The CSD binds only positive producible events.

**Unchanged legs:** handoff (`capture.photo_nonced` + `artifact.hash`); mail (`confirm.target_system` carrier scan + §7 provenance — `provenance`/`independentCarrierScan` inside the hashed payload, `requiresIndependentCarrierScan` tier param); proof (`confirm.target_system` delivery + `confirm.recipient_signature`).

**CSD rebind (composition's small PR):** in the `document-print-and-mail` CSD, repoint the print leg's `receipt.kernel_signed` substantiation `printer_job_verified` → `execution_completed`; keep `printer_job_verified` under `machine.execution_log` as tier≥1 supporting; add NOTHING for the absence check (program-side only).

## 10. EMITTER conformance — pcc-node must emit `execution_failed` on failure (grounded finding, 2026-09-07)

Verified from source in this worktree (`packages/pcc-node/pcc_node/job_executor.py`) :
- **DEFECT: pcc-node has NO `execution_failed` path at all.** `build_evidence_bundle` (:133–159) emits `execution_completed` UNCONDITIONALLY with `payload: result` (:147–158), whatever `result` says; the string `execution_failed` appears NOWHERE in pcc-node. And `execute()` (:215–230) routes only RAISED exceptions to `update_job_status("failed")` — a device result `{"status":"failed", ...}` returned normally (no exception) falls through to :216 `build_evidence_bundle` + :219 `push_evidence` + :220 `update_job_status("completed")`.
- **CONSEQUENCE: the landed golden-v4 print-leg defense (3e449b95) is DEFEATED AT THE EMITTER and currently inert.** Committed program = and(`execution_completed` present, `execution_failed` absent). A failed device result → bundle carries `execution_completed` present + `execution_failed` absent → the program RELEASES the exact failure golden v4 was built to dispute. The settlement-side fix is correct; it does nothing until the emitter emits the right event.
- **REQUIRED (emitter contract — pcc-node owns the per-adapter mapping):** `build_evidence_bundle` must branch on `result`: success → `execution_completed`; failure → `execution_failed` (and NOT `execution_completed`). Fail-closed: a result that cannot be classified as success MUST NOT emit `execution_completed`. Also gate `execute()` :218–220 so a failed result reports `update_job_status("failed")`, not `"completed"`.
- **Known result shapes (from the code, non-exhaustive — owner must census every adapter):** success `{printed:True, returncode:0}` (test_job_executor.py:148); failure `{status:"failed", error:...}` (job_executor.py:204–208 / :227). The per-adapter success predicate is the owner's call (they know every adapter's result) — which is why the implementation is pcc-node's, not evidence's.
- **ACCEPTANCE (conformance to this contract):** (a) failed device result → bundle events include `execution_failed` and NOT `execution_completed` → the committed program disputes (golden v4 3e449b95); (b) success result → `execution_completed` present, `execution_failed` absent → releases; (c) unclassifiable result → NOT `execution_completed` (fail-closed).
- **OWNERSHIP:** EVIDENCE owns this event contract + the settlement-side golden (both landed). pcc-node owns `build_evidence_bundle` mapping each adapter result → the event. Implemented by PR #333 (failure path) and PR #343 (acceptance is not completion).
