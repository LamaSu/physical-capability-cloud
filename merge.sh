#!/usr/bin/env bash
# Merge fix/bash-mechanical + fix/llm-linq-rewrite into a unified branch on
# Spark, run full topological build + tests, sync results back signal.
set -uo pipefail
LC_ALL=C; export LC_ALL

TARGET=$HOME/projects/pcc-integrated-7
BASH_BRANCH=fix/bash-mechanical-2026-05-29
LLM_BRANCH=fix/llm-linq-rewrite-2026-05-29
RUNID=$(date -u +%Y-%m-%dT%H-%M-%SZ)
MERGE_BRANCH=fix/lab-automation-trio-unified-$RUNID
STATUS=$TARGET/MERGE_STATUS.json
LOG=$TARGET/merge.log

phase() { printf '\n=== [%s] %s ===\n' "$(date -u +%H:%M:%S)" "$*"; }
write_status() {
  cat > "$STATUS" <<EOF
{"run_id":"$RUNID","updated":"$(date -u +%FT%TZ)","phase":"$1","status":"$2","note":"$3"}
EOF
}

cd "$TARGET" || { write_status init failed "no target dir"; exit 1; }

write_status init running "merge bash + llm branches → unified"
phase "INIT"
git fetch . "+$BASH_BRANCH:$BASH_BRANCH" "+$LLM_BRANCH:$LLM_BRANCH" 2>&1 | tail -3 || true

phase "create merge branch off bash-mechanical (smaller set of changes)"
git checkout -B "$MERGE_BRANCH" "$BASH_BRANCH" 2>&1 | tail -3

phase "merge llm-linq-rewrite (LINQ rewrite is large but in disjoint files)"
write_status merge running "merging $LLM_BRANCH"
if git merge --no-edit "$LLM_BRANCH" 2>&1 | tee -a "$LOG" | tail -10; then
  echo "merge clean"
else
  echo "merge has conflicts — listing:"
  git diff --name-only --diff-filter=U
  write_status merge blocked "merge conflicts — abort and report"
  git merge --abort
  exit 2
fi

write_status install running "pnpm install"
phase "pnpm install"
bash -lc 'pnpm install' 2>&1 | tee -a "$LOG" | tail -10

write_status build running "topological build (spec → kernel-sdk → trio)"
phase "topological build"
bash -lc 'pnpm --filter @pcc/spec --filter @pcc/kernel-sdk build' 2>&1 | tee -a "$LOG" | tail -5

BUILD_OK=0; BUILD_FAIL=0
for p in adapter-madsci kernel-automata-linq kernel-omniverse-sim prism-orchestrator; do
  echo "--- build @pcc/$p ---"
  bash -lc "pnpm --filter @pcc/$p build" 2>&1 | tee -a "$LOG" | tail -8
  ec=${PIPESTATUS[0]}
  if [ "$ec" -eq 0 ]; then BUILD_OK=$((BUILD_OK+1)); else BUILD_FAIL=$((BUILD_FAIL+1)); fi
done

write_status test running "test 4 trio packages"
phase "test"
TEST_OK=0; TEST_FAIL=0
TS=$TARGET/merge-test-summary.txt; : > "$TS"
for p in adapter-madsci kernel-automata-linq kernel-omniverse-sim prism-orchestrator; do
  echo "=== test @pcc/$p ===" | tee -a "$TS"
  bash -lc "pnpm --filter @pcc/$p test" 2>&1 | tee -a "$TS" | tail -12
  ec=${PIPESTATUS[0]}
  if [ "$ec" -eq 0 ]; then TEST_OK=$((TEST_OK+1)); echo "  OK"; else TEST_FAIL=$((TEST_FAIL+1)); echo "  FAIL"; fi
done

phase "commit unified branch"
git add -A 2>&1 | tail -2
git commit --allow-empty -m "fix(trio): unified merge of bash-mechanical + llm-linq-rewrite

bash side:
- kernel-omniverse-sim: DigitalWorkflowStep type fix (stepType + dependsOn),
  default python interpreter → python3 (Linux)
- prism-orchestrator: tweetnacl + @types/node devDeps; README clarification
  that upstream PRISM is 3-stage planner-critique-validation loop and our
  package is a 5-stage on-chain wrap of that loop

llm side:
- kernel-automata-linq: complete rewrite per Automata dossier
  - Auth0 client-credentials flow (LINQ_CLIENT_ID + LINQ_CLIENT_SECRET)
  - snake_case verb methods (get_workcells, start_workflow, respond_to_error, ...)
  - 5 typed Hook payload classes (RunStateChangeHook, TaskStateChangeHook,
    SafetyStateChangeHook, LabwareMovementHook, NewPlanHook) with zod schemas
  - DigitalWorkflowStep type fix
  - Contact: hello@automata.tech

Build: $BUILD_OK/$((BUILD_OK+BUILD_FAIL)) green
Tests: $TEST_OK/$((TEST_OK+TEST_FAIL)) green" 2>&1 | tail -5

phase "summary"
echo "Branch: $MERGE_BRANCH"
echo "Build: $BUILD_OK/$((BUILD_OK+BUILD_FAIL)) green"
echo "Test:  $TEST_OK/$((TEST_OK+TEST_FAIL)) green"

if [ "$BUILD_FAIL" -eq 0 ] && [ "$TEST_FAIL" -eq 0 ]; then
  write_status done success "build $BUILD_OK/$BUILD_OK | tests $TEST_OK/$TEST_OK | branch $MERGE_BRANCH"
elif [ "$BUILD_FAIL" -gt 0 ]; then
  write_status done partial "build failed: $BUILD_FAIL packages | branch $MERGE_BRANCH"
else
  write_status done partial "tests failed: $TEST_FAIL packages | branch $MERGE_BRANCH"
fi
phase "FINISHED — STATUS at $STATUS"
