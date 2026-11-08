// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Socket } from "node:net";

const ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
let server: Server;
const sockets = new Set<Socket>();
async function run(on: boolean, reset = false, key = "") {
  server = createServer((req, res) => {
    if (req.url === "/sse/demo/firehose" && req.method === "GET") {
      if (on) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: {}\n\n");
      } else {
        res.writeHead(404, { "content-type": "application/json" });
        res.end('{"error":"not_found"}');
      }
    } else if (req.url === "/api/demo/_reset" && req.method === "POST") {
      const authorized = req.headers.authorization === "Bearer pcc_live_test";
      res.writeHead(authorized ? 200 : 401, { "content-type": "application/json" });
      res.end(authorized ? '{"ok":true}' : '{"error":"api_key_required"}');
    } else { res.writeHead(404); res.end(); }
  });
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new TypeError("fetch failed");
  const base = "http://127.0.0.1:" + address.port;
  const env = { ...process.env, PCC_BASE: base, TMPDIR: ROOT + "tmp" };
  delete (env as Record<string, string | undefined>).PCC_API_KEY;
  if (key) (env as Record<string, string>).PCC_API_KEY = key;
  return new Promise<{ code: number | null; output: string; base: string }>((resolve, reject) => {
    const child = spawn("bash", ["scripts/demo-pizza.sh", ...(reset ? ["reset"] : [])], { cwd: ROOT, env });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output, base }));
  });
}
afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("demo-pizza.sh", () => {
  it("stops and says so when the demo is off", async () => {
    const { code, output, base } = await run(false);
    expect(code).toBe(1);
    expect(output).toContain("The pizza demo is off on " + base + ".");
    expect(output).not.toContain("order.html");
  }, 15000);
  it("prints today's links when the demo is on", async () => {
    const { code, output, base } = await run(true);
    expect(code).toBe(0);
    const urls = output.split("\n").filter((line) => line.startsWith("  " + base));
    expect(urls).toEqual(["/order.html", "/operator.html?shop=shop-roma", "/operator.html?shop=shop-slice-heaven", "/operator.html?shop=shop-mamas-kitchen", "/driver.html?driver=driver-alex", "/driver.html?driver=driver-beth", "/driver.html?driver=driver-carlos", "/driver.html?driver=driver-dana"].map((path) => "  " + base + path));
  }, 15000);
  it("reset fails with the HTTP status when the gateway refuses it", async () => {
    const { code, output } = await run(true, true);
    expect(code).toBe(1);
    expect(output).toContain("reset failed: HTTP 401");
  }, 15000);
  it("reset sends the API key when one is set", async () => {
    const { code, output } = await run(true, true, "pcc_live_test");
    expect(code).toBe(0);
    expect(output).toContain('{"ok":true}');
  }, 15000);
});
