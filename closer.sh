#!/usr/bin/env bash
# Spark-side closer — finalizes the merge, runs full topological build + test,
# writes results to disk. Launched via setsid + nohup + </dev/null + & so it
# survives ssh disconnect AND tablet close.
set -uo pipefail
LC_ALL=C; export LC_ALL

TARGET=$HOME/projects/pcc-integrated-7
STATUS=$TARGET/CLOSER_STATUS.json
LOG=$TARGET/closer.log

phase() { printf '\n=== [%s] %s ===\n' "$(date -u +%H:%M:%S)" "$*"; }
write_status() {
  cat > "$STATUS" <<EOF
{"updated":"$(date -u +%FT%TZ)","phase":"$1","status":"$2","note":"$3","log":"$LOG"}
EOF
}

cd "$TARGET" || { write_status init failed "no target dir"; exit 1; }

# Set git identity (avoid "could not read identity" errors)
git config user.email spark-orchestrator@local 2>/dev/null || true
git config user.name "spark-orchestrator" 2>/dev/null || true

write_status "finalize-merge" "running" "completing the trio merge"
phase "FINALIZE MERGE"
# Stage everything, finalize merge commit if mid-merge, else just commit
git add -A 2>&1 | tail -2
if [ -f .git/MERGE_HEAD ]; then
  echo "in mid-merge — finishing"
  git commit --no-edit 2>&1 | tail -5 || git commit -m "fix(trio): merge fix/bash-mechanical + fix/llm-linq-rewrite" 2>&1 | tail -5
else
  echo "no MERGE_HEAD — likely already committed; recording lockfile commit"
  git commit -m "fix(lockfile): regenerate pnpm-lock after trio merge" 2>&1 | tail -3 || echo "(nothing to commit)"
fi
echo "current branch: $(git branch --show-current)"
git log --oneline -5

write_status "build-deps" "running" "topological build of workspace deps"
phase "BUILD WORKSPACE DEPS"
bash -lc 'pnpm --filter @pcc/spec --filter @pcc/kernel-sdk build' 2>&1 | tail -5

write_status "build-trio" "running" "build 4 trio packages"
phase "BUILD TRIO"
BUILD_OK=0; BUILD_FAIL=0
BUILD_REPORT=$TARGET/closer-build-report.txt
: > "$BUILD_REPORT"
for p in adapter-madsci kernel-automata-linq kernel-omniverse-sim prism-orchestrator; do
  echo "=== build @pcc/$p ===" | tee -a "$BUILD_REPORT"
  bash -lc "pnpm --filter @pcc/$p build" 2>&1 | tee -a "$BUILD_REPORT" | tail -8
  ec=${PIPESTATUS[0]}
  if [ "$ec" -eq 0 ]; then BUILD_OK=$((BUILD_OK+1)); echo "  exit=$ec OK" | tee -a "$BUILD_REPORT"; else BUILD_FAIL=$((BUILD_FAIL+1)); echo "  exit=$ec FAIL" | tee -a "$BUILD_REPORT"; fi
done

write_status "test-trio" "running" "test 4 trio packages"
phase "TEST TRIO"
TEST_OK=0; TEST_FAIL=0
TEST_REPORT=$TARGET/closer-test-report.txt
: > "$TEST_REPORT"
for p in adapter-madsci kernel-automata-linq kernel-omniverse-sim prism-orchestrator; do
  echo "=== test @pcc/$p ===" | tee -a "$TEST_REPORT"
  bash -lc "pnpm --filter @pcc/$p test" 2>&1 | tee -a "$TEST_REPORT" | tail -10
  ec=${PIPESTATUS[0]}
  if [ "$ec" -eq 0 ]; then TEST_OK=$((TEST_OK+1)); echo "  exit=$ec OK" | tee -a "$TEST_REPORT"; else TEST_FAIL=$((TEST_FAIL+1)); echo "  exit=$ec FAIL" | tee -a "$TEST_REPORT"; fi
done

phase "COMMIT VERIFICATION"
git add -A 2>&1 | tail -2
git commit --allow-empty -m "verify(trio): build $BUILD_OK/$((BUILD_OK+BUILD_FAIL)) | test $TEST_OK/$((TEST_OK+TEST_FAIL))" 2>&1 | tail -3 || echo "(nothing to commit)"

# Compose final status
phase "FINAL SUMMARY"
{
  echo "BRANCH: $(git branch --show-current)"
  echo "HEAD:   $(git log --oneline -1)"
  echo "BUILD:  $BUILD_OK/$((BUILD_OK+BUILD_FAIL))"
  echo "TEST:   $TEST_OK/$((TEST_OK+TEST_FAIL))"
} > "$TARGET/CLOSER_SUMMARY.txt"
cat "$TARGET/CLOSER_SUMMARY.txt"

if [ "$BUILD_FAIL" -eq 0 ] && [ "$TEST_FAIL" -eq 0 ]; then
  write_status "done" "success" "build $BUILD_OK/$BUILD_OK | tests $TEST_OK/$TEST_OK | branch fix/lab-automation-trio-unified"
else
  write_status "done" "partial" "build $BUILD_OK/$((BUILD_OK+BUILD_FAIL)) test $TEST_OK/$((TEST_OK+TEST_FAIL))"
fi

phase "FINISHED — TABLET CAN CLOSE"
