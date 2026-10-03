/**
 * Real-service tests for POST /api/setup/test-job's simulation honesty.
 *
 * N59 "the honest setup test-job", round 3: the cross-family review's F2
 * (HIGH, open after round 2 at f77375db).
 *
 * ../__tests__/setup.test.ts covers this route end-to-end against a MOCKED
 * KernelService (see that file's own header comment: real background timers
 * from fire-and-forget jobs can SIGABRT during test teardown). That tradeoff
 * is wrong for F2 specifically — F2 is about what deviceIsSimulated() does
 * against a REAL adapter instance (an IppAdapter defaulting to mock, an
 * OctoPrintAdapter in mockMode, an IppAdapter that downgrades from real to
 * mock at runtime because the optional 'ipp' package isn't installed). A
 * mocked KernelService can't exercise any of that.
 *
 * So this file does NOT call vi.mock() on "../services/kernel-service.js".
 * It constructs one real KernelService — via the exact same
 * initKernelService()/getKernelService() module-singleton seam the route
 * itself uses — wired to real @pcc/kernel adapters (IppAdapter,
 * OctoPrintAdapter, plus one hand-written neutral MachineAdapter double for
 * the control case), and drives it through the real HTTP route with
 * app.inject(). deviceIsSimulated() is also exercised directly (unit-style)
 * by injecting fakes into the service's private `machines` map via a typed
 * cast — the seam the task asked for.
 *
 * To avoid the documented SIGABRT risk from background work outliving a
 * test, every adapter that can hang past its own test is forced to
 * terminate before that test returns (see the OctoPrint case below), and
 * everything still alive is disposed in afterAll().
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { setupRoutes } from "../routes/setup.js";
import { initStore, closeStore, getRepos } from "../db.js";
import { initKernelService, resetKernelService } from "../services/kernel-service.js";
import { JobRunner, EvidenceEmitter, resetSafetyGateway } from "@pcc/kernel";
import type { MachineAdapter, MachineCommand, MachineCommandResult } from "@pcc/kernel";
import type { EvidenceEvent, EvidenceSource } from "@pcc/spec";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const KERNEL_ID = "kernel-n59r3-real";
const OWNER = "op-n59r3-real-owner";
const CAP_ID = "cap-n59r3-real";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function seedKernel(id: string, operatorAddress: string): void {
  const now = new Date().toISOString();
  getRepos().kernels.insert({
    id,
    name: id,
    operatorAddress,
    location: { lat: 0, lng: 0 },
    physicalAddress: "1 Bench Row",
    maxAssuranceTier: 2,
    publicKey: "pk",
    reputation: 0,
    totalJobsCompleted: 0,
    status: "online",
    registeredAt: now,
    lastHeartbeat: now,
    version: "1",
  } as never);
}

function seedDevice(
  id: string,
  kernelId: string,
  adapterType: string,
  adapterConfig?: Record<string, unknown>,
): void {
  getRepos().kernels.insertDevice({
    id,
    kernelId,
    type: "machine",
    model: "BENCH",
    firmware: "1.0",
    status: "idle",
    contributesToCapabilities: [],
    lastUpdated: new Date().toISOString(),
    adapterType,
    ...(adapterConfig ? { adapterConfig: JSON.stringify(adapterConfig) } : {}),
  } as never);
}

// A capability must exist for the kernel, or the route's best-effort job
// insert finds no capabilityId and skips the DB row entirely — then
// getJobStatus() can never observe "completed" (it falls back to an
// in-memory map that is deleted the instant the job finishes, landing on
// "unknown"). Seeding this is what makes finalStatus genuinely reach
// "completed" below, matching the astra verdict's "a completed run".
function seedCapability(id: string, kernelId: string): void {
  getRepos().capabilities.insert({
    id,
    kernelId,
    type: "test-bench",
    name: "N59 R3 bench capability",
    materials: [],
    assuranceTiers: [0, 1],
    pricing: { currency: "USDC", baseCost: "0", minimum: "0" },
    availability: {},
    location: { lat: 0, lng: 0 },
  } as never);
}

/**
 * A genuinely non-simulated MachineAdapter test double for the control case:
 * neutral class name, source.simulated explicitly false, completes a job
 * quickly so the control test needs no multi-second background timer of its
 * own. Installed directly into the service's machines/runners maps in
 * beforeAll — see there for why nothing else is ever constructed for this
 * device id.
 *
 * The "execution_completed" event (and the progress=100 flip) is scheduled
 * on a short setTimeout rather than fired synchronously inside execute().
 * JobRunner wires onEvidence() to a FIRE-AND-FORGET
 * `evidenceEmitter.addEvent(...).catch(...)` (job-runner.ts's handleEvidence
 * does not await it), and addEvent() itself awaits an async hashEvent()
 * before pushing the event into the step's event list. A synchronous
 * progress=100 races that — waitForCompletion() returns before either event
 * is actually recorded, and finalizeBundle() then throws "No evidence
 * events for ..." because the step has zero events, which turns the
 * "control" job into a failure instead of a pass. The delay below gives
 * that fire-and-forget chain time to land before progress is ever read as
 * complete.
 */
class NeutralBenchAdapter implements MachineAdapter {
  readonly id: string;
  readonly type = "bench-neutral-test-double";
  readonly source: EvidenceSource;
  private listeners: Array<(event: Omit<EvidenceEvent, "id" | "hash">) => void> = [];
  private progress = 0;

  constructor(id: string, kernelId: string) {
    this.id = id;
    this.source = {
      deviceId: id,
      deviceType: "controller",
      kernelId,
      firmwareVersion: "NeutralBenchAdapter-1.0.0",
      simulated: false,
    };
  }

  async getStatus(): Promise<"idle" | "busy"> {
    return this.progress >= 100 ? "idle" : "busy";
  }

  async getProgress(): Promise<number> {
    return this.progress;
  }

  async execute(command: MachineCommand): Promise<MachineCommandResult> {
    if (command.type === "start") {
      this.emit({
        type: "execution_started",
        timestamp: new Date().toISOString(),
        source: this.source,
        payload: {},
      });
      setTimeout(() => {
        this.progress = 100;
        this.emit({
          type: "execution_completed",
          timestamp: new Date().toISOString(),
          source: this.source,
          payload: {},
        });
      }, 150);
    }
    return { success: true, message: `${command.type} ok` };
  }

  onEvidence(callback: (event: Omit<EvidenceEvent, "id" | "hash">) => void): void {
    this.listeners.push(callback);
  }

  async dispose(): Promise<void> {
    this.listeners = [];
  }

  private emit(event: Omit<EvidenceEvent, "id" | "hash">): void {
    for (const listener of this.listeners) listener(event);
  }
}

/**
 * Two minimal doubles for deviceIsSimulated()'s unit tests. Only `.source`
 * and `.constructor.name` are ever read by that method, so these don't need
 * to implement MachineAdapter at all — injected via a typed cast straight
 * into the service's `machines` map, as the task's seam suggestion.
 */
class RealishBenchDouble {
  constructor(public source: Record<string, unknown>) {}
}
class FakeBench {
  constructor(public source: Record<string, unknown>) {}
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("POST /api/setup/test-job — real adapters, simulation honesty (N59 F2 round 3)", () => {
  let app: FastifyInstance;
  let svc: ReturnType<typeof initKernelService>;
  let svcInternals: {
    machines: Map<string, MachineAdapter>;
    runners: Map<string, JobRunner>;
    emitter: EvidenceEmitter;
  };

  beforeAll(async () => {
    process.env.PCC_DB_PATH = process.env.PCC_DB_PATH ?? ":memory:";
    initStore({ seed: true });

    seedKernel(KERNEL_ID, OWNER);
    seedCapability(CAP_ID, KERNEL_ID);
    // ipp, no adapterConfig -> IppAdapter.mockMode defaults to true (buildIpp).
    seedDevice("dev-ipp-default", KERNEL_ID, "ipp");
    // octoprint, explicit mockMode:true -> OctoPrintAdapter stays named
    // "OctoPrintAdapter" but is a simulator.
    seedDevice("dev-octoprint-mock", KERNEL_ID, "octoprint", { mockMode: true });
    // ipp, explicit mockMode:false -> IppAdapter attempts the real transport
    // and (see beforeAll below) downgrades to mock at runtime.
    seedDevice("dev-ipp-downgrade", KERNEL_ID, "ipp", { mockMode: false });
    // An adapterType with NO registered factory on purpose — see the
    // "install manually" step below for why.
    seedDevice("dev-bench-neutral", KERNEL_ID, "bench-neutral-test-double");

    resetKernelService();
    resetSafetyGateway();
    svc = initKernelService({ kernelId: KERNEL_ID, devices: [] });
    svcInternals = svc as unknown as typeof svcInternals;

    // Every job below completes real work through the real submitJob() path,
    // which — fire-and-forget, NOT awaited by submitJob() itself — chains
    // into a settlement pipeline (IPFS archive, then DB persistence of the
    // evidence bundle, then on-chain release) whenever the finalized bundle
    // shows up in the service's private `completedBundles` map (populated by
    // the emitter's onBundle listener registered in the constructor). None
    // of these tests care about settlement — only about ran/passed/simulated,
    // which are computed and the job row flipped to "completed" BEFORE that
    // pipeline is ever reached. Left alone, that background chain keeps
    // touching the DB well after this file's own afterAll() calls
    // closeStore(), which reproducibly aborts the whole test process
    // (better-sqlite3 operating on a closed handle) — confirmed by running
    // this suite without the stub below: SIGABRT, exit code 134, with
    // "[settlement] DB persistence failed: Store not initialised" logged
    // AFTER "[db] Store closed". This is the same class of
    // background-work-outliving-a-test risk ../__tests__/setup.test.ts's own
    // header comment documents for MockFDMAdapter's job timer — just reached
    // through the settlement path instead. Swapping completedBundles for a
    // stub whose set() is a no-op makes completedBundles.get(jobId) always
    // undefined, so the settlement block's `if (bundle)` never fires, for
    // every job this file submits.
    const noSettlementBundles = {
      get: (_key: string) => undefined,
      set: (_key: string, _value: unknown) => noSettlementBundles,
      delete: (_key: string) => false,
    };
    (svc as unknown as { completedBundles: typeof noSettlementBundles }).completedBundles =
      noSettlementBundles;

    // The 'ipp' optional peer dependency is NOT installed in this workspace
    // (confirmed via `require.resolve("ipp")` from the kernel package before
    // writing this test — MODULE_NOT_FOUND; it is not even listed in
    // packages/kernel/package.json). So for dev-ipp-downgrade,
    // IppAdapter's constructor-time `import("ipp")` genuinely rejects on its
    // own — no stubbing required to force the downgrade. We just give that
    // rejection (a real microtask-queue async operation) time to land and
    // noteMockRouting() to set source.simulated=true before any test uses
    // the device, so the "sanity" check below isn't racing construction.
    await sleep(800);

    // dev-bench-neutral's DB row uses an adapterType with no registered
    // factory, so loadDbDevicesIntoRuntime()'s attempt to build it throws
    // inside installMachineFromDbRow's own try/catch and silently no-ops —
    // nothing with a background timer was ever constructed for this id.
    // We install the control double ourselves the same way initAdapters()
    // installs any other machine: one MachineAdapter + one JobRunner
    // sharing the service's own evidence emitter.
    const neutral = new NeutralBenchAdapter("dev-bench-neutral", KERNEL_ID);
    svcInternals.machines.set("dev-bench-neutral", neutral);
    svcInternals.runners.set(
      "dev-bench-neutral",
      new JobRunner(neutral, [], null, svcInternals.emitter),
    );

    app = Fastify({ logger: false });
    // Stand in for apiGate, exactly as ../__tests__/setup.test.ts does: an
    // x-test-key header names the authenticated caller.
    app.decorateRequest("userId", null);
    app.decorateRequest("operatorId", null);
    app.addHook("onRequest", async (req) => {
      const key = req.headers["x-test-key"];
      if (typeof key === "string") {
        (req as { userId?: string }).userId = key;
        (req as { operatorId?: string }).operatorId = key;
      }
    });
    await app.register(setupRoutes);
    await app.ready();
  });

  afterAll(async () => {
    // Belt-and-suspenders: stop any adapter-internal timers (IPP's mock job
    // timer / poll timer) regardless of per-test cleanup below.
    for (const id of ["dev-ipp-default", "dev-octoprint-mock", "dev-ipp-downgrade", "dev-bench-neutral"]) {
      try {
        await svcInternals.machines.get(id)?.dispose();
      } catch {
        // best-effort cleanup only
      }
    }
    await app.close();
    closeStore();
    resetKernelService();
  });

  const post = (payload: unknown) =>
    app.inject({ method: "POST", url: "/api/setup/test-job", headers: { "x-test-key": OWNER }, payload });

  // ── 1. IPP, no adapterConfig -> defaults to mock ─────────────────────────

  describe("IPP machine registered with no adapterConfig", () => {
    it("sanity: IppAdapter self-reports source.simulated=true with no adapterConfig", () => {
      const machine = svcInternals.machines.get("dev-ipp-default");
      expect(machine?.source.simulated).toBe(true);
    });

    it("[F] a completed simulated run is never reported as a pass (N59 F2 repro #1)", async () => {
      const res = await post({ kernelId: KERNEL_ID, deviceId: "dev-ipp-default", assuranceTier: 0 });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({ ran: true, status: "completed", simulated: true, passed: false });
    }, 20_000);
  });

  // ── 2. OctoPrint, adapterConfig {mockMode:true} ──────────────────────────

  describe("OctoPrint machine with adapterConfig {mockMode:true}", () => {
    it("sanity: OctoPrintAdapter self-reports source.simulated=true in mockMode, despite its class name", () => {
      const machine = svcInternals.machines.get("dev-octoprint-mock");
      expect(machine?.source.simulated).toBe(true);
      expect(machine?.constructor?.name).toBe("OctoPrintAdapter"); // the old regex's blind spot
    });

    it("[F] simulated:true, passed:false even though the class name is OctoPrintAdapter (N59 F2 repro #2)", async () => {
      const res = await post({ kernelId: KERNEL_ID, deviceId: "dev-octoprint-mock", assuranceTier: 0 });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ran).toBe(true);
      expect(body.simulated).toBe(true);
      expect(body.passed).toBe(false);
      // NOTE: OctoPrintAdapter's mock "start" handler (executeMock, case
      // "start") sets mockStatus busy / mockProgress 0 and never advances
      // either on its own — unlike IppAdapter's mock, it has no completion
      // timer. So JobRunner.waitForCompletion() never sees progress>=100 or
      // status "idle" and the job genuinely never reaches "completed" here;
      // it is still "executing" when the route's 10s poll gives up. That is
      // an orthogonal adapter-completeness gap, not the F2 security issue —
      // it only makes the job fail SLOWER, it never lets it pass. The F2
      // assertions above (simulated/passed) hold regardless.
      expect(body.status).not.toBe("completed");

      // Cleanup: force this mock job out of its hang (JobRunner's internal
      // waitForCompletion loop would otherwise keep polling every 500ms for
      // up to 120s in the background — the exact class of dangling
      // fire-and-forget timer ../__tests__/setup.test.ts's header comment
      // warns can SIGABRT the process during teardown). execute({type:
      // "stop"}) is the adapter's own public mock-mode handler; it sets
      // mockStatus "idle" with progress still 0, which the next
      // waitForCompletion tick (<=500ms) reads as "Machine went idle before
      // completion" and resolves JobRunner.run() with success:false.
      const machine = svcInternals.machines.get("dev-octoprint-mock");
      await machine?.execute({ type: "stop" });
      await sleep(1000);
    }, 20_000);
  });

  // ── 3. IPP, mockMode:false, but the optional 'ipp' package is missing ───

  describe("IPP machine with mockMode:false, live downgrade (optional 'ipp' package unavailable)", () => {
    it("sanity: the real->mock downgrade already landed by request time", () => {
      const machine = svcInternals.machines.get("dev-ipp-downgrade");
      expect(machine?.source.simulated).toBe(true);
    });

    it("[F] the downgraded run is reported simulated:true, passed:false (N59 F2 repro #3)", async () => {
      const res = await post({ kernelId: KERNEL_ID, deviceId: "dev-ipp-downgrade", assuranceTier: 0 });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({ ran: true, status: "completed", simulated: true, passed: false });
    }, 20_000);
  });

  // ── 4. deviceIsSimulated() unit tests on the real service ────────────────

  describe("deviceIsSimulated — direct unit tests via the service's machines map", () => {
    it("an unregistered/unknown device is simulated (fail closed)", () => {
      expect(svc.deviceIsSimulated("dev-totally-unregistered-n59r3")).toBe(true);
    });

    it("source.simulated === true is simulated", () => {
      svcInternals.machines.set(
        "dev-u1",
        new RealishBenchDouble({ simulated: true }) as unknown as MachineAdapter,
      );
      expect(svc.deviceIsSimulated("dev-u1")).toBe(true);
    });

    it("a non-boolean truthy marker (source.simulated === 'yes') is simulated", () => {
      svcInternals.machines.set(
        "dev-u2",
        new RealishBenchDouble({ simulated: "yes" }) as unknown as MachineAdapter,
      );
      expect(svc.deviceIsSimulated("dev-u2")).toBe(true);
    });

    it("a neutral class with source.simulated === false is NOT simulated", () => {
      svcInternals.machines.set(
        "dev-u3",
        new RealishBenchDouble({ simulated: false }) as unknown as MachineAdapter,
      );
      expect(svc.deviceIsSimulated("dev-u3")).toBe(false);
    });

    it("a neutral class with source.simulated absent is NOT simulated", () => {
      svcInternals.machines.set(
        "dev-u4",
        new RealishBenchDouble({}) as unknown as MachineAdapter,
      );
      expect(svc.deviceIsSimulated("dev-u4")).toBe(false);
    });

    it("an adapter with no evidence source at all is simulated (fail closed)", () => {
      svcInternals.machines.set("dev-u6", {} as unknown as MachineAdapter);
      expect(svc.deviceIsSimulated("dev-u6")).toBe(true);
    });

    it("a class named FakeBench with no marker is simulated via the class-name fallback", () => {
      svcInternals.machines.set("dev-u5", new FakeBench({}) as unknown as MachineAdapter);
      expect(svc.deviceIsSimulated("dev-u5")).toBe(true);
    });
  });

  // ── 5. Control: a genuinely non-simulated device CAN pass ────────────────

  describe("control: a genuinely non-simulated test-double adapter", () => {
    it("a neutral, non-simulated adapter that completes the job returns passed:true", async () => {
      const res = await post({ kernelId: KERNEL_ID, deviceId: "dev-bench-neutral", assuranceTier: 0 });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({ ran: true, status: "completed", simulated: false, passed: true });
    }, 20_000);
  });
});
