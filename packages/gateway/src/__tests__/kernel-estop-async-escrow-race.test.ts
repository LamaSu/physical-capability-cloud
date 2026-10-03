/**
 * Paid-job creation must not hand out execution authority for a kernel that
 * went into emergency stop WHILE its escrow was being created (astra pack 150
 * MEDIUM, routes/paid-job-flow.ts createJobFromSession).
 *
 * createJobFromSession asks assertKernelAcceptsJobs exactly once, as its very
 * first statement, BEFORE any escrow work starts. The REAL (non-mock) escrow
 * path then does genuinely asynchronous on-chain writes (createEscrowV3, then
 * addMilestone / approve / fund, serialized inside the single gateway-signer
 * lock). A stop activated AFTER that first check but WHILE those writes are
 * in flight was never asked again, so once the chain writes settled the job
 * and its 1-hour execution scope were published anyway.
 *
 * Fix (two more checks, both via the same assertKernelAcceptsJobs):
 *   1. Right after the escrow (+ its DB record) is created and BEFORE the job
 *      and execution scope are published — so a stop that landed during the
 *      chain writes still blocks the authority grant. The escrow row itself
 *      is left recorded (an explicit, recoverable state), not silently
 *      dropped.
 *   2. At the TOP of the signer-lock callback itself — so a request that had
 *      to WAIT for the lock (another job's sequence was already in flight)
 *      re-checks the instant it is finally granted the signer, before
 *      spending it (and real gas, on the real chain) on a doomed write.
 *
 * MOCK_SETTLEMENT is forced OFF here on purpose: the mock branch has no
 * internal await between the first check and the DB writes, so it cannot
 * exhibit this race at all. The (synchronous, already-covered) mock-path
 * cases live in kernel-estop-job-paths.test.ts.
 *
 * Mocking strategy mirrors the established v3-mode-a-wiring.test.ts pattern:
 * only `createWalletClient` / `createPublicClient` from "viem" are replaced
 * (so no real network call is ever made); `createEscrowV3` itself runs for
 * real, decoding a synthetic EscrowCreated receipt, which is what lets the
 * first test pause execution exactly at the on-chain create write via a
 * deferred promise returned from the mocked `writeContract`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, encodeEventTopics, type Hex } from "viem";
import { schema, eq, sql } from "@pcc/store";
import { PCCProtocolV3FactoryABI } from "../contracts/escrow-client.js";

const NEW_ESCROW = ("0x" + "5e".repeat(20)) as `0x${string}`;
const BASE_SEPOLIA_MOCK_USDC = "0x18bef3dee9f4f97f7cec16db0c4a0a930f478470";
const KERNEL_ID = "kernel-nyc";

const ORIG = {
  pk: process.env.PCC_GATEWAY_PRIVATE_KEY,
  mock: process.env.MOCK_SETTLEMENT,
  v3: process.env.PCC_USE_V3_MODE_A,
  v2: process.env.PCC_USE_EAS_V2,
  net: process.env.PCC_NETWORK,
  env: process.env.MOCK_USDC_ADDRESS,
  db: process.env.PCC_DB_PATH,
};

function restoreEnv(): void {
  const entries: Array<[string, string | undefined]> = [
    ["PCC_GATEWAY_PRIVATE_KEY", ORIG.pk],
    ["MOCK_SETTLEMENT", ORIG.mock],
    ["PCC_USE_V3_MODE_A", ORIG.v3],
    ["PCC_USE_EAS_V2", ORIG.v2],
    ["PCC_NETWORK", ORIG.net],
    ["MOCK_USDC_ADDRESS", ORIG.env],
    ["PCC_DB_PATH", ORIG.db],
  ];
  for (const [k, v] of entries) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

/** A deferred promise: resolve() is exposed to the test. */
function defer<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function buildSession(overrides: Record<string, unknown> = {}) {
  return {
    id: "sess-race",
    status: "committed",
    userAgentId: "0x" + "11".repeat(20),
    kernelId: KERNEL_ID,
    capabilityType: "liquid-handler",
    capabilityId: null,
    network: null,
    selections: {},
    operatorConstraints: {},
    scheduling: {},
    quote: { totalPrice: "10.00", currency: "USDC", bondAmount: "0.00" },
    contractTerms: {
      milestones: [{ stepId: "step-race", amount: "10.00", bondAmount: "0.00", challengeWindowSeconds: 0 }],
      deadline: new Date(Date.now() + 86_400_000).toISOString(),
      assuranceTier: 0,
    },
    jobId: "job-race",
    escrowAddress: null,
    cwmId: "cwm-race",
    transitions: [],
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 1_800_000).toISOString(),
    committedAt: new Date().toISOString(),
    ...overrides,
  } as any;
}

/** Writes emergencyStop:true directly, bypassing HTTP — this suite is about
 *  createJobFromSession's internal re-checks, not the route/auth layer. */
async function activateStop(): Promise<void> {
  const { getStore } = await import("../db.js");
  getStore().db.run(
    sql`INSERT OR REPLACE INTO operator_policies (kernel_id, policy, updated_at, updated_by)
        VALUES (${KERNEL_ID}, ${JSON.stringify({ version: 1, emergencyStop: true })}, ${new Date().toISOString()}, ${"test"})`,
  );
}

describe("createJobFromSession: emergency stop during asynchronous escrow creation (V3 Mode-A)", () => {
  const writeContract = vi.fn();
  const waitForTransactionReceipt = vi.fn();
  const getTransactionCount = vi.fn().mockResolvedValue(5);
  const readContract = vi.fn().mockResolvedValue(1n);

  beforeEach(() => {
    vi.resetModules();
    writeContract.mockReset();
    waitForTransactionReceipt.mockReset();
    getTransactionCount.mockClear();
    readContract.mockClear();

    process.env.PCC_GATEWAY_PRIVATE_KEY =
      "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
    process.env.MOCK_SETTLEMENT = "false"; // exercise the REAL on-chain branch
    process.env.PCC_USE_V3_MODE_A = "true"; // V3 Mode-A: the simplest real path
    delete process.env.PCC_USE_EAS_V2;
    process.env.PCC_NETWORK = "base-sepolia";
    delete process.env.MOCK_USDC_ADDRESS;
    process.env.PCC_DB_PATH = ":memory:";

    const receiptTopics = encodeEventTopics({
      abi: PCCProtocolV3FactoryABI,
      eventName: "EscrowCreated",
      args: {
        escrow: NEW_ESCROW,
        payer: ("0x" + "00".repeat(20)) as Hex,
        arbiter: ("0x" + "00".repeat(20)) as Hex,
      },
    });
    const receiptData = encodeAbiParameters(
      [{ type: "address" }, { type: "bytes32" }],
      [BASE_SEPOLIA_MOCK_USDC as Hex, ("0x" + "00".repeat(32)) as Hex],
    );
    // One shared receipt shape for every call: createEscrowV3 decodes the
    // EscrowCreated log out of it; addMilestone/approve/fund only look at
    // `.status`, so reusing the same object for those is harmless.
    waitForTransactionReceipt.mockResolvedValue({
      status: "success",
      logs: [{ topics: receiptTopics, data: receiptData, address: NEW_ESCROW }],
    });

    vi.doMock("viem", async (importOriginal) => {
      const actual = await importOriginal<typeof import("viem")>();
      return {
        ...actual,
        createWalletClient: () => ({ writeContract }),
        createPublicClient: () => ({ waitForTransactionReceipt, getTransactionCount, readContract }),
      };
    });
    vi.doMock("../services/kernel-service.js", () => ({
      getKernelService: vi.fn().mockReturnValue({ config: { kernelId: "kernel-test-race" } }),
      initKernelService: vi.fn(),
      resetKernelService: vi.fn(),
    }));
  });

  afterEach(() => {
    restoreEnv();
    vi.doUnmock("viem");
    vi.doUnmock("../services/kernel-service.js");
  });

  it(
    "[repro] a stop activated WHILE createEscrowV3 is in flight is re-checked before the job/scope publish; the escrow stays recorded",
    { timeout: 15000 },
    async () => {
      const { initStore, closeStore, getStore } = await import("../db.js");
      initStore({ seed: true });
      try {
        const { createJobFromSession } = await import("../routes/paid-job-flow.js");

        const createGate = defer<void>();
        writeContract.mockImplementation(async (args: { functionName: string }) => {
          if (args.functionName === "createEscrowV3") {
            await createGate.promise; // pause here until the test releases it
          }
          return "0x" + "a".repeat(64);
        });

        const resultPromise = createJobFromSession(buildSession());

        // Let execution reach (and pause at) the createEscrowV3 write.
        await vi.waitFor(() => {
          expect(writeContract.mock.calls.some((c) => c[0].functionName === "createEscrowV3")).toBe(true);
        });

        // The stop fires WHILE the on-chain create is in flight.
        await activateStop();

        // Let the (mocked) chain write "land".
        createGate.resolve();

        await expect(resultPromise).rejects.toMatchObject({
          name: "KernelNotAcceptingJobsError",
          code: "kernel_emergency_stopped",
          status: 409,
        });

        // The escrow IS recorded (an explicit, recoverable row)...
        const { db } = getStore();
        const escrowRows = db.select().from(schema.escrows).all();
        expect(escrowRows).toHaveLength(1);
        expect(escrowRows[0].contractAddress.toLowerCase()).toBe(NEW_ESCROW.toLowerCase());
        // ...but no job and no execution scope were published for it.
        const jobRows = db.select().from(schema.jobs).where(eq(schema.jobs.kernelId, KERNEL_ID)).all();
        expect(jobRows).toHaveLength(0);
        const scopeRows = db
          .select()
          .from(schema.executionScopes)
          .where(eq(schema.executionScopes.kernelId, KERNEL_ID))
          .all();
        expect(scopeRows).toHaveLength(0);
      } finally {
        closeStore();
      }
    },
  );

  it(
    "[repro] a request that had to WAIT for the signer lock re-checks the instant it is granted the signer, before spending any gas",
    { timeout: 15000 },
    async () => {
      const { initStore, closeStore } = await import("../db.js");
      initStore({ seed: true });
      try {
        const { createJobFromSession } = await import("../routes/paid-job-flow.js");
        const { withSignerLock } = await import("../contracts/signer-lock.js");

        writeContract.mockResolvedValue("0x" + "a".repeat(64));

        // Hold the signer lock ourselves so createJobFromSession's own
        // withSignerLock call must queue behind us.
        const holdGate = defer<void>();
        const held = withSignerLock(() => holdGate.promise);

        const resultPromise = createJobFromSession(
          buildSession({ id: "sess-race-lockwait", cwmId: "cwm-race-lockwait" }),
        );

        // Give createJobFromSession time to run its synchronous prelude and
        // reach (and queue on) the lock. Everything before the lock call is
        // synchronous/microtask-only, so a single macrotask tick suffices.
        await new Promise((r) => setTimeout(r, 0));

        // The stop fires while the request is still queued, waiting for the signer.
        await activateStop();

        // Release the lock we were holding — the queued callback now runs.
        holdGate.resolve();
        await held;

        await expect(resultPromise).rejects.toMatchObject({
          name: "KernelNotAcceptingJobsError",
          code: "kernel_emergency_stopped",
          status: 409,
        });

        // The recheck fired before any chain write was attempted — no gas spent.
        expect(writeContract).not.toHaveBeenCalled();
      } finally {
        closeStore();
      }
    },
  );
});
