/**
 * LIVE-CHAIN FORK TEST — the settlement crank + keeper against a REAL escrow.
 *
 * settlement-crank.test.ts and settlement-keeper.test.ts prove the LOGIC against a
 * MOCKED escrow-client. This test proves the crank actually works ON-CHAIN: it
 * spins up a local anvil, deploys a REAL MilestoneEscrowV2 (clone + MockUSDC +
 * MockEAS) via the SettlementKeeperForkFixture, and then runs the ACTUAL gateway
 * TypeScript — `driveSettlement` (Step 1) and `runKeeperSweep` (Step 2) — against
 * it via viem. Step 0 fork-proved the CONTRACT's dedup; this closes the gap by
 * proving the crank's viem revert-mapping + confirming-read logic on a live chain.
 *
 * Proven here, end to end on anvil:
 *   1. the crank attests a funded→evidenced milestone (real submitAttestation), and
 *      the KEEPER releases it once the challenge window closes (the self-heal);
 *   2. re-running the keeper is idempotent — no double-release (the P7 invariant,
 *      now exercised through the real crank);
 *   3. a Disputed escrow is reported terminal_other (settled=false) and NEVER released.
 *
 * Env note: escrow-client.ts captures PCC_GATEWAY_PRIVATE_KEY / PCC_NETWORK at
 * module load, so all gateway modules are DYNAMICALLY imported inside beforeAll,
 * AFTER the anvil env is set. Nothing gateway-side is imported statically.
 *
 * Requires `anvil` on PATH and a built fixture artifact (forge build). When either
 * is absent the suite skips with a clear message rather than hard-failing (CI hosts
 * without Foundry). AGENT_NAME: keeper-opus
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
  type WalletClient,
  type TestClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

// ── Anvil / chain config ────────────────────────────────────────────────────
const PORT = 8577;
const RPC_URL = `http://127.0.0.1:${PORT}`;
// anvil is started with --chain-id 84532 so it matches escrow-client's base-sepolia
// deployment chain (viem writeContract rejects a chain-id mismatch otherwise).
const CHAIN_ID = 84532;
// Anvil default account #0 (well-known dev key; never a real key).
const ANVIL_KEY0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const ORACLE = "0x00000000000000000000000000000000000000a0" as Address;

const AMOUNT = 100_000_000n; // 100 USDC (6-dec)
const CHALLENGE_WINDOW = 3600; // 1h — nonzero so the crank stops at the open window
const EVIDENCE_HASH = keccak256(toBytes("evidence-bundle-keeper-fork-001"));

const anvilChain = defineChain({
  id: CHAIN_ID,
  name: "anvil-fork",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});

const ERC20_BALANCE_ABI = [
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
] as const;

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ARTIFACT = resolve(
  HERE,
  "../../../contracts/out/SettlementKeeperForkFixture.sol/SettlementKeeperForkFixture.json",
);

// A fake repos whose escrows.findAll() feeds the keeper one escrow row; updateStatus is captured.
function makeRepos(rows: { id: string; contractAddress: string; status: string; version?: string | null }[]) {
  const updates: { id: string; status: string }[] = [];
  const repos = {
    escrows: {
      findAll: () => rows,
      updateStatus: (id: string, status: string) => {
        updates.push({ id, status });
        const r = rows.find((x) => x.id === id);
        if (r) r.status = status;
        return r;
      },
    },
  } as any;
  return { repos, updates };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Loaded in beforeAll (dynamic — see env note above).
let publicClient: PublicClient;
let walletClient: WalletClient;
let testClient: TestClient;
let anvil: ChildProcess | undefined;
let available = false;
let skipReason = "";

// Dynamically-imported gateway surface.
let driveSettlement: typeof import("../services/settlement-crank.js").driveSettlement;
let runKeeperSweep: typeof import("../services/settlement-keeper.js").runKeeperSweep;
let getMilestoneV2: typeof import("../contracts/escrow-client.js").getMilestoneV2;
let MilestoneStatusV2: typeof import("../contracts/escrow-client.js").MilestoneStatusV2;

// Deployed fixtures.
let releaseEscrow: Address;
let releaseUsdc: Address;
let releaseUid: Hex;
let disputeEscrow: Address;
let disputeUsdc: Address;

/** Deploy one SettlementKeeperForkFixture, return its escrow + usdc + uid. */
async function deployFixture(disputeIt: boolean): Promise<{ escrow: Address; usdc: Address; uid: Hex }> {
  const artifact = JSON.parse(readFileSync(FIXTURE_ARTIFACT, "utf8"));
  const account = privateKeyToAccount(ANVIL_KEY0);
  const hash = await walletClient.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode.object as Hex,
    args: [AMOUNT, BigInt(CHALLENGE_WINDOW), ORACLE, disputeIt],
    account,
    chain: anvilChain,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const fixture = receipt.contractAddress!;
  const read = (fn: string) =>
    publicClient.readContract({ address: fixture, abi: artifact.abi, functionName: fn }) as Promise<Address & Hex>;
  const [escrow, usdc, uid] = await Promise.all([read("escrow"), read("usdc"), read("uid")]);
  return { escrow, usdc, uid };
}

async function usdcBalance(usdc: Address, who: Address): Promise<bigint> {
  return publicClient.readContract({ address: usdc, abi: ERC20_BALANCE_ABI, functionName: "balanceOf", args: [who] }) as Promise<bigint>;
}

async function chainNow(): Promise<number> {
  const block = await publicClient.getBlock();
  return Number(block.timestamp);
}

async function waitForAnvil(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      await publicClient.getBlockNumber();
      return;
    } catch {
      await sleep(200);
    }
  }
  throw new Error("anvil did not become ready within 10s");
}

beforeAll(async () => {
  if (!existsSync(FIXTURE_ARTIFACT)) {
    skipReason = `fixture artifact missing (run \`forge build\` in packages/contracts): ${FIXTURE_ARTIFACT}`;
    return;
  }

  // Set env BEFORE any gateway module loads (escrow-client reads these at module eval).
  process.env.PCC_GATEWAY_PRIVATE_KEY = ANVIL_KEY0;
  process.env.PCC_RPC_URL = RPC_URL;
  process.env.PCC_NETWORK = "base-sepolia"; // → escrow-client chain id 84532, matches anvil

  const anvilBin = process.env.ANVIL_BIN || "anvil";
  anvil = spawn(
    anvilBin,
    ["--port", String(PORT), "--chain-id", String(CHAIN_ID), "--gas-limit", "500000000", "--code-size-limit", "200000", "--silent"],
    { stdio: "ignore" },
  );
  let spawnErr: Error | undefined;
  anvil.on("error", (e) => (spawnErr = e as Error));

  publicClient = createPublicClient({ chain: anvilChain, transport: http(RPC_URL) });
  walletClient = createWalletClient({ account: privateKeyToAccount(ANVIL_KEY0), chain: anvilChain, transport: http(RPC_URL) });
  testClient = createTestClient({ chain: anvilChain, mode: "anvil", transport: http(RPC_URL) });

  try {
    await waitForAnvil();
  } catch (e) {
    skipReason = `anvil unavailable (${anvilBin}): ${spawnErr?.message ?? (e as Error).message}`;
    return;
  }

  // Dynamic imports — now that env is set, escrow-client captures the anvil config.
  ({ driveSettlement } = await import("../services/settlement-crank.js"));
  ({ runKeeperSweep } = await import("../services/settlement-keeper.js"));
  ({ getMilestoneV2, MilestoneStatusV2 } = await import("../contracts/escrow-client.js"));

  // Deploy both fixtures against the single anvil instance.
  const rel = await deployFixture(false);
  releaseEscrow = rel.escrow;
  releaseUsdc = rel.usdc;
  releaseUid = rel.uid;
  const dis = await deployFixture(true);
  disputeEscrow = dis.escrow;
  disputeUsdc = dis.usdc;

  available = true;
}, 60_000);

afterAll(() => {
  if (anvil && !anvil.killed) anvil.kill("SIGKILL");
});

describe("settlement keeper — live anvil fork", () => {
  it("boots anvil + deploys real escrows, or skips with a clear reason", () => {
    if (!available) {
      console.warn(`[settlement-keeper.fork] SKIPPED: ${skipReason}`);
      expect(skipReason.length).toBeGreaterThan(0);
      return;
    }
    expect(releaseEscrow).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(disputeEscrow).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it("crank attests, then the KEEPER releases a past-window milestone (the self-heal)", async () => {
    if (!available) return; // reason asserted above

    // ── The crank does the real on-chain attestation (evidence already submitted
    //    by the fixture). Nonzero window → it stops at awaiting_challenge_window. ──
    const attestDrive = await driveSettlement(releaseEscrow, 0, {
      evidenceBundleHash: EVIDENCE_HASH,
      easUid: releaseUid,
      nowSeconds: await chainNow(),
    });
    expect(attestDrive.outcome).toBe("awaiting_challenge_window");
    expect(attestDrive.settled).toBe(false);
    // Real chain confirms the attestation landed.
    let m = await getMilestoneV2(0, releaseEscrow);
    expect(m.status).toBe(MilestoneStatusV2.Attested);

    // Funds are escrowed (nothing released yet).
    expect(await usdcBalance(releaseUsdc, releaseEscrow)).toBe(AMOUNT);

    // ── Advance chain time past the challenge window, then run the KEEPER. ──
    await testClient.increaseTime({ seconds: CHALLENGE_WINDOW + 60 });
    await testClient.mine({ blocks: 1 });

    const now = await chainNow();
    const { repos, updates } = makeRepos([
      { id: "esc-release", contractAddress: releaseEscrow, status: "funded", version: "v2" },
    ]);
    const sweep1 = await runKeeperSweep(repos, { nowSeconds: now });

    expect(sweep1.released).toBe(1);
    expect(sweep1.milestones[0].disposition).toBe("released");
    // On-chain proof the money moved: milestone Released, escrow drained to 0.
    m = await getMilestoneV2(0, releaseEscrow);
    expect(m.status).toBe(MilestoneStatusV2.Released);
    expect(await usdcBalance(releaseUsdc, releaseEscrow)).toBe(0n);
    // Escrow row reconciled to completed (sole milestone released).
    expect(updates).toContainEqual({ id: "esc-release", status: "completed" });

    // ── Idempotency: re-running the keeper does NOT double-release. ──
    const opBalanceAfter1 = await usdcBalance(releaseUsdc, releaseEscrow); // 0
    const { repos: repos2 } = makeRepos([
      { id: "esc-release", contractAddress: releaseEscrow, status: "funded", version: "v2" },
    ]);
    const sweep2 = await runKeeperSweep(repos2, { nowSeconds: await chainNow() });

    expect(sweep2.released).toBe(0); // nothing new to release
    expect(sweep2.milestones[0].disposition).toBe("already_released");
    // No second payout — escrow balance unchanged (P7, via the real crank).
    expect(await usdcBalance(releaseUsdc, releaseEscrow)).toBe(opBalanceAfter1);
    m = await getMilestoneV2(0, releaseEscrow);
    expect(m.status).toBe(MilestoneStatusV2.Released);
  }, 60_000);

  it("does NOT settle a Disputed escrow — reports terminal_other, leaves funds escrowed", async () => {
    if (!available) return;

    // Fixture drove this one to Disputed.
    let m = await getMilestoneV2(0, disputeEscrow);
    expect(m.status).toBe(MilestoneStatusV2.Disputed);
    const escrowedBefore = await usdcBalance(disputeUsdc, disputeEscrow);

    const now = await chainNow();
    const { repos, updates } = makeRepos([
      { id: "esc-dispute", contractAddress: disputeEscrow, status: "active", version: "v2" },
    ]);
    const sweep = await runKeeperSweep(repos, { nowSeconds: now });

    expect(sweep.released).toBe(0);
    expect(sweep.terminalOther).toBe(1);
    expect(sweep.milestones[0].disposition).toBe("terminal_other");
    expect(sweep.milestones[0].reason).toBe("disputed");
    // Never reconciled to completed; money still frozen in the escrow.
    expect(updates).toHaveLength(0);
    m = await getMilestoneV2(0, disputeEscrow);
    expect(m.status).toBe(MilestoneStatusV2.Disputed);
    // Escrow still holds funds (amount + the challenger bond) — nothing released.
    expect(await usdcBalance(disputeUsdc, disputeEscrow)).toBe(escrowedBefore);
  }, 60_000);
});
