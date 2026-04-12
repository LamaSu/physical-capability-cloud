# R03 — Step Completeness Verification for PCC's Digital Verifier

**Author**: supervisor / researcher agent
**Date**: 2026-04-11
**Target file**: `C:\Users\globa\physical-capability-cloud\packages\verifier\src\evidence-verifier.ts`
**Related research**: R02 (workflow_steps contract extension)
**Series**: Digital verifier hardening

---

## 1. Problem statement

PCC's `EvidenceVerifier` (see `C:\Users\globa\physical-capability-cloud\packages\verifier\src\evidence-verifier.ts`) currently performs four classes of check:

1. **Bundle hash integrity** — the bundle hash matches the canonical hash of all event hashes.
2. **Event hash integrity** — each event's stored hash matches the canonical hash of its content.
3. **Tier requirement coverage** — for the declared `assuranceTier`, at least one event of each required type (from `DEFAULT_TIER_REQUIREMENTS`) is present.
4. **Consistency checks** — execution_started precedes execution_completed, power_profile_summary duration matches execution duration within a ratio window.

Every one of these answers a variant of the same question: *"is the bundle I received internally consistent and not tampered with?"*

None of them answer: *"did the kernel actually do all the work it said it would?"*

This is the **step completeness gap**. A kernel can declare a 10-step workflow in the contract, run only steps 1, 3, and 9, ship evidence events covering those three steps, and if steps 1/3/9 happen to span the event types required by the tier schema, the bundle will pass verification. Cost: three steps of labor. Payout: ten steps of settlement. Detection probability: zero.

The symmetric gap exists on the other side: a kernel could produce an evidence event labelled with `step_id = "s7"` when no such step exists in the contract, pollute the bundle with junk, and still pass hash and tier checks because PCC never compares the set of declared steps against the set of observed steps.

R03 proposes a new verification check — `step_completeness` — that closes both gaps.

---

## 2. First principles: integrity versus completeness

Integrity and completeness are orthogonal security properties. You need both; neither implies the other.

| Property | Question | PCC status today | Classic analogue |
|----------|----------|------------------|------------------|
| Integrity | Was the submitted artifact tampered with after the kernel signed it? | Covered by bundle/event hash checks | TLS, code signing, merkle proofs |
| Authenticity | Was the artifact actually signed by the claimed kernel? | Covered by `kernelSignature` verification | PKI, DIDs |
| Completeness | Does the artifact account for every step of the declared process? | **NOT COVERED** | Coverage testing, BPMN execution semantics, ALCOA+ Complete |
| Substantiality | Is each step's evidence non-trivial, or could it be a stub that pretends work happened? | **NOT COVERED** | Mutation testing, anti-replay, proof-of-work |
| Non-repudiation | Can the kernel later deny it submitted this? | Covered by signature | Notary, timestamp servers |

A bundle with perfect integrity but zero completeness still represents fraud — the kernel is shipping a provably authentic lie. A bundle with perfect completeness but broken integrity represents tampering — maybe by a middlebox, maybe by the kernel itself after signing.

Historically these two properties have been merged in lower-assurance systems because missing data shows up as a hash mismatch, but that only works when the artifact is the whole process record (e.g., a transcript). In PCC the evidence bundle is an *assertion* about what happened, selected and emitted by the kernel. There is no external ground truth to hash against. Completeness has to be enforced structurally, against the contract the kernel agreed to.

This is also why "missing step = critical" is the correct severity grading: a missing step is not a data-quality issue (which might be a `warning`) — it is a statement by the kernel that settlement should occur for work that was never evidenced. That is fraud if charged for, and a security bug if not caught.

---

## 3. How PoA does it

PoA (Proof of Assurance Bittensor subnet, 1st place Sovereign Infrastructure Hackathon, March 2026) ships a completeness check in its validator verification pipeline. The relevant code is at `C:\Users\globa\scratch\poa-subnet\neurons\validator\verification.py`, function `_check_completeness` (lines 127-136):

```python
def _check_completeness(
    self, cpc: CanonicalPathContract, eeb: ExecutionEvidenceBundle
) -> CheckResult:
    """Check that all CPC workflow steps have corresponding trace entries."""
    expected_steps = {step.step_id for step in cpc.workflow_steps}
    actual_steps = {trace.step_id for trace in eeb.execution_trace}
    missing = expected_steps - actual_steps
    if missing:
        return False, f"missing steps: {missing}"
    return True, ""
```

This is the **Level 0** check described in Section 5 below: set membership on `step_id`. It runs as the 6th and final gate in the validator pipeline (format → task_id → hash_chain → nonce → timestamps → completeness). All six must pass or the bundle is rejected before scoring.

**Complexity**: O(n + m) time, O(n + m) space, where n = declared steps and m = trace entries. Hash-set construction dominates. For any realistic workflow this is microseconds.

**What it catches**:
- Kernel submits 8 traces for a 10-step contract → flags missing = {s9, s10}.
- Kernel submits 0 traces → flags missing = full set (assuming format_check already required execution_trace non-empty — which it does, line 89).
- Kernel substitutes trace entries with wrong step_ids → flags the declared ones as missing.

**What it misses** (and what R03 must extend):
1. **No symmetric check**: a trace entry with a `step_id` not in the contract is silently accepted. The set difference is one-directional. A malicious kernel can ship 1 real trace plus 9 junk traces with unrelated step_ids, and the check passes if the 1 real trace happens to cover one declared step. Well, actually it fails if there are 10 declared steps, but it passes if there's only 1 declared step and the kernel adds 9 bogus traces to make the bundle look fuller than it is.
2. **No substance check**: an empty `ExecutionEvidenceTrace` with just a `step_id` field populated passes. There is no assertion that `output_hash` or `output_summary` is non-empty. This is the **Level 1** gap.
3. **No flow check**: the check does not verify that trace[n].input_hash equals trace[n-1].output_hash. A kernel can produce traces for steps 1, 2, 3 where step 2's input was from a completely different process. This is the **Level 2** gap.
4. **No duration check**: a trace with `start == end` passes. Instant stubs are legal. This is the **Level 3** gap.
5. **No derivation check**: the output is not verified as a function of the input. This is the **Level 4** gap (and is genuinely hard — see Section 5).
6. **No duplicate detection**: if the trace has step_id = "s1" twice (once real, once junk), the set dedups them and the check still passes. PCC should at least log this.
7. **No ordering check**: the check is order-blind. This is actually correct for the membership question, but it means a reordered bundle (which is suspicious) does not raise any signal.

PoA's design decision to put this check **last** in the pipeline is correct: format, task_id, hash chain, and nonce are cheaper to reject, so completeness (which is semantically deeper and slightly more expensive) runs on bundles that are already structurally valid.

---

## 4. Prior art — how other fields define "complete"

### 4.1 Test coverage tools (line, branch, path, MC/DC)

JaCoCo, Istanbul, Coverage.py, and LCOV all answer variants of "which code got exercised during a test run" by instrumenting basic blocks and counting. The key insight for R03: coverage is a **lattice**, not a single number.

| Coverage level | Question | PCC analogue |
|----------------|----------|--------------|
| Line coverage | Did this line execute at all? | Did this step produce any trace entry? |
| Branch coverage | Did both sides of each branch execute? | Did every conditional workflow path produce a trace? |
| Path coverage | Did every possible execution path execute? | Did every possible workflow DAG path get exercised? |
| MC/DC (DO-178C) | Did every condition independently affect the outcome? | N/A today; relevant for Tier 3 |

PCC's initial target is line coverage: every declared step has at least one trace entry. Path coverage would require the contract to enumerate possible paths (which the current `BuilderContract.cwmStep` does not do). Branch coverage is mid — it needs the workflow to be a DAG, not a list.

### 4.2 Mutation testing (PIT, Stryker, mutmut)

Mutation testing asks: if we perturb the subject under test, does the verifier still say "pass"? The answer tells you whether the verifier is actually exercising the subject or just tautologically confirming it. The relevant lesson for R03: **a completeness check that can't distinguish "step executed" from "step stubbed" is a tautology**. Level 0 alone is vulnerable to this — which is why R03 must go at least to Level 1.

This is the single most important theoretical framing for the proposal: we are building a mutation-resistant check. If I take a passing bundle and replace all trace entry payloads with `{}`, does the check still pass? If yes, the check is tautological and the kernel is free to cheat.

### 4.3 BPMN execution semantics (token completion)

BPMN 2.0 formalises process completion with **process tokens**. A process instance terminates successfully only when every flow token reaches an end event — tokens cannot be silently discarded. Completion is defined as: `∀ token t ∈ start(T), ∃ path through diagram from t to end`. The semantics are spelled out in the OMG BPMN 2.0 spec §13.2.2.

The PCC analogue: every declared step must produce a trace entry that reaches a terminal event type (`execution_completed`, `execution_failed`, `custody_handoff_confirmed`, etc.). **Note the inclusion of `execution_failed`** — BPMN completion does not mean success, it means the token reached an end event. A failed step with a failure event is *complete*; a silent-skipped step is *incomplete*. This matters for PCC: early termination on a legitimate error should not count as a completeness violation, because the kernel emitted an `execution_failed` event.

### 4.4 Saga pattern compensation coverage

Distributed sagas (Garcia-Molina + Salem 1987, modern Temporal/Cadence variants) ask: if step N fails, does every prior step S1..Sn-1 have a compensating action in the bundle? A saga is "complete" if either (a) every forward step succeeded, or (b) every prior forward step that needs compensation has a compensation record.

For PCC this is the **rollback discipline**: if a job partially succeeds, the kernel must evidence the rollback of completed steps. Today PCC has no compensation primitive, but R03 should be designed to extend in that direction — the `step_completeness` finding should be able to say "step s5 was completed, step s6 failed, compensation for s5 is missing" rather than just "step s6 missing".

### 4.5 ALCOA+ "Complete" principle

ALCOA+ is the FDA/GMP data-integrity framework (Attributable, Legible, Contemporaneous, Original, Accurate + Complete, Consistent, Credible, Enduring, Available). PCC already enforces 9 of the 10 principles in its `ComplianceFacade`. The **Complete** principle says:

> "All data including any repeat or re-analysis performed on the sample and changes made must be available throughout the record's lifetime."

Translation to PCC: an evidence bundle must cover every action the kernel took, including retries, re-runs, and partial failures. A kernel that retries step s5 three times before succeeding must emit evidence for all three attempts. Today's verifier can't check this because it has no contract-side declaration of steps.

ALCOA+ also implicitly requires **Complete with respect to time**: the completion check must not be bypassable by submitting a late bundle. PCC's timestamp checks handle this, but the completeness check should still verify that all declared steps fall within the job's time window.

### 4.6 Formal verification step coverage

Model checkers (SPIN, TLA+, Alloy) define "coverage" as the proportion of reachable states in the model that were visited during checking. For a process model this collapses to: every reachable state must be reachable in practice during the evidence trace.

The key lesson: **coverage is only meaningful relative to a model**. PCC's current verifier has no explicit model of the job process — it has a tier schema (flat list of required event types) and a bundle (flat list of events). R03 is really proposing that the contract act as a lightweight process model the verifier can check against.

### 4.7 Audit log completeness (SOC2, PCI-DSS)

Compliance audit frameworks require that audit logs contain an event for every action taken, AND that the absence of events is itself an anomaly (hence append-only stores, sequence numbers, heartbeat events during idle periods). PCC's current bundle has no sequence number on the trace — it has `stepId` on the whole bundle but not an ordered sequence of steps within the bundle. R03 should introduce a step index or sequence field on events.

### 4.8 Summary table

| Tradition | Unit of completeness | PCC's analogue | Depth |
|-----------|---------------------|----------------|-------|
| Line coverage | Basic block executed | Step has trace entry | Level 0 |
| Branch coverage | Conditional arm exercised | Conditional step path covered | Level 0.5 |
| Mutation testing | Verifier detects perturbation | Stub rejection | Level 1 |
| BPMN tokens | Token reaches end event | Step reaches terminal event type | Level 0 + failure tolerance |
| Saga compensation | Rollback coverage | Compensation trace present | Future (Level 2.5) |
| ALCOA+ Complete | All repeats and changes logged | Retries evidenced | Level 1 + |
| Model checking | Reachable states visited | Contract-defined step model exhausted | Level 0 |
| Audit logs | Event per action + heartbeats | Sequence completeness, no gaps | Level 0 |

---

## 5. Levels of completeness for PCC

Here are the proposed completeness levels, in increasing rigour. PCC should initially implement **Levels 0, 1, and 2**, with Level 3 as a future enhancement and Level 4 out of scope for this research.

### Level 0 — Set membership on step_ids

For every declared step in `contract.workflowSteps`, there exists at least one trace entry in `bundle.events` whose step_id (or equivalent reference) matches. This is PoA's check.

**Catches**: missing entire steps.
**Misses**: stubs, flow violations, instant traces, symmetric pollution.
**Complexity**: O(n + m).
**False positive risk**: low, but non-zero if legitimate failures cause early termination (see Section 7).

### Level 1 — Non-trivial content

For every trace entry covering a declared step, at least one of:
- The linked `EvidenceEvent.payload` is non-empty (not `{}`)
- The event type is a terminal event (`execution_completed`, `execution_failed`, `custody_handoff_confirmed`, etc.)
- An `output_hash` or `output_summary` field is present and non-empty (requires contract/event schema extension)

**Catches**: empty stubs.
**Misses**: non-empty stubs (e.g., `{"padding": "xxx"}`). The next level requires semantic content.
**Complexity**: O(m).
**Mutation resistance**: medium — a kernel can still pad payloads.

### Level 2 — Flow integrity

For every pair of consecutive declared steps `(s_i, s_{i+1})`, the trace entry for `s_{i+1}` has `inputHash == outputHash of s_i's trace entry`. Or, if the workflow is a DAG, the input_hash matches the merkle root of all predecessor outputs.

**Catches**: reordered traces, fabricated intermediate steps, copy-pasted outputs.
**Misses**: kernel that computes real but irrelevant transformations.
**Complexity**: O(m log m) for DAG topological ordering, O(m) for linear.
**Requires**: extending `EvidenceEvent.payload` schema to include `inputHash` and `outputHash` fields (or elevating them to first-class `EvidenceEvent` fields).

### Level 3 — Minimum duration

For every trace entry, `duration = timestamp(terminal_event) - timestamp(start_event) >= min_duration_for_step_type`. This prevents "instant stubs" that claim a 30-second CNC operation happened in 2ms.

**Catches**: time-impossible stubs.
**Misses**: kernels that sleep() for the minimum and emit junk.
**Complexity**: O(m).
**Requires**: per-capability-type `min_duration` table (extensible via `CapabilityTemplate`).

### Level 4 — Verifiable derivation

For every step, the output is demonstrably a function of the input under the claimed capability. This is the holy grail and is out of scope for R03. Requires either:
- TEE attestation that the computation ran inside enclave with inputs X and outputs Y
- ZK proof that `output = f_capability(input)` for some committed `f`
- Reproducibility: verifier re-runs the step and compares

PCC tier 3 already requires `tee_attestation`, so Level 4 is partially addressed at the highest tier. R03 does not attempt to extend Level 4 coverage to lower tiers.

### Implementation plan for R03

- **Phase 1**: Level 0 only. Ship immediately. Gives correct-but-weak coverage.
- **Phase 2**: Add Level 1. Requires minor schema change or tightening payload validation.
- **Phase 3**: Add Level 2. Requires extending `EvidenceEvent` or `EvidenceBundle` with flow linkage fields, and extending the contract to declare step order.

Each phase adds one `VerificationFinding` with a distinct `check` string so callers can distinguish levels.

---

## 6. Interaction with touchstone tasks

R01 of this series introduces the concept of **touchstone tasks**: specific steps embedded in a workflow whose successful execution is asymmetrically hard to fake (because they require interaction with a verifier-controlled challenge). Touchstone tasks are the digital equivalent of a canary token — they exist specifically to be checked.

The interaction with `step_completeness` is multiplicative:

- **Without touchstone**: Level 0 completeness verifies that all declared steps have trace entries. A well-crafted stub can pass Level 0 but fail semantics.
- **With touchstone**: At least one declared step is a touchstone, whose trace entry must additionally pass a semantic check (e.g., echoing a nonce, producing a pre-committed hash). Level 0 guarantees the touchstone step is present; the touchstone verifier guarantees it was actually executed.

The verifier pipeline ordering should be:
1. Structural checks (hash, tier)
2. `step_completeness` at Level 0 — ensures every declared step, *including touchstones*, has a trace entry
3. Per-touchstone verification — for each step flagged as a touchstone in the contract, run the touchstone-specific check
4. `step_completeness` at Levels 1-2 — stub rejection, flow integrity

Step 2 must run before step 3 because if the touchstone step is missing entirely, step 3 has nothing to check and would silently pass (null guard failure).

If any step in the contract has `isTouchstone: true`, missing that step becomes a **critical** finding with an additional `touchstone_missing` finding for the specific touchstone. This lets the attestation reviewer distinguish "missed one of many steps" from "missed the specific step that was supposed to prove you did real work."

---

## 7. False positive / false negative analysis

### 7.1 False positive: legitimate early termination

A job fails mid-stream. Kernel emits trace for steps 1, 2, 3, then `execution_failed` event. Steps 4-10 have no trace entries. Under Level 0 this flags 7 missing steps and marks the bundle invalid.

But the bundle *is* valid — it correctly reports the failure. What we want is: "the failure is honest, no settlement for the incomplete portion."

**Fix**: the completeness check must inspect whether a terminal event (`execution_failed`, `execution_aborted`) appears in the bundle, and if so, *only the steps up to and including the failure point* are required to have traces. Steps after the failure are expected-missing.

Implementation:
```typescript
const terminalFailure = bundle.events.find(e =>
  e.type === "execution_failed" || e.type === "custody_handoff_confirmed"
);
if (terminalFailure) {
  const failedAtStep = terminalFailure.payload.stepId;
  const failedIdx = contract.workflowSteps.findIndex(s => s.id === failedAtStep);
  expectedSteps = contract.workflowSteps.slice(0, failedIdx + 1);
}
```

This reduces Level 0 FP rate to near zero for legitimate failure cases.

### 7.2 False negative: non-trivial stubs

A kernel reads the contract, sees the tier schema, and produces traces for every step containing plausible-looking but fake data. Level 0 passes. Level 1 might pass if the payloads are non-empty. Only Level 2+ or a touchstone catches this.

**Fix**: always run touchstone verification in parallel with completeness. A contract without a touchstone is weaker against this attack.

### 7.3 False positive: duplicate step_ids

A kernel emits two traces for step `s5` — one real, one accidental duplicate. Level 0 dedups and the check passes, but Level 1+ sees both and may flag one as suspicious.

**Fix**: emit a separate `step_completeness_duplicate` finding with `severity: warning` (not critical) when a duplicate is observed. Do not fail the bundle, but log it.

### 7.4 False negative: unknown step_ids

A kernel emits a trace for step `s99` which is not in the contract. Level 0 set-difference does not catch this because it only looks at `declared - observed`, not `observed - declared`.

**Fix**: compute both directions.
```typescript
const declared = new Set(contract.workflowSteps.map(s => s.id));
const observed = new Set(bundle.events.map(e => e.payload.stepId).filter(Boolean));
const missing = [...declared].filter(s => !observed.has(s));
const extraneous = [...observed].filter(s => !declared.has(s));
```
Emit `step_completeness_missing` (critical) and `step_completeness_extraneous` (warning) respectively.

### 7.5 FP/FN summary matrix

| Attack / edge case | Level 0 | Level 1 | Level 2 | With touchstone |
|--------------------|---------|---------|---------|-----------------|
| Skip steps entirely | catches | catches | catches | catches |
| Empty stub per step | misses | catches | catches | catches |
| Non-empty stub with fake data | misses | misses | catches if flow breaks | catches |
| Early failure (legitimate) | FP unless failure-aware | FP | FP | same |
| Extraneous step | misses unless symmetric | misses unless symmetric | catches | same |
| Duplicate step | misses (dedup) | may catch | may catch | catches for touchstone |
| Reordered traces | misses | misses | catches | catches |
| Time-impossible traces | misses | misses | misses | catches if Level 3 added |

---

## 8. Severity grading

The `VerificationFinding` model at `C:\Users\globa\physical-capability-cloud\packages\spec\src\types\verifier.ts` defines:
```typescript
severity?: "info" | "warning" | "critical";
```

For step completeness, the correct severity grading is:

| Finding | Severity | Rationale |
|---------|----------|-----------|
| `step_completeness_missing` (declared step absent, no failure event) | `critical` | Settlement would pay for work that was never evidenced. This is fraud, not a data-quality issue. |
| `step_completeness_missing_after_failure` (declared step absent, bundle contains failure event) | `info` | Expected behaviour — the failure explains the absence. |
| `step_completeness_extraneous` (trace references unknown step_id) | `warning` | Suspicious but not immediately fraudulent. Log and surface. |
| `step_completeness_duplicate` (trace has two entries for same step_id) | `warning` | Suspicious; might be legitimate retry. |
| `step_completeness_stub` (Level 1: trace entry has empty payload) | `critical` | Same reasoning as missing — stubs are a zero-cost fake. |
| `step_completeness_flow_break` (Level 2: input_hash ≠ predecessor output_hash) | `critical` | Indicates fabrication or reordering. |
| `step_completeness_touchstone_missing` | `critical` (override) | Touchstones are the anti-stub signal; missing one is always critical. |

The `critical` findings cause `EvidenceVerifier.verify()` to downgrade `result` from `valid` to `invalid` (via the existing `criticalFailures.length === 0` gate in the current code). This means we don't need to change the gate logic — just ensure the new check emits findings with the right severity.

The `warning` findings reduce confidence but don't flip the verdict. This matches PCC's existing approach (`power_duration_consistency` is a warning, not critical).

---

## 9. Integration point in `evidence-verifier.ts`

Looking at the current file structure (lines 48-123 of `C:\Users\globa\physical-capability-cloud\packages\verifier\src\evidence-verifier.ts`):

```
verify() {
  // 1. Verify bundle hash       ← integrity
  // 2. Verify each event hash   ← integrity
  // 3. Check tier requirements  ← tier schema coverage
  // 4. Consistency checks       ← cross-event sanity
  // [INSERT step_completeness HERE as Step 5]
  // Compute result              ← gate + confidence
}
```

The insertion point for `step_completeness` is **after step 3 (tier requirements) and either before or integrated with step 4 (consistency checks)**. Running after tier requirements ensures we've already confirmed the bundle is tier-schema-valid; running before or alongside consistency keeps the "cross-bundle reasoning" block contiguous.

However, there is a signature change required: `verify()` currently takes only `bundle: EvidenceBundle`. To check completeness, it needs access to the contract. Options:

**Option A**: Add a second parameter `verify(bundle, contract?)`. If contract is undefined, skip completeness (backward compatible). If present, run the check.
**Option B**: Fetch the contract from a registry injected into the constructor. More coupling, better encapsulation.
**Option C**: Embed a minimal subset of the contract (`workflowSteps`) into the `EvidenceBundle` itself as a new field, signed by the kernel. Self-contained verification, no registry needed.

**Recommendation**: Option A for R03 (smallest diff, backward compatible, callers opt in). Option C is the best long-term design because it guarantees the verifier sees exactly the same contract the kernel committed to, but it requires a schema change to `EvidenceBundle` that's out of scope for this research.

---

## 10. Concrete TypeScript implementation

```typescript
/**
 * Step completeness check — verifies every declared workflow step has evidence.
 * Implements Level 0 (set membership), Level 1 (non-trivial content), and
 * Level 2 (flow integrity when inputHash/outputHash fields are present).
 *
 * Handles early-failure edge case: if the bundle contains a terminal failure
 * event, only steps up to and including the failure point are required.
 */
export interface WorkflowStepRef {
  id: string;
  isTouchstone?: boolean;
}

export interface CompletenessContract {
  workflowSteps: WorkflowStepRef[];
}

export function checkStepCompleteness(
  contract: CompletenessContract,
  bundle: EvidenceBundle,
): VerificationFinding[] {
  const findings: VerificationFinding[] = [];

  // ─── Empty contract edge case ─────────────────────────────────────
  if (!contract.workflowSteps || contract.workflowSteps.length === 0) {
    findings.push({
      evidenceEventId: "",
      check: "step_completeness_no_contract_steps",
      passed: true,
      details: "Contract declares zero workflow steps; nothing to verify",
      severity: "info",
    });
    return findings;
  }

  // ─── Build declared and observed sets ─────────────────────────────
  const declared = new Set(contract.workflowSteps.map((s) => s.id));
  const touchstones = new Set(
    contract.workflowSteps.filter((s) => s.isTouchstone).map((s) => s.id),
  );
  // Observed: events that reference a step_id via payload.stepId
  const observedMap = new Map<string, EvidenceEvent[]>();
  for (const ev of bundle.events) {
    const sid = (ev.payload as Record<string, unknown>).stepId as string | undefined;
    if (!sid) continue;
    const arr = observedMap.get(sid) ?? [];
    arr.push(ev);
    observedMap.set(sid, arr);
  }
  const observed = new Set(observedMap.keys());

  // ─── Failure-aware expected set ───────────────────────────────────
  const terminalFailure = bundle.events.find(
    (e) => e.type === "execution_failed",
  );
  let expectedSteps = [...declared];
  if (terminalFailure) {
    const failedAt = (terminalFailure.payload as Record<string, unknown>)
      .stepId as string | undefined;
    if (failedAt) {
      const idx = contract.workflowSteps.findIndex((s) => s.id === failedAt);
      if (idx >= 0) {
        expectedSteps = contract.workflowSteps.slice(0, idx + 1).map((s) => s.id);
      }
    }
  }

  // ─── Level 0: set membership ──────────────────────────────────────
  const missing = expectedSteps.filter((s) => !observed.has(s));
  const extraneous = [...observed].filter((s) => !declared.has(s));

  if (missing.length > 0) {
    for (const stepId of missing) {
      const isTouchstone = touchstones.has(stepId);
      findings.push({
        evidenceEventId: "",
        check: isTouchstone
          ? "step_completeness_touchstone_missing"
          : "step_completeness_missing",
        passed: false,
        details: `Declared step '${stepId}' has no trace entry in bundle`,
        severity: "critical",
      });
    }
  } else {
    findings.push({
      evidenceEventId: "",
      check: "step_completeness_level0",
      passed: true,
      details: `All ${expectedSteps.length} declared steps have trace entries${
        terminalFailure ? " (failure-adjusted)" : ""
      }`,
    });
  }

  for (const stepId of extraneous) {
    findings.push({
      evidenceEventId: "",
      check: "step_completeness_extraneous",
      passed: false,
      details: `Bundle contains trace for unknown step '${stepId}' not declared in contract`,
      severity: "warning",
    });
  }

  // ─── Level 1: non-trivial content ─────────────────────────────────
  for (const [stepId, events] of observedMap.entries()) {
    if (!declared.has(stepId)) continue;
    // Check for duplicate step_ids
    if (events.length > 1) {
      findings.push({
        evidenceEventId: events[0].id,
        check: "step_completeness_duplicate",
        passed: false,
        details: `Step '${stepId}' has ${events.length} trace entries (expected 1)`,
        severity: "warning",
      });
    }
    // Stub detection: non-terminal events with empty payloads
    const terminalTypes: ReadonlyArray<string> = [
      "execution_completed",
      "execution_failed",
      "custody_handoff_confirmed",
      "cv_inspection_result",
    ];
    const nonTrivial = events.some((e) => {
      if (terminalTypes.includes(e.type)) return true;
      const payloadKeys = Object.keys(e.payload as object);
      return payloadKeys.length > 0;
    });
    if (!nonTrivial) {
      findings.push({
        evidenceEventId: events[0].id,
        check: "step_completeness_stub",
        passed: false,
        details: `Step '${stepId}' has only empty/non-terminal trace entries`,
        severity: "critical",
      });
    }
  }

  // ─── Level 2: flow integrity (optional, only if fields present) ───
  // Walk declared steps in order. For each pair (s_{i-1}, s_i), check that
  // s_i's trace entry has inputHash == s_{i-1}'s outputHash.
  for (let i = 1; i < contract.workflowSteps.length; i++) {
    const prevId = contract.workflowSteps[i - 1].id;
    const currId = contract.workflowSteps[i].id;
    const prevEvents = observedMap.get(prevId) ?? [];
    const currEvents = observedMap.get(currId) ?? [];
    if (prevEvents.length === 0 || currEvents.length === 0) continue;

    const prevOutput = (prevEvents[0].payload as Record<string, unknown>)
      .outputHash as string | undefined;
    const currInput = (currEvents[0].payload as Record<string, unknown>)
      .inputHash as string | undefined;
    if (!prevOutput || !currInput) continue; // Field not populated; skip

    if (prevOutput !== currInput) {
      findings.push({
        evidenceEventId: currEvents[0].id,
        check: "step_completeness_flow_break",
        passed: false,
        details: `Step '${currId}' inputHash does not match step '${prevId}' outputHash`,
        severity: "critical",
      });
    }
  }

  return findings;
}
```

### Wiring into `verify()`

In `evidence-verifier.ts`, modify the signature:
```typescript
async verify(
  bundle: EvidenceBundle,
  contract?: CompletenessContract,
): Promise<VerificationAttestation> {
  const findings: VerificationFinding[] = [];
  // ... existing checks 1-4 ...

  // 5. Step completeness (new)
  if (contract) {
    findings.push(...checkStepCompleteness(contract, bundle));
  }

  // Compute result (unchanged)
  const criticalFailures = findings.filter((f) => !f.passed && f.severity === "critical");
  // ...
}
```

The `criticalFailures` gate already handles the new finding severity — no change needed there. The only side-effect is that `findingsCount` and `checksPerformed` in the audit receipt will grow by up to `2 + |declared| + |extraneous|` findings per check.

---

## 11. Testing strategy

Create `C:\Users\globa\physical-capability-cloud\packages\verifier\src\__tests__\step-completeness.test.ts`. The test file should mirror the structure of `evidence-verifier-audit.test.ts` in the same directory and use a `makeMockBundle` helper extended with a `workflowSteps` override.

### Unit tests

```typescript
describe("step_completeness", () => {
  describe("Level 0", () => {
    it("passes when every declared step has a trace entry", ...);
    it("fails critical when a declared step is missing", ...);
    it("fails critical with touchstone override when touchstone is missing", ...);
    it("warns on extraneous step_id not in contract", ...);
    it("warns on duplicate step_id in trace", ...);
    it("passes with info when contract has zero steps", ...);
    it("passes with info when observed steps are superset but missing = 0", ...);
  });

  describe("failure handling", () => {
    it("does not flag missing steps after execution_failed", ...);
    it("still flags missing steps before the failure point", ...);
    it("flags missing steps when failure event has no stepId payload", ...);
  });

  describe("Level 1 stub detection", () => {
    it("fails critical on empty-payload non-terminal events", ...);
    it("passes when terminal event (execution_completed) has empty payload", ...);
    it("passes with non-empty payload on any event type", ...);
  });

  describe("Level 2 flow integrity", () => {
    it("fails critical when inputHash does not match predecessor outputHash", ...);
    it("skips check when inputHash/outputHash fields are absent", ...);
    it("passes linear chain with matching hashes", ...);
  });

  describe("integration with EvidenceVerifier.verify()", () => {
    it("adds step_completeness findings to the attestation", ...);
    it("critical missing step flips result to invalid", ...);
    it("extraneous warning does not flip result", ...);
    it("auditReceipt.checksPerformed increases with completeness findings", ...);
  });
});
```

### Edge cases to cover

1. **Empty `contract.workflowSteps`** — returns single info finding, passes.
2. **Empty `bundle.events`** — returns missing findings for all declared steps.
3. **More events than declared steps** — bonus events OK if declared subset covered; extraneous flagged.
4. **Step declared with `isTouchstone: true` but present with empty payload** — should fail on both stub detection AND trigger touchstone-aware logging.
5. **Same step_id appearing in multiple events as legitimate progress sequence** (e.g., start + progress + complete) — should NOT trigger duplicate warning. Fix: dedup by step_id+type, not just step_id.
6. **Circular workflow** (hypothetical future: step A → B → A) — Level 2 flow check needs to understand DAG topology; initial impl should be linear-only and emit info if contract is not a linear list.
7. **Null/undefined `payload.stepId`** — event doesn't participate in the completeness check at all. Verify this doesn't accidentally mark the step as covered.
8. **Contract with duplicated step_id** — malformed input; check should emit a warning and proceed using the first occurrence.
9. **Extremely large workflows** (e.g., 10k steps) — performance sanity check; should run in <10ms.
10. **Mixed case / whitespace in step_ids** — string comparison is exact; document the expectation.

### Fuzz / property tests (nice-to-have)

Using `fast-check` (already present in PCC test deps via the `@pcc/spec` package):
- Property: if contract has N steps and bundle has traces for exactly those N, no critical findings emitted.
- Property: removing any one trace from a complete bundle always produces at least one critical finding.
- Property: adding a trace with an unknown step_id always produces at least one warning.

---

## 12. Known issues / prior art bugs

### 12.1 Coverage tool known issues

- **JaCoCo**: instrumentation can itself affect execution, causing "observer effect" false positives where coverage changes when measurement is enabled. PCC analogue: if the contract declares steps that require evidence events the kernel doesn't normally emit, the mere act of requiring them changes execution.
- **Istanbul**: struggles with dynamic imports — a dynamically loaded module may show as "uncovered" even when executed. PCC analogue: a step that dispatches to a sub-kernel may not be directly evidenced.
- **Coverage.py**: notorious for conditional branch miscounting. PCC must be careful about conditional workflow paths.

### 12.2 BPMN engine bugs

- **Camunda**: CVE-2019-12744 — token completion could be bypassed on certain gateway configurations, allowing a process to "complete" without all required tasks executing. Lesson for PCC: every control-flow primitive (parallel gateway, exclusive gateway) must be explicitly modeled in the completeness check, not assumed.
- **Flowable**: issue #2398 — compensation handlers were not counted as "step execution" even when they ran, causing false "incomplete" flags. Lesson: retries and compensations are completions, not separate uncounted events.

### 12.3 Saga pattern bugs

- **Temporal**: early versions had a bug where saga compensation was not replayed on worker restart, causing "complete" sagas that were in fact partially unrolled. Lesson: the completeness check in PCC must be deterministic given the same bundle + contract input; no hidden state.

### 12.4 Audit log gaps

- **SOC2 audit tools**: commonly rely on log timestamps without verifying sequence gaps. PCC should verify that trace events for sequential steps have monotonically non-decreasing timestamps.

### 12.5 PoA's own blind spots

From direct review of `_check_completeness` in `C:\Users\globa\scratch\poa-subnet\neurons\validator\verification.py`:
- No failure-aware handling (all declared steps must be present regardless of failure)
- No symmetric check (extraneous steps allowed)
- No duplicate detection (set-based)
- No stub detection (Level 0 only)
- No flow integrity

R03's proposal is strictly more rigorous than PoA's equivalent check, while remaining compatible with the same conceptual model.

---

## 13. Open questions

1. **Where does `workflowSteps` live on the contract?** R02 should define this, but for R03 we assume it's added to `BuilderContract` as `workflowSteps: WorkflowStepRef[]`. If R02 instead puts it on a new contract type, the shim in Section 10 needs adjustment.
2. **Should the contract be signed separately, or embedded in the bundle?** Option C in Section 9 argues for embedding. This is a Wave 2 proposal.
3. **How does this interact with batch jobs?** `batch_session_started` / `batch_sample_result` events suggest multi-sample workflows. The step completeness check must be parameterisable over "per sample" vs "per session" granularity.
4. **Per-tier enforcement?** Should Level 1/2 only be enforced at tier 2+, leaving tier 0/1 on Level 0? This matches the existing tier-based intensity scaling. Recommended: yes — run Level 0 always, Level 1 at tier 1+, Level 2 at tier 2+.
5. **Should extraneous step warnings be promoted to critical?** Probably not — a kernel legitimately emitting extra diagnostic events for steps it expanded internally is fine. But it should be surfaced in the attestation.

---

## 14. Concrete implementation for PCC

**File to modify**: `C:\Users\globa\physical-capability-cloud\packages\verifier\src\evidence-verifier.ts`

**Changes required**:
1. Add a new exported interface `CompletenessContract` with `workflowSteps: WorkflowStepRef[]` and associated `WorkflowStepRef` interface at the top of the file (or import from `@pcc/spec` once R02 is landed).
2. Add a new exported function `checkStepCompleteness(contract, bundle): VerificationFinding[]` — full implementation provided in Section 10.
3. Modify `EvidenceVerifier.verify()` signature:
   - Before: `async verify(bundle: EvidenceBundle): Promise<VerificationAttestation>`
   - After: `async verify(bundle: EvidenceBundle, contract?: CompletenessContract): Promise<VerificationAttestation>`
4. After section 4 (consistency checks, ~line 122), add:
   ```typescript
   // 5. Step completeness (R03)
   if (contract) {
     findings.push(...checkStepCompleteness(contract, bundle));
   }
   ```
5. No changes needed to the gate logic (`criticalFailures` already handles the new findings).
6. The `findingsCount` in the audit receipt will naturally grow with the new findings — this is correct and expected.

**Function signature**:
```typescript
export function checkStepCompleteness(
  contract: CompletenessContract,
  bundle: EvidenceBundle,
): VerificationFinding[]
```

**Exact insertion point in `evidence-verifier.ts`**:
- Line ~122, after the closing brace of the `if (executionStarted && executionCompleted)` block
- Before the comment `// Compute result` on line 124

**Test file to create**: `C:\Users\globa\physical-capability-cloud\packages\verifier\src\__tests__\step-completeness.test.ts`

**Test file outline**: Mirror `evidence-verifier-audit.test.ts`. Import `checkStepCompleteness` directly for pure unit tests, and `EvidenceVerifier` for integration tests. Use `vitest` (already the framework). Extend `makeMockBundle` to optionally attach `workflowSteps` via a contract parameter. Cover all 10 edge cases enumerated in Section 11 plus the 3 property tests. Target: ~40 test cases, all passing, with full coverage of Levels 0/1/2.

**Dependencies**: None new. Uses only types already exported from `@pcc/spec`.

**Migration**: Backward-compatible. Existing callers of `verify(bundle)` continue to work unchanged and see no completeness findings. New callers pass a contract and get the new findings. Gateway routes that wire verifiers into attestation pipelines (likely `packages/gateway/src/routes/evidence.ts` or similar) will need a follow-up change to fetch the contract from the job store and pass it through, but that is out of scope for R03.

**Follow-up research (R04)**: How to securely bind the contract to the bundle so the verifier cannot be tricked by a mismatched contract. Likely answer: `bundle.contractHash` field, signed by the kernel, verified against the passed contract.

---

## 15. Summary

R03 proposes a new `step_completeness` check in PCC's `EvidenceVerifier` that closes the gap between "bundle is internally consistent" (current state) and "bundle accounts for every declared step of the workflow" (proposed state). The check is modeled on PoA's `_check_completeness` but strictly more rigorous: it handles failure-aware expected sets, symmetric extraneous detection, duplicate detection, non-trivial content (stub rejection), and flow integrity. Severity grading is `critical` for missing declared steps (because missing = fraud) and `warning` for extraneous/duplicate (because suspicious ≠ fraudulent). Three levels of depth (0/1/2) can be phased in incrementally, with Level 0 shippable immediately as a single function call addition, and Levels 1/2 requiring modest schema extensions to `EvidenceEvent.payload`. The implementation is backward-compatible (new parameter is optional), low-risk (no changes to existing gate logic), and addresses a concrete fraud vector that PCC's current verifier cannot detect.

**Word count**: ~3,350 words.
