/** N85 F2: a heartbeat may refresh only capability rows owned by its kernel. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { provisionApiKey } from "../auth/api-key-auth.js";
import { apiGate } from "../middleware/api-gate.js";
import { kernelRoutes } from "../routes/kernels.js";
import { operatorRelayRoutes } from "../routes/operator-relay.js";
import { closeStore, getRepos, initStore } from "../db.js";

const PREV_DB = process.env.PCC_DB_PATH;
const KERNELS = { A: "kp-a", B: "kp-a-x" };
const PAST = "2020-01-01T00:00:00.000Z";
const keys = { A: "", B: "" };
const bearer = (operator: keyof typeof keys) => ({ authorization: `Bearer ${keys[operator]}` });
let app: FastifyInstance;

beforeEach(async () => {
  process.env.PCC_DB_PATH = ":memory:";
  closeStore();
  initStore({ seed: false });
  app = Fastify({ logger: false });
  await app.register(apiGate);
  await app.register(kernelRoutes);
  await app.register(operatorRelayRoutes);
  await app.ready();
  for (const operator of ["A", "B"] as const) {
    keys[operator] = provisionApiKey({ operatorId: `n85-heartbeat-${operator}`, scopes: ["*"] }).rawKey;
    const registered = await app.inject({
      method: "POST", url: "/api/kernels", headers: bearer(operator),
      payload: { id: KERNELS[operator], name: `N85 heartbeat ${operator}`, location: { lat: 1, lng: 1 } },
    });
    expect(registered.statusCode).toBe(201);
  }
});

afterEach(async () => {
  await app.close();
  closeStore();
  if (PREV_DB === undefined) delete process.env.PCC_DB_PATH;
  else process.env.PCC_DB_PATH = PREV_DB;
});

describe("N85 heartbeat capability ownership", () => {
  it.each(["operator-relay", "kernel"] as const)("%s ignores a colliding capability id owned by another kernel", async (route) => {
    const heartbeat = (operator: keyof typeof keys, types: string[]) => app.inject({
      method: "POST",
      url: route === "operator-relay" ? "/api/operator/heartbeat" : `/api/kernels/${KERNELS[operator]}/heartbeat`,
      headers: bearer(operator),
      payload: {
        ...(route === "operator-relay" ? { kernelId: KERNELS[operator] } : {}),
        status: "online", capabilities: types.map((type) => ({ type, name: `${operator} ${type}` })),
      },
    });

    expect((await heartbeat("B", ["y"])).statusCode).toBe(200);
    const repos = getRepos();
    // kp-a + x-y and kp-a-x + y produce the same generated capability id.
    const collidedId = "cap-kp-a-x-y";
    repos.capabilities.update(collidedId, { lastHeartbeatAt: PAST, validUntil: PAST });
    const before = repos.capabilities.findById(collidedId);
    expect(before?.kernelId).toBe(KERNELS.B);
    const otherKernelBefore = repos.kernels.findById(KERNELS.B);

    const response = await heartbeat("A", ["x-y", "own"]);
    expect(response.statusCode).toBe(200);
    expect(repos.capabilities.findById(collidedId)).toEqual(before);
    expect(repos.kernels.findById(KERNELS.B)).toEqual(otherKernelBefore);
    expect(response.json().capabilitiesReceived).toBe(1);
    expect(repos.capabilities.findById("cap-kp-a-own")?.kernelId).toBe(KERNELS.A);
    expect(repos.kernels.findById(KERNELS.A)?.lastHeartbeat).toBe(response.json().timestamp);
  });
});
