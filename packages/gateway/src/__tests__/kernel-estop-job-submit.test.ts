/**
 * A kernel in emergency stop takes no new jobs: POST /api/jobs/submit (adk #4446).
 *
 * The operator's emergency stop sets `emergencyStop: true` in the kernel's stored
 * policy. The negotiation, fast-track and approval routes read it and refuse, but
 * POST /api/jobs/submit did not consult it at all: a job submitted to a stopped
 * kernel was accepted (200, status "queued") and sat in the queue the kernel's
 * node polls.
 *
 * Now the route refuses a stopped kernel with 409 `kernel_emergency_stopped`,
 * before any job is written, for the kernel's owner and for any other caller (a
 * buyer). A kernel with no policy row is not stopped, and a resumed kernel takes
 * jobs again.
 *
 * Driven over HTTP through the REAL apiGate and real API keys, and through the
 * real operator routes (POST /api/operator/emergency-stop and -resume) that set
 * and clear the stop.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { schema } from "@pcc/store";
import { apiGate } from "../middleware/api-gate.js";
import { kernelRoutes } from "../routes/kernels.js";
import { operatorRoutes } from "../routes/operator.js";
import { jobSubmitRoutes } from "../routes/job-submit.js";
import { provisionApiKey } from "../auth/api-key-auth.js";
import { closeStore, getRepos, getStore, initStore } from "../db.js";

const { jobs } = schema;

const OWNER = "estop-submit-owner@x.test";
const BUYER = "estop-submit-buyer@x.test";

let app: FastifyInstance;
let ownerKey = "";
let buyerKey = "";
let seq = 0;
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${++seq}`;

const asOwner = () => ({ authorization: `Bearer ${ownerKey}` });
const asBuyer = () => ({ authorization: `Bearer ${buyerKey}` });

/** A kernel registered by OWNER through the real write path, with one fdm capability. */
async function ownedKernel(prefix: string): Promise<{ kernelId: string; capabilityId: string }> {
  const kernelId = uid(prefix);
  const res = await app.inject({
    method: "POST",
    url: "/api/kernels",
    headers: asOwner(),
    payload: { id: kernelId, name: `Estop ${kernelId}` },
  });
  expect(res.statusCode, res.body).toBe(201);
  const capabilityId = `cap-${kernelId}-fdm`;
  getRepos().capabilities.insert({
    id: capabilityId,
    kernelId,
    type: "fdm",
    name: "FDM",
    materials: ["PLA"],
    assuranceTiers: [0],
    pricing: { currency: "USDC", baseCost: "10", minimum: "5" },
    availability: {},
    location: { lat: 0, lng: 0 },
  } as never);
  return { kernelId, capabilityId };
}

const emergencyStop = (kernelId: string) =>
  app.inject({
    method: "POST",
    url: "/api/operator/emergency-stop",
    headers: asOwner(),
    payload: { kernelId, reason: "estop-submit test" },
  });

const emergencyResume = (kernelId: string) =>
  app.inject({
    method: "POST",
    url: "/api/operator/emergency-resume",
    headers: asOwner(),
    payload: { kernelId },
  });

const submit = (headers: Record<string, string>, kernelId: string, capabilityId: string) =>
  app.inject({
    method: "POST",
    url: "/api/jobs/submit",
    headers,
    payload: { kernelId, stepId: uid("step"), capabilityId },
  });

function jobsFor(kernelId: string): number {
  return getStore().db.select().from(jobs).all().filter((j) => j.kernelId === kernelId).length;
}

beforeAll(async () => {
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: false });
  ownerKey = provisionApiKey({ operatorId: OWNER, scopes: ["operator"] }).rawKey;
  buyerKey = provisionApiKey({ operatorId: BUYER, scopes: ["operator"] }).rawKey;
  app = Fastify({ logger: false });
  await app.register(apiGate);
  await app.register(kernelRoutes);
  await app.register(operatorRoutes);
  await app.register(jobSubmitRoutes);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  closeStore();
});

describe("POST /api/jobs/submit and a kernel's emergency stop", () => {
  it("control: a kernel with no policy row takes a job, from its owner and from a buyer", async () => {
    const { kernelId, capabilityId } = await ownedKernel("submit-open");
    for (const headers of [asOwner(), asBuyer()]) {
      const res = await submit(headers, kernelId, capabilityId);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().status).toBe("queued");
    }
    expect(jobsFor(kernelId)).toBe(2);
  });

  it("[repro] a stopped kernel refuses a job from its OWNER: 409 kernel_emergency_stopped, no job written", async () => {
    const { kernelId, capabilityId } = await ownedKernel("submit-stop-owner");
    expect((await emergencyStop(kernelId)).statusCode).toBe(200);
    const res = await submit(asOwner(), kernelId, capabilityId);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error).toBe("kernel_emergency_stopped");
    expect(jobsFor(kernelId)).toBe(0);
  });

  it("[repro] a stopped kernel refuses a job from a BUYER: 409 kernel_emergency_stopped, no job written", async () => {
    const { kernelId, capabilityId } = await ownedKernel("submit-stop-buyer");
    expect((await emergencyStop(kernelId)).statusCode).toBe(200);
    const res = await submit(asBuyer(), kernelId, capabilityId);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error).toBe("kernel_emergency_stopped");
    expect(jobsFor(kernelId)).toBe(0);
  });

  it("[repro] refused while stopped, accepted again once the kernel is resumed (the stop is not sticky)", async () => {
    const { kernelId, capabilityId } = await ownedKernel("submit-resume");
    expect((await emergencyStop(kernelId)).statusCode).toBe(200);
    expect((await submit(asBuyer(), kernelId, capabilityId)).statusCode).toBe(409);
    expect((await emergencyResume(kernelId)).statusCode).toBe(200);
    const res = await submit(asBuyer(), kernelId, capabilityId);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().status).toBe("queued");
    expect(jobsFor(kernelId)).toBe(1);
  });
});
