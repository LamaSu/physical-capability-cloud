/**
 * Demo fixtures for the System Dashboard (pages/SystemDashboardPage.tsx).
 *
 * Sample values, not PCC state. The page renders them only in demo mode
 * (lib/demo-mode.ts), under a DemoBanner. Before implementer-charlie moved them
 * here, the page showed these as the platform's state whenever
 * /api/telemetry/system failed: 347 routes, 3300 tests, a 1.50% fee, 154
 * agent tools and a Base Sepolia contract address.
 */

import type { PrototypeSystemPayload } from "../pages/SystemDashboardPage.js";

/** The sample overview the prototype cards render in demo mode. */
export function demoSystemTelemetry(now: number = Date.now()): PrototypeSystemPayload {
  return {
    timestamp: new Date(now).toISOString(),
    protocol: { feeBps: 150, feeRecipient: "0x0000000000000000000000000000000000000000", totalFeesCollected: "0.00" },
    escrow: { totalEscrows: 0, totalVolume: "0.00" },
    marketplace: { listingsCount: 0, orderCount: 0, categoryCount: 0 },
    chains: [
      { name: "Base Sepolia", contractAddress: "0x9e81f5fd7cfa08e2a6a2a0a0128498bf8fd66454", status: "active" },
      { name: "Flow EVM", contractAddress: null, status: "pending" },
      { name: "Starknet", contractAddress: null, status: "pending" },
    ],
    operators: { registered: 0, activeKernels: 0, dhtPeers: 0, capabilityAnnouncements: 0 },
    gateway: { routeCount: 347, testCount: 3300, version: "2.0.0", uptimeSeconds: 0 },
    evidence: { bundlesStored: 0, bundlesEncrypted: 0, ipfsUploads: 0, zkProofsAnchored: 0 },
    storage: { storageMode: "mock", encryptionMode: "mock" },
    near: { quotes: 0, intentsSubmitted: 0, status: "mock" },
    agentPackage: { version: "2.0.0", toolCount: 154, lastUpdated: null },
    a2a: { conversations: 0, intentsProcessed: 0, toolCalls: 0 },
    jobs: { total: 0, pending: 0, active: 0, completed: 0, failed: 0 },
    sponsors: {
      storacha: "mock",
      starknet: "not-deployed",
      lit: "disabled",
      flow: "pending",
      near: "mock",
    },
  };
}
