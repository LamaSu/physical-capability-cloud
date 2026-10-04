/**
 * `readUnitConfigs` against the REAL contracts on a local anvil chain — the real-contract regression for
 * `../vnext/read.ts`, exactly like `vnext-preflight.anvil.test.ts` is for `../vnext/preflight.ts`. Reuses the
 * SAME fixture (`test/fixtures/vnext-anvil/PreflightAnvilFixture.s.sol`): it only deploys the factory,
 * implementation, library, mock attesters and MockUSDC — no escrow-specific state — so this file deploys and
 * funds its OWN escrow from it, with no fixture change.
 *
 * This funds a MULTI-unit escrow (2 units; unit 0 has 2 payout legs and a nonzero compositionRoot) and checks:
 *   - readUnitConfigs reconstructs every unit, deep-equal to the funded configs (payouts included, in their
 *     on-chain order — the exact property N102's field-equality check needs), `ok:true`;
 *   - a read pinned BEFORE fund() reports the clone unfunded (`ok:false`, by name), not a throw;
 *   - a read pinned AT the funding block still reports it funded even after MORE blocks are mined on top —
 *     a genuine historical-block read, not merely "whatever is currently head" (preflightVNextFunding's own
 *     "reports the state AT the pinned block, not at the head" guarantee, exercised here for this function).
 *
 * OPT-IN, same gate as the sibling file: needs foundry's `anvil` and `forge`.
 *   VNEXT_ANVIL_E2E=1 pnpm vitest run ts/__tests__/vnext-read-unit-configs.anvil.test.ts
 * Binaries: $ANVIL_BIN / $FORGE_BIN (an exact path to the binary) take precedence; else $FOUNDRY_BIN (a bin
 * DIRECTORY — the sibling file's own convention); else ~/.foundry/bin; else the bare name on PATH.
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
  http,
  keccak256,
  stringToHex,
  zeroHash,
  type Address,
  type Hex,
  type PrivateKeyAccount,
  type PublicClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  VNextSettlementEscrowABI,
  VNextSettlementEscrowFactoryABI,
  buildUnitConfig,
  compileVNextPolicy,
  jobIdHashOf,
  readUnitConfigs,
  type PolicyAcceptance,
  type ReadUnitConfigsResult,
} from "../vnext/index.js";

const RUN = process.env.VNEXT_ANVIL_E2E === "1";
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const FIXTURE = join(ROOT, "test/fixtures/vnext-anvil/PreflightAnvilFixture.s.sol") + ":PreflightAnvilFixture";
/** anvil's first default account, unlocked on every anvil. An address, not a key. */
const ANVIL_DEFAULT_SENDER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

/** $ANVIL_BIN / $FORGE_BIN (exact path) first; else $FOUNDRY_BIN (bin dir, the sibling file's convention). */
const bin = (name: "anvil" | "forge"): string => {
  const direct = process.env[`${name.toUpperCase()}_BIN`];
  if (direct) return direct;
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

const failed = (r: ReadUnitConfigsResult) => r.checks.filter((c) => !c.ok).map((c) => c.name);

describe.skipIf(!RUN)("readUnitConfigs against the real contracts on anvil", () => {
  let anvil: ChildProcess | undefined;
  let rpc = "";
  let deployed: { FACTORY: Address; IMPL: Address; TOKEN: Address; ORACLE: Address };

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
      ["script", FIXTURE, "--root", ROOT, "--offline", "--rpc-url", rpc, "--broadcast", "--slow", "--unlocked", "--sender", ANVIL_DEFAULT_SENDER],
      { cwd: ROOT, encoding: "utf8", maxBuffer: 64 << 20, timeout: 300_000 },
    );
    const grab = (label: string): Address => {
      const m = out.match(new RegExp(`${label} (0x[0-9a-fA-F]{40})`));
      if (!m?.[1]) throw new Error(`the fixture did not log ${label}`);
      return m[1] as Address;
    };
    deployed = { FACTORY: grab("FACTORY"), IMPL: grab("IMPL"), TOKEN: grab("TOKEN"), ORACLE: grab("ORACLE") };
  }, 600_000);

  afterAll(() => {
    anvil?.kill();
  });

  it("reconstructs a real, multi-unit funded escrow byte-for-byte, and proves it at a pinned historical block", async () => {
    const { FACTORY, IMPL, TOKEN } = deployed;
    const chain = {
      id: 31337,
      name: "anvil",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [rpc] } },
    } as const;
    const pub: PublicClient = createPublicClient({ chain, transport: http(rpc) });
    const testClient = createTestClient({ mode: "anvil", chain, transport: http(rpc) });
    const [payer, operator, relayer] = [0, 1, 2].map(() => privateKeyToAccount(generatePrivateKey())) as [
      PrivateKeyAccount,
      PrivateKeyAccount,
      PrivateKeyAccount,
    ];
    for (const a of [payer, operator, relayer]) await testClient.setBalance({ address: a.address, value: 10n ** 20n });
    const send = async (account: PrivateKeyAccount, request: unknown) => {
      const hash = await createWalletClient({ account, chain, transport: http(rpc) }).writeContract(request as never);
      const receipt = await pub.waitForTransactionReceipt({ hash });
      expect(receipt.status).toBe("success");
      return receipt;
    };

    const now = (await pub.getBlock()).timestamp;
    const RECIP_A: Address = "0x1111111111111111111111111111111111111111";
    const RECIP_B: Address = "0x2222222222222222222222222222222222222222";
    const RECIP_C: Address = "0x3333333333333333333333333333333333333333";
    const FEE_RECIPIENT: Address = "0x4444444444444444444444444444444444444444";

    // Unit 0: 2 payout legs, nonzero compositionRoot, a nonzero fee. Unit 1: a single leg, no composition, no fee.
    const input = {
      chainId: 31337n,
      factory: FACTORY,
      implementation: IMPL,
      token: TOKEN,
      payer: payer.address,
      operator: operator.address,
      jobIdHash: jobIdHashOf("pcc:vnext:anvil-read-unit-configs"),
      termsHash: keccak256(stringToHex("pcc:vnext:anvil-read-unit-configs:terms")),
      policyNonce: 1n,
      acceptedPolicyDigest: zeroHash,
      expiry: now + 86_400n,
      fundingTime: now,
      units: [
        buildUnitConfig({
          milestoneIndex: 0n,
          stepId: keccak256(stringToHex("pcc:vnext:anvil-read-unit-configs:step-0")),
          requiredTier: 1,
          g: 1_000_000_003n,
          feeBps: 235,
          feeRecipient: FEE_RECIPIENT,
          reclaimAt: now + 30n * 86_400n,
          compositionSchemaVersion: 1,
          compositionRoot: keccak256(stringToHex("pcc:vnext:anvil-read-unit-configs:composition-root")),
          payouts: [
            { recipient: RECIP_A, amount: 500_000_000n },
            { recipient: RECIP_B, amount: 476_500_003n },
          ],
        }),
        buildUnitConfig({
          milestoneIndex: 1n,
          stepId: keccak256(stringToHex("pcc:vnext:anvil-read-unit-configs:step-1")),
          requiredTier: 0,
          g: 2_000_000n,
          feeBps: 0,
          feeRecipient: "0x0000000000000000000000000000000000000000",
          reclaimAt: now + 20n * 86_400n,
          compositionSchemaVersion: 0,
          compositionRoot: zeroHash,
          payouts: [{ recipient: RECIP_C, amount: 2_000_000n }],
        }),
      ],
    };
    const compiled = compileVNextPolicy(input);
    const acc: PolicyAcceptance = {
      expiry: compiled.expiry,
      payerSignature: await payer.sign({ hash: compiled.digest }),
      operatorSignature: await operator.sign({ hash: compiled.digest }),
    };

    await send(relayer, { address: FACTORY, abi: VNextSettlementEscrowFactoryABI, functionName: "createEscrow", args: [compiled.identity] } as never);
    const beforeFund = (await pub.getBlock()).number;

    // Before fund(): unfunded, fails closed by name, never throws.
    let r = await readUnitConfigs({ client: pub, escrow: compiled.escrow, blockNumber: beforeFund });
    expect(r.ok).toBe(false);
    expect(failed(r)).toContain("escrow funded (unitCount > 0)");
    expect(r.units).toEqual([]);

    const TOKEN_ABI = [
      { name: "mint", type: "function", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [] },
      {
        name: "approve",
        type: "function",
        stateMutability: "nonpayable",
        inputs: [{ type: "address" }, { type: "uint256" }],
        outputs: [{ type: "bool" }],
      },
    ] as const;
    await send(payer, { address: TOKEN, abi: TOKEN_ABI, functionName: "mint", args: [payer.address, compiled.totalGross] } as never);
    await send(payer, { address: TOKEN, abi: TOKEN_ABI, functionName: "approve", args: [compiled.escrow, compiled.totalGross] } as never);
    await send(relayer, { address: compiled.escrow, abi: VNextSettlementEscrowABI, functionName: "fund", args: [compiled.configs, acc] } as never);
    const fundedAt = (await pub.getBlock()).number;

    // After fund(), at the (then-)latest block: every unit reconstructs, byte-for-byte, and the three proofs pass.
    r = await readUnitConfigs({ client: pub, escrow: compiled.escrow });
    expect(failed(r)).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.chainId).toBe(31337);
    expect(r.escrow).toBe(compiled.escrow);
    expect(r.prePolicyRoot).toBe(compiled.prePolicyRoot);
    expect(r.units).toHaveLength(2);
    expect(r.units.map((u) => u.unitId)).toEqual(compiled.unitIds);
    expect(r.units.map((u) => u.config)).toEqual(compiled.configs);
    // The exact property N102 needs: each unit's payout legs (recipient AND amount), in their on-chain order.
    expect(r.units[0]!.config.payouts).toEqual([
      { recipient: RECIP_A, amount: 500_000_000n },
      { recipient: RECIP_B, amount: 476_500_003n },
    ]);
    expect(r.units[1]!.config.payouts).toEqual([{ recipient: RECIP_C, amount: 2_000_000n }]);

    // A genuine HISTORICAL-block read: mine more blocks on top, then re-read PINNED at `fundedAt`. Still
    // ok:true and byte-identical — this is not merely "whatever happens to be head right now".
    await testClient.mine({ blocks: 5 });
    expect((await pub.getBlock()).number).toBeGreaterThan(fundedAt);
    r = await readUnitConfigs({ client: pub, escrow: compiled.escrow, blockNumber: fundedAt });
    expect(r.blockNumber).toBe(fundedAt);
    expect(failed(r)).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.units.map((u) => u.config)).toEqual(compiled.configs);
  }, 300_000);
});
