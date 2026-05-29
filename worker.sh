#!/usr/bin/env bash
# Spark worker A — mechanical fixes via plain bash. Survives ssh disconnect
# (setsid + nohup + </dev/null + & at launch).
set -uo pipefail
LC_ALL=C; export LC_ALL

WORK=$HOME/projects/pcc-fix-bash-2026-05-29
STATUS=$WORK/STATUS.json
LOG=$WORK/run.log
STARTED=$(date -u +%FT%TZ)

write_status() {
  cat > "$STATUS" <<EOF
{"started":"$STARTED","updated":"$(date -u +%FT%TZ)","phase":"$1","status":"$2","note":"$3","log":"$LOG"}
EOF
}

phase() { printf '\n=== [%s] %s ===\n' "$(date -u +%H:%M:%S)" "$*"; }

cd "$WORK" || { write_status init failed "cwd missing"; exit 1; }
write_status "init" "running" "bash worker on Spark — mechanical fixes"
phase "INIT"

# A2: Fix kernel-omniverse-sim/src/kernel.ts (DigitalWorkflowStep type)
phase "A2 — patch kernel-omniverse-sim kernel.ts"
python3 <<'PY'
p = "packages/kernel-omniverse-sim/src/kernel.ts"
s = open(p).read()
old = '''    workflowSteps: [
      {
        stepId: "sim-attest",
        name: "Simulate workflow",
        description:
          "Replay MADSci workflow against a USD scene in headless Omniverse Kit",
      },
    ],'''
new = '''    workflowSteps: [
      {
        stepId: "sim-attest",
        stepType: "validate",
        description:
          "Simulate workflow — replay MADSci workflow against a USD scene in headless Omniverse Kit",
        dependsOn: [],
      },
    ],'''
if old in s:
    s = s.replace(old, new)
    open(p,"w").write(s)
    print("PATCHED kernel.ts")
else:
    print("PATTERN NOT FOUND in kernel.ts — sniffing actual content...")
    import re
    m = re.search(r'workflowSteps:\s*\[(.+?)\],', s, re.S)
    if m:
        print("found block:")
        print(m.group(0)[:400])
PY

# A3: kernel-omniverse-sim runner.test.ts uses python3, not python
phase "A3 — patch runner.test.ts to use python3"
python3 <<'PY'
p = "packages/kernel-omniverse-sim/src/__tests__/runner.test.ts"
s = open(p).read()
patches = [
    ('await detectCapabilities({\n      helperPath: HELPER,\n      env: { OMNIVERSE_AVAILABLE: "0" },\n    });',
     'await detectCapabilities({\n      python: "python3",\n      helperPath: HELPER,\n      env: { OMNIVERSE_AVAILABLE: "0" },\n    });'),
    ('const result = await runSim(WORKFLOW, {\n      helperPath: HELPER,\n      env: { OMNIVERSE_AVAILABLE: "0" },\n    });',
     'const result = await runSim(WORKFLOW, {\n      python: "python3",\n      helperPath: HELPER,\n      env: { OMNIVERSE_AVAILABLE: "0" },\n    });'),
]
patched = 0
for old, new in patches:
    if old in s:
        s = s.replace(old, new); patched += 1
open(p,"w").write(s)
print(f"PATCHED runner.test.ts ({patched} sites)")
PY

# A4: prism-orchestrator/package.json — add tweetnacl + @types/node devDeps
phase "A4 — add tweetnacl + @types/node to prism-orchestrator devDeps"
python3 <<'PY'
import json
p = "packages/prism-orchestrator/package.json"
d = json.load(open(p))
d.setdefault("devDependencies", {})
d["devDependencies"]["tweetnacl"] = "^1.0.3"
d["devDependencies"]["@types/node"] = "^20.0.0"
with open(p, "w") as f:
    json.dump(d, f, indent=2)
    f.write("\n")
print("ADDED devDeps")
PY

# A5: prism-orchestrator README — clarify 3-stage upstream PRISM vs our 5-stage PCC pipeline
phase "A5 — patch prism-orchestrator README (3 stages upstream / 5 stages on PCC)"
python3 <<'PY'
p = "packages/prism-orchestrator/README.md"
s = open(p).read()
old = '# @pcc/prism-orchestrator\n\nEnd-to-end PRISM-style pipeline on PCC. Models [github.com/ramanathanlab/PRISM](https://github.com/ramanathanlab/PRISM) (Argonne, MIT) as a 5-stage state machine wired against PCC primitives.'
new = '''# @pcc/prism-orchestrator

End-to-end PRISM-style pipeline on PCC. The canonical upstream PRISM
([github.com/ramanathanlab/PRISM](https://github.com/ramanathanlab/PRISM), Argonne, MIT) is a **3-stage** planner-critique-validation loop. This package wires that loop into a **5-stage on-chain state machine** by adding escrow + execute + settle stages around it.'''
if old in s:
    s = s.replace(old, new)
    open(p,"w").write(s)
    print("PATCHED README")
else:
    print("README pattern not found — head:")
    print(s[:600])
PY

# Install + build + test
write_status "install" "running" "pnpm install"
phase "pnpm install"
bash -lc 'pnpm install' 2>&1 | tail -15
echo "install exit: ${PIPESTATUS[0]}"

write_status "build" "running" "pnpm -r build (3 packages)"
phase "pnpm build (adapter-madsci → kernel-omniverse-sim → prism-orchestrator)"
BUILD_OK=0; BUILD_FAIL=0
for p in adapter-madsci kernel-omniverse-sim prism-orchestrator; do
  echo "--- build @pcc/$p ---"
  bash -lc "pnpm --filter @pcc/$p build" 2>&1 | tail -10
  ec=${PIPESTATUS[0]}
  if [ "$ec" -eq 0 ]; then BUILD_OK=$((BUILD_OK+1)); else BUILD_FAIL=$((BUILD_FAIL+1)); fi
  echo "  exit=$ec"
done
echo "build: $BUILD_OK ok / $BUILD_FAIL fail"

write_status "test" "running" "pnpm test (3 packages)"
phase "pnpm test"
TEST_OK=0; TEST_FAIL=0
TS=$WORK/test-summary.txt; : > "$TS"
for p in adapter-madsci kernel-omniverse-sim prism-orchestrator; do
  echo "=== test @pcc/$p ===" | tee -a "$TS"
  bash -lc "pnpm --filter @pcc/$p test" 2>&1 | tee -a "$TS" | tail -15
  ec=${PIPESTATUS[0]}
  if [ "$ec" -eq 0 ]; then TEST_OK=$((TEST_OK+1)); echo "  exit=$ec OK"; else TEST_FAIL=$((TEST_FAIL+1)); echo "  exit=$ec FAIL"; fi
done
echo "test: $TEST_OK ok / $TEST_FAIL fail"

# Commit on this worktree's branch
phase "git commit"
cd "$WORK"
git add -A 2>&1 | tail -3
git commit -m "fix(spark-bash): omniverse-sim DigitalWorkflowStep type+python3 tests; prism-orchestrator tweetnacl devDep + README 3-stage note" 2>&1 | tail -3 || echo "(nothing to commit)"

# Final status
if [ "$BUILD_FAIL" -eq 0 ] && [ "$TEST_FAIL" -eq 0 ]; then
  write_status "done" "success" "build_ok=$BUILD_OK test_ok=$TEST_OK"
else
  write_status "done" "partial" "build_ok=$BUILD_OK build_fail=$BUILD_FAIL test_ok=$TEST_OK test_fail=$TEST_FAIL — see run.log"
fi
phase "FINISHED — STATUS at $STATUS"
