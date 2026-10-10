/**
 * The buyer-funding SDK (`@pcc/spec/funding`, buyer-funding plan S3.1) end to end against the REAL V-next contracts on
 * a local anvil chain (implementer-bravo, pcc-adk). The committed `test/fixtures/vnext-anvil/PreflightAnvilFixture.s.sol`
 * deploys the real factory, implementation and library (with mock attesters and MockUSDC).
 *
 * The gateway's side (plan §3 step 4) uses the CANONICAL compiler (`compileVNextPolicy`): it takes the operator's
 * signature, creates the escrow, and hands the buyer the prepare payload as JSON. The buyer's side is only the SDK. So
 * the SDK's independent recomputation is checked against the canonical compiler AND the real contracts:
 *   - a buyer EOA runs prepare -> sign -> approve -> fund; the escrow's own state says funded, the balances move by
 *     exactly ΣG, and a retry sends nothing;
 *   - the buyer's JobPolicy signature is exactly what the contract verifies (a relayed fund() simulates with it);
 *   - refusals before any send: a tampered config, an unlimited approve, and a consistent payload from a rival factory;
 *   - `unchanged`: a fund() the chain would refuse (a disabled cohort) is never sent;
 *   - `indeterminate`: a fund() still pending when the receipt wait ends is not success, and reading the escrow later
 *     resolves it;
 *   - a reorg makes a read pinned to the vanished block unreadable, never "funded".
 *
 * OPT-IN, like the other anvil suites: it needs foundry's `anvil` and `forge`, so it runs only with VNEXT_ANVIL_E2E=1,
 * and it needs @pcc/spec built (the package resolves `@pcc/spec/funding` from its dist):
 *   pnpm --filter @pcc/spec build && VNEXT_ANVIL_E2E=1 pnpm --filter @pcc/contracts exec vitest run ts/__tests__/buyer-funding.anvil.test.ts
 * Binaries come from $FOUNDRY_BIN, else ~/.foundry/bin, else PATH. Local anvil only. No private key is committed: every
 * party is generated per run and funded with anvil_setBalance; the fixture deploys from anvil's unlocked default account.
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
  custom,
  decodeFunctionData,
  encodeFunctionData,
  http,
  keccak256,
  maxUint256,
  parseAbi,
  parseEventLogs,
  recoverAddress,
  stringToHex,
  zeroAddress,
  zeroHash,
  type Address,
  type Chain,
  type Hex,
  type PrivateKeyAccount,
  type PublicClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  FUNDING_PREPARE_SCHEMA,
  FundingRefusal,
  approveAndFund,
  classifyFunding,
  prepareFunding,
  readFundedState,
  signJobPolicy,
  type FundingRefusalCode,
  type PreparedFunding,
} from "@pcc/spec/funding";
import {
  VNextSettlementEscrowABI,
  VNextSettlementEscrowFactoryABI,
  VNextUnitState,
  buildUnitConfig,
  compileVNextPolicy,
  describeRevert,
  jobIdHashOf,
  type CompiledVNextPolicy,
} from "../vnext/index.js";

const RUN = process.env.VNEXT_ANVIL_E2E === "1";
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const FIXTURE = join(ROOT, "test/fixtures/vnext-anvil/PreflightAnvilFixture.s.sol") + ":PreflightAnvilFixture";
/** anvil's first default account, unlocked on every anvil. An address, not a key. */
const ANVIL_DEFAULT_SENDER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const DAY = 86_400n;

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
  "function allowance(address,address) view returns (uint256)",
]);
const ATTESTER_ABI = parseAbi(["function setEnabled(bool)"]);

/** The JSON wire form the gateway sends: bigint as a decimal string. */
const toWire = (value: unknown): any => JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));

async function refusal(p: Promise<unknown>): Promise<FundingRefusalCode> {
  try {
    await p;
  } catch (e) {
    if (e instanceof FundingRefusal) return e.code;
    throw e;
  }
  throw new Error("expected a FundingRefusal, but the call succeeded");
}

describe.skipIf(!RUN)("buyer funding with @pcc/spec/funding against the real V-next contracts on anvil", () => {
  let anvil: ChildProcess | undefined;
  let rpc = "";
  let chain: Chain;
  let pub: PublicClient;
  let testClient: ReturnType<typeof createTestClient>;
  let deployed: { FACTORY: Address; IMPL: Address; TOKEN: Address; ORACLE: Address };
  let buyer: PrivateKeyAccount;
  let operator: PrivateKeyAccount;
  let gateway: PrivateKeyAccount;
  let feeSink: Address;

  const deploy = () => {
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
    return { FACTORY: grab("FACTORY"), IMPL: grab("IMPL"), TOKEN: grab("TOKEN"), ORACLE: grab("ORACLE") };
  };
  const wallet = (account: PrivateKeyAccount) => createWalletClient({ account, chain, transport: http(rpc) });
  const send = async (account: PrivateKeyAccount, request: unknown) => {
    const hash = await wallet(account).writeContract(request as never);
    const receipt = await pub.waitForTransactionReceipt({ hash });
    expect(receipt.status).toBe("success");
    return receipt;
  };
  const usdcBalance = (who: Address) => pub.readContract({ address: deployed.TOKEN, abi: TOKEN_ABI, functionName: "balanceOf", args: [who] });
  const allowance = (escrow: Address) => pub.readContract({ address: deployed.TOKEN, abi: TOKEN_ABI, functionName: "allowance", args: [buyer.address, escrow] });
  const escrowRead = (escrow: Address, functionName: string, args: readonly unknown[] = []) =>
    pub.readContract({ address: escrow, abi: VNextSettlementEscrowABI, functionName, args } as never) as Promise<unknown>;
  const pins = () => ({ "31337": { usdc: deployed.TOKEN, factory: deployed.FACTORY } });

  beforeAll(async () => {
    const port = await freePort();
    rpc = `http://127.0.0.1:${port}`;
    anvil = spawn(bin("anvil"), ["--port", String(port), "--silent"], { stdio: "ignore" });
    chain = { id: 31337, name: "anvil", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } };
    pub = createPublicClient({ chain, transport: http(rpc), pollingInterval: 100 });
    testClient = createTestClient({ mode: "anvil", chain, transport: http(rpc) });
    for (let k = 0; ; k++) {
      try {
        await pub.getChainId();
        break;
      } catch {
        if (k > 80) throw new Error("anvil did not start");
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    deployed = deploy();
    [buyer, operator, gateway] = [0, 1, 2].map(() => privateKeyToAccount(generatePrivateKey())) as [PrivateKeyAccount, PrivateKeyAccount, PrivateKeyAccount];
    feeSink = privateKeyToAccount(generatePrivateKey()).address;
    for (const a of [buyer, operator, gateway]) await testClient.setBalance({ address: a.address, value: 10n ** 20n });
    // The buyer holds more than any one job needs, so every balance assertion below is an exact delta.
    await send(buyer, { address: deployed.TOKEN, abi: TOKEN_ABI, functionName: "mint", args: [buyer.address, 100_000_000_000n] });
  }, 600_000);

  afterAll(() => {
    anvil?.kill();
  });

  /**
   * The gateway's side of plan §3 step 4: compile with the canonical compiler (payer = the buyer's wallet), take the
   * operator's signature, create the escrow (the gateway pays gas only), and return the prepare payload as JSON.
   */
  async function gatewayPrepare(label: string, d: { FACTORY: Address; IMPL: Address } = deployed) {
    const now = (await pub.getBlock()).timestamp;
    const compiled: CompiledVNextPolicy = compileVNextPolicy({
      chainId: 31337n,
      factory: d.FACTORY,
      implementation: d.IMPL,
      token: deployed.TOKEN,
      payer: buyer.address,
      operator: operator.address,
      jobIdHash: jobIdHashOf(`pcc:buyer-funding-e2e:${label}`),
      termsHash: keccak256(stringToHex(`pcc:buyer-funding-e2e:${label}:terms`)),
      policyNonce: 1n,
      acceptedPolicyDigest: keccak256(stringToHex(`pcc:buyer-funding-e2e:${label}:accepted`)),
      expiry: now + DAY,
      fundingTime: now,
      units: [
        buildUnitConfig({
          milestoneIndex: 0n,
          stepId: keccak256(stringToHex(`${label}:step-a`)),
          requiredTier: 0,
          g: 1_000_000_003n,
          feeBps: 235,
          feeRecipient: feeSink,
          reclaimAt: now + 30n * DAY,
          compositionSchemaVersion: 0,
          compositionRoot: zeroHash,
          payouts: [{ recipient: operator.address, amount: 976_500_003n }],
        }),
        buildUnitConfig({
          milestoneIndex: 1n,
          stepId: keccak256(stringToHex(`${label}:step-b`)),
          requiredTier: 1,
          g: 7_000_000n,
          feeBps: 0,
          feeRecipient: zeroAddress,
          reclaimAt: now + 45n * DAY,
          compositionSchemaVersion: 0,
          compositionRoot: zeroHash,
          payouts: [{ recipient: operator.address, amount: 7_000_000n }],
        }),
      ],
    });
    const operatorSignature = await operator.sign({ hash: compiled.digest });
    await send(gateway, { address: d.FACTORY, abi: VNextSettlementEscrowFactoryABI, functionName: "createEscrow", args: [compiled.identity] });
    const payload = toWire({
      schema: FUNDING_PREPARE_SCHEMA,
      chainId: compiled.chainId,
      factory: compiled.factory,
      escrow: compiled.escrow,
      usdc: compiled.token,
      totalGross: compiled.totalGross,
      expiry: compiled.expiry,
      typedData: compiled.typedData,
      approve: { token: compiled.token, spender: compiled.escrow, amount: compiled.totalGross },
      fund: { configs: compiled.configs, acceptance: { expiry: compiled.expiry, payerSignature: "0x", operatorSignature } },
    });
    return { compiled, operatorSignature, payload };
  }

  // Buyer choices come from the test's purchase record, independently of the gateway payload/compiler output.
  const prepare = async (payload: unknown, compiled: CompiledVNextPolicy, label: string) =>
    prepareFunding({ payload, wallet: wallet(buyer), publicClient: pub, quote: { maxTotalGross: compiled.totalGross }, pins: pins(),
      expect: {
        jobId: `pcc:buyer-funding-e2e:${label}`,
        operator: operator.address,
        payees: [operator.address],
        maxFeeBps: 235,
        feeRecipients: [feeSink],
        tiers: [0, 1],
        latestReclaimAt: (await pub.getBlock()).timestamp + 45n * DAY,
        termsHash: keccak256(stringToHex(`pcc:buyer-funding-e2e:${label}:terms`)),
        acceptedPolicyDigest: keccak256(stringToHex(`pcc:buyer-funding-e2e:${label}:accepted`)),
        compositionRoots: [zeroHash],
      },
    });

  it("a buyer EOA runs prepare -> sign -> approve -> fund; the escrow's own state says funded, and balances move by exactly ΣG", async () => {
    const { compiled, payload } = await gatewayPrepare("A");
    const prepared: PreparedFunding = await prepare(payload, compiled, "A");
    // The SDK's independent recomputation agrees with the canonical compiler.
    expect(prepared.escrow).toBe(compiled.escrow);
    expect(prepared.digest).toBe(compiled.digest);
    expect(prepared.jobPolicyHash).toBe(compiled.jobPolicyHash);
    expect(prepared.unitIds).toEqual(compiled.unitIds);
    expect(prepared.policyKey).toBe(compiled.policyKey);
    expect(prepared.totalGross).toBe(compiled.totalGross);

    const acceptance = await signJobPolicy({ prepared, wallet: wallet(buyer) });
    expect(await recoverAddress({ hash: compiled.digest, signature: acceptance })).toBe(buyer.address);

    const buyerBefore = await usdcBalance(buyer.address);
    const result = await approveAndFund({ prepared, wallet: wallet(buyer), publicClient: pub });
    expect(result.outcome).toBe("committed");
    expect(result.alreadyFunded).toBe(false);
    expect(result.stage).toBe("fund");
    expect(result.readBack.kind).toBe("funded_ours");
    expect(result.readBack.unitStates).toEqual([VNextUnitState.FUNDED_ACTIVE, VNextUnitState.FUNDED_ACTIVE]);

    // The escrow's own state (plan G5), read independently of the SDK.
    const [, , preRoot, jobPolicyHash] = (await escrowRead(compiled.escrow, "policy")) as [Address, bigint, Hex, Hex, Hex];
    expect(jobPolicyHash).toBe(compiled.jobPolicyHash);
    expect(preRoot).toBe(compiled.prePolicyRoot);
    expect(
      await pub.readContract({ address: deployed.FACTORY, abi: VNextSettlementEscrowFactoryABI, functionName: "fundedEscrowOf", args: [compiled.policyKey] }),
    ).toBe(compiled.escrow);
    for (const [i, id] of compiled.unitIds.entries()) {
      expect(await escrowRead(compiled.escrow, "unitIdAt", [BigInt(i)])).toBe(id);
      expect(await escrowRead(compiled.escrow, "unitState", [id])).toBe(VNextUnitState.FUNDED_ACTIVE);
    }
    // Balances: exactly ΣG moved from the buyer to the escrow, and the allowance was spent to zero.
    expect(buyerBefore - (await usdcBalance(buyer.address))).toBe(compiled.totalGross);
    expect(await usdcBalance(compiled.escrow)).toBe(compiled.totalGross);
    expect(await allowance(compiled.escrow)).toBe(0n);

    // The two transactions are exactly the plan's: approve(escrow, ΣG), then a payer-sent fund() with no payer signature.
    const approveTx = await pub.getTransaction({ hash: result.approveTx! });
    expect(approveTx.from.toLowerCase()).toBe(buyer.address.toLowerCase());
    expect(decodeFunctionData({ abi: TOKEN_ABI, data: approveTx.input }).args).toEqual([compiled.escrow, compiled.totalGross]);
    const fundTx = await pub.getTransaction({ hash: result.fundTx! });
    expect(fundTx.from.toLowerCase()).toBe(buyer.address.toLowerCase());
    expect(fundTx.to?.toLowerCase()).toBe(compiled.escrow.toLowerCase());
    const [, acceptanceArg] = decodeFunctionData({ abi: VNextSettlementEscrowABI, data: fundTx.input }).args as unknown as [unknown, { payerSignature: Hex }];
    expect(acceptanceArg.payerSignature).toBe("0x");
    const fundReceipt = await pub.getTransactionReceipt({ hash: result.fundTx! });
    const [funded] = parseEventLogs({ abi: VNextSettlementEscrowABI, logs: fundReceipt.logs, eventName: "Funded" });
    expect(funded?.args.totalGross).toBe(compiled.totalGross);
    expect(funded?.args.unitCount).toBe(2n);

    // A retry sends nothing: the escrow is already funded under this policy.
    const nonce = await pub.getTransactionCount({ address: buyer.address });
    const again = await approveAndFund({ prepared, wallet: wallet(buyer), publicClient: pub });
    expect(again.outcome).toBe("committed");
    expect(again.alreadyFunded).toBe(true);
    expect(await pub.getTransactionCount({ address: buyer.address })).toBe(nonce);
  }, 120_000);

  it("the buyer's JobPolicy signature is exactly what the contract verifies: a relayed fund() simulates with it, and reverts without it", async () => {
    const { compiled, operatorSignature, payload } = await gatewayPrepare("B");
    const prepared = await prepare(payload, compiled, "B");
    const signature = await signJobPolicy({ prepared, wallet: wallet(buyer) });
    // Test-only: the allowance a relayed fund() would pull. The SDK itself never relays (plan S3.3).
    await send(buyer, { address: deployed.TOKEN, abi: TOKEN_ABI, functionName: "approve", args: [compiled.escrow, compiled.totalGross] });
    const relayed = (payerSignature: Hex) =>
      pub.call({
        account: gateway.address,
        to: compiled.escrow,
        data: encodeFunctionData({
          abi: VNextSettlementEscrowABI,
          functionName: "fund",
          args: [compiled.configs as never, { expiry: compiled.expiry, payerSignature, operatorSignature }],
        }),
      });
    await expect(relayed(signature)).resolves.toBeDefined();
    const wrong = await buyer.sign({ hash: keccak256("0x01") });
    expect(describeRevert(await relayed(wrong).catch((e: unknown) => e))).toBe("BadSignature");
    expect(describeRevert(await relayed("0x").catch((e: unknown) => e))).toBe("OnlyPayer");
    expect((await readFundedState({ publicClient: pub, prepared })).kind).toBe("unfunded");
  }, 120_000);

  it("refuses before sending: a tampered config, an unlimited approve, and a consistent payload from a rival factory", async () => {
    const { compiled, payload } = await gatewayPrepare("C");
    const nonce = await pub.getTransactionCount({ address: buyer.address });

    const tampered = structuredClone(payload);
    tampered.fund.configs[0].payouts[0].amount = (BigInt(tampered.fund.configs[0].payouts[0].amount) - 1n).toString();
    tampered.fund.configs[0].n = (BigInt(tampered.fund.configs[0].n) - 1n).toString();
    tampered.fund.configs[0].f = (BigInt(tampered.fund.configs[0].f) + 1n).toString();
    expect(await refusal(prepare(tampered, compiled, "C"))).toBe("POLICY_ROOT_MISMATCH");

    const unlimited = structuredClone(payload);
    unlimited.approve.amount = maxUint256.toString();
    expect(await refusal(prepare(unlimited, compiled, "C"))).toBe("APPROVE_AMOUNT_NOT_TOTAL");

    // A rival deployment of the same contracts: its payload is internally consistent and its escrow really exists.
    const rival = deploy();
    const r = await gatewayPrepare("C-rival", rival);
    expect(await pub.getCode({ address: r.compiled.escrow })).not.toBe("0x");
    expect(await refusal(prepare(r.payload, r.compiled, "C-rival"))).toBe("FACTORY_NOT_PINNED");

    // Nothing was sent: no nonce used, no allowance, nothing funded.
    expect(await pub.getTransactionCount({ address: buyer.address })).toBe(nonce);
    expect(await allowance(compiled.escrow)).toBe(0n);
    const [, , , jobPolicyHash] = (await escrowRead(compiled.escrow, "policy")) as [Address, bigint, Hex, Hex, Hex];
    expect(jobPolicyHash).toBe(zeroHash);
  }, 120_000);

  it("unchanged: a fund() the chain would refuse (the primary cohort disabled after prepare) is never sent", async () => {
    const { compiled, payload } = await gatewayPrepare("D");
    const prepared = await prepare(payload, compiled, "D");
    await send(gateway, { address: deployed.ORACLE, abi: ATTESTER_ABI, functionName: "setEnabled", args: [false] });
    try {
      const buyerBefore = await usdcBalance(buyer.address);
      const result = await approveAndFund({ prepared, wallet: wallet(buyer), publicClient: pub });
      expect(result.outcome).toBe("unchanged");
      expect(result.stage).toBe("fund");
      expect(result.fundTx).toBeUndefined();
      expect(result.approveTx).toBeDefined();
      expect(result.readBack.kind).toBe("unfunded");
      expect(result.detail).toContain("InvalidOrDisabledCohort");
      expect(await usdcBalance(buyer.address)).toBe(buyerBefore);
      // The approve stands (documented): exactly ΣG, to an escrow that pulls only through fund().
      expect(await allowance(compiled.escrow)).toBe(compiled.totalGross);
    } finally {
      await send(gateway, { address: deployed.ORACLE, abi: ATTESTER_ABI, functionName: "setEnabled", args: [true] });
    }
  }, 120_000);

  it("indeterminate is not success: a fund() still pending when the receipt wait ends, resolved later by reading the escrow", async () => {
    const { compiled, payload } = await gatewayPrepare("E");
    const prepared = await prepare(payload, compiled, "E");
    // The buyer's wallet transport switches automine off just before the SECOND raw transaction (the fund) reaches anvil.
    const base = http(rpc)({ chain });
    let raws = 0;
    const stallingWallet = createWalletClient({
      account: buyer,
      chain,
      transport: custom({
        async request({ method, params }: { method: string; params?: unknown }) {
          if (method === "eth_sendRawTransaction" && ++raws === 2) await testClient.setAutomine(false);
          return base.request({ method, params } as never);
        },
      }),
    });
    try {
      const result = await approveAndFund({ prepared, wallet: stallingWallet, publicClient: pub, receiptTimeoutMs: 2_000 });
      expect(raws).toBe(2);
      expect(result.outcome).toBe("indeterminate");
      expect(result.stage).toBe("fund");
      expect(result.fundTx).toBeDefined();
      expect(result.readBack.kind).toBe("unfunded");
      // reviewer-charlie L7 (implementer-delta): a retry while that fund() is still in anvil's pool refuses, and sends
      // nothing: the buyer's nonce at "pending" stays where it was.
      const pendingNonce = await pub.getTransactionCount({ address: buyer.address, blockTag: "pending" });
      expect(pendingNonce).toBe((await pub.getTransactionCount({ address: buyer.address, blockTag: "latest" })) + 1);
      expect(await refusal(approveAndFund({ prepared, wallet: wallet(buyer), publicClient: pub }))).toBe("PAYER_TX_PENDING");
      expect(await pub.getTransactionCount({ address: buyer.address, blockTag: "pending" })).toBe(pendingNonce);
    } finally {
      await testClient.mine({ blocks: 1 });
      await testClient.setAutomine(true);
    }
    expect((await readFundedState({ publicClient: pub, prepared })).kind).toBe("funded_ours");
    const retry = await approveAndFund({ prepared, wallet: wallet(buyer), publicClient: pub });
    expect(retry.outcome).toBe("committed");
    expect(retry.alreadyFunded).toBe(true);
  }, 120_000);

  it("a reorg makes a read pinned to the vanished block unreadable, never funded", async () => {
    const { compiled, payload } = await gatewayPrepare("F");
    const prepared = await prepare(payload, compiled, "F");
    const snapshot = await testClient.snapshot();
    const result = await approveAndFund({ prepared, wallet: wallet(buyer), publicClient: pub });
    expect(result.outcome).toBe("committed");
    const fundedAt = result.readBack.blockHash!;
    await testClient.revert({ id: snapshot });
    const stale = await readFundedState({ publicClient: pub, prepared, blockHash: fundedAt });
    expect(stale.kind).toBe("unreadable");
    expect(classifyFunding({ kind: "mined", txHash: result.fundTx!, status: "success", blockHash: fundedAt }, stale.kind)).toBe("indeterminate");
    expect((await readFundedState({ publicClient: pub, prepared })).kind).toBe("unfunded");
  }, 120_000);
});
