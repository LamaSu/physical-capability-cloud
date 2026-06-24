/**
 * V2 Settlement End-to-End SMOKE  (coord task: [LANE settlement-fix/globa], Q2.2)
 * =============================================================================
 * The V2-close acceptance gate. Drives one full EAS-gated settlement loop on
 * Base Sepolia and asserts the four refusal-reverts hold.
 *
 *   createEscrowV2 (factory 0x39F695…) → addMilestone → approve+fund
 *   → submitEvidence → oracle mints pcc.evidence.v1 (attester == authorizedOracle)
 *   → submitAttestation(easUid) → [challengeWindow=0] → release → operator PAID
 *
 * REFUSAL checks — each MUST revert (the security-review guards):
 *   - wrong evidenceBundleHash      → "Evidence mismatch"
 *   - wrong stepId            (C2b) → "stepId mismatch"
 *   - wrong recipient         (C2a) → "Wrong recipient"
 *   - UID replay              (C1)  → "Attestation already used"
 *
 * Idempotency: the happy path runs TWICE (fresh escrow each time); both settle.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * STATUS: WRITTEN, NOT RUN. On-chain execution is HALT-gated (coord R3) and
 * requires the oracle signer key + gas — all owner-side. This script is SAFE BY
 * DEFAULT: with no RUN_ONCHAIN=1 it prints the plan + the resolved config and
 * exits 0 WITHOUT touching the chain. Fire it only as part of the V2 deploy
 * runbook (C:\Users\globa\pcc-v2-deploy-runbook.md), after the HALT lifts.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Required env to actually run (RUN_ONCHAIN=1):
 *   BASE_RPC_URL                Base Sepolia JSON-RPC (default https://sepolia.base.org)
 *   ORACLE_PRIVATE_KEY          the authorizedOracle / EAS attester signer (0x…)
 *   PAYER_PRIVATE_KEY           buyer/payer + operator (funds escrow, receives payout)
 *   PCC_EVIDENCE_SCHEMA_UID     registered pcc.evidence.v1 schema UID (Step 1 of runbook)
 *   ESCROW_FACTORY_ADDRESS      PCCProtocolV2 factory (default: chain-config 0x39F695…)
 *   MOCK_USDC_ADDRESS           test token the payer holds (default: chain-config mockUSDC)
 *   ARBITER_ADDRESS             dispute arbiter (default: payer address)
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  parseUnits,
  keccak256,
  toBytes,
  encodeAbiParameters,
  decodeEventLog,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import {
  PCCProtocolV2ABI,
  MockUSDCABI,
  getContractAddress,
} from "@pcc/contracts";
import { MilestoneEscrowV2ABI } from "@pcc/contracts/abi";

// ── EAS (Base Sepolia predeploy) ─────────────────────────────────────────────
const EAS_ADDRESS: Address = "0x4200000000000000000000000000000000000021";

/** Minimal EAS surface: attest() + getAttestation() + the Attested event. */
const EAS_ABI = [
  {
    name: "attest",
    type: "function",
    stateMutability: "payable",
    inputs: [
      {
        name: "request",
        type: "tuple",
        components: [
          { name: "schema", type: "bytes32" },
          {
            name: "data",
            type: "tuple",
            components: [
              { name: "recipient", type: "address" },
              { name: "expirationTime", type: "uint64" },
              { name: "revocable", type: "bool" },
              { name: "refUID", type: "bytes32" },
              { name: "data", type: "bytes" },
              { name: "value", type: "uint256" },
            ],
          },
        ],
      },
    ],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    name: "Attested",
    type: "event",
    inputs: [
      { name: "recipient", type: "address", indexed: true },
      { name: "attester", type: "address", indexed: true },
      { name: "uid", type: "bytes32", indexed: false },
      { name: "schemaUID", type: "bytes32", indexed: true },
    ],
  },
] as const;

// pcc.evidence.v1 — FIELD ORDER IS LOAD-BEARING (mirrors MilestoneEscrowV2.sol's
// abi.decode + oracle-client.ts PCC_EVIDENCE_SCHEMA_PARAMS).
const EVIDENCE_SCHEMA_PARAMS = [
  { name: "jobId", type: "string" },
  { name: "kernelId", type: "bytes32" },
  { name: "evidenceBundleHash", type: "bytes32" },
  { name: "ipfsCid", type: "string" },
  { name: "assuranceTier", type: "uint8" },
  { name: "oracleVerified", type: "bool" },
  { name: "stepId", type: "bytes32" },
] as const;

interface EvidencePayload {
  jobId: string;
  kernelId: Hex;
  evidenceBundleHash: Hex;
  ipfsCid: string;
  assuranceTier: number;
  oracleVerified: boolean;
  stepId: Hex;
}

const b32 = (s: string): Hex => keccak256(toBytes(s));

// ── Config resolution (env → chain-config defaults) ──────────────────────────
function resolveConfig() {
  const rpc = process.env.BASE_RPC_URL ?? "https://sepolia.base.org";
  let factory: Address | undefined;
  let token: Address | undefined;
  try { factory = getContractAddress("base-sepolia", "milestoneEscrowFactoryV2"); } catch { /* env fallback */ }
  try { token = getContractAddress("base-sepolia", "mockUSDC"); } catch { /* env fallback */ }
  factory = (process.env.ESCROW_FACTORY_ADDRESS as Address) ?? factory;
  token = (process.env.MOCK_USDC_ADDRESS as Address) ?? token;
  return {
    rpc,
    factory,
    token,
    schemaUid: process.env.PCC_EVIDENCE_SCHEMA_UID as Hex | undefined,
    oracleKey: process.env.ORACLE_PRIVATE_KEY as Hex | undefined,
    payerKey: process.env.PAYER_PRIVATE_KEY as Hex | undefined,
    arbiter: process.env.ARBITER_ADDRESS as Address | undefined,
  };
}

// ── Result accounting ────────────────────────────────────────────────────────
const results: Array<{ name: string; ok: boolean; note: string }> = [];
function record(name: string, ok: boolean, note = "") {
  results.push({ name, ok, note });
  console.log(`  ${ok ? "✓" : "✗"} ${name}${note ? ` — ${note}` : ""}`);
}

async function main() {
  const cfg = resolveConfig();
  const run = process.env.RUN_ONCHAIN === "1";

  console.log("=== V2 Settlement Smoke (Q2.2 / V2-close gate) ===");
  console.log(`  factory     : ${cfg.factory ?? "(unresolved — set ESCROW_FACTORY_ADDRESS)"}`);
  console.log(`  token       : ${cfg.token ?? "(unresolved — set MOCK_USDC_ADDRESS)"}`);
  console.log(`  schemaUid   : ${cfg.schemaUid ?? "(unset — set PCC_EVIDENCE_SCHEMA_UID)"}`);
  console.log(`  EAS         : ${EAS_ADDRESS}`);
  console.log(`  RPC         : ${cfg.rpc}`);

  if (!run) {
    console.log(
      "\n[DRY-RUN] RUN_ONCHAIN!=1 — printing plan only, NO chain writes.\n" +
        "Plan: 2× { createEscrowV2 → addMilestone(tier0, window0) → approve+fund →\n" +
        "  submitEvidence → mint pcc.evidence.v1 (attester=oracle, recipient=escrow) →\n" +
        "  submitAttestation(uid) → release → assert operator balance +net } (idempotency),\n" +
        "then 4 refusal-reverts: bad evidenceHash / bad stepId / bad recipient / UID-replay.\n" +
        "Fire with RUN_ONCHAIN=1 + ORACLE_PRIVATE_KEY + PAYER_PRIVATE_KEY + PCC_EVIDENCE_SCHEMA_UID,\n" +
        "ONLY after the coord HALT lifts (per C:\\Users\\globa\\pcc-v2-deploy-runbook.md).",
    );
    return;
  }

  // ── Live mode: validate required secrets/config ────────────────────────────
  const missing = [
    !cfg.oracleKey && "ORACLE_PRIVATE_KEY",
    !cfg.payerKey && "PAYER_PRIVATE_KEY",
    !cfg.schemaUid && "PCC_EVIDENCE_SCHEMA_UID",
    !cfg.factory && "ESCROW_FACTORY_ADDRESS",
    !cfg.token && "MOCK_USDC_ADDRESS",
  ].filter(Boolean);
  if (missing.length) {
    throw new Error(`RUN_ONCHAIN=1 but missing: ${missing.join(", ")}`);
  }

  const oracle = privateKeyToAccount(cfg.oracleKey!);
  const payer = privateKeyToAccount(cfg.payerKey!);
  const arbiter = cfg.arbiter ?? payer.address;
  const transport = http(cfg.rpc);
  const pub = createPublicClient({ chain: baseSepolia, transport });
  const oracleWallet = createWalletClient({ account: oracle, chain: baseSepolia, transport });
  const payerWallet = createWalletClient({ account: payer, chain: baseSepolia, transport });

  console.log(`  oracle(attester): ${oracle.address}`);
  console.log(`  payer/operator  : ${payer.address}\n`);

  // ── Helpers ────────────────────────────────────────────────────────────────

  /** Deploy a fresh per-job escrow via the factory; return its address. */
  async function createEscrow(cwmSeed: string): Promise<Address> {
    const cwmId = b32(`smoke-${cwmSeed}-${Math.floor(performance.now())}`);
    const hash = await payerWallet.writeContract({
      address: cfg.factory!, abi: PCCProtocolV2ABI, functionName: "createEscrowV2",
      args: [payer.address, arbiter, cfg.token!, cwmId],
    });
    const receipt = await pub.waitForTransactionReceipt({ hash });
    for (const log of receipt.logs) {
      try {
        const d = decodeEventLog({ abi: PCCProtocolV2ABI, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
        if (d.eventName === "EscrowCreated") {
          const addr = (d.args as { escrow?: Address }).escrow;
          if (addr && addr !== zeroAddress) return addr;
        }
      } catch { /* not the EscrowCreated log */ }
    }
    throw new Error("createEscrowV2: no EscrowCreated event with a non-zero address");
  }

  /** Mint a pcc.evidence.v1 EAS attestation as the oracle; return its UID. */
  async function mintAttestation(recipient: Address, payload: EvidencePayload): Promise<Hex> {
    const data = encodeAbiParameters(EVIDENCE_SCHEMA_PARAMS, [
      payload.jobId, payload.kernelId, payload.evidenceBundleHash, payload.ipfsCid,
      payload.assuranceTier, payload.oracleVerified, payload.stepId,
    ]);
    const hash = await oracleWallet.writeContract({
      address: EAS_ADDRESS, abi: EAS_ABI, functionName: "attest",
      args: [{ schema: cfg.schemaUid!, data: { recipient, expirationTime: 0n, revocable: true, refUID: ("0x" + "00".repeat(32)) as Hex, data, value: 0n } }],
    });
    const receipt = await pub.waitForTransactionReceipt({ hash });
    for (const log of receipt.logs) {
      try {
        const d = decodeEventLog({ abi: EAS_ABI, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
        if (d.eventName === "Attested") return (d.args as { uid: Hex }).uid;
      } catch { /* not the Attested log */ }
    }
    throw new Error("EAS.attest: no Attested event in receipt");
  }

  /** Assert a contract write reverts with a message containing `needle`. */
  async function expectRevert(name: string, needle: string, fn: () => Promise<unknown>) {
    try {
      await fn();
      record(name, false, `expected revert "${needle}" but the tx succeeded`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      record(name, msg.includes(needle), msg.includes(needle) ? `reverted as expected` : `reverted with the WRONG reason: ${msg.slice(0, 120)}`);
    }
  }

  // Build a milestone on an escrow + fund it; returns the canonical good payload.
  async function fundedMilestone(escrow: Address, jobId: string, stepIdStr: string, amount: string) {
    const stepIdBytes = b32(stepIdStr);
    const evidenceHash = b32(`evidence-${jobId}`);
    // addMilestone(stepId, operator, amount, bond, challengeWindowSeconds=0, requiredTier=0, jobId)
    await payerWallet.writeContract({
      address: escrow, abi: MilestoneEscrowV2ABI, functionName: "addMilestone",
      args: [stepIdBytes, payer.address, parseUnits(amount, 6), 0n, 0n, 0, jobId],
    }).then((h) => pub.waitForTransactionReceipt({ hash: h }));
    // approve + fund
    await payerWallet.writeContract({
      address: cfg.token!, abi: MockUSDCABI, functionName: "approve", args: [escrow, parseUnits(amount, 6)],
    }).then((h) => pub.waitForTransactionReceipt({ hash: h }));
    await payerWallet.writeContract({ address: escrow, abi: MilestoneEscrowV2ABI, functionName: "fund", args: [] })
      .then((h) => pub.waitForTransactionReceipt({ hash: h }));
    // submitEvidence (operator == payer here)
    await payerWallet.writeContract({
      address: escrow, abi: MilestoneEscrowV2ABI, functionName: "submitEvidence", args: [0n, evidenceHash],
    }).then((h) => pub.waitForTransactionReceipt({ hash: h }));
    const good: EvidencePayload = {
      jobId, kernelId: b32(`kernel-${jobId}`), evidenceBundleHash: evidenceHash,
      ipfsCid: "", assuranceTier: 0, oracleVerified: true, stepId: stepIdBytes,
    };
    return { stepIdBytes, evidenceHash, good };
  }

  async function submitAndRelease(escrow: Address, uid: Hex): Promise<void> {
    await payerWallet.writeContract({ address: escrow, abi: MilestoneEscrowV2ABI, functionName: "submitAttestation", args: [0n, uid] })
      .then((h) => pub.waitForTransactionReceipt({ hash: h }));
    // challengeWindowSeconds=0 → window already elapsed; release immediately.
    await payerWallet.writeContract({ address: escrow, abi: MilestoneEscrowV2ABI, functionName: "release", args: [0n] })
      .then((h) => pub.waitForTransactionReceipt({ hash: h }));
  }

  async function balanceOf(addr: Address): Promise<bigint> {
    return (await pub.readContract({ address: cfg.token!, abi: MockUSDCABI, functionName: "balanceOf", args: [addr] })) as bigint;
  }

  // ── 1. Happy path × 2 (idempotency) ────────────────────────────────────────
  for (const round of [1, 2]) {
    const jobId = `job-smoke-${round}`;
    const escrow = await createEscrow(`hp${round}`);
    const { good } = await fundedMilestone(escrow, jobId, `step-${round}`, "1.00");
    const before = await balanceOf(payer.address);
    const uid = await mintAttestation(escrow, good);
    await submitAndRelease(escrow, uid);
    const after = await balanceOf(payer.address);
    record(`happy-path round ${round} (operator paid)`, after > before, `Δ=${after - before} (escrow ${escrow})`);
  }

  // ── 2. Refusal reverts (fresh escrow; good evidence on-chain, bad attestation) ──
  {
    const jobId = "job-refusal";
    const escrow = await createEscrow("refusal");
    const { good, stepIdBytes, evidenceHash } = await fundedMilestone(escrow, jobId, "step-refusal", "1.00");

    // wrong evidenceBundleHash → "Evidence mismatch"
    await expectRevert("refusal: wrong evidenceBundleHash", "Evidence mismatch", async () => {
      const uid = await mintAttestation(escrow, { ...good, evidenceBundleHash: b32("WRONG-evidence") });
      await payerWallet.writeContract({ address: escrow, abi: MilestoneEscrowV2ABI, functionName: "submitAttestation", args: [0n, uid] });
    });

    // wrong stepId (C2b) → "stepId mismatch"
    await expectRevert("refusal: wrong stepId (C2b)", "stepId mismatch", async () => {
      const uid = await mintAttestation(escrow, { ...good, stepId: b32("WRONG-step") });
      await payerWallet.writeContract({ address: escrow, abi: MilestoneEscrowV2ABI, functionName: "submitAttestation", args: [0n, uid] });
    });

    // wrong recipient (C2a) → "Wrong recipient" (mint to a different address)
    await expectRevert("refusal: wrong recipient (C2a)", "Wrong recipient", async () => {
      const uid = await mintAttestation(payer.address /* not the escrow */, good);
      await payerWallet.writeContract({ address: escrow, abi: MilestoneEscrowV2ABI, functionName: "submitAttestation", args: [0n, uid] });
    });

    // UID replay (C1): mint a VALID uid, bind it once, then re-submit → "Attestation already used".
    // (Re-uses the same milestone; first submit transitions it to Attested, second must revert on the used-UID guard.)
    void stepIdBytes; void evidenceHash;
    const validUid = await mintAttestation(escrow, good);
    await payerWallet.writeContract({ address: escrow, abi: MilestoneEscrowV2ABI, functionName: "submitAttestation", args: [0n, validUid] })
      .then((h) => pub.waitForTransactionReceipt({ hash: h }));
    await expectRevert("refusal: UID replay (C1)", "Attestation already used", async () => {
      await payerWallet.writeContract({ address: escrow, abi: MilestoneEscrowV2ABI, functionName: "submitAttestation", args: [0n, validUid] });
    });
  }

  // ── Tally ──────────────────────────────────────────────────────────────────
  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== ${failed.length === 0 ? "PASS ✓" : `FAIL ✗ (${failed.length}/${results.length})`} — V2 settlement gate ===`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("[smoke] fatal:", e instanceof Error ? e.message : e);
  process.exit(1);
});
