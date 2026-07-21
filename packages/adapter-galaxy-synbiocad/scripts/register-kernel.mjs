// Turnkey gateway registration for the Galaxy-SynBioCAD kernel.
//
//   GATEWAY_URL=https://pcc-gateway-staging.up.railway.app \
//   PCC_API_KEY=pcc_live_... \
//   ENDPOINT_URL=https://<your-public-host>/  \
//   node scripts/register-kernel.mjs
//
// Steps: build manifest -> POST /api/kernels/register (Bearer) ->
// POST /api/kernels/:id/verify (builder self-auth via X-Agent-Id) -> confirm.
// The endpoint must already be serving scripts/serve.mjs behind ENDPOINT_URL
// (the gateway touchstone POSTs a dry-run and requires a 2xx).
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ADAPTER = process.env.ADAPTER_DIST ?? join(HERE, "..", "dist", "index.js");
const SDK =
  process.env.KERNEL_SDK_DIST ??
  join(HERE, "..", "..", "kernel-sdk", "dist", "index.js");

const GATEWAY = process.env.GATEWAY_URL;
const KEY = process.env.PCC_API_KEY;
const ENDPOINT = process.env.ENDPOINT_URL;
const KERNEL_ID = process.env.KERNEL_ID ?? "galaxy-synbiocad-demo";
const AGENT = process.env.BUILDER_AGENT_ID ?? "eip155:84532:0xGalaxySynBioCadDemo";

if (!GATEWAY || !KEY || !ENDPOINT) {
  console.error("Required env: GATEWAY_URL, PCC_API_KEY, ENDPOINT_URL");
  process.exit(2);
}

const { buildGalaxySynBioCadManifest } = await import(pathToFileURL(ADAPTER).href);
const { registerKernel } = await import(pathToFileURL(SDK).href);

const manifest = buildGalaxySynBioCadManifest({
  kernelId: KERNEL_ID,
  endpointURL: ENDPOINT,
  builderAgentId: AGENT,
  maxAssuranceTier: 1,
});
console.log(
  `manifest: ${manifest.kernelId} · ${manifest.capabilityType} · ${manifest.workflowSteps.length} steps · ${manifest.endpointURL}`,
);

const reg = await registerKernel(GATEWAY, manifest, { apiKey: KEY });
console.log("register:", JSON.stringify(reg));

const vres = await fetch(`${GATEWAY}/api/kernels/${encodeURIComponent(KERNEL_ID)}/verify`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${KEY}`,
    "X-Agent-Id": AGENT, // builder self-auth
  },
});
console.log("verify:", vres.status, await vres.text());

const mres = await fetch(
  `${GATEWAY}/api/kernels/marketplace/${encodeURIComponent(KERNEL_ID)}`,
  { headers: { Authorization: `Bearer ${KEY}` } },
);
const mj = await mres.json().catch(() => ({}));
console.log("marketplace status:", mj?.kernel?.status, "· verifiedAt:", mj?.kernel?.verifiedAt);
