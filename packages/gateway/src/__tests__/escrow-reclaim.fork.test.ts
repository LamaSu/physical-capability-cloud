/**
 * LIVE-CHAIN FORK TEST: the V3 deadline-reclaim primitive (N79) against the REAL MilestoneEscrowV3 on anvil.
 *
 * escrow-reclaim.test.ts proves the decision against a mocked chain client. This runs the gateway's own code
 * (getReclaimStateV3, reclaimAfterDeadlineV3 and reclaimEscrowV3, with the new ABI entries) against the contract.
 * The escrows are deployed by V3ReclaimForkFixture with the gateway signer as payer, as the Mode-A flow creates them.
 * The test then adds milestones and funds as that payer.
 *   1. Before the deadline it refuses `not_due` and sends nothing.
 *   2. The window read honours a payer-set reclaimDeadlineSeconds: that escrow reclaims after one hour, while the
 *      default-window escrow is still early.
 *   3. Past fundedAt + 30 days it reclaims every milestone: each reads Refunded and the payer is repaid in full.
 *   4. A repeat sends nothing (`already_refunded`).
 *   5. An escrow whose payer is not the gateway signer is refused `not_payer`, with nothing sent.
 *
 * Env note: escrow-client captures PCC_GATEWAY_PRIVATE_KEY / PCC_RPC_URL / PCC_NETWORK at module load, so the gateway
 * modules are imported dynamically in beforeAll, after the anvil env is set.
 * Requires `anvil` (ANVIL_BIN or PATH) and the fixture artifact built WITHOUT dynamic test linking
 * (`forge build --no-dynamic-test-linking` in packages/contracts). forge 1.8 links test-directory contracts through
 * cheatcodes by default, and such bytecode only deploys inside forge's own EVM. When anvil or a deployable artifact
 * is missing, the suite skips with the reason (CI's node job has no Foundry).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  createTestClient,
  http,
  defineChain,
  keccak256,
  toBytes,
  type Address,
  type Hex,
  type PublicClient,
  type TestClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const PORT = 8581;
const RPC_URL = `http://127.0.0.1:${PORT}`;
const CHAIN_ID = 84532; // matches escrow-client's base-sepolia config
// Anvil's well-known dev keys (never real keys): #0 is the gateway signer, #1 a stranger.
const KEY_GATEWAY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const KEY_STRANGER = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
const GATEWAY = privateKeyToAccount(KEY_GATEWAY);
const STRANGER = privateKeyToAccount(KEY_STRANGER);
const OPERATOR = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as Address; // anvil #2, the payee

const USDC = (n: number) => BigInt(n) * 1_000_000n;
const MINT = USDC(100);
const DAY = 24 * 3600;

const anvilChain = defineChain({
  id: CHAIN_ID,
  name: "anvil-reclaim",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});

const ERC20 = [
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { name: "approve", type: "function", stateMutability: "nonpayable", inputs: [{ name: "s", type: "address" }, { name: "v", type: "uint256" }], outputs: [{ name: "", type: "bool" }] },
] as const;
const SET_RECLAIM_DEADLINE = [
  { name: "setReclaimDeadline", type: "function", stateMutability: "nonpayable", inputs: [{ name: "_seconds", type: "uint256" }], outputs: [] },
] as const;

/** forge's cheatcode address: present in bytecode built with dynamic test linking, which anvil cannot deploy. */
const CHEATCODE_ADDRESS = "7109709ecfa91a80626ff3989d68f67f5b1dd12d";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ARTIFACT = resolve(HERE, "../../../contracts/out/V3ReclaimForkFixture.sol/V3ReclaimForkFixture.json");

let anvil: ChildProcess | undefined;
let publicClient: PublicClient;
let testClient: TestClient;
let available = false;
let skipReason = "";

let reclaimEscrowV3: typeof import("../services/escrow-reclaim.js").reclaimEscrowV3;
let getReclaimStateV3: typeof import("../contracts/escrow-client.js").getReclaimStateV3;
let MilestoneEscrowV3ABI: typeof import("@pcc/contracts/abi").MilestoneEscrowV3ABI;

/** Three escrows: A (default 30-day window, two milestones), B (a payer-set one-hour window), C (paid by a stranger). */
const E = {} as Record<"A" | "B" | "C", { escrow: Address; usdc: Address; payer: Address }>;

/** Wait for anvil to answer. Gives up at once if it failed to start (e.g. not installed), so the suite skips fast. */
async function waitForAnvil(spawnFailed: () => Error | undefined): Promise<void> {
  const probe = createPublicClient({ chain: anvilChain, transport: http(RPC_URL, { retryCount: 0 }) });
  for (let i = 0; i < 100; i++) {
    const failed = spawnFailed();
    if (failed) throw failed;
    try {
      await probe.getBlockNumber();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error("anvil did not become ready within 10s");
}

/** Deploy a fixture escrow with `payer`, then add milestones and fund AS that payer, as production does. */
async function makeEscrow(key: Hex, amounts: number[], windowSeconds?: number) {
  const account = privateKeyToAccount(key);
  const wallet = createWalletClient({ account, chain: anvilChain, transport: http(RPC_URL) });
  const artifact = JSON.parse(readFileSync(FIXTURE_ARTIFACT, "utf8"));
  const deploy = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode.object as Hex, args: [account.address, MINT] });
  const fixture = (await publicClient.waitForTransactionReceipt({ hash: deploy })).contractAddress!;
  const read = (functionName: "escrow" | "usdc") => publicClient.readContract({ address: fixture, abi: artifact.abi, functionName }) as Promise<Address>;
  const [escrow, usdc] = [await read("escrow"), await read("usdc")];

  const send = async (hash: Hex) => expect((await publicClient.waitForTransactionReceipt({ hash })).status).toBe("success");
  for (const [i, amount] of amounts.entries()) {
    await send(await wallet.writeContract({
      address: escrow,
      abi: MilestoneEscrowV3ABI,
      functionName: "addMilestone",
      args: [keccak256(toBytes(`step-${i}`)), OPERATOR, USDC(amount), 0n, 0n, 0, `job-reclaim-${i}`],
    }));
  }
  if (windowSeconds !== undefined) {
    await send(await wallet.writeContract({ address: escrow, abi: SET_RECLAIM_DEADLINE, functionName: "setReclaimDeadline", args: [BigInt(windowSeconds)] }));
  }
  const total = amounts.reduce((a, b) => a + USDC(b), 0n);
  await send(await wallet.writeContract({ address: usdc, abi: ERC20, functionName: "approve", args: [escrow, total] }));
  await send(await wallet.writeContract({ address: escrow, abi: MilestoneEscrowV3ABI, functionName: "fund" }));
  return { escrow, usdc, payer: account.address };
}

const balanceOf = (usdc: Address, who: Address) =>
  publicClient.readContract({ address: usdc, abi: ERC20, functionName: "balanceOf", args: [who] });

async function statuses(escrow: Address): Promise<number[]> {
  return (await getReclaimStateV3(escrow)).milestones.map((m) => m.status);
}

async function advance(seconds: number): Promise<void> {
  await testClient.increaseTime({ seconds });
  await testClient.mine({ blocks: 1 });
}

beforeAll(async () => {
  if (!existsSync(FIXTURE_ARTIFACT)) {
    skipReason = `fixture artifact missing (run \`forge build --no-dynamic-test-linking\` in packages/contracts): ${FIXTURE_ARTIFACT}`;
    return;
  }
  if (String(JSON.parse(readFileSync(FIXTURE_ARTIFACT, "utf8")).bytecode.object).toLowerCase().includes(CHEATCODE_ADDRESS)) {
    skipReason = "fixture was built with dynamic test linking (forge 1.8's default); rebuild with `forge build --no-dynamic-test-linking`";
    return;
  }
  process.env.PCC_GATEWAY_PRIVATE_KEY = KEY_GATEWAY;
  process.env.PCC_RPC_URL = RPC_URL;
  process.env.PCC_NETWORK = "base-sepolia";

  const anvilBin = process.env.ANVIL_BIN || "anvil";
  anvil = spawn(
    anvilBin,
    ["--port", String(PORT), "--chain-id", String(CHAIN_ID), "--gas-limit", "500000000", "--code-size-limit", "200000", "--silent"],
    { stdio: "ignore" },
  );
  let spawnErr: Error | undefined;
  anvil.on("error", (e) => (spawnErr = e as Error));
  publicClient = createPublicClient({ chain: anvilChain, transport: http(RPC_URL) });
  testClient = createTestClient({ chain: anvilChain, mode: "anvil", transport: http(RPC_URL) });
  try {
    await waitForAnvil(() => spawnErr);
  } catch (e) {
    skipReason = `anvil unavailable (${anvilBin}): ${spawnErr?.message ?? (e as Error).message}`;
    return;
  }

  ({ reclaimEscrowV3 } = await import("../services/escrow-reclaim.js"));
  ({ getReclaimStateV3 } = await import("../contracts/escrow-client.js"));
  ({ MilestoneEscrowV3ABI } = await import("@pcc/contracts/abi"));

  E.A = await makeEscrow(KEY_GATEWAY, [30, 20]);
  E.B = await makeEscrow(KEY_GATEWAY, [10], 3600);
  E.C = await makeEscrow(KEY_STRANGER, [10]);
  available = true;
}, 90_000);

afterAll(() => {
  if (anvil && !anvil.killed) anvil.kill("SIGKILL");
});

describe("V3 deadline reclaim: live anvil fork", () => {
  it("boots anvil and deploys real escrows, or skips with a clear reason", () => {
    if (!available) {
      console.warn(`[escrow-reclaim.fork] SKIPPED: ${skipReason}`);
      expect(skipReason.length).toBeGreaterThan(0);
      return;
    }
    expect(GATEWAY.address).toBe(E.A.payer);
  });

  it("reads the window in force: the 30-day default, or the payer's own", async () => {
    if (!available) return;
    expect((await getReclaimStateV3(E.A.escrow)).windowSeconds).toBe(BigInt(30 * DAY));
    expect((await getReclaimStateV3(E.B.escrow)).windowSeconds).toBe(3600n);
  });

  it("before the deadline it refuses not_due and sends nothing", async () => {
    if (!available) return;
    const before = await balanceOf(E.A.usdc, E.A.payer);
    const out = await reclaimEscrowV3(E.A.escrow);
    const state = await getReclaimStateV3(E.A.escrow);
    expect(out).toEqual(expect.objectContaining({ outcome: "refused", reason: "not_due", dueAt: state.fundedAt + BigInt(30 * DAY) }));
    expect(await statuses(E.A.escrow)).toEqual([1, 1]);
    expect(await balanceOf(E.A.usdc, E.A.payer)).toBe(before);
  });

  it("a payer-set one-hour window is honoured: B reclaims after an hour while A is still early", async () => {
    if (!available) return;
    await advance(3601);
    const out = await reclaimEscrowV3(E.B.escrow);
    expect(out).toEqual(expect.objectContaining({ outcome: "reclaimed", reclaimed: [expect.objectContaining({ index: 0 })] }));
    expect(await statuses(E.B.escrow)).toEqual([7]);
    expect(await balanceOf(E.B.usdc, E.B.payer)).toBe(MINT);
    expect(await reclaimEscrowV3(E.A.escrow)).toEqual(expect.objectContaining({ outcome: "refused", reason: "not_due" }));
  });

  it("past fundedAt + 30 days it reclaims every milestone, and the payer is repaid in full", async () => {
    if (!available) return;
    await advance(30 * DAY);
    const out = await reclaimEscrowV3(E.A.escrow);
    expect(out).toEqual(expect.objectContaining({ outcome: "reclaimed", alreadyRefunded: [] }));
    expect((out as { reclaimed: Array<{ index: number }> }).reclaimed.map((r) => r.index)).toEqual([0, 1]);
    expect(await statuses(E.A.escrow)).toEqual([7, 7]);
    expect(await balanceOf(E.A.usdc, E.A.payer)).toBe(MINT);
    expect(await balanceOf(E.A.usdc, E.A.escrow)).toBe(0n);
    expect(await balanceOf(E.A.usdc, OPERATOR)).toBe(0n);
  });

  it("a repeat sends nothing: already_refunded", async () => {
    if (!available) return;
    const nonce = await publicClient.getTransactionCount({ address: GATEWAY.address });
    expect(await reclaimEscrowV3(E.A.escrow)).toEqual({ outcome: "already_refunded", escrow: E.A.escrow, alreadyRefunded: [0, 1] });
    expect(await publicClient.getTransactionCount({ address: GATEWAY.address })).toBe(nonce);
  });

  it("an escrow the gateway signer does not pay for is refused not_payer, and nothing is sent", async () => {
    if (!available) return;
    const nonce = await publicClient.getTransactionCount({ address: GATEWAY.address });
    expect(await reclaimEscrowV3(E.C.escrow)).toEqual(
      expect.objectContaining({ outcome: "refused", reason: "not_payer", payer: STRANGER.address }),
    );
    expect(await statuses(E.C.escrow)).toEqual([1]);
    expect(await publicClient.getTransactionCount({ address: GATEWAY.address })).toBe(nonce);
  });
});
