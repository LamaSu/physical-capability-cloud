import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const PAGES = ["order.html", "driver.html", "operator.html", "operator-capture.html", "pizza-observability.html", "pizza-llm-bootstrap.html", "pizza-onboard-driver.html", "pizza-onboard-shop.html", "pizza-onboard-user.html", "pizza-llm-agent-prompt.html", "pizza-demo-index.html"];
let dashboard: string;
let app: FastifyInstance | undefined;
let createGateway: typeof import("../server.js").createGateway;

beforeAll(async () => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("PCC_DB_PATH", ":memory:");
  vi.stubEnv("WORKFLOW_DB_PATH", ":memory:");
  vi.stubEnv("PCC_SEED_DATA", "false");
  vi.stubEnv("SERVE_DASHBOARD", "true");
  vi.stubEnv("COOKIE_SECRET", "pcc_live_test");
  dashboard = await mkdtemp(join(tmpdir(), "demo-gate-"));
  await writeFile(join(dashboard, "index.html"), "<!doctype html><title>PCC</title>");
  for (const file of PAGES) await copyFile(join(ROOT, "apps/dashboard/public", file), join(dashboard, file));
  vi.stubEnv("DASHBOARD_PATH", dashboard);
  ({ createGateway } = await import("../server.js"));
}, 180000);
async function boot(flag: string, listen = false) {
  vi.stubEnv("PCC_DEMOS_ENABLED", flag === "true" ? "true" : "");
  if (flag === "unset") delete process.env.PCC_DEMOS_ENABLED;
  app = (await createGateway(0)).app as unknown as FastifyInstance;
  await app.ready();
  return listen ? app.listen({ port: 0, host: "127.0.0.1" }) : "";
}
afterEach(async () => {
  await app?.close();
  app = undefined;
  vi.restoreAllMocks();
});
afterAll(async () => {
  if (dashboard) await rm(dashboard, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("demo gate contract", () => {
  it("production without the flag: the demo stream and the demo routes are not found", async () => {
    await boot("unset");
    const stream = await app!.inject({ method: "GET", url: "/sse/demo/firehose", signal: AbortSignal.timeout(1000) });
    expect(stream.statusCode).toBe(404);
    expect(stream.body).toBe('{"error":"not_found"}');
    const noKey = await app!.inject({ method: "GET", url: "/api/demo/orders" });
    expect(noKey.statusCode).toBe(401);
    expect(noKey.json().error).toBe("api_key_required");
    const provision = await app!.inject({ method: "POST", url: "/api/auth/provision", remoteAddress: "127.0.0.2", payload: { email: "operator@example.com" } });
    expect(provision.statusCode).toBe(201);
    const key = provision.json().api_key;
    expect(key).toBeTypeOf("string");
    const authenticated = await app!.inject({ method: "GET", url: "/api/demo/orders", headers: { authorization: "Bearer " + key } });
    expect(authenticated.statusCode).toBe(404);
    expect(authenticated.body).toBe('{"error":"not_found"}');
  }, 15000);
  it("production with the flag: the demo stream answers as an event stream", async () => {
    const base = await boot("true", true);
    const controller = new AbortController();
    try {
      const response = await fetch(base + "/sse/demo/firehose", { signal: controller.signal });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toMatch(/^text\/event-stream/i);
    } finally { controller.abort(); }
  }, 15000);
  it("aborted demo checks leave no stream heartbeat running", async () => {
    const base = await boot("true", true);
    const intervals = vi.spyOn(globalThis, "setInterval");
    const cleared = vi.spyOn(globalThis, "clearInterval");
    try {
      for (let i = 0; i < 25; i++) {
        const controller = new AbortController();
        try {
          const response = await fetch(base + "/sse/demo/firehose", { signal: controller.signal });
          expect(response.status).toBe(200);
        } finally { controller.abort(); }
      }
      const heartbeats = intervals.mock.calls.flatMap((call, index) => call[1] === 15000 ? [intervals.mock.results[index].value] : []);
      expect(heartbeats).toHaveLength(25);
      await vi.waitFor(() => {
        for (const handle of heartbeats) expect(cleared.mock.calls.some(([value]) => value === handle)).toBe(true);
      }, { timeout: 1000, interval: 20 });
    } finally {
      intervals.mock.calls.forEach((call, index) => {
        if (call[1] === 15000) clearInterval(intervals.mock.results[index].value);
      });
    }
  }, 15000);
  it.each(["unset", "true"])("the demo pages stay served with revalidation when the flag is %s", async (flag) => {
    await boot(flag);
    for (const file of PAGES) {
      const response = await app!.inject({ method: "GET", url: "/" + file });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toMatch(/^text\/html/i);
      expect(response.headers["cache-control"]).toBe("public, max-age=0");
      expect(response.headers.etag).toBeTruthy();
    }
  }, 15000);
});
