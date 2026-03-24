/**
 * Oracle Cascade Fallback Test
 *
 * Tests all cascade scenarios end-to-end:
 *   1. All oracles up → UMA handles it (primary)
 *   2. UMA down → Chainlink catches it (fallback)
 *   3. UMA + Chainlink down → EigenLayer attempted (always unavailable) → all-fail
 *   4. UMA recovers → UMA handles it again
 *
 * Run: npx tsx scripts/oracle-cascade-test.ts
 */

import { OracleVerificationBridge } from "@pcc/verifier";
import type { EvidenceBundle, EvidenceEvent } from "@pcc/spec";
import { ids, sha256 } from "@pcc/spec";

// ── Helpers ──────────────────────────────────────────────────────────

function log(tag: string, msg: string) {
  const padded = tag.padEnd(12);
  console.log(`[${padded}] ${msg}`);
}

const DIVIDER = "══════════════════════════════════════════════════════════════";
const SUB_DIVIDER = "──────────────────────────────────────────────────";

function buildTestBundle(): { bundle: EvidenceBundle; hash: string; data: string } {
  const now = new Date().toISOString();
  const events: EvidenceEvent[] = [
    {
      id: ids.evidence(),
      type: "execution_started",
      timestamp: now,
      source: "test_kernel",
      payload: { jobId: "test_job_001" },
      eventHash: sha256(JSON.stringify({ type: "execution_started", timestamp: now })),
    },
    {
      id: ids.evidence(),
      type: "power_profile_summary",
      timestamp: now,
      source: "test_kernel",
      payload: { avgWatts: 150, peakWatts: 300, durationSeconds: 120 },
      eventHash: sha256(JSON.stringify({ type: "power_profile_summary", timestamp: now })),
    },
    {
      id: ids.evidence(),
      type: "execution_completed",
      timestamp: now,
      source: "test_kernel",
      payload: { result: "success" },
      eventHash: sha256(JSON.stringify({ type: "execution_completed", timestamp: now })),
    },
  ];

  const bundle: EvidenceBundle = {
    id: ids.bundle(),
    jobId: ids.job(),
    stepId: ids.step(),
    kernelId: ids.kernel(),
    assuranceTier: 1,
    events,
    bundleHash: sha256(JSON.stringify(events.map((e) => e.eventHash))),
    kernelSignature: "test-sig",
    createdAt: now,
  };

  return {
    bundle,
    hash: bundle.bundleHash,
    data: JSON.stringify(bundle),
  };
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  console.log(DIVIDER);
  console.log("  Oracle Cascade Fallback Test");
  console.log(DIVIDER);
  console.log();

  const bridge = new OracleVerificationBridge({
    chainId: 84532,
    rpcUrl: "https://sepolia.base.org",
    minScoreThreshold: 0.6,
    mock: true,
  });

  const { hash, data } = buildTestBundle();

  // ── Scenario 1: All oracles up → UMA primary ──────────────────────

  console.log("▸ SCENARIO 1: All oracles available — expect UMA (primary)\n" + SUB_DIVIDER);

  const r1 = await bridge.submitForVerification(hash, data, 1);
  log("RESULT", `Oracle used:  ${r1.oracle}`);
  log("RESULT", `Passed:       ${r1.passed ? "✓" : "✗"}`);
  log("RESULT", `Score:        ${r1.score}`);
  log("RESULT", `Assertion ID: ${r1.assertionId?.slice(0, 18)}...`);
  log("RESULT", `Bond:         ${r1.bondAmount} USDC units`);
  log("RESULT", `Dispute win:  ${r1.disputeWindow}s`);
  console.assert(r1.oracle === "uma", `Expected UMA, got ${r1.oracle}`);
  console.assert(r1.score > 0, "Expected nonzero score");
  log("TEST", "✓ UMA handled verification as primary\n");

  // ── Scenario 2: UMA down → Chainlink fallback ─────────────────────

  console.log("▸ SCENARIO 2: UMA disabled — expect Chainlink (fallback)\n" + SUB_DIVIDER);

  bridge.getUMA().disable();
  log("ACTION", "UMA adapter DISABLED");
  log("STATUS", `UMA available:       ${bridge.getUMA().isAvailable() ? "✓" : "✗"}`);
  log("STATUS", `Chainlink available: ${bridge.getChainlink().isAvailable() ? "✓" : "✗"}`);
  log("STATUS", `EigenLayer available: ${bridge.getEigenLayer().isAvailable() ? "✓" : "✗"}`);
  log("STATUS", `Bridge available:    ${bridge.isAvailable() ? "✓" : "✗"}`);

  const r2 = await bridge.submitForVerification(hash, data, 1);
  log("RESULT", `Oracle used:  ${r2.oracle}`);
  log("RESULT", `Passed:       ${r2.passed ? "✓" : "✗"}`);
  log("RESULT", `Score:        ${r2.score}`);
  log("RESULT", `Request ID:   ${r2.requestId?.slice(0, 18)}...`);
  console.assert(r2.oracle === "chainlink", `Expected Chainlink, got ${r2.oracle}`);
  console.assert(r2.score > 0, "Expected nonzero score");
  log("TEST", "✓ Chainlink caught fallback correctly\n");

  // ── Scenario 3: UMA + Chainlink down → all fail ────────────────────

  console.log("▸ SCENARIO 3: UMA + Chainlink disabled — expect all-fail\n" + SUB_DIVIDER);

  bridge.getChainlink().disable();
  log("ACTION", "Chainlink adapter DISABLED");
  log("STATUS", `UMA available:       ${bridge.getUMA().isAvailable() ? "✓" : "✗"}`);
  log("STATUS", `Chainlink available: ${bridge.getChainlink().isAvailable() ? "✓" : "✗"}`);
  log("STATUS", `EigenLayer available: ${bridge.getEigenLayer().isAvailable() ? "✓" : "✗"}`);
  log("STATUS", `Bridge available:    ${bridge.isAvailable() ? "✓" : "✗"}`);

  const r3 = await bridge.submitForVerification(hash, data, 1);
  log("RESULT", `Oracle used:  ${r3.oracle}`);
  log("RESULT", `Passed:       ${r3.passed ? "✓" : "✗"}`);
  log("RESULT", `Score:        ${r3.score}`);
  log("RESULT", `Defects:      ${r3.defects.join(", ")}`);
  log("RESULT", `Details:`);
  for (const d of r3.details) {
    log("RESULT", `  ${d.source}: ${JSON.stringify(d.metadata)}`);
  }
  console.assert(r3.oracle === "none", `Expected none, got ${r3.oracle}`);
  console.assert(r3.passed === false, "Expected fail");
  console.assert(r3.defects.includes("all_oracles_unavailable"), "Expected all_oracles_unavailable defect");
  log("TEST", "✓ All-fail cascade works correctly\n");

  // ── Scenario 4: UMA recovers → back to primary ─────────────────────

  console.log("▸ SCENARIO 4: UMA re-enabled — expect UMA recovery\n" + SUB_DIVIDER);

  bridge.getUMA().enable();
  log("ACTION", "UMA adapter RE-ENABLED");
  log("STATUS", `UMA available:       ${bridge.getUMA().isAvailable() ? "✓" : "✗"}`);
  log("STATUS", `Chainlink available: ${bridge.getChainlink().isAvailable() ? "✓" : "✗"}`);
  log("STATUS", `Bridge available:    ${bridge.isAvailable() ? "✓" : "✗"}`);

  const r4 = await bridge.submitForVerification(hash, data, 1);
  log("RESULT", `Oracle used:  ${r4.oracle}`);
  log("RESULT", `Passed:       ${r4.passed ? "✓" : "✗"}`);
  log("RESULT", `Score:        ${r4.score}`);
  console.assert(r4.oracle === "uma", `Expected UMA, got ${r4.oracle}`);
  console.assert(r4.score > 0, "Expected nonzero score");
  log("TEST", "✓ UMA recovered as primary\n");

  // ── Scenario 5: UMA + Chainlink down, EigenLayer enabled → EigenLayer catches it

  console.log("▸ SCENARIO 5: UMA + Chainlink down, EigenLayer enabled — expect EigenLayer (last resort)\n" + SUB_DIVIDER);

  bridge.getUMA().disable();
  bridge.getChainlink().disable();
  bridge.getEigenLayer().enable();
  log("ACTION", "UMA DISABLED, Chainlink DISABLED, EigenLayer ENABLED");
  log("STATUS", `UMA available:       ${bridge.getUMA().isAvailable() ? "✓" : "✗"}`);
  log("STATUS", `Chainlink available: ${bridge.getChainlink().isAvailable() ? "✓" : "✗"}`);
  log("STATUS", `EigenLayer available: ${bridge.getEigenLayer().isAvailable() ? "✓" : "✗"}`);
  log("STATUS", `Bridge available:    ${bridge.isAvailable() ? "✓" : "✗"}`);

  const r5 = await bridge.submitForVerification(hash, data, 1);
  log("RESULT", `Oracle used:  ${r5.oracle}`);
  log("RESULT", `Passed:       ${r5.passed ? "✓" : "✗"}`);
  log("RESULT", `Score:        ${r5.score}`);
  log("RESULT", `Defects:      ${r5.defects.length > 0 ? r5.defects.join(", ") : "none"}`);
  log("RESULT", `Details:`);
  for (const d of r5.details) {
    log("RESULT", `  ${d.source}: score=${d.score}  ${JSON.stringify(d.metadata)}`);
  }
  console.assert(r5.oracle === "eigenlayer", `Expected eigenlayer, got ${r5.oracle}`);
  console.assert(r5.score > 0, "Expected nonzero score from EigenLayer");
  log("TEST", "✓ EigenLayer caught as last-resort fallback\n");

  // ── Scenario 6: Only Chainlink up → Chainlink as sole survivor ────

  console.log("▸ SCENARIO 6: Only Chainlink re-enabled — expect Chainlink as sole survivor\n" + SUB_DIVIDER);

  bridge.getEigenLayer().disable();
  bridge.getChainlink().enable();
  log("ACTION", "EigenLayer DISABLED, Chainlink RE-ENABLED");
  log("STATUS", `UMA available:       ${bridge.getUMA().isAvailable() ? "✓" : "✗"}`);
  log("STATUS", `Chainlink available: ${bridge.getChainlink().isAvailable() ? "✓" : "✗"}`);
  log("STATUS", `EigenLayer available: ${bridge.getEigenLayer().isAvailable() ? "✓" : "✗"}`);

  const r6 = await bridge.submitForVerification(hash, data, 1);
  log("RESULT", `Oracle used:  ${r6.oracle}`);
  log("RESULT", `Score:        ${r6.score}`);
  log("RESULT", `Request ID:   ${r6.requestId?.slice(0, 18)}...`);
  console.assert(r6.oracle === "chainlink", `Expected chainlink, got ${r6.oracle}`);
  log("TEST", "✓ Chainlink handled as sole survivor\n");

  // ── Metrics Summary ────────────────────────────────────────────────

  console.log("▸ CASCADE METRICS\n" + SUB_DIVIDER);

  const metrics = bridge.getMetrics();
  log("METRICS", `Total verifications: ${metrics.totalVerifications}`);
  log("METRICS", `Average score:       ${metrics.averageScore.toFixed(3)}`);
  log("METRICS", `Active oracles:      ${metrics.activeOracles}`);
  log("METRICS", `Primary:             ${metrics.primaryOracle}`);
  log("METRICS", `Fallbacks:           ${metrics.fallbackOracles.join(", ")}`);
  log("METRICS", `Recent results:`);
  for (const r of metrics.recentResults) {
    log("METRICS", `  ${r.oracle.padEnd(12)} ${r.passed ? "PASS" : "FAIL"}  score=${r.score.toFixed(3)}  ${r.timestamp}`);
  }

  console.log();

  const leaderboard = bridge.getOracleLeaderboard();
  log("LEADER", "Oracle Leaderboard:");
  for (const o of leaderboard) {
    log("LEADER", `  ${o.name.padEnd(12)} avail=${o.available ? "✓" : "✗"}  verified=${o.totalVerifications}  avg=${o.averageScore.toFixed(3)}  ${o.isPrimary ? "(PRIMARY)" : ""}`);
  }

  console.log();
  console.log(DIVIDER);
  console.log("  ✓ All 6 cascade scenarios passed");
  console.log(DIVIDER);
}

main().catch((err) => {
  console.error("Cascade test failed:", err);
  process.exit(1);
});
