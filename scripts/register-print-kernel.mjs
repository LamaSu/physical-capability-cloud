#!/usr/bin/env node
/**
 * register-print-kernel.mjs — onboard an IPP 2D-printer kernel + device against
 * a LOCAL gateway, via the STANDARD onboarding routes:
 *
 *   1. POST /api/kernels             (register the kernel; optionally bind an
 *                                     Ed25519 signing key by proof-of-possession)
 *   2. POST /api/setup/register-device  (register the printer device,
 *                                     adapterType:"ipp")
 *
 * This is the PRINT leg of document.print-and-mail. The Ed25519 key it registers
 * is the SAME key the print-job path (packages/kernel/src/printer-job.ts,
 * makeKernelEd25519Signer) signs evidence bundles with — so bundles produced by
 * a later print verify against the signer this script proved here.
 *
 *   node scripts/register-print-kernel.mjs
 *   node scripts/register-print-kernel.mjs --gateway=http://localhost:3200 --uri=ipp://192.168.1.50/ipp/print
 *   PRINT_REAL=1 node scripts/register-print-kernel.mjs --uri=ipp://192.168.1.50/ipp/print
 *
 * Env / flags (all optional):
 *   --gateway / PCC_GATEWAY_URL   base URL (default http://localhost:3200). LOCAL ONLY — hard-refuses prod.
 *   --kernel-id / KERNEL_ID       kernel id (default kernel_print_ipp_<ts>)
 *   --device-id                   device id (default ipp_printer_01)
 *   --uri / IPP_URI               IPP printer URI (default ipp://localhost:631/ipp/print)
 *   --name                        printer display name (default "PCC IPP Printer")
 *   --model                       printer model (default "Canon PIXMA TR8620a")
 *   --real / PRINT_REAL=1         register in REAL mode (mockMode:false). Default is mock mode.
 *   --seed=<64hex> / KERNEL_ED25519_SEED   deterministic 32-byte signing seed (else random)
 *   --no-signing                  skip Ed25519 signing-key registration (kernel registers unsigned)
 *   PCC_API_KEY                   Bearer token, if the local gateway gates writes
 *
 * NOTE: The task suggested modelling this on a `register-bambu-kernel` helper on
 * origin/feat/kernel-bambu-printer — that branch is not present in origin, so
 * this is modelled on scripts/canary-agent-onboarding.mjs + the real onboarding
 * routes (packages/gateway/src/routes/{kernels,setup}.ts). Same shape a Bambu
 * helper would use; different adapterType.
 *
 * Exit 0 = kernel + device registered. Exit 1 = failure (printed loudly).
 */

// Ed25519 via node:crypto — zero external deps (so this script resolves from
// scripts/ under pnpm's non-hoisted layout), same technique as the gateway's
// packages/gateway/src/auth/ed25519.ts. RFC-8032 Ed25519 is interoperable with
// the tweetnacl signer used by @pcc/kernel-sdk / packages/kernel.
import { generateKeyPairSync, createPrivateKey, createPublicKey, sign } from "node:crypto";

// ── args ──────────────────────────────────────────────────────────────────────
const args = Object.fromEntries(
  process.argv
    .slice(2)
    .filter((a) => a.startsWith("--"))
    .map((a) => {
      const [k, v] = a.replace(/^--/, "").split("=");
      return [k, v ?? "true"];
    }),
);

const GATEWAY = (args.gateway || process.env.PCC_GATEWAY_URL || "http://localhost:3200").replace(
  /\/$/,
  "",
);
const KERNEL_ID = args["kernel-id"] || process.env.KERNEL_ID || `kernel_print_ipp_${Date.now()}`;
const DEVICE_ID = args["device-id"] || "ipp_printer_01";
const IPP_URI = args.uri || process.env.IPP_URI || "ipp://localhost:631/ipp/print";
const PRINTER_NAME = args.name || "PCC IPP Printer";
const PRINTER_MODEL = args.model || "Canon PIXMA TR8620a";
const REAL = args.real === "true" || process.env.PRINT_REAL === "1";
const MOCK_MODE = !REAL;
const SIGN = args["no-signing"] !== "true";
const API_KEY = process.env.PCC_API_KEY;
const SEED_HEX = args.seed || process.env.KERNEL_ED25519_SEED;

const die = (msg) => {
  console.error(`\n✖ ${msg}`);
  process.exit(1);
};

// ── LOCAL-ONLY guard (never prod) ───────────────────────────────────────────────
function assertLocalGateway(url) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    die(`--gateway is not a valid URL: ${url}`);
  }
  // Hard block on anything that looks like the production/staging network.
  if (/capability\.network|\.railway\.app|\.fly\.dev|\.vercel\.app|amazonaws\.com/.test(host)) {
    die(`refusing to target a non-local host "${host}". This script registers on LOCAL gateways only.`);
  }
  const localHosts = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"]);
  const isPrivateLan = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) || host.endsWith(".local");
  if (!localHosts.has(host) && !isPrivateLan) {
    die(
      `refusing to target "${host}" — not localhost/loopback/private-LAN. ` +
        `Point --gateway at a LOCAL gateway (e.g. http://localhost:3200).`,
    );
  }
}

// ── HTTP helper ─────────────────────────────────────────────────────────────────
async function call(method, path, body) {
  const headers = { "content-type": "application/json", "user-agent": "register-print-kernel/1" };
  if (API_KEY) headers.authorization = `Bearer ${API_KEY}`;
  let res;
  try {
    res = await fetch(`${GATEWAY}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    die(`cannot reach gateway at ${GATEWAY}${path} — is a LOCAL gateway running? (${e})`);
  }
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON body */
  }
  return { status: res.status, ok: res.ok, json };
}

// Ed25519 DER framing constants (see gateway/src/auth/ed25519.ts).
const SPKI_DER_PREFIX = Buffer.from("302a300506032b6570032100", "hex"); // 12 bytes, before raw 32-byte pubkey
const PKCS8_DER_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex"); // 16 bytes, before raw 32-byte seed

/** Raw 32-byte public key (hex) from a node:crypto Ed25519 public KeyObject. */
function rawPublicKeyHex(pubKeyObject) {
  const spki = pubKeyObject.export({ type: "spki", format: "der" });
  return Buffer.from(spki.subarray(SPKI_DER_PREFIX.length)).toString("hex");
}

/**
 * Build the Ed25519 registration proof for POST /api/kernels.
 *
 * Same scheme as @pcc/kernel-sdk buildEd25519RegistrationProof: a raw detached
 * Ed25519 signature over the utf8 bytes of the kernelId-bound challenge
 *   `pcc-kernel-signing-key:${kernelId}`
 * (single source of truth: kernelSigningProofMessage in @pcc/kernel). The
 * gateway's ed25519 lane verifies exactly this with node:crypto.
 */
function buildEd25519Signing(kernelId, seedHex) {
  let privateKey;
  let seedBytes;
  if (seedHex) {
    const clean = seedHex.startsWith("0x") ? seedHex.slice(2) : seedHex;
    if (!/^[0-9a-fA-F]{64}$/.test(clean)) die("--seed must be 64 hex chars (32-byte ed25519 seed)");
    seedBytes = Buffer.from(clean, "hex");
    privateKey = createPrivateKey({
      key: Buffer.concat([PKCS8_DER_PREFIX, seedBytes]),
      format: "der",
      type: "pkcs8",
    });
  } else {
    const kp = generateKeyPairSync("ed25519");
    privateKey = kp.privateKey;
    const pkcs8 = privateKey.export({ type: "pkcs8", format: "der" });
    seedBytes = Buffer.from(pkcs8.subarray(PKCS8_DER_PREFIX.length)); // raw 32-byte seed
  }
  const publicKeyHex = rawPublicKeyHex(createPublicKey(privateKey));
  const challenge = Buffer.from(`pcc-kernel-signing-key:${kernelId}`, "utf8");
  const proof = sign(null, challenge, privateKey); // raw 64-byte Ed25519 signature

  return {
    signingKeyAlgorithm: "ed25519",
    signingPublicKey: `0x${publicKeyHex}`,
    signingProof: proof.toString("hex"),
    // returned to the caller (printed once) — NOT sent on the wire
    _publicKeyHex: publicKeyHex,
    _seedHex: seedBytes.toString("hex"),
  };
}

// ── main ──────────────────────────────────────────────────────────────────────
async function main() {
  assertLocalGateway(GATEWAY);

  console.log(`▶ registering IPP print kernel on ${GATEWAY}`);
  console.log(`  kernelId=${KERNEL_ID} deviceId=${DEVICE_ID} adapterType=ipp mockMode=${MOCK_MODE}`);
  console.log(`  uri=${IPP_URI}`);

  // ── 1. POST /api/kernels ──────────────────────────────────────────────────
  const kernelBody = {
    id: KERNEL_ID,
    name: PRINTER_NAME,
    maxAssuranceTier: 1,
  };
  let signing;
  if (SIGN) {
    signing = buildEd25519Signing(KERNEL_ID, SEED_HEX);
    kernelBody.signingKeyAlgorithm = signing.signingKeyAlgorithm;
    kernelBody.signingPublicKey = signing.signingPublicKey;
    kernelBody.signingProof = signing.signingProof;
  }

  const k = await call("POST", "/api/kernels", kernelBody);
  if (k.status === 401 || k.status === 403) {
    die(`POST /api/kernels → ${k.status}. This gateway gates writes; set PCC_API_KEY=<key> and retry.`);
  }
  if (!k.ok || !k.json?.kernel) {
    die(`POST /api/kernels failed (${k.status}): ${JSON.stringify(k.json)}`);
  }
  const created = k.json.created;
  console.log(`✔ kernel ${created ? "created" : "updated"}: ${k.json.kernel.id}`);
  if (SIGN) {
    const boundKey = k.json.kernel.signingKey;
    if (boundKey && boundKey.algorithm === "ed25519") {
      console.log(`  ✔ ed25519 signing key bound: ${boundKey.publicKey}`);
    } else {
      console.log(
        `  ⚠ signing key not bound (proof rejected or set-once already bound). signingKey=${JSON.stringify(boundKey)}`,
      );
    }
  }

  // ── 2. POST /api/setup/register-device ─────────────────────────────────────
  const deviceBody = {
    kernelId: KERNEL_ID,
    deviceId: DEVICE_ID,
    type: "machine", // DeviceRole
    model: PRINTER_MODEL,
    adapterType: "ipp", // ← the exact enum value (packages/kernel AdapterType / setup VALID_ADAPTER_TYPES)
    adapterConfig: {
      uri: IPP_URI,
      name: PRINTER_NAME,
      kernelId: KERNEL_ID,
      mockMode: MOCK_MODE,
    },
    capabilities: ["document.print"],
  };

  const d = await call("POST", "/api/setup/register-device", deviceBody);
  if (d.status === 401 || d.status === 403) {
    die(`POST /api/setup/register-device → ${d.status}. Set PCC_API_KEY=<key> and retry.`);
  }
  if (!d.ok || !d.json?.registered) {
    die(`POST /api/setup/register-device failed (${d.status}): ${JSON.stringify(d.json)}`);
  }
  console.log(`✔ device ${d.json.action}: ${d.json.device?.id ?? DEVICE_ID} (adapterType=ipp)`);

  // ── summary ────────────────────────────────────────────────────────────────
  console.log(`\n✅ IPP print kernel onboarded.`);
  console.log(
    `   kernelId=${KERNEL_ID}  deviceId=${DEVICE_ID}  mode=${MOCK_MODE ? "MOCK (source.simulated=true)" : "REAL"}`,
  );
  if (SIGN && signing) {
    // The signing secret is shown ONCE (AWS/Stripe/GitHub-PAT convention).
    console.log(`\n   Ed25519 signing key (KEEP SECRET — shown once):`);
    console.log(`     public : ${signing.signingPublicKey}`);
    console.log(`     seed   : ${signing._seedHex}`);
    console.log(
      `   Reuse this seed for the print-job path so its bundles verify against the registered key:`,
    );
    console.log(`     KERNEL_ED25519_SEED=${signing._seedHex}  (makeKernelEd25519Signer)`);
  }
  console.log(
    `\n   Next: submit a print job (packages/kernel printer-job.runPrintJob) or POST /api/capabilities to become discoverable.`,
  );

  const result = {
    ts: new Date().toISOString(),
    gateway: GATEWAY,
    kernelId: KERNEL_ID,
    deviceId: DEVICE_ID,
    adapterType: "ipp",
    mockMode: MOCK_MODE,
    signed: Boolean(SIGN),
  };
  console.log(`\nREGISTER_RESULT=${JSON.stringify(result)}`);
  process.exit(0);
}

main().catch((e) => die(`unexpected error: ${e?.stack ?? e}`));
