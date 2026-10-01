/**
 * N71 / astra pack 83, finding 3 (HIGH): "Ordinary device registration
 * authorizes any existing kernel." astra's reproduction, written against WP-C at
 * dfb41dc1: A creates kernel K; B POSTs a new device targeting K; the handler
 * inserts it without comparing ownership.
 *
 * AT THIS HEAD THAT SCENARIO DOES NOT REPRODUCE. WP-C's N71 owner guard
 * (routes/job-submit.ts, operator item 86) now answers B with 403
 * not_kernel_owner and writes nothing. The first test pins that as it was
 * written, so a regression of the plain case fails loudly.
 *
 * WHAT DOES REPRODUCE is a bypass of that guard by type. The guard is entered
 * only `if (typeof body.kernelId === "string" && body.kernelId !== "")`, and
 * the handler then hands the SAME body to the facade, which looks the kernel up
 * with whatever `body.kernelId` holds. better-sqlite3 flattens an array
 * parameter, so `kernelId: ["<A's kernel>"]` skips the guard and still finds
 * A's kernel: B gets 200 and a device row, with its connection config, on A's
 * kernel. An object or a boolean is a 500 from the same lookup, and a number is
 * answered by a lookup that was never meant to take one.
 *
 * Driven over HTTP through the REAL apiGate and real API keys, and through the
 * same routes with no apiGate. The file imports only modules that exist at
 * 3e4f5d63, so it runs unchanged there.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { apiGate } from "../middleware/api-gate.js";
import { jobSubmitRoutes } from "../routes/job-submit.js";
import { provisionApiKey } from "../auth/api-key-auth.js";
import { closeStore, getRepos, initStore } from "../db.js";

const A = "n71-devreg-owner-a@x.test";
const B = "n71-devreg-stranger-b@x.test";
/** A synthetic connection credential: it must never end up on a kernel the writer does not own. */
const SECRET = "SYNTHETIC-N71-DEVICE-CREDENTIAL";

let app: FastifyInstance;
/** The same routes with NO apiGate: the handler must refuse on its own. */
let bareApp: FastifyInstance;
let keyA = "";
let keyB = "";
let seq = 0;
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${++seq}`;
const KERNEL_A = uid("kernel-n71-a");

const asKey = (k: string) => ({ authorization: `Bearer ${k}` });

/** A device body naming `kernelId` (whatever its type: the point of several cases). */
const device = (kernelId: unknown, id: string) => ({
  kernelId,
  id,
  type: "printer",
  model: "Model X",
  adapterType: "http",
  adapterConfig: { host: "10.0.0.7", apiKey: SECRET },
  capabilities: ["print"],
});

const register = (on: FastifyInstance, headers: Record<string, string>, payload: unknown) =>
  on.inject({ method: "POST", url: "/api/devices/register", headers, payload: payload as never });

/** The ids of every device row on `kernelId`. */
const devicesOn = (kernelId: string) =>
  (getRepos().kernels.findDevicesByKernel(kernelId) as Array<{ id: string }>).map((d) => d.id);

beforeAll(async () => {
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: false });
  keyA = provisionApiKey({ operatorId: A, scopes: ["operator"] }).rawKey;
  keyB = provisionApiKey({ operatorId: B, scopes: ["operator"] }).rawKey;
  const { getKernelFacade } = await import("../facades/index.js");
  const reg = await getKernelFacade().register({ id: KERNEL_A, name: "N71 A's workshop" }, A);
  expect(reg.success).toBe(true);

  app = Fastify({ logger: false });
  await app.register(apiGate);
  await app.register(jobSubmitRoutes);
  await app.ready();

  bareApp = Fastify({ logger: false });
  await bareApp.register(jobSubmitRoutes);
  await bareApp.ready();
});

afterAll(async () => {
  await app?.close();
  await bareApp?.close();
  closeStore();
});

describe("N71 / astra pack 83 HIGH 3: only the kernel's owner registers devices on it", () => {
  it("[neg] astra's scenario as written: B registers a device on A's kernel (string kernelId): 403 not_kernel_owner, no row", async () => {
    const id = uid("dev-b-plain");
    const res = await register(app, asKey(keyB), device(KERNEL_A, id));
    expect(devicesOn(KERNEL_A)).not.toContain(id);
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error).toBe("not_kernel_owner");
  });

  it("[neg] an ARRAY kernelId naming A's kernel does not skip the owner check: B gets 400 invalid_kernel_id and no row", async () => {
    const id = uid("dev-b-array");
    const res = await register(app, asKey(keyB), device([KERNEL_A], id));
    // At 3e4f5d63 this is 200 and the row exists: the guard is skipped, the
    // facade's lookup flattens the array and finds A's kernel.
    expect(devicesOn(KERNEL_A), `B registered a device on A's kernel: ${res.statusCode} ${res.body}`).not.toContain(id);
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error).toBe("invalid_kernel_id");
  });

  it.each([
    ["an array", (k: string) => [k]],
    ["a two-element array", (k: string) => [k, "kernel-elsewhere"]],
    ["an object", () => ({ id: "x" })],
    ["a boolean", () => true],
    ["a number", () => 12345],
  ])("[neg] %s as kernelId is a 400 invalid_kernel_id for B and for A alike, nothing written (never a 200 or a 500)", async (_label, make) => {
    for (const [who, key] of [["B", keyB], ["A", keyA]] as const) {
      const id = uid(`dev-${who}-typed`);
      const res = await register(app, asKey(key), device(make(KERNEL_A), id));
      expect(res.statusCode, `${who}: ${res.body}`).toBe(400);
      expect(res.json().error, who).toBe("invalid_kernel_id");
      expect(devicesOn(KERNEL_A), who).not.toContain(id);
    }
  });

  it("[neg] NO actor at the handler (apiGate absent) is 401 before the kernelId is looked at, whatever its type", async () => {
    for (const kernelId of [KERNEL_A, [KERNEL_A], { id: "x" }, true, 12345, undefined]) {
      const id = uid("dev-noactor");
      const res = await register(bareApp, {}, device(kernelId, id));
      expect(res.statusCode, JSON.stringify(kernelId)).toBe(401);
      expect(devicesOn(KERNEL_A)).not.toContain(id);
    }
  });

  it("a MISSING kernelId (absent, null or empty) is still 400 missing_required_fields, nothing written (unchanged)", async () => {
    for (const kernelId of [undefined, null, ""]) {
      const id = uid("dev-missing");
      const res = await register(app, asKey(keyB), device(kernelId, id));
      expect(res.statusCode, `${JSON.stringify(kernelId)}: ${res.body}`).toBe(400);
      expect(res.json().error).toBe("missing_required_fields");
      expect(devicesOn(KERNEL_A)).not.toContain(id);
    }
  });

  it("an UNKNOWN kernel, and a case variant of A's kernel id, are still 400 kernel_not_found for any caller (unchanged)", async () => {
    for (const kernelId of [uid("kernel-n71-ghost"), KERNEL_A.toUpperCase()]) {
      const id = uid("dev-unknown");
      const res = await register(app, asKey(keyB), device(kernelId, id));
      expect(res.statusCode, `${kernelId}: ${res.body}`).toBe(400);
      expect(res.json().error).toBe("kernel_not_found");
      expect(devicesOn(KERNEL_A)).not.toContain(id);
    }
  });

  it("control: the OWNER registers a device on its own kernel with a string kernelId; the row lands there and keeps its config", async () => {
    const id = uid("dev-a-owner");
    const res = await register(app, asKey(keyA), device(KERNEL_A, id));
    expect(res.statusCode, res.body).toBe(200);
    expect(devicesOn(KERNEL_A)).toContain(id);
    const row = (getRepos().kernels.findDevicesByKernel(KERNEL_A) as Array<{ id: string; adapterConfig?: string | null }>).find(
      (d) => d.id === id,
    );
    expect(String(row?.adapterConfig ?? "")).toContain(SECRET);
  });
});
