/**
 * Verification Oracles demo fixtures: sample values, not live PCC state.
 *
 * Rendered only in demo mode (lib/demo-mode.ts), under a DemoBanner, by
 * pages/SubnetStatusPage.tsx. Before implementer-delta moved them here, the
 * page loaded these metrics and oracles on every visit and fell back to them
 * whenever it had no oracle list, so it always showed 1,247 verifications,
 * an average score of 0.873 and two active oracles.
 */

import type { OracleCascadeStatus } from "../pages/SubnetStatusPage.js";

export const DEMO_ORACLE_STATUS: OracleCascadeStatus = {
  available: true,
  metrics: {
    totalVerifications: 1_247,
    averageScore: 0.873,
    activeOracles: 2,
    recentResults: [
      { oracle: "uma", passed: true, score: 0.94, timestamp: new Date(Date.now() - 60_000).toISOString() },
      { oracle: "uma", passed: true, score: 0.88, timestamp: new Date(Date.now() - 180_000).toISOString() },
      { oracle: "chainlink", passed: true, score: 0.91, timestamp: new Date(Date.now() - 300_000).toISOString() },
      { oracle: "uma", passed: false, score: 0.41, timestamp: new Date(Date.now() - 600_000).toISOString() },
      { oracle: "uma", passed: true, score: 0.86, timestamp: new Date(Date.now() - 900_000).toISOString() },
    ],
  },
  oracles: [
    { name: "uma", available: true, totalVerifications: 1100, averageScore: 0.872, isPrimary: true },
    { name: "chainlink", available: true, totalVerifications: 147, averageScore: 0.881, isPrimary: false },
    { name: "eigenlayer", available: false, totalVerifications: 0, averageScore: 0, isPrimary: false },
  ],
};
