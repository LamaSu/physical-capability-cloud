# 07 -- Safe Removal of Dead POABridge Code

**Date**: 2026-04-11
**Status**: Research complete -- ready for execution
**Scope**: `packages/verifier/src/poa/` (574 lines source + 693 lines test + 29-line barrel)

---

## 1. Import Graph Analysis

Every reference to POABridge symbols was traced across the full monorepo (22+ packages, 1 app, scripts/, docs/, ai/).

### Symbols searched

| Symbol | Files referencing it | All inside `poa/`? |
|--------|--------------------|--------------------|
| `POABridge` (class) | `poa-bridge.ts`, `index.ts` (barrel), `src/index.ts` (main barrel), `poa-bridge.test.ts` | Yes |
| `CPCTask` | `types.ts`, `poa-bridge.ts`, `index.ts`, `src/index.ts`, `poa-bridge.test.ts` | Yes |
| `POAEvidenceBundle` | `index.ts` (barrel alias), `src/index.ts` | Yes |
| `DEFAULT_POA_BRIDGE_CONFIG` | `types.ts`, `poa-bridge.ts`, `index.ts`, `src/index.ts` | Yes |
| `DEFAULT_SCORING_WEIGHTS` | `types.ts`, `poa-bridge.ts`, `index.ts`, `src/index.ts`, `poa-bridge.test.ts` | Yes |
| `CreateCPCParams` | `poa-bridge.ts`, `index.ts`, `src/index.ts` | Yes |
| `SubmitEvidenceParams` | `poa-bridge.ts`, `index.ts`, `src/index.ts` | Yes |
| `CPCTaskType` | `types.ts`, `poa-bridge.ts`, `index.ts`, `src/index.ts` | Yes |
| `CPCWorkflowStep` | `types.ts`, `poa-bridge.ts`, `index.ts`, `src/index.ts` | Yes |
| `CPCTaskConstraints` | `types.ts`, `poa-bridge.ts`, `index.ts`, `src/index.ts` | Yes |
| `TraceEntry` | `types.ts`, `poa-bridge.ts`, `index.ts`, `src/index.ts` | Yes |
| `ExecutionTimestamps` | `types.ts`, `poa-bridge.ts`, `index.ts`, `src/index.ts` | Yes |
| `AssuranceScore` | `types.ts`, `poa-bridge.ts`, `index.ts`, `src/index.ts`, `poa-bridge.test.ts` | Yes |
| `ScoreDimension` | `types.ts`, `poa-bridge.ts`, `index.ts`, `src/index.ts` | Yes |
| `POABridgeConfig` | `types.ts`, `poa-bridge.ts`, `index.ts`, `src/index.ts` | Yes |
| `POAVerificationResult` | `types.ts`, `poa-bridge.ts`, `index.ts`, `src/index.ts`, `poa-bridge.test.ts` | Yes |

**Verdict**: Zero external consumers. Every reference is either inside `packages/verifier/src/poa/` or in the barrel re-export at `packages/verifier/src/index.ts` lines 99-116. No script, no gateway route, no other package, and no app file imports any POA symbol.

### Downstream consumer check

All files that `import ... from "@pcc/verifier"` were enumerated:

| File | Imports |
|------|---------|
| `scripts/oracle-cascade-test.ts` | `OracleVerificationBridge` |
| `scripts/investor-demo.ts` | `CommitmentService, ZKProofService, BittensorSubnetBridge` |
| `scripts/sovereign-e2e-simulation.ts` | `CommitmentService, ZKProofService, EvidenceVerifier, OracleVerificationBridge` |
| `scripts/full-demo.ts` | `CommitmentService, ZKProofService, EvidenceVerifier, BittensorSubnetBridge` |
| `scripts/e2e-simulation.ts` | `VerifierMarket, EvidenceVerifier` |
| `scripts/print-deliver-e2e.ts` | Various (non-POA) |
| `packages/agent-broker/src/broker-agent.ts` | `VerifierMarket, EvidenceVerifier` |
| `packages/gateway/src/services.ts` | `CommitmentService, NoirProofService` |
| `packages/gateway/src/routes/zk-proofs.ts` | `OracleVerificationBridge, StarknetProofAnchoringService, configFromEnv` |
| `packages/gateway/src/routes/tmp-tasks.ts` | TMP-related types |
| `packages/gateway/src/routes/subnet.ts` | Bittensor types |
| `packages/gateway/src/routes/status.ts` | `configFromEnv` |
| `packages/gateway/src/routes/paid-job-flow.ts` | `StarknetProofAnchoringService` |
| `packages/gateway/src/routes/human-verification.ts` | Network/verifier types |

**None of these import POABridge, CPCTask, or any POA symbol.** The barrel re-exports are dead exports -- compiled into `dist/` but never consumed.

---

## 2. Barrel Export Audit

File: `C:\Users\globa\physical-capability-cloud\packages\verifier\src\index.ts`

Lines 99-116 constitute the POA re-export block:

```typescript
export {
  POABridge,
  type CreateCPCParams,
  type SubmitEvidenceParams,
  type CPCTask,
  type CPCTaskType,
  type CPCWorkflowStep,
  type CPCTaskConstraints,
  type POAEvidenceBundle,
  type TraceEntry,
  type ExecutionTimestamps,
  type AssuranceScore,
  type ScoreDimension,
  type POABridgeConfig,
  type POAVerificationResult,
  DEFAULT_POA_BRIDGE_CONFIG,
  DEFAULT_SCORING_WEIGHTS,
} from "./poa/index.js";
```

**Action**: Delete this entire block (lines 99-116).

---

## 3. package.json Exports Audit

File: `C:\Users\globa\physical-capability-cloud\packages\verifier\package.json`

The package.json has **no `exports` field** at all. It uses the legacy `main`/`types` pattern:

```json
{
  "main": "dist/index.js",
  "types": "dist/index.d.ts"
}
```

There are no subpath exports like `"./poa"`. No action needed on package.json.

---

## 4. Test File Audit

File: `C:\Users\globa\physical-capability-cloud\packages\verifier\src\poa\__tests__\poa-bridge.test.ts`
Lines: 693

### Test suites (6 describe blocks, ~28 test cases)

| Describe | Test count | Coverage |
|----------|-----------|----------|
| `POABridge -- createCPC` | 5 | Nonce generation, step mapping, custom types, constraints, input passthrough |
| `POABridge -- submitEvidence` | 5 | Hash chain build, determinism, nonce reflection, trace mapping, task ID, miner hotkey |
| `POABridge -- verify` | 7 | Valid pass, wrong task ID, broken hash chain, wrong nonce, timestamp ordering, missing step, empty trace, chain length mismatch |
| `POABridge -- score` | 7 | Dimension weights, weight sum, perfect score, score range, partial completeness, hash chain penalty, task ID mismatch penalty |
| `POABridge -- mapToAssuranceTier` | 5 | Tier boundaries (0.0, 0.49, 0.5, 0.7, 0.9, 1.0) |
| `POABridge -- full pipeline` | 4 | End-to-end flow, failed verification score, mock vs prod mode, DEFAULT_SCORING_WEIGHTS values |

All imports in the test file are relative (`../poa-bridge.js`, `../types.js`). No other test file anywhere in the monorepo references these POA types.

**Action**: The entire `__tests__/` directory inside `poa/` is deleted with the parent directory.

---

## 5. Documentation References

### Search results

| File | Reference | Action |
|------|-----------|--------|
| `ai/research/digital-verifier/02-workflow-steps.md` line 22 | "We do not adopt any vocabulary from Provenonce PoA's `CanonicalPathContract`..." | **Keep as-is.** This is a design decision document that explains *why* PCC rejected PoA naming. The reference is to the external PoA repo, not to the deleted code. Still valid after deletion. |
| `ai/research/digital-verifier/01-touchstone.md` line 163 | "PoA's implementation at `C:\Users\globa\scratch\poa-subnet\anti_gaming\canary.py` is the right *idea*..." | **Keep as-is.** References the external PoA codebase as prior art, not the deleted bridge. |
| `docs/EXECUTION_CALENDAR.md` line 46 | "Outreach: Contact POA/Provenonce team about integration partnership" | **Keep as-is.** This is a to-do item about business outreach, not a code reference. The deletion of local bridge code doesn't affect outreach plans. |

**No markdown files anywhere reference `POABridge`, `CPCTask`, `poa-bridge`, or any of the deleted symbols.** The only PoA/Provenonce mentions are about the external project as prior art.

---

## 6. Git History Check

Single commit created the entire directory:

```
a64bde0 PL Genesis hackathon: full sovereign infrastructure + real chain deployment
```

No git tags exist in the repository. No CHANGELOG file references POA or poa. The code was added as part of a large hackathon commit and never evolved.

---

## 7. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Hidden circular import | None | N/A | Grep confirms zero imports from outside `poa/` |
| Type-only import that compiler elides | None | N/A | No downstream file imports any POA type |
| Downstream `@pcc/verifier/poa` subpath import | None | N/A | No `exports` field in package.json; grep confirms zero subpath imports |
| Published package consumers | None | N/A | Package is `"private": true`, never published to npm |
| `dist/poa/` artifacts confuse tooling | Negligible | Low | `pnpm build` regenerates dist; old files harmless but `pnpm clean` before rebuild is cleaner |
| Build break in other packages | None | N/A | No other package depends on POA exports |
| Test count regression | Expected | Low | 28 tests removed, but they only test deleted code |

**Overall risk: Negligible.** This is textbook dead code removal with zero consumers.

---

## 8. Rollback Plan

If an unexpected consumer is discovered after deletion:

1. `git revert HEAD` (assuming the deletion is its own commit) restores all files instantly.
2. If the deletion is part of a larger commit, extract the POA files from the pre-deletion commit:
   ```bash
   git checkout HEAD~1 -- packages/verifier/src/poa/
   git checkout HEAD~1 -- packages/verifier/src/index.ts
   ```
3. Re-add the barrel export block to `packages/verifier/src/index.ts` at the end of the file.

The rollback is trivial because (a) git tracks everything and (b) no other file needs modification to restore the exports.

---

## 9. Replacement Documentation

### Commit message

```
refactor(verifier): remove dead POABridge research code

POABridge (574 lines + 693 lines tests) was a 2026-03-18 research
exercise mapping Provenonce PoA primitives onto PCC types. It has zero
consumers outside its own directory. The digital-verifier foundation
work (reports 01-06 in ai/research/digital-verifier/) defines the
replacement: WorkflowVerifier with PCC-native naming (workflow steps,
challenge anchors, touchstone tasks) instead of PoA's CPC/EEB/ASO
vocabulary.

Deletion verified by full monorepo grep: no imports of POABridge,
CPCTask, POAEvidenceBundle, or any symbol from ./poa/ exist outside
packages/verifier/src/poa/ and its barrel re-export.
```

### CHANGELOG entry (if a CHANGELOG is ever created)

```
### Removed
- `POABridge` class and all associated types (`CPCTask`, `EvidenceBundle`,
  `AssuranceScore`, etc.) from `@pcc/verifier`. These were research-only
  mappings of Provenonce PoA protocol types, never consumed by any PCC
  component. Replaced by the digital-verifier WorkflowVerifier architecture.
```

---

## 10. Exact Deletion Sequence

The following steps are designed to be executed verbatim by the Wave 5 implementer agent.

### Step 1: Remove barrel export from `packages/verifier/src/index.ts`

Delete lines 99-116 (the entire `export { ... } from "./poa/index.js"` block). The block to remove is:

```typescript
export {
  POABridge,
  type CreateCPCParams,
  type SubmitEvidenceParams,
  type CPCTask,
  type CPCTaskType,
  type CPCWorkflowStep,
  type CPCTaskConstraints,
  type POAEvidenceBundle,
  type TraceEntry,
  type ExecutionTimestamps,
  type AssuranceScore,
  type ScoreDimension,
  type POABridgeConfig,
  type POAVerificationResult,
  DEFAULT_POA_BRIDGE_CONFIG,
  DEFAULT_SCORING_WEIGHTS,
} from "./poa/index.js";
```

### Step 2: Delete the `poa/` directory

```bash
rm -rf packages/verifier/src/poa/
```

This removes:
- `packages/verifier/src/poa/index.ts` (29 lines)
- `packages/verifier/src/poa/types.ts` (155 lines)
- `packages/verifier/src/poa/poa-bridge.ts` (575 lines)
- `packages/verifier/src/poa/__tests__/poa-bridge.test.ts` (693 lines)

### Step 3: Clean dist artifacts

```bash
rm -rf packages/verifier/dist/poa/
```

### Step 4: Rebuild the verifier package

```bash
spark-run "cd ~/projects/physical-capability-cloud && pnpm --filter @pcc/verifier build"
```

**Expected**: Clean build, zero errors. The barrel export no longer references `./poa/index.js`.

### Step 5: Run verifier tests

```bash
spark-run "cd ~/projects/physical-capability-cloud && pnpm --filter @pcc/verifier test"
```

**Expected**: All remaining tests pass. Test count drops by ~28 (the POABridge tests). `--passWithNoTests` flag in the test script means the test runner won't fail if there happen to be zero remaining tests in any sub-path.

### Step 6: Full monorepo typecheck

```bash
spark-run "cd ~/projects/physical-capability-cloud && pnpm -r run typecheck"
```

**Expected**: Zero type errors. No other package imports any POA symbol.

### Step 7: Commit

```bash
git add -A packages/verifier/src/poa/ packages/verifier/src/index.ts packages/verifier/dist/poa/
git commit -m "refactor(verifier): remove dead POABridge research code

POABridge (574 lines + 693 lines tests) was a 2026-03-18 research
exercise mapping Provenonce PoA primitives onto PCC types. It has zero
consumers outside its own directory. The digital-verifier foundation
work (reports 01-06 in ai/research/digital-verifier/) defines the
replacement: WorkflowVerifier with PCC-native naming (workflow steps,
challenge anchors, touchstone tasks) instead of PoA's CPC/EEB/ASO
vocabulary.

Deletion verified by full monorepo grep: no imports of POABridge,
CPCTask, POAEvidenceBundle, or any symbol from ./poa/ exist outside
packages/verifier/src/poa/ and its barrel re-export."
```

Note on git staging: `git add -A packages/verifier/src/poa/` will stage the *deletions* of those files. The `dist/poa/` deletion may or may not be tracked (check `.gitignore`). If `dist/` is gitignored, skip staging it.

### Step 8: Verify post-commit

```bash
git status
git diff --stat HEAD~1
```

Expected diff: ~1,452 lines deleted across 4 source files plus the barrel edit, plus dist artifacts if tracked.
