/**
 * V3 Settlement End-to-End SMOKE  (extends PR #188; coord bulletins 222 / 225)
 * =============================================================================
 * The V3 settlement gate. Exercises BOTH release modes of MilestoneEscrowV3 plus
 * the V3 fee-from-attestation guards, against Base Sepolia. Sibling of
 * v2-settlement-smoke.ts (same structure, V3 surface).
 *
 * Mode A — payer-approval, oracle-FREE (the income-first cheap-trust rail):
 *   createEscrowV3 → addMilestone → approve+fund → submitEvidence
 *   → approveAndRelease(payer) → operator PAID in full (no fee, no oracle, no attestation)
 *
 * Mode B — oracle-attested, fee-from-attestation:
 *   createEscrowV3 → addMilestone → approve+fund → submitEvidence
 *   → oracle mints pcc.evidence.v2 (9 fields incl feeBps + feeRecipient,
 *     attester == authorizedOracle) → submitAttestation(uid)
 *   → [challengeWindow=0] → release → operator PAID (amount - fee) AND
 *     feeRecipient PAID the fee   ← the V3 fee-from-attestation assertion
 *
 * REFUSAL checks — each MUST revert (the V3 + inherited security guards):
 *   - feeBps > MAX_FEE_BPS (1000)        → "Fee exceeds MAX_FEE_BPS"   (V3 fee cap)
 *   - feeBps > 0 + zero feeRecipient     → "Zero fee recipient"        (V3)
 *   - wrong evidenceBundleHash           → "Evidence mismatch"
 *   - wrong stepId                 (C2b) → "stepId mismatch"
 *   - wrong recipient              (C2a) → "Wrong recipient"
 *   - UID replay                   (C1)  → "Attestation already used"
 *
 * Idempotency: the Mode-A happy path runs TWICE (fresh escrow each time); both settle.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * STATUS: WRITTEN, NOT RUN. Per coord bulletin 225, the deploy-broadcast is OUT of
 * this gate's acceptance criteria — V3 deploy is premature until the v2 EAS schema
 * is registered (RegisterEASSchemaV2, PR #189) and the oracle mints v2 (bulletin
 * 222). The contract-call SHAPES are kept IN so the gate is ready the moment a
 * PCCProtocolV3 factory is deployed. SAFE BY DEFAULT: with no RUN_ONCHAIN=1 it
 * prints the plan + resolved config and exits 0 WITHOUT touching the chain.
 *
 * The V3 ABIs are inlined (not imported from @pcc/contracts) so this script is
 * self-contained on the master-based #188 branch, which does not yet export the
 * V3 contracts. The inlined fragments mirror PCCProtocolV3 / MilestoneEscrowV3.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Required env to actually run (RUN_ONCHAIN=1):
 *   BASE_RPC_URL                Base Sepolia JSON-RPC (default https://sepolia.base.org)
 *   ORACLE_PRIVATE_KEY          the authorizedOracle / EAS attester signer (0x…)  [Mode B]
 *   PAYER_PRIVATE_KEY           buyer/payer + operator (funds escrow, receives payout)
 *   PCC_EVIDENCE_V2_SCHEMA_UID  registered pcc.evidence.v2 schema UID (RegisterEASSchemaV2)
 *   ESCROW_FACTORY_V3_ADDRESS   deployed PCCProtocolV3 factory (no chain-config default yet)
 *   MOCK_USDC_ADDRESS           test token the payer holds (default: chain-config mockUSDC)
 *   ARBITER_ADDRESS             dispute arbiter (default: payer address)
 *   PCC_FEE_RECIPIENT           Mode-B fee recipient (default 0xdDF4…4b6B, the V1/V2/V3 fee addr)
 *   PCC_FEE_BPS                 Mode-B attested fee bps (default 235 = 2.35%)
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
// No @pcc/contracts import — this stub imports ONLY viem. All ABIs are inlined
// (the #188 branch is master-based and does not export the V3 contracts anyway).

// ── EAS (Base Sepolia predeploy) ─────────────────────────────────────────────
const EAS_ADDRESS: Address = "0x4200000000000000000000000000000000000021";

/** The canonical V3 fee recipient (hardcoded in DeployProtocolV3 / V1 / V2). */
const DEFAULT_FEE_RECIPIENT: Address = "0xdDF476D86afD5e2075b8c95CBFfd3d76aEfa4b6B";

/** Minimal EAS surface: attest() + the Attested event. */
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

/** Minimal ERC-20 surface used by the smoke (balanceOf + approve). */
const ERC20_ABI = [
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { name: "approve", type: "function", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "", type: "bool" }] },
] as const;

// ── Inlined V3 ABI fragments (mirror PCCProtocolV3 / MilestoneEscrowV3) ───────
const PCCProtocolV3ABI = [
  {
    name: "createEscrowV3",
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
] as const;

const MilestoneEscrowV3ABI = [
  {
    name: "addMilestone",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_stepId", type: "bytes32" },
      { name: "_operator", type: "address" },
      { name: "_amount", type: "uint256" },
      { name: "_operatorBond", type: "uint256" },
      { name: "_challengeWindowSeconds", type: "uint256" },
      { name: "_requiredTier", type: "uint8" },
      { name: "_jobId", type: "string" },
    ],
    outputs: [],
  },
  { name: "fund", type: "function", stateMutability: "nonpayable", inputs: [], outputs: [] },
  {
    name: "submitEvidence",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "milestoneIndex", type: "uint256" },
      { name: "_evidenceBundleHash", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    name: "submitAttestation",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "milestoneIndex", type: "uint256" },
      { name: "easUid", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    name: "release",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "milestoneIndex", type: "uint256" }],
    outputs: [],
  },
  {
    name: "approveAndRelease",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "milestoneIndex", type: "uint256" }],
    outputs: [],
  },
] as const;

// pcc.evidence.v2 — FIELD ORDER IS LOAD-BEARING (mirrors MilestoneEscrowV3.sol's
// abi.decode + the gateway PCC_EVIDENCE_SCHEMA_V2 in oracle-client.ts:350).
// = v1's 7 fields + uint16 feeBps + address feeRecipient.
const EVIDENCE_V2_SCHEMA_PARAMS = [
  { name: "jobId", type: "string" },
  { name: "kernelId", type: "bytes32" },
  { name: "evidenceBundleHash", type: "bytes32" },
  { name: "ipfsCid", type: "string" },
  { name: "assuranceTier", type: "uint8" },
  { name: "oracleVerified", type: "bool" },
  { name: "stepId", type: "bytes32" },
  { name: "feeBps", type: "uint16" },
  { name: "feeRecipient", type: "address" },
] as const;

interface EvidencePayloadV2 {
  jobId: string;
  kernelId: Hex;
  evidenceBundleHash: Hex;
  ipfsCid: string;
  assuranceTier: number;
  oracleVerified: boolean;
  stepId: Hex;
  feeBps: number;
  feeRecipient: Address;
}

const b32 = (s: string): Hex => keccak256(toBytes(s));

// ── Config resolution (env → chain-config defaults) ──────────────────────────
function resolveConfig() {
  const rpc = process.env.BASE_RPC_URL ?? "https://sepolia.base.org";
  // Token is env-only (no @pcc/contracts dependency — this stub imports only viem).
  const token = process.env.MOCK_USDC_ADDRESS as Address | undefined;
  const feeBps = Number(process.env.PCC_FEE_BPS ?? "235");
  return {
    rpc,
    // No chain-config default for the V3 factory — it is not deployed yet.
    factory: process.env.ESCROW_FACTORY_V3_ADDRESS as Address | undefined,
    token,
    schemaUid: process.env.PCC_EVIDENCE_V2_SCHEMA_UID as Hex | undefined,
    oracleKey: process.env.ORACLE_PRIVATE_KEY as Hex | undefined,
    payerKey: process.env.PAYER_PRIVATE_KEY as Hex | undefined,
    arbiter: process.env.ARBITER_ADDRESS as Address | undefined,
    feeRecipient: (process.env.PCC_FEE_RECIPIENT as Address) ?? DEFAULT_FEE_RECIPIENT,
    feeBps,
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
  const AMOUNT = "1.00";
  const amountUnits = parseUnits(AMOUNT, 6);

  console.log("=== V3 Settlement Smoke (Mode A + Mode B + fee-from-attestation) ===");
  console.log(`  factory(V3) : ${cfg.factory ?? "(unresolved — set ESCROW_FACTORY_V3_ADDRESS once deployed)"}`);
  console.log(`  token       : ${cfg.token ?? "(unresolved — set MOCK_USDC_ADDRESS)"}`);
  console.log(`  schemaUid(v2): ${cfg.schemaUid ?? "(unset — set PCC_EVIDENCE_V2_SCHEMA_UID)"}`);
  console.log(`  feeRecipient: ${cfg.feeRecipient}`);
  console.log(`  feeBps      : ${cfg.feeBps} (${(cfg.feeBps / 100).toFixed(2)}%)`);
  console.log(`  EAS         : ${EAS_ADDRESS}`);
  console.log(`  RPC         : ${cfg.rpc}`);

  if (!run) {
    console.log(
      "\n[DRY-RUN] RUN_ONCHAIN!=1 — printing plan only, NO chain writes.\n" +
        "Plan:\n" +
        "  Mode A ×2 (idempotency): createEscrowV3 → addMilestone(tier0, window0) →\n" +
        "    approve+fund → submitEvidence → approveAndRelease → assert operator +amount (no fee).\n" +
        "  Mode B: createEscrowV3 → … → mint pcc.evidence.v2 (feeBps+feeRecipient, attester=oracle,\n" +
        "    recipient=escrow) → submitAttestation(uid) → release → assert operator +(amount-fee)\n" +
        "    AND feeRecipient +fee.\n" +
        "  Refusal reverts: feeBps>MAX_FEE_BPS / zero feeRecipient / bad evidenceHash / bad stepId /\n" +
        "    bad recipient / UID-replay.\n" +
        "Deploy-broadcast is OUT of this gate (coord 225). Fire with RUN_ONCHAIN=1 + the env above\n" +
        "ONLY after a PCCProtocolV3 factory is deployed and the v2 schema is registered (bulletin 222).",
    );
    return;
  }

  // ── Live mode: validate required secrets/config ────────────────────────────
  const missing = [
    !cfg.payerKey && "PAYER_PRIVATE_KEY",
    !cfg.oracleKey && "ORACLE_PRIVATE_KEY",
    !cfg.schemaUid && "PCC_EVIDENCE_V2_SCHEMA_UID",
    !cfg.factory && "ESCROW_FACTORY_V3_ADDRESS",
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

  // simulate → write → wait → assert success. simulateContract throws the ACTUAL
  // revert reason BEFORE sending; status check catches on-chain reverts. gas set
  // explicitly (Base Sepolia estimation is flaky).
  async function wc(params: any, label: string) {
    // Retry the simulate to absorb public-RPC state lag: a load-balanced node may
    // serve a block from BEFORE the prior tx propagated (stale read). If the call
    // genuinely reverts, all retries see the same reason and we surface it.
    let lastErr: unknown = null;
    for (let i = 0; i < 6; i++) {
      try { await pub.simulateContract({ account: payer, ...params }); lastErr = null; break; }
      catch (e) { lastErr = e; await new Promise((r) => setTimeout(r, 2500)); }
    }
    if (lastErr) {
      const m = lastErr instanceof Error ? lastErr.message : String(lastErr);
      throw new Error(`[${label}] WOULD REVERT (after 6 retries): ${m.split("\n").slice(0, 4).join(" | ")}`);
    }
    const h = await payerWallet.writeContract({ ...params, gas: 2000000n });
    const r = await pub.waitForTransactionReceipt({ hash: h, confirmations: 2 });
    if (r.status !== "success") throw new Error(`[${label}] reverted on-chain: ${h}`);
    console.log(`  ✓ ${label} (${h})`);
    return r;
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  /** Deploy a fresh per-job V3 escrow via the factory; return its address. */
  async function createEscrowV3(cwmSeed: string): Promise<Address> {
    const cwmId = b32(`v3smoke-${cwmSeed}-${Math.floor(performance.now())}`);
    const hash = await payerWallet.writeContract({
      address: cfg.factory!, abi: PCCProtocolV3ABI, functionName: "createEscrowV3",
      args: [payer.address, arbiter, cfg.token!, cwmId],
    });
    const receipt = await pub.waitForTransactionReceipt({ hash, confirmations: 2 });
    for (const log of receipt.logs) {
      try {
        const d = decodeEventLog({ abi: PCCProtocolV3ABI, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
        if (d.eventName === "EscrowCreated") {
          const addr = (d.args as { escrow?: Address }).escrow;
          if (addr && addr !== zeroAddress) return addr;
        }
      } catch { /* not the EscrowCreated log */ }
    }
    throw new Error("createEscrowV3: no EscrowCreated event with a non-zero address");
  }

  /** Mint a pcc.evidence.v2 EAS attestation as the oracle; return its UID. */
  async function mintAttestationV2(recipient: Address, payload: EvidencePayloadV2): Promise<Hex> {
    const data = encodeAbiParameters(EVIDENCE_V2_SCHEMA_PARAMS, [
      payload.jobId, payload.kernelId, payload.evidenceBundleHash, payload.ipfsCid,
      payload.assuranceTier, payload.oracleVerified, payload.stepId,
      payload.feeBps, payload.feeRecipient,
    ]);
    const hash = await oracleWallet.writeContract({
      address: EAS_ADDRESS, abi: EAS_ABI, functionName: "attest", gas: 2000000n,
      args: [{ schema: cfg.schemaUid!, data: { recipient, expirationTime: 0n, revocable: true, refUID: ("0x" + "00".repeat(32)) as Hex, data, value: 0n } }],
    });
    const receipt = await pub.waitForTransactionReceipt({ hash, confirmations: 2 });
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

  /** Build a milestone on a V3 escrow + fund it; returns the canonical good v2 payload. */
  async function fundedMilestone(escrow: Address, jobId: string, stepIdStr: string) {
    const stepIdBytes = b32(stepIdStr);
    const evidenceHash = b32(`evidence-${jobId}`);
    // addMilestone(stepId, operator, amount, bond=0, challengeWindowSeconds=0, requiredTier=0, jobId)
    await wc({ address: escrow, abi: MilestoneEscrowV3ABI, functionName: "addMilestone", args: [stepIdBytes, payer.address, amountUnits, 0n, 0n, 0, jobId] }, "addMilestone");
    // fund() pulls amount + reserved fee (fee-from-attestation), so approve a buffer that covers both.
    await wc({ address: cfg.token!, abi: ERC20_ABI, functionName: "approve", args: [escrow, amountUnits * 2n] }, "approve");
    await wc({ address: escrow, abi: MilestoneEscrowV3ABI, functionName: "fund", args: [] }, "fund");
    await wc({ address: escrow, abi: MilestoneEscrowV3ABI, functionName: "submitEvidence", args: [0n, evidenceHash] }, "submitEvidence");
    // Canonical "good" v2 payload (Mode B). feeBps/feeRecipient overridden per-test.
    const good: EvidencePayloadV2 = {
      jobId, kernelId: b32(`kernel-${jobId}`), evidenceBundleHash: evidenceHash,
      ipfsCid: "", assuranceTier: 0, oracleVerified: true, stepId: stepIdBytes,
      feeBps: cfg.feeBps, feeRecipient: cfg.feeRecipient,
    };
    return { stepIdBytes, evidenceHash, good };
  }

  async function balanceOf(addr: Address): Promise<bigint> {
    return (await pub.readContract({ address: cfg.token!, abi: ERC20_ABI, functionName: "balanceOf", args: [addr] })) as bigint;
  }

  // ── 1. Mode A: payer-approval × 2 (idempotency), oracle-free, NO fee ────────
  for (const round of (process.env.ONLY_MODE_B ? [] : [1, 2])) {
    const jobId = `job-v3a-${round}`;
    const escrow = await createEscrowV3(`a${round}`);
    await fundedMilestone(escrow, jobId, `step-a-${round}`);
    const before = await balanceOf(payer.address);
    await payerWallet.writeContract({ address: escrow, abi: MilestoneEscrowV3ABI, functionName: "approveAndRelease", args: [0n] })
      .then((h) => pub.waitForTransactionReceipt({ hash: h }));
    const after = await balanceOf(payer.address);
    // operator == payer; Mode A has NO fee → exact +amount (bond 0).
    record(`mode-A round ${round} (operator paid in full, no fee)`, after - before === amountUnits, `Δ=${after - before} expected=${amountUnits} (escrow ${escrow})`);
  }

  // ── 2. Mode B: oracle-attested, fee FROM the attestation ────────────────────
  {
    const jobId = "job-v3b";
    const escrow = await createEscrowV3("b");
    const { good } = await fundedMilestone(escrow, jobId, "step-b");
    const fee = (amountUnits * BigInt(cfg.feeBps)) / 10000n;
    const payerBefore = await balanceOf(payer.address);
    const feeBefore = await balanceOf(cfg.feeRecipient);
    const uid = await mintAttestationV2(escrow, good);
    await wc({ address: escrow, abi: MilestoneEscrowV3ABI, functionName: "submitAttestation", args: [0n, uid] }, "submitAttestation");
    await wc({ address: escrow, abi: MilestoneEscrowV3ABI, functionName: "release", args: [0n] }, "release");
    const payerAfter = await balanceOf(payer.address);
    const feeAfter = await balanceOf(cfg.feeRecipient);
    record("mode-B operator paid (amount - fee)", payerAfter - payerBefore === amountUnits - fee, `Δ=${payerAfter - payerBefore} expected=${amountUnits - fee}`);
    record("mode-B feeRecipient paid the attested fee", feeAfter - feeBefore === fee, `Δ=${feeAfter - feeBefore} expected=${fee}`);
  }

  // ── 3. Refusal reverts (fresh escrow; good evidence on-chain, bad attestation) ──
  if (!process.env.ONLY_MODE_B) {
    const jobId = "job-v3-refusal";
    const escrow = await createEscrowV3("refusal");
    const { good } = await fundedMilestone(escrow, jobId, "step-refusal");

    // feeBps > MAX_FEE_BPS (1000) → "Fee exceeds MAX_FEE_BPS"  (V3 fee cap)
    await expectRevert("refusal: feeBps > MAX_FEE_BPS (V3)", "Fee exceeds MAX_FEE_BPS", async () => {
      const uid = await mintAttestationV2(escrow, { ...good, feeBps: 1001 });
      await payerWallet.writeContract({ address: escrow, abi: MilestoneEscrowV3ABI, functionName: "submitAttestation", args: [0n, uid] });
    });

    // feeBps > 0 with zero feeRecipient → "Zero fee recipient"  (V3)
    await expectRevert("refusal: zero feeRecipient w/ feeBps>0 (V3)", "Zero fee recipient", async () => {
      const uid = await mintAttestationV2(escrow, { ...good, feeBps: 235, feeRecipient: zeroAddress });
      await payerWallet.writeContract({ address: escrow, abi: MilestoneEscrowV3ABI, functionName: "submitAttestation", args: [0n, uid] });
    });

    // wrong evidenceBundleHash → "Evidence mismatch"
    await expectRevert("refusal: wrong evidenceBundleHash", "Evidence mismatch", async () => {
      const uid = await mintAttestationV2(escrow, { ...good, evidenceBundleHash: b32("WRONG-evidence") });
      await payerWallet.writeContract({ address: escrow, abi: MilestoneEscrowV3ABI, functionName: "submitAttestation", args: [0n, uid] });
    });

    // wrong stepId (C2b) → "stepId mismatch"
    await expectRevert("refusal: wrong stepId (C2b)", "stepId mismatch", async () => {
      const uid = await mintAttestationV2(escrow, { ...good, stepId: b32("WRONG-step") });
      await payerWallet.writeContract({ address: escrow, abi: MilestoneEscrowV3ABI, functionName: "submitAttestation", args: [0n, uid] });
    });

    // wrong recipient (C2a) → "Wrong recipient" (mint to a different address)
    await expectRevert("refusal: wrong recipient (C2a)", "Wrong recipient", async () => {
      const uid = await mintAttestationV2(payer.address /* not the escrow */, good);
      await payerWallet.writeContract({ address: escrow, abi: MilestoneEscrowV3ABI, functionName: "submitAttestation", args: [0n, uid] });
    });

    // UID replay (C1): mint a VALID uid, bind it once, then re-submit → "Attestation already used".
    const validUid = await mintAttestationV2(escrow, good);
    await payerWallet.writeContract({ address: escrow, abi: MilestoneEscrowV3ABI, functionName: "submitAttestation", args: [0n, validUid] })
      .then((h) => pub.waitForTransactionReceipt({ hash: h }));
    await expectRevert("refusal: UID replay (C1)", "Attestation already used", async () => {
      await payerWallet.writeContract({ address: escrow, abi: MilestoneEscrowV3ABI, functionName: "submitAttestation", args: [0n, validUid] });
    });
  }

  // ── Tally ──────────────────────────────────────────────────────────────────
  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== ${failed.length === 0 ? "PASS ✓" : `FAIL ✗ (${failed.length}/${results.length})`} — V3 settlement gate ===`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("[v3-smoke] fatal:", e instanceof Error ? e.message : e);
  process.exit(1);
});
