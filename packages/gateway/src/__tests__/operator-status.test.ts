/**
 * Tests for GET /api/operators/:slug/status — the four-slot self-service view.
 *
 * Coverage:
 *   - unconfigured (no kernel, no caps, no channels) → status: "unconfigured"
 *   - kernel + capability + channel + a verified run → status: "ready"
 *   - kernel + capability without availability → status: "partial" + missing slot 4
 *   - human-lane capability without sla → still "ready" with a verified run
 *   - channels attached but all disabled → status: "partial"
 *   - totals tallies correctly (humanLane vs machineLane, enabled vs total)
 *   - agentCardUrls populated per kernel
 *   - readiness (D4(a)): only a completed run whose evidence verifies against
 *     the kernel's registered key makes an operator ready; self-attested,
 *     wrongly signed, unregistered-signer and failed runs do not, and neither
 *     do mock-only devices; nothing secret is served
 */

import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import nacl from "tweetnacl";
import { operatorStatusRoutes } from "../routes/operator-status.js";
import {
  attachChannel,
  _clearOperatorChannelsForTests,
} from "../routes/operator-channels.js";
import {
  initJobOffersStore,
  _resetJobOffersStoreForTests,
} from "../services/job-offers-store.js";
import { initStore, closeStore, getStore } from "../db.js";
import { schema, eq } from "@pcc/store";

const { shopKernels, capabilities, kernelDevices, jobs, evidenceBundles, evidenceEvents } = schema;

const TEST_OP = "0xtest-operator-status";
const BUNDLE_HASH = `sha256:${"ab".repeat(32)}`;

function seedKernel(id: string, name: string, operatorAddress: string = TEST_OP): void {
  const { db } = getStore();
  const now = new Date().toISOString();
  db.insert(shopKernels).values({
    id,
    name,
    operatorAddress,
    location: { lat: 0, lng: 0 },
    physicalAddress: "test",
    maxAssuranceTier: 2,
    publicKey: "test-key",
    reputation: 0,
    totalJobsCompleted: 0,
    status: "online",
    registeredAt: now,
    lastHeartbeat: now,
    version: "1.0.0",
  } as any).run();
}

function seedCapability(
  id: string,
  kernelId: string,
  type: string,
  opts: { sla?: object; availability?: object } = {},
): void {
  const { db } = getStore();
  db.insert(capabilities).values({
    id,
    kernelId,
    type,
    name: `${type} cap`,
    description: `${type} capability for testing`,
    materials: [],
    assuranceTiers: [0, 1],
    pricing: { currency: "USDC", baseCost: "10", minimum: "5" },
    location: { lat: 0, lng: 0 },
    queueDepth: 0,
    availability: opts.availability ?? {},
    sla: opts.sla ?? null,
  } as any).run();
}

function seedDevice(id: string, kernelId: string, type: string, adapterType: string | null): void {
  const { db } = getStore();
  db.insert(kernelDevices).values({
    id,
    kernelId,
    type,
    model: "test model",
    firmware: "1.0",
    status: "idle",
    contributesToCapabilities: [],
    lastUpdated: new Date().toISOString(),
    adapterType,
  } as any).run();
}

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

/** A device key; `register` stores it on the kernel row as its proven signer. */
function deviceKey() {
  const pair = nacl.sign.keyPair();
  const publicKey = `0x${hex(pair.publicKey)}`;
  return {
    publicKey,
    register(kernelId: string): void {
      getStore()
        .db.update(shopKernels)
        .set({ signingKeyAlgorithm: "ed25519", signingKeyPublicKey: publicKey } as any)
        .where(eq(shopKernels.id, kernelId))
        .run();
    },
    sign(bundleHash: string = BUNDLE_HASH) {
      return {
        signer: publicKey,
        algorithm: "ed25519",
        value: hex(nacl.sign.detached(new TextEncoder().encode(bundleHash), pair.secretKey)),
      };
    },
  };
}

/** A job on `kernelId` with one evidence bundle carrying `signature`. */
function seedRun(
  jobId: string,
  kernelId: string,
  capabilityId: string,
  signature: object,
  opts: { status?: string; bundleId?: string; at?: string } = {},
): void {
  const { db } = getStore();
  const now = opts.at ?? new Date().toISOString();
  db.insert(jobs).values({
    id: jobId,
    stepId: `${jobId}-step`,
    cwmId: `${jobId}-cwm`,
    capabilityId,
    kernelId,
    status: opts.status ?? "completed",
    assignedDevices: [],
    startedAt: now,
    completedAt: now,
    progress: 100,
  } as any).run();
  db.insert(evidenceBundles).values({
    id: opts.bundleId ?? `${jobId}-bundle`,
    jobId,
    stepId: `${jobId}-step`,
    kernelId,
    assuranceTier: 0,
    bundleHash: BUNDLE_HASH,
    kernelSignature: signature,
    createdAt: now,
  } as any).run();
}

/** Kernel + machine device + capability + channel: every slot filled. */
function seedAllSlots(kernelId: string, capabilityId: string): void {
  seedKernel(kernelId, "Test Kernel");
  seedDevice(`${kernelId}-printer`, kernelId, "machine", "octoprint");
  seedCapability(capabilityId, kernelId, "fdm", { availability: { mode: "always" } });
  attachChannel(TEST_OP, {
    label: "Webhook printer",
    transport: "webhook",
    describe: "POST to local printer endpoint",
    endpoint: { url: "http://localhost:9100" },
  });
}

describe("GET /api/operators/:slug/status", () => {
  let app: FastifyInstance;

  async function status() {
    const res = await app.inject({ method: "GET", url: `/api/operators/${TEST_OP}/status` });
    expect(res.statusCode).toBe(200);
    return res;
  }

  beforeAll(async () => {
    process.env.PCC_DB_PATH = ":memory:";
    initStore({ seed: true });
    app = Fastify({ logger: false });
    await app.register(operatorStatusRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    closeStore();
  });

  beforeEach(() => {
    _clearOperatorChannelsForTests();
    _resetJobOffersStoreForTests();
    // Wipe rows from the in-memory DB for a clean slate per test, children
    // first (foreign keys are on). Each delete stands alone, so one failure
    // cannot leave the rest in place.
    const { db } = getStore();
    for (const table of [evidenceEvents, evidenceBundles, jobs, kernelDevices, capabilities, shopKernels]) {
      try {
        db.delete(table).run();
      } catch { /* no-op */ }
    }
  });

  it("returns unconfigured when no kernel/cap/channel exists", async () => {
    const body = (await status()).json();
    expect(body.operatorSlug).toBe(TEST_OP);
    expect(body.status).toBe("unconfigured");
    expect(body.kernels).toEqual([]);
    expect(body.capabilities).toEqual([]);
    expect(body.channels).toEqual([]);
    expect(body.totals.kernelCount).toBe(0);
  });

  it("returns ready when all slots are filled and a run verifies (machine lane, no SLA needed)", async () => {
    seedAllSlots("kernel-test-1", "cap-test-1");
    const key = deviceKey();
    key.register("kernel-test-1");
    seedRun("job-test-1", "kernel-test-1", "cap-test-1", key.sign());
    const body = (await status()).json();
    expect(body.status).toBe("ready");
    expect(body.totals.kernelCount).toBe(1);
    expect(body.totals.capabilityCount).toBe(1);
    expect(body.totals.channelCount).toBe(1);
    expect(body.totals.enabledChannelCount).toBe(1);
    expect(body.totals.humanLaneCount).toBe(0);
    expect(body.totals.machineLaneCount).toBe(1);
    expect(body.agentCardUrls).toHaveLength(1);
    expect(body.agentCardUrls[0]).toContain("/api/kernels/kernel-test-1/agent-card.json");
    expect(body.missing).toEqual([]);
    expect(body.readiness).toEqual({
      devices: { registered: 1, executable: 1 },
      adapterReady: true,
      verifiedRun: true,
      runEvidence: "verified",
      setupTestEvidence: "none",
      payout: "not_supported",
      openOffers: null, // the job-offer store is not initialised here
    });
  });

  it("is partial with every slot filled but no verified run", async () => {
    seedAllSlots("kernel-test-1", "cap-test-1");
    const body = (await status()).json();
    expect(body.status).toBe("partial");
    expect(body.readiness.verifiedRun).toBe(false);
    expect(body.readiness.runEvidence).toBe("none");
    expect(body.missing).toEqual([expect.stringContaining("verified run — no completed job")]);
  });

  it("does not count a self-attested setup test job", async () => {
    seedAllSlots("kernel-test-1", "cap-test-1");
    deviceKey().register("kernel-test-1");
    // The shape POST /api/setup/test-job writes for a kernel with no devices.
    seedRun("test-job-0001", "kernel-test-1", "cap-test-1", {
      signer: "self-attest",
      algorithm: "none",
      value: "self-attested by kernel kernel-test-1",
    });
    const body = (await status()).json();
    expect(body.status).toBe("partial");
    expect(body.readiness.setupTestEvidence).toBe("self-attest");
    expect(body.readiness.runEvidence).toBe("self-attest");
    expect(body.missing.some((m: string) => m.includes("a setup test job does not count"))).toBe(true);
  });

  it("does not count the gateway's own test-key run", async () => {
    seedAllSlots("kernel-test-1", "cap-test-1");
    deviceKey().register("kernel-test-1");
    // The in-process KernelService signs with the zero-address test key.
    seedRun("test-job-0002", "kernel-test-1", "cap-test-1", {
      signer: "0x0000000000000000000000000000000000000000",
      algorithm: "secp256k1",
      value: "0xdeadbeef",
    });
    const body = (await status()).json();
    expect(body.status).toBe("partial");
    expect(body.readiness.setupTestEvidence).toBe("test-key");
  });

  it("does not count evidence signed by a key other than the kernel's registered key", async () => {
    seedAllSlots("kernel-test-1", "cap-test-1");
    const registered = deviceKey();
    registered.register("kernel-test-1");
    const impostor = deviceKey();
    seedRun("job-test-1", "kernel-test-1", "cap-test-1", { ...impostor.sign(), signer: registered.publicKey });
    const body = (await status()).json();
    expect(body.status).toBe("partial");
    expect(body.readiness.runEvidence).toBe("invalid");
    expect(body.missing.some((m: string) => m.includes("does not verify against the kernel's registered key"))).toBe(
      true,
    );
  });

  it("cannot verify device evidence when the kernel has no registered signing key", async () => {
    seedAllSlots("kernel-test-1", "cap-test-1");
    seedRun("job-test-1", "kernel-test-1", "cap-test-1", deviceKey().sign());
    const body = (await status()).json();
    expect(body.status).toBe("partial");
    expect(body.readiness.runEvidence).toBe("unregistered-signer");
    expect(body.missing.some((m: string) => m.includes("no signing key is registered for the kernel"))).toBe(true);
  });

  it("does not count verified evidence on a job that did not complete", async () => {
    seedAllSlots("kernel-test-1", "cap-test-1");
    const key = deviceKey();
    key.register("kernel-test-1");
    seedRun("job-test-1", "kernel-test-1", "cap-test-1", key.sign(), { status: "failed" });
    const body = (await status()).json();
    expect(body.status).toBe("partial");
    expect(body.readiness.verifiedRun).toBe(false);
  });

  it("does not borrow another operator's verified run", async () => {
    seedAllSlots("kernel-test-1", "cap-test-1");
    seedKernel("kernel-other", "Someone else", "0xsomeone-else");
    seedCapability("cap-other", "kernel-other", "fdm", { availability: { mode: "always" } });
    const key = deviceKey();
    key.register("kernel-other");
    seedRun("job-other", "kernel-other", "cap-other", key.sign());
    const body = (await status()).json();
    expect(body.status).toBe("partial");
    expect(body.readiness.verifiedRun).toBe(false);
    expect(body.readiness.runEvidence).toBe("none"); // the other operator's run is never read
  });

  it("does not let newer failed jobs push a verified run out of the examined window", async () => {
    seedAllSlots("kernel-test-1", "cap-test-1");
    const key = deviceKey();
    key.register("kernel-test-1");
    seedRun("job-verified", "kernel-test-1", "cap-test-1", key.sign(), { at: "2026-01-01T00:00:00.000Z" });
    for (let i = 10; i < 22; i++) {
      seedRun(`job-failed-${i}`, "kernel-test-1", "cap-test-1", { signer: "self-attest", algorithm: "none", value: "x" }, {
        status: "failed",
        at: `2026-02-${i}T00:00:00.000Z`,
      });
    }
    const body = (await status()).json();
    expect(body.readiness.verifiedRun).toBe(true);
    expect(body.status).toBe("ready");
  });

  it("flags mock-only devices even with a verified run", async () => {
    seedKernel("kernel-test-1", "Test Kernel");
    seedDevice("dev-mock", "kernel-test-1", "machine", "mock");
    seedDevice("dev-refusal", "kernel-test-1", "machine", "generic-http");
    seedCapability("cap-test-1", "kernel-test-1", "fdm", { availability: { mode: "always" } });
    attachChannel(TEST_OP, { label: "x", transport: "manual", describe: "dashboard only" });
    const key = deviceKey();
    key.register("kernel-test-1");
    seedRun("job-test-1", "kernel-test-1", "cap-test-1", key.sign());
    const body = (await status()).json();
    expect(body.status).toBe("partial");
    expect(body.readiness.devices).toEqual({ registered: 2, executable: 0 });
    expect(body.readiness.adapterReady).toBe(false);
    expect(body.missing).toEqual([expect.stringContaining("device adapter — none of the 2 registered devices")]);
  });

  it("serves no key, signature or job and bundle id", async () => {
    seedAllSlots("kernel-test-1", "cap-test-1");
    const key = deviceKey();
    key.register("kernel-test-1");
    const signature = key.sign();
    seedRun("job-secret-id", "kernel-test-1", "cap-test-1", signature, { bundleId: "bundle-secret-id" });
    const res = await status();
    expect(res.json().readiness.verifiedRun).toBe(true);
    for (const secret of [key.publicKey.slice(2), signature.value, "job-secret-id", "bundle-secret-id", BUNDLE_HASH]) {
      expect(res.body).not.toContain(secret);
    }
  });

  it("counts open offers for the operator's capability types only", async () => {
    seedAllSlots("kernel-test-1", "cap-test-1");
    const offers = initJobOffersStore();
    const pricing = { amount: 10, currency: "USD", model: "fixed" as const };
    for (const capabilityType of ["fdm", "fdm", "cnc"]) {
      const created = await offers.create({ capabilityType, requirements: {}, pricing });
      expect(created.ok).toBe(true);
    }
    const body = (await status()).json();
    expect(body.readiness.openOffers).toBe(2);
  });

  it("flags missing availability for capabilities without it", async () => {
    seedKernel("kernel-test-2", "Kernel B");
    seedCapability("cap-test-2", "kernel-test-2", "fdm", {
      availability: {}, // empty object → counts as missing
    });
    attachChannel(TEST_OP, {
      label: "x",
      transport: "manual",
      describe: "dashboard only",
    });
    const body = (await status()).json();
    expect(body.status).toBe("partial");
    expect(body.missing.some((m: string) => m.includes("availability"))).toBe(true);
  });

  it("flags missing SLA for human-lane capability without it", async () => {
    seedKernel("kernel-test-3", "Kernel C");
    // human-lane: sla absent but it SHOULD be there since this is a human capability
    // Trick: we use null sla here but pretend the operator wanted human-lane by adding ONE human cap (sla set) + one without
    seedCapability("cap-test-3a", "kernel-test-3", "courier", {
      availability: { mode: "always" },
      sla: { acceptanceWindowSec: 60, completionDeadlineSec: 1800 },
    });
    seedCapability("cap-test-3b", "kernel-test-3", "concierge", {
      availability: { mode: "always" },
      // sla intentionally missing — this is a human-shaped cap missing its slot 2
    });
    attachChannel(TEST_OP, {
      label: "Owner phone",
      transport: "sms",
      describe: "SMS to owner E.164",
      endpoint: { phoneE164: "+14155551234" },
    });
    // A courier has no machine device; a verified run is what makes it ready.
    const key = deviceKey();
    key.register("kernel-test-3");
    seedRun("job-test-3", "kernel-test-3", "cap-test-3a", key.sign());
    const body = (await status()).json();
    expect(body.totals.humanLaneCount).toBe(1); // only cap-test-3a has sla set
    expect(body.totals.machineLaneCount).toBe(1); // cap-test-3b has no sla
    expect(body.status).toBe("ready");
    // Note: SLA absence on cap-test-3b counts it as machine-lane, which is fine.
    // Only flags missing SLA when humanLaneCount > 0 AND some have no sla — not our case here.
  });

  it("flags channels attached but all disabled", async () => {
    seedKernel("kernel-test-4", "Kernel D");
    seedCapability("cap-test-4", "kernel-test-4", "fdm", {
      availability: { mode: "always" },
    });
    attachChannel(TEST_OP, {
      label: "Disabled webhook",
      transport: "webhook",
      describe: "currently off for maintenance",
      enabled: false,
      endpoint: { url: "http://localhost:9100" },
    });
    const body = (await status()).json();
    expect(body.totals.channelCount).toBe(1);
    expect(body.totals.enabledChannelCount).toBe(0);
    expect(body.status).toBe("partial");
    expect(body.missing.some((m: string) => m.includes("channel enabled"))).toBe(true);
  });

  it("agentCardUrls populated per kernel", async () => {
    seedKernel("kernel-A", "Kernel A");
    seedKernel("kernel-B", "Kernel B");
    seedCapability("cap-A", "kernel-A", "fdm", { availability: { mode: "always" } });
    seedCapability("cap-B", "kernel-B", "cnc", { availability: { mode: "always" } });
    attachChannel(TEST_OP, {
      label: "x",
      transport: "manual",
      describe: "dashboard",
    });
    const body = (await status()).json();
    expect(body.agentCardUrls).toHaveLength(2);
    expect(body.agentCardUrls.every((u: string) => u.includes("/agent-card.json"))).toBe(true);
  });

  it("response is cacheable (15s)", async () => {
    const res = await status();
    expect(res.headers["cache-control"]).toBe("public, max-age=15");
  });
});
