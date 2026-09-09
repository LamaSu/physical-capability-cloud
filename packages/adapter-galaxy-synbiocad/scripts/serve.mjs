// Minimal HTTP server that serves the Galaxy-SynBioCAD kernel's job handler so
// it can be registered with a PCC gateway. Framework-free (node:http).
//
//   PORT=8790 node scripts/serve.mjs
//
// Endpoints:
//   GET  /            -> 200 health
//   POST / (dryRun or no tool_id) -> 200 (satisfies the gateway touchstone smoke test)
//   POST / {jobId, input:{tool_id, params}} -> 200 signed evidence bundle (mock transport)
//
// The ephemeral key is dev-only (not on-chain-registered). For production
// settlement, wire an operator-owned principal key via kernel.createHandler({...}).
import http from "node:http";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = process.env.ADAPTER_DIST ?? join(HERE, "..", "dist", "index.js");
const PORT = Number(process.env.PORT ?? 8790);
const KERNEL_ID = process.env.KERNEL_ID ?? "galaxy-synbiocad-demo";
const BUILDER_AGENT_ID = process.env.BUILDER_AGENT_ID ?? "eip155:84532:0xGalaxySynBioCadDemo";

const m = await import(pathToFileURL(DIST).href);
const kernel = new m.GalaxySynBioCadKernel({
  kernelId: KERNEL_ID,
  endpointURL: process.env.ENDPOINT_URL ?? "https://placeholder.invalid/run", // not used for serving
  builderAgentId: BUILDER_AGENT_ID,
  mockMode: true,
});
const { handler } = kernel.createEphemeralHandler();

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json" });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET") {
    return send(res, 200, {
      status: "ok",
      kernel: kernel.manifest.kernelId,
      capabilityType: kernel.manifest.capabilityType,
      tools: kernel.capabilities().length,
    });
  }
  if (req.method !== "POST") return send(res, 405, { error: "method_not_allowed" });

  let raw = "";
  for await (const chunk of req) raw += chunk;
  let body = {};
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    return send(res, 400, { error: "bad_json" });
  }

  const input = body.input ?? {};
  // Touchstone smoke test (dryRun / no tool_id): answer 2xx without executing.
  if (body.dryRun || !input.tool_id) {
    return send(res, 200, {
      ok: true,
      dryRun: true,
      kernelId: kernel.manifest.kernelId,
      message: "smoke ok",
    });
  }
  try {
    const result = await handler({ jobId: String(body.jobId ?? `job-${Date.now()}`), input });
    return send(res, 200, result);
  } catch (e) {
    return send(res, 500, { error: "execute_failed", detail: e?.message ?? String(e) });
  }
});

server.listen(PORT, () => {
  console.log(`[serve] galaxy-synbiocad kernel '${KERNEL_ID}' listening on :${PORT}`);
});
