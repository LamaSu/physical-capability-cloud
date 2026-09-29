/**
 * The funding preflight against the REAL contracts on a local anvil chain: the real-contract regression astra asked
 * for on #367. `test/fixtures/vnext-anvil/PreflightAnvilFixture.s.sol` deploys the real factory, implementation and
 * library (with mock attesters and MockUSDC). This then checks that the preflight agrees with the chain at each step:
 *   - it fails by name before the escrow exists, and on each missing prerequisite;
 *   - it passes exactly when the signed fund() then succeeds;
 *   - it reports the state AT the block it pins, reads and simulation alike;
 *   - it refuses an acceptance signed for another expiry, which the chain itself would fund.
 *
 * OPT-IN. It needs foundry's `anvil` and `forge`, so it runs only with VNEXT_ANVIL_E2E=1. CI's node job has no
 * foundry and skips it; the unit suite (vnext-preflight.test.ts) and the forge suites run there.
 *   VNEXT_ANVIL_E2E=1 pnpm vitest run ts/__tests__/vnext-preflight.anvil.test.ts
 * Binaries come from $FOUNDRY_BIN, else ~/.foundry/bin, else PATH. No private key is committed: the three parties are
 * generated per run and funded with anvil_setBalance, and the fixture deploys from anvil's unlocked default account.
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
  parseAbi,
  parseEventLogs,
  stringToHex,
  zeroHash,
  type Address,
  type Hex,
  type PrivateKeyAccount,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  VNextSettlementEscrowABI,
  VNextSettlementEscrowFactoryABI,
  buildUnitConfig,
  compileVNextPolicy,
  jobIdHashOf,
  preflightVNextFunding,
  type PolicyAcceptance,
  type VNextFundingPreflight,
} from "../vnext/index.js";

const RUN = process.env.VNEXT_ANVIL_E2E === "1";
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const FIXTURE = join(ROOT, "test/fixtures/vnext-anvil/PreflightAnvilFixture.s.sol") + ":PreflightAnvilFixture";
/** anvil's first default account, unlocked on every anvil. An address, not a key. */
const ANVIL_DEFAULT_SENDER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

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
const ATTESTER_ABI = parseAbi(["function setEnabled(bool)"]);
const failed = (r: VNextFundingPreflight) => r.checks.filter((c) => !c.ok).map((c) => c.name);

describe.skipIf(!RUN)("preflightVNextFunding against the real contracts on anvil", () => {
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
      // --slow: send each transaction only after the previous one is mined. Without it, forge's concurrent sends
      // through the unlocked account were seen to leave a nonce gap that anvil queued forever.
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

  it("agrees with the chain at every step, and reports the state at the block it pins", async () => {
    const { FACTORY, IMPL, TOKEN, ORACLE } = deployed;
    const chain = {
      id: 31337,
      name: "anvil",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [rpc] } },
    } as const;
    const pub = createPublicClient({ chain, transport: http(rpc) });
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
    const input = {
      chainId: 31337n,
      factory: FACTORY,
      implementation: IMPL,
      token: TOKEN,
      payer: payer.address,
      operator: operator.address,
      jobIdHash: jobIdHashOf("pcc:vnext:anvil-preflight"),
      termsHash: keccak256(stringToHex("pcc:vnext:anvil-preflight:terms")),
      policyNonce: 1n,
      acceptedPolicyDigest: zeroHash,
      expiry: now + 86_400n,
      fundingTime: now,
      units: [
        buildUnitConfig({
          milestoneIndex: 0n,
          stepId: keccak256(stringToHex("pcc:vnext:anvil-preflight:step")),
          requiredTier: 1,
          g: 1_000_000_003n,
          feeBps: 235,
          feeRecipient: "0x4444444444444444444444444444444444444444",
          reclaimAt: now + 30n * 86_400n,
          compositionSchemaVersion: 0,
          compositionRoot: zeroHash,
          payouts: [
            { recipient: "0x1111111111111111111111111111111111111111", amount: 500_000_000n },
            { recipient: "0x2222222222222222222222222222222222222222", amount: 476_500_003n },
          ],
        }),
      ],
    };
    const compiled = compileVNextPolicy(input);
    const sign = async (digest: Hex, expiry: bigint): Promise<PolicyAcceptance> => ({
      expiry,
      payerSignature: await payer.sign({ hash: digest }),
      operatorSignature: await operator.sign({ hash: digest }),
    });
    const acc = await sign(compiled.digest, compiled.expiry);
    const pf = (acceptance: PolicyAcceptance = acc, blockNumber?: bigint) =>
      preflightVNextFunding(pub, { compiled, acceptance, sender: relayer.address, blockNumber });

    // 0. before createEscrow: fails by name and does not simulate; the factory predicts the compiled address
    let r = await pf();
    expect(failed(r)).toContain("escrow created");
    expect(failed(r)).not.toContain("predicted escrow");
    expect(r.simulation.ok).toBe(false);
    const beforeCreate = r.blockNumber!;

    // 1. created, payer unfunded: exactly the two pull checks fail. Pinned BEFORE the creation, it still sees no escrow.
    await send(relayer, { address: FACTORY, abi: VNextSettlementEscrowFactoryABI, functionName: "createEscrow", args: [compiled.identity] } as never);
    r = await pf();
    expect(failed(r)).toEqual(["payer balance", "payer allowance to the escrow"]);
    r = await pf(acc, beforeCreate);
    expect(r.blockNumber).toBe(beforeCreate);
    expect(failed(r)).toContain("escrow created");

    // 2. ready: every check passes AND the signed fund() simulates
    await send(payer, { address: TOKEN, abi: TOKEN_ABI, functionName: "mint", args: [payer.address, compiled.totalGross] } as never);
    await send(payer, { address: TOKEN, abi: TOKEN_ABI, functionName: "approve", args: [compiled.escrow, compiled.totalGross] } as never);
    r = await pf();
    expect(failed(r)).toEqual([]);
    expect(r.simulation).toEqual({ ok: true });
    expect(r.ok).toBe(true);
    const ready = r.blockNumber!;

    // 3. the primary cohort disabled: fails by name and the simulation reverts at the head, while the same preflight
    //    pinned at `ready` still passes, reads AND simulation, because it reports its own block
    await send(payer, { address: ORACLE, abi: ATTESTER_ABI, functionName: "setEnabled", args: [false] } as never);
    r = await pf();
    expect(failed(r)).toEqual(["primary cohort enabled"]);
    expect(r.simulation.error).toBe("InvalidOrDisabledCohort");
    r = await pf(acc, ready);
    expect(r.blockNumber).toBe(ready);
    expect(r.ok).toBe(true);
    await send(payer, { address: ORACLE, abi: ATTESTER_ABI, functionName: "setEnabled", args: [true] } as never);

    // 4. a payer signature over another digest: every named check passes, the simulation reverts
    r = await pf({ ...acc, payerSignature: await payer.sign({ hash: keccak256("0x01") }) });
    expect(failed(r)).toEqual([]);
    expect(r.simulation.error).toBe("BadSignature");
    expect(r.ok).toBe(false);

    // 5. a relayer without the payer's signature: refused by name (OnlyPayer), and the chain agrees
    r = await pf({ ...acc, payerSignature: "0x" });
    expect(failed(r)).toEqual(["acceptance shape"]);
    expect(r.simulation.error).toBe("OnlyPayer");

    // 6. astra's case, on the real chain: an acceptance validly signed for a LATER expiry. The expiry is not in the
    //    salt, so it is the same escrow, and the chain would fund it. It is not the compiled policy, so the preflight
    //    refuses it by name.
    const later = compileVNextPolicy({ ...input, expiry: compiled.expiry + 100n });
    expect(later.escrow).toBe(compiled.escrow);
    r = await pf(await sign(later.digest, later.expiry));
    expect(r.simulation).toEqual({ ok: true });
    expect(failed(r)).toEqual(["acceptance expiry matches the compiled policy"]);
    expect(r.ok).toBe(false);

    // 7. the real fund() from the relayer succeeds, and the chain commits exactly the compiled values
    const receipt = await send(relayer, {
      address: compiled.escrow,
      abi: VNextSettlementEscrowABI,
      functionName: "fund",
      args: [compiled.configs, acc],
    } as never);
    const read = (functionName: string, args: readonly unknown[] = []) =>
      pub.readContract({ address: compiled.escrow, abi: VNextSettlementEscrowABI, functionName, args } as never) as Promise<unknown>;
    const [, , preRoot, jobPolicyHash] = (await read("policy")) as [Address, bigint, Hex, Hex, Hex];
    expect(preRoot).toBe(compiled.prePolicyRoot);
    expect(jobPolicyHash).toBe(compiled.jobPolicyHash);
    expect(await read("unitIdAt", [0n])).toBe(compiled.unitIds[0]);
    expect(await read("feeScheduleHashOf", [compiled.unitIds[0]])).toBe(compiled.perUnit[0]!.feeScheduleHash);
    const [accepted] = parseEventLogs({ abi: VNextSettlementEscrowABI, logs: receipt.logs, eventName: "PolicyAccepted" });
    expect(accepted?.args.unitsRoot).toBe(compiled.unitsRoot);
    expect(await pub.readContract({ address: TOKEN, abi: TOKEN_ABI, functionName: "balanceOf", args: [compiled.escrow] })).toBe(
      compiled.totalGross,
    );

    // 8. after funding it fails (sealed, job funded); pinned at `ready`, it still reports that block's state
    r = await pf();
    expect(failed(r)).toEqual(expect.arrayContaining(["escrow initialized, not sealed", "job not already funded"]));
    r = await pf(acc, ready);
    expect(r.ok).toBe(true);
  }, 300_000);
});
