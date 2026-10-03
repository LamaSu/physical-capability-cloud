/**
 * `readMilestoneRecipients` (N102) against the REAL `MilestoneEscrowV2` / `MilestoneEscrowV3`
 * contracts on a local anvil chain — the real-contract regression the stub unit tests
 * (`milestone-recipients.test.ts`) cannot give: real bytecode, a real EIP-1898-pinned
 * `eth_call` against a real node, and real ERC-20 balance deltas out of a real `release()`.
 *
 * `test/fixtures/milestone-recipients-anvil/MilestoneRecipientsAnvilFixture.s.sol` deploys a
 * MockUSDC, a MockEAS, and a real clone of each escrow (protocolRoot = address(0) — V2's
 * "with a root" fee path is already covered by the stub tests; this fixture's job is the
 * split/truncation/release money path, which doesn't need a root to be exercised honestly).
 * For each version, this test then drives the FULL lifecycle through the contract's own
 * entry points (no `anvil_setStorageAt`, no shortcuts):
 *   addMilestone → setPayoutMap (2 legs, chosen to truncate) → fund → depositBond →
 *   submitEvidence → submitAttestation (a MockEAS-registered attestation) → release
 * and checks `readMilestoneRecipients` at two pinned blocks:
 *   - right after fund(): legs, the residual, and recipientsFinal:true match what was set;
 *   - right after release(): the ACTUAL token balance deltas equal `.projected`, recipient
 *     by recipient (the strongest proof — the module's math against the EVM's own math).
 *
 * OPT-IN. Needs foundry's anvil + forge. CI's node job has neither and skips this; the stub
 * suite and the forge suites run there.
 *   MILESTONE_RECIPIENTS_ANVIL_E2E=1 pnpm vitest run ts/__tests__/milestone-recipients.anvil.test.ts
 * Binaries come from $FOUNDRY_BIN, else ~/.foundry/bin, else PATH. No private key is
 * committed: PAYER/OPERATOR are fixed addresses the fixture bakes in, driven here via
 * anvil's account impersonation (`anvil_impersonateAccount`) rather than a local signer —
 * `submitAttestation`/`release` are permissionless on the contract itself, so those run
 * from anvil's own unlocked default account.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  encodeAbiParameters,
  getAddress,
  http,
  keccak256,
  parseAbi,
  stringToHex,
  zeroAddress,
  zeroHash,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { readMilestoneRecipients } from "../milestone-recipients.js";
import { MilestoneEscrowV2ABI } from "../abi/MilestoneEscrowV2.js";
import { MilestoneEscrowV3ABI } from "../abi/MilestoneEscrowV3.js";

const RUN = process.env.MILESTONE_RECIPIENTS_ANVIL_E2E === "1";
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const FIXTURE =
  join(ROOT, "test/fixtures/milestone-recipients-anvil/MilestoneRecipientsAnvilFixture.s.sol") +
  ":MilestoneRecipientsAnvilFixture";
/** anvil's first default account, unlocked on every anvil. An address, not a key. */
const ANVIL_DEFAULT_SENDER: Address = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

// Must match the fixture's constants exactly.
const PAYER: Address = "0x0000000000000000000000000000000000001111";
const OPERATOR: Address = "0x0000000000000000000000000000000000002222";
const ORACLE: Address = "0x0000000000000000000000000000000000006666";
const SCHEMA_V2_UID: Hex = `0x${"0".repeat(60)}aaaa`;
const SCHEMA_V3_UID: Hex = `0x${"0".repeat(60)}bbbb`;

// This test's own fixtures (not shared with the Solidity script).
const LEG1: Address = "0x0000000000000000000000000000000000004444";
const LEG2: Address = "0x0000000000000000000000000000000000005555";
const FEE_RECIPIENT: Address = "0x0000000000000000000000000000000000007777";
const ROLE_LEG1 = keccak256(stringToHex("leg1"));
const ROLE_LEG2 = keccak256(stringToHex("leg2"));

// Deliberately not evenly divisible by 10000 bps, so the split truncates and leaves dust
// for the operator — the same money-proof shape as the stub unit test's dust case.
const AMOUNT = 1_000_001n;
const OPERATOR_BOND = 1_000n;
const CHALLENGE_WINDOW_SECONDS = 10n;
const V3_ATTESTED_FEE_BPS = 500; // 5%, well under V3's MAX_FEE_BPS (1000)

const bin = (name: string) => {
  const p = join(process.env.FOUNDRY_BIN ?? join(homedir(), ".foundry", "bin"), name);
  return existsSync(p) ? p : name;
};
const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      s.close(() => (a && typeof a === "object" ? resolve(a.port) : reject(new Error("no free port"))));
    });
  });

const TOKEN_ABI = parseAbi([
  "function mint(address,uint256)",
  "function approve(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
]);

/** MockEAS is test-only (packages/contracts/test/mocks/MockEAS.sol) — it has no entry in
 *  the package's generated ABI surface, so this is a small local fragment, JSON-shaped
 *  (not human-readable `parseAbi`) because the single argument is a named tuple. */
const MOCK_EAS_ABI = [
  {
    type: "function",
    name: "setAttestation",
    stateMutability: "nonpayable",
    inputs: [
      { name: "uid", type: "bytes32" },
      {
        name: "att",
        type: "tuple",
        components: [
          { name: "uid", type: "bytes32" },
          { name: "schema", type: "bytes32" },
          { name: "time", type: "uint64" },
          { name: "expirationTime", type: "uint64" },
          { name: "revocationTime", type: "uint64" },
          { name: "refUID", type: "bytes32" },
          { name: "recipient", type: "address" },
          { name: "attester", type: "address" },
          { name: "revocable", type: "bool" },
          { name: "data", type: "bytes" },
        ],
      },
    ],
    outputs: [],
  },
] as const;

describe.skipIf(!RUN)("readMilestoneRecipients against the real contracts on anvil (N102)", () => {
  let anvil: ChildProcess | undefined;
  let rpc = "";
  let deployed: { TOKEN: Address; EAS: Address; ESCROW_V2: Address; ESCROW_V3: Address };

  beforeAll(async () => {
    const port = await freePort();
    rpc = `http://127.0.0.1:${port}`;
    anvil = spawn(bin("anvil"), ["--port", String(port), "--silent"], { stdio: "ignore" });
    const probe = createPublicClient({ transport: http(rpc) });
    for (let k = 0; ; k++) {
      try {
        await probe.getChainId();
        break;
      } catch {
        if (k > 80) throw new Error("anvil did not start");
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    const out = execFileSync(
      bin("forge"),
      [
        "script", FIXTURE, "--root", ROOT, "--offline", "--rpc-url", rpc,
        "--broadcast", "--slow", "--unlocked", "--sender", ANVIL_DEFAULT_SENDER,
      ],
      { cwd: ROOT, encoding: "utf8", maxBuffer: 64 << 20, timeout: 300_000 },
    );
    const grab = (label: string): Address => {
      const m = out.match(new RegExp(`${label} (0x[0-9a-fA-F]{40})`));
      if (!m?.[1]) throw new Error(`the fixture did not log ${label}:\n${out}`);
      return getAddress(m[1]);
    };
    deployed = { TOKEN: grab("TOKEN"), EAS: grab("EAS"), ESCROW_V2: grab("ESCROW_V2"), ESCROW_V3: grab("ESCROW_V3") };
  }, 600_000);

  afterAll(() => {
    anvil?.kill();
  });

  /** Drives one escrow (V2 or V3) through its full lifecycle via the contract's own entry
   *  points, then checks `readMilestoneRecipients` at the post-fund and post-release blocks. */
  async function driveAndVerify(version: "v2" | "v3") {
    const chain = {
      id: 31337, name: "anvil",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [rpc] } },
    } as const;
    const pub: PublicClient = createPublicClient({ chain, transport: http(rpc) });
    const test = createTestClient({ mode: "anvil", chain, transport: http(rpc) });
    const escrow = version === "v2" ? deployed.ESCROW_V2 : deployed.ESCROW_V3;
    const escrowAbi = version === "v2" ? MilestoneEscrowV2ABI : MilestoneEscrowV3ABI;
    const schemaUid = version === "v2" ? SCHEMA_V2_UID : SCHEMA_V3_UID;

    const sendAs = async (account: Address, request: unknown) => {
      await test.impersonateAccount({ address: account });
      try {
        const wallet = createWalletClient({ account, chain, transport: http(rpc) });
        const hash = await wallet.writeContract(request as never);
        const receipt = await pub.waitForTransactionReceipt({ hash });
        expect(receipt.status).toBe("success");
        return receipt;
      } finally {
        await test.stopImpersonatingAccount({ address: account });
      }
    };
    const sendDefault = async (request: unknown) => {
      const wallet = createWalletClient({ account: ANVIL_DEFAULT_SENDER, chain, transport: http(rpc) });
      const hash = await wallet.writeContract(request as never);
      const receipt = await pub.waitForTransactionReceipt({ hash });
      expect(receipt.status).toBe("success");
      return receipt;
    };

    await test.setBalance({ address: PAYER, value: 10n ** 18n });
    await test.setBalance({ address: OPERATOR, value: 10n ** 18n });

    const stepId = keccak256(stringToHex(`n102-step-${version}`));
    const jobId = `n102-job-${version}`;
    const evidenceHash = keccak256(stringToHex(`n102-evidence-${version}`));

    // 1. payer: fund a milestone with a 2-leg payout map set while Unfunded.
    await sendDefault({ address: deployed.TOKEN, abi: TOKEN_ABI, functionName: "mint", args: [PAYER, AMOUNT] } as never);
    await sendAs(PAYER, {
      address: escrow, abi: escrowAbi, functionName: "addMilestone",
      args: [stepId, OPERATOR, AMOUNT, OPERATOR_BOND, CHALLENGE_WINDOW_SECONDS, 0, jobId],
    });
    await sendAs(PAYER, {
      address: escrow, abi: escrowAbi, functionName: "setPayoutMap",
      args: [
        0n,
        [
          { recipient: LEG1, bps: 3333n, roleTag: ROLE_LEG1, ipId: zeroHash },
          { recipient: LEG2, bps: 3333n, roleTag: ROLE_LEG2, ipId: zeroHash },
        ],
      ],
    });
    await sendAs(PAYER, { address: deployed.TOKEN, abi: TOKEN_ABI, functionName: "approve", args: [escrow, AMOUNT] } as never);
    await sendAs(PAYER, { address: escrow, abi: escrowAbi, functionName: "fund", args: [] });

    // ── Phase A: right after fund() — legs, residual, recipientsFinal, against what was set ──
    const postFundBlock = await pub.getBlockNumber();
    const afterFund = await readMilestoneRecipients({ client: pub, escrow, version, milestoneIndex: 0n, blockNumber: postFundBlock });

    expect(afterFund.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(version === "v3" ? ["fee-known"] : []);
    expect(afterFund.ok).toBe(true);
    expect(afterFund.status).toBe(1); // Funded
    expect(afterFund.recipientsFinal).toBe(true); // map can never change again past Unfunded
    expect(afterFund.token).toBe(getAddress(deployed.TOKEN));
    expect(afterFund.amount).toBe(AMOUNT);
    expect(afterFund.operatorBond).toBe(OPERATOR_BOND);
    const expectedLegs = [
      { recipient: LEG1, role: "split", bps: 3333, roleTag: ROLE_LEG1, ipId: zeroHash },
      { recipient: LEG2, role: "split", bps: 3333, roleTag: ROLE_LEG2, ipId: zeroHash },
      { recipient: getAddress(OPERATOR), role: "operator-residual", residualBps: 10000 - 6666, plusBond: OPERATOR_BOND },
    ];
    expect(afterFund.legs).toEqual(expectedLegs);
    if (version === "v2") {
      // no protocolRoot in this fixture: fee known immediately, and zero.
      expect(afterFund.fee).toEqual({ recipient: null, bps: 0, final: true, source: "none" });
    } else {
      // not yet attested: fee genuinely unknown — but that must not fail `ok` (fee-known
      // is informational only).
      expect(afterFund.fee).toEqual({ recipient: null, bps: null, final: false, source: "none" });
      expect(afterFund.projected).toBeUndefined();
    }

    // 2. operator: deposit bond, submit evidence.
    await sendDefault({ address: deployed.TOKEN, abi: TOKEN_ABI, functionName: "mint", args: [OPERATOR, OPERATOR_BOND] } as never);
    await sendAs(OPERATOR, { address: deployed.TOKEN, abi: TOKEN_ABI, functionName: "approve", args: [escrow, OPERATOR_BOND] } as never);
    await sendAs(OPERATOR, { address: escrow, abi: escrowAbi, functionName: "depositBond", args: [0n] });
    await sendAs(OPERATOR, { address: escrow, abi: escrowAbi, functionName: "submitEvidence", args: [0n, evidenceHash] });

    // 3. register a valid attestation in MockEAS, then submit it — both PERMISSIONLESS on
    //    the real contract, so these run from anvil's own unlocked default account.
    const uid = keccak256(stringToHex(`n102-uid-${version}`));
    const data =
      version === "v2"
        ? encodeAbiParameters(
            [{ type: "string" }, { type: "bytes32" }, { type: "bytes32" }, { type: "string" }, { type: "uint8" }, { type: "bool" }, { type: "bytes32" }],
            [jobId, keccak256(stringToHex("kernel")), evidenceHash, "", 0, true, stepId],
          )
        : encodeAbiParameters(
            [
              { type: "string" }, { type: "bytes32" }, { type: "bytes32" }, { type: "string" },
              { type: "uint8" }, { type: "bool" }, { type: "bytes32" }, { type: "uint16" }, { type: "address" },
            ],
            [jobId, keccak256(stringToHex("kernel")), evidenceHash, "", 0, true, stepId, V3_ATTESTED_FEE_BPS, FEE_RECIPIENT],
          );
    await sendDefault({
      address: deployed.EAS, abi: MOCK_EAS_ABI, functionName: "setAttestation",
      args: [
        uid,
        {
          uid, schema: schemaUid, time: 0n, expirationTime: 0n, revocationTime: 0n,
          refUID: zeroHash, recipient: escrow, attester: ORACLE, revocable: true, data,
        },
      ],
    } as never);
    await sendDefault({ address: escrow, abi: escrowAbi, functionName: "submitAttestation", args: [0n, uid] });

    // 4. warp past the challenge window and mine, then capture pre-release balances.
    await test.increaseTime({ seconds: Number(CHALLENGE_WINDOW_SECONDS) + 1 });
    await test.mine({ blocks: 1 });

    const balanceOf = async (addr: Address) =>
      pub.readContract({ address: deployed.TOKEN, abi: TOKEN_ABI, functionName: "balanceOf", args: [addr] }) as Promise<bigint>;
    const trackedRecipients = version === "v3" ? [LEG1, LEG2, OPERATOR, FEE_RECIPIENT] : [LEG1, LEG2, OPERATOR];
    const before = new Map(await Promise.all(trackedRecipients.map(async (a) => [a, await balanceOf(a)] as const)));

    // 5. release — PERMISSIONLESS on the real contract — through the contract's own path.
    await sendDefault({ address: escrow, abi: escrowAbi, functionName: "release", args: [0n] });
    const postReleaseBlock = await pub.getBlockNumber();
    const after = new Map(await Promise.all(trackedRecipients.map(async (a) => [a, await balanceOf(a)] as const)));

    // ── Phase B: right after release() — the strongest proof ──
    const afterRelease = await readMilestoneRecipients({ client: pub, escrow, version, milestoneIndex: 0n, blockNumber: postReleaseBlock });
    expect(afterRelease.checks.filter((c) => !c.ok)).toEqual([]);
    expect(afterRelease.ok).toBe(true);
    expect(afterRelease.status).toBe(5); // Released
    expect(afterRelease.recipientsFinal).toBe(true);
    expect(afterRelease.legs).toEqual(expectedLegs); // the map never changed
    expect(afterRelease.projected).toBeDefined();

    // LEG1 / LEG2 / OPERATOR (and, for V3, FEE_RECIPIENT via the "fee" row — F3): actual
    // balance delta === readMilestoneRecipients' projection, recipient by recipient (the
    // module's math against the EVM's own math).
    const projectedByRecipient = new Map(afterRelease.projected!.map((p) => [p.recipient.toLowerCase(), p.amount]));
    for (const r of trackedRecipients) {
      const delta = after.get(r)! - before.get(r)!;
      const want = projectedByRecipient.get(r.toLowerCase());
      expect(want).toBeDefined();
      expect(delta).toBe(want);
    }
    // sum(projected) === amount + bond whenever the fee is fully routed (F3) — true here
    // for both versions (V2 has no root in this fixture; V3's fee has a real recipient).
    expect(afterRelease.projected!.reduce((s, p) => s + p.amount, 0n)).toBe(AMOUNT + OPERATOR_BOND);

    if (version === "v3") {
      expect(afterRelease.fee).toEqual({ recipient: getAddress(FEE_RECIPIENT), bps: V3_ATTESTED_FEE_BPS, final: true, source: "attested" });
      const expectedFee = (AMOUNT * BigInt(V3_ATTESTED_FEE_BPS)) / 10000n;
      const realFeeDelta = after.get(FEE_RECIPIENT)! - before.get(FEE_RECIPIENT)!;
      // Against the hand-computed contract math (.fee)...
      expect(realFeeDelta).toBe(expectedFee);
      // ...AND against the "fee" row readMilestoneRecipients itself reports (F3), which must
      // be first in `.projected` and must be the SAME real recipient/amount.
      const feeRow = afterRelease.projected!.find((p) => p.role === "fee");
      expect(feeRow).toEqual({ recipient: getAddress(FEE_RECIPIENT), role: "fee", amount: expectedFee });
      expect(afterRelease.projected!.indexOf(feeRow!)).toBe(0);
      expect(realFeeDelta).toBe(feeRow!.amount);
    } else {
      expect(afterRelease.fee).toEqual({ recipient: null, bps: 0, final: true, source: "none" });
      expect(afterRelease.projected!.some((p) => p.role === "fee")).toBe(false); // no root → no fee row at all
    }
  }

  it("V2: fund → attest → release matches readMilestoneRecipients at both pinned blocks", async () => {
    await driveAndVerify("v2");
  }, 120_000);

  it("V3: fund → attest (with a fee) → release matches readMilestoneRecipients at both pinned blocks", async () => {
    await driveAndVerify("v3");
  }, 120_000);
});
