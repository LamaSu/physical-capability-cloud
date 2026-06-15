/**
 * PCCProtocolV2 ABI — EAS-gated root protocol / escrow factory for PCC.
 *
 * V2 deploys EAS-gated MilestoneEscrowV2 instances via createEscrowV2. The
 * wire signature is IDENTICAL to V1's createEscrow(payer,arbiter,token,cwmId);
 * only the function NAME differs (and the deployed escrow is the EAS-gated V2
 * variant). The V2 factory threads its configured EAS address + schema UID +
 * authorized oracle into every escrow it constructs.
 *
 * This is a MINIMAL hand-authored surface — only the members the gateway needs:
 *   - createEscrowV2 (the per-job escrow factory call)
 *   - EscrowCreated event (receipt parsing: topics[1] = new escrow address)
 *   - protocolFeeBps / feeRecipient views (informational)
 *
 * Verbatim from packages/contracts/out/PCCProtocolV2.sol/PCCProtocolV2.json.
 * Deployment record: deployments/base-sepolia/PCCProtocolV2.json
 * (factory 0x39F6958b132c0972Ce8f5658A3F8F16491395642 on base-sepolia / 84532).
 */
export const PCCProtocolV2ABI = [
  // ── Factory: create an EAS-gated MilestoneEscrowV2 instance ──────────
  {
    name: "createEscrowV2",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "payer", type: "address" },
      { name: "arbiter", type: "address" },
      { name: "token", type: "address" },
      { name: "cwmId", type: "bytes32" },
    ],
    outputs: [{ name: "escrow", type: "address" }],
  },

  // ── Views (informational) ───────────────────────────────────────────
  {
    name: "protocolFeeBps",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "feeRecipient",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },

  // ── Events ──────────────────────────────────────────────────────────
  // Receipt parsing: `escrow` is the FIRST indexed param, so it lands in
  // topics[1] of the EscrowCreated log. payer/arbiter are topics[2]/topics[3].
  {
    name: "EscrowCreated",
    type: "event",
    inputs: [
      { name: "escrow", type: "address", indexed: true },
      { name: "payer", type: "address", indexed: true },
      { name: "arbiter", type: "address", indexed: true },
      { name: "token", type: "address", indexed: false },
      { name: "cwmId", type: "bytes32", indexed: false },
    ],
  },
  {
    name: "FeeCollected",
    type: "event",
    inputs: [
      { name: "escrow", type: "address", indexed: true },
      { name: "token", type: "address", indexed: true },
      { name: "fee", type: "uint256", indexed: false },
    ],
  },
] as const;
