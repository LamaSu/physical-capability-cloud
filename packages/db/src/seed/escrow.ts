import type { StoreDB } from "../connection.js";
import { escrows, escrowMilestones } from "../schema/index.js";

/**
 * Seeds escrows and milestones from gateway mock data.
 */
export function seedEscrow(db: StoreDB): void {
  // ── Escrows ─────────────────────────────────────────────────────

  db.insert(escrows)
    .values([
      {
        id: "esc-001",
        cwmId: "cwm-001",
        contractAddress: "0xESCROW_CONTRACT_001",
        payer: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        totalAmount: "77.00",
        currency: "USDC",
        status: "active",
        createdAt: "2026-03-09T12:00:00Z",
        deadline: "2026-03-20T00:00:00Z",
      },
      {
        id: "esc-002",
        cwmId: "cwm-002",
        contractAddress: "0xESCROW_CONTRACT_002",
        payer: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        totalAmount: "245.00",
        currency: "USDC",
        status: "active",
        createdAt: "2026-03-10T06:00:00Z",
        deadline: "2026-03-25T00:00:00Z",
      },
      {
        id: "esc-003",
        cwmId: "cwm-003",
        contractAddress: "0xESCROW_CONTRACT_003",
        payer: "0xcccccccccccccccccccccccccccccccccccccccc",
        totalAmount: "18.50",
        currency: "USDC",
        status: "funded",
        createdAt: "2026-03-10T09:00:00Z",
        deadline: "2026-03-22T00:00:00Z",
      },
    ])
    .run();

  // ── Milestones ──────────────────────────────────────────────────

  db.insert(escrowMilestones)
    .values([
      {
        id: "mile-001-1",
        escrowId: "esc-001",
        stepId: "step_fdm_print_01",
        amount: "50.00",
        status: "released",
        evidenceBundleHash: "0xabc123...",
        verifierAttestationHash: "0xdef456...",
        challengeWindowStart: "2026-03-09T14:00:00Z",
        challengeWindowEnd: "2026-03-09T15:00:00Z",
        bondAmount: "5.00",
      },
      {
        id: "mile-001-2",
        escrowId: "esc-001",
        stepId: "step_fdm_print_02",
        amount: "27.00",
        status: "releasing",
        evidenceBundleHash: "0x789abc...",
        verifierAttestationHash: "0x012def...",
        challengeWindowStart: new Date().toISOString(),
        challengeWindowEnd: new Date(Date.now() + 3600000).toISOString(),
        bondAmount: "2.70",
      },
      {
        id: "mile-002-1",
        escrowId: "esc-002",
        stepId: "step_cnc_mill_01",
        amount: "245.00",
        status: "released",
        evidenceBundleHash: "0xabc123...",
        verifierAttestationHash: "0xdef456...",
        challengeWindowStart: "2026-03-10T08:00:00Z",
        challengeWindowEnd: "2026-03-10T09:00:00Z",
        bondAmount: "12.25",
      },
    ])
    .run();
}
