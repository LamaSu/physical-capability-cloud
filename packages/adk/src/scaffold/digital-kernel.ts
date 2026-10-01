/**
 * @pcc/adk — digital-kernel scaffold (D3 slice 1, ledger R4).
 *
 * `scaffoldDigitalKernel()` generates a complete, installable third-party
 * digital-kernel project that depends ONLY on the public `@pcc/kernel-sdk`,
 * `@pcc/spec`, and `tweetnacl` — none of the six private workspace packages
 * `@pcc/onboard-kit`'s `scaffold()` pulls in (`workspace:*` on `@pcc/kernel`,
 * `@pcc/a2a`, `@pcc/agent-runtime`, `@pcc/agent-kernel`,
 * `@pcc/contract-builder`). A project generated here installs and runs
 * outside this monorepo (see `scripts/clean-install-check.mjs`).
 *
 * PURE: no filesystem, no network, no clock, no randomness. The same input
 * produces byte-identical output. Every validation rule below that fails
 * throws `ScaffoldRefused` naming the offending field. No field is
 * defaulted or invented — `pricing`, `maxAssuranceTier`, `search`, and
 * `versions` in particular are all money-, liability-, or provenance-
 * adjacent, and a missing value there is a refusal, not a default.
 *
 * DEVIATION from the D3 plan (reported per the implementer's instructions:
 * "If kernel-sdk's actual API differs from the spec, follow the real API
 * and report the difference"):
 *
 * `@pcc/kernel-sdk`'s `createKernelHandler` takes a `principalKey` typed as
 * `@pcc/spec`'s `PrincipalKey`, which requires THREE fields — `agentId`,
 * `walletAddress` (the wallet that owns the ERC-721 identity token), and
 * `publicKey` (see packages/spec/src/identity/ephemeral.ts). The plan's
 * declared `DigitalKernelScaffoldOptions.builder` shape was only
 * `{agentId, contactURI}`. Rather than invent or default a wallet address
 * (this is identity/settlement-adjacent — the gateway's reputation and
 * signer-binding paths key off it), this module adds a required, validated
 * `builder.walletAddress` field and refuses (ScaffoldRefused) if it is
 * missing or malformed, matching the DECLARED-not-defaulted rule the plan
 * already applies to pricing/tier/search/versions. `builder.agentId` is
 * also runtime-validated against the ERC-8004 `AgentRegistryId` pattern
 * (`eip155:<chainId>:0x<address>`) even though the plan's declared TS type
 * for it is a plain `string`: `@pcc/spec`'s `KernelBuilder.agentId` is
 * typed as the template-literal type `AgentRegistryId`, so an
 * out-of-pattern value would only surface as a `tsc` failure deep inside
 * the generated project's build (in `src/manifest.ts`'s `buildManifest`
 * call) — refusing early, at scaffold time, with a clear message is the
 * fail-closed choice.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A recorded marketplace search, proving search-before-build (MUST-CLOSE 5). */
export interface RecordedSearch {
  source: "capabilities.search" | "capabilities.templates";
  /** Non-empty search query string. */
  query: string;
  /** ISO-8601 UTC timestamp, e.g. `new Date().toISOString()`. */
  at: string;
  /** Non-negative integer count of results the search returned. */
  resultCount: number;
  /** IDs seen (may be empty); length must not exceed `resultCount`. */
  resultIds: string[];
}

export interface DigitalKernelScaffoldOptions {
  /** npm-safe project name: /^[a-z0-9][a-z0-9._-]{0,213}$/ */
  projectName: string;
  /** Globally-unique kernel id: /^[a-z0-9][a-z0-9_-]{2,63}$/ */
  kernelId: string;
  /** Human-readable name shown in the marketplace, non-empty, <= 120 chars. */
  name: string;
  /** One-paragraph description, non-empty. */
  description: string;
  /** Capability type this kernel advertises: /^[a-z0-9][a-z0-9-]{1,63}$/ */
  capabilityType: string;
  builder: {
    /** ERC-8004 AgentRegistryId, e.g. "eip155:84532:0x...". Non-empty. */
    agentId: string;
    /** mailto:/https: contact for support + suspension notices. Non-empty. */
    contactURI: string;
    /**
     * The wallet that owns this builder's ERC-721 identity token. Required
     * by @pcc/spec's PrincipalKey (see the module doc comment above for
     * why this field exists beyond the D3 plan's declared shape). Must be
     * a 20-byte hex address: /^0x[0-9a-fA-F]{40}$/.
     */
    walletAddress: string;
  };
  /** DECLARED, no default: finite, > 0. */
  pricing: { baseUSD: number };
  /** DECLARED, no default: integer 0..3. */
  maxAssuranceTier: 0 | 1 | 2 | 3;
  /** Non-empty; unique stepIds; dependsOn names EARLIER steps only. */
  workflowSteps: Array<{
    stepId: string;
    stepType: string;
    description: string;
    dependsOn: string[];
  }>;
  /** DECLARED, no default: proof of search-before-build. */
  search: RecordedSearch;
  /** Semver ranges for the generated package.json. Must not point in-monorepo. */
  versions: { spec: string; kernelSdk: string };
}

export class ScaffoldRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScaffoldRefused";
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

type ScaffoldWorkflowStep = DigitalKernelScaffoldOptions["workflowSteps"][number];

const PROJECT_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,213}$/;
const KERNEL_ID_RE = /^[a-z0-9][a-z0-9_-]{2,63}$/;
const CAPABILITY_TYPE_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
// eip155:<chainId>:0x<address> — matches @pcc/spec's AgentRegistryId template type.
const AGENT_ID_RE = /^eip155:[0-9]+:0x[0-9a-fA-F]+$/;
const WALLET_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
// ISO-8601 UTC, matching new Date().toISOString()'s shape (fractional seconds optional).
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const FORBIDDEN_VERSION_SUBSTRINGS = ["workspace:", "file:", "link:", "portal:"];

function refuse(field: string, reason: string): never {
  throw new ScaffoldRefused(`${field}: ${reason}`);
}

function validateOptions(opts: DigitalKernelScaffoldOptions): void {
  // --- projectName ---
  if (typeof opts?.projectName !== "string" || !PROJECT_NAME_RE.test(opts.projectName)) {
    refuse("projectName", "must be an npm-safe name matching /^[a-z0-9][a-z0-9._-]{0,213}$/");
  }

  // --- kernelId ---
  if (typeof opts?.kernelId !== "string" || !KERNEL_ID_RE.test(opts.kernelId)) {
    refuse("kernelId", "must match /^[a-z0-9][a-z0-9_-]{2,63}$/");
  }

  // --- name ---
  if (typeof opts?.name !== "string" || opts.name.length === 0) {
    refuse("name", "is required (non-empty string)");
  }
  if (opts.name.length > 120) {
    refuse("name", "must be at most 120 characters");
  }

  // --- description ---
  if (typeof opts?.description !== "string" || opts.description.length === 0) {
    refuse("description", "is required (non-empty string)");
  }

  // --- capabilityType ---
  if (typeof opts?.capabilityType !== "string" || !CAPABILITY_TYPE_RE.test(opts.capabilityType)) {
    refuse("capabilityType", "must match /^[a-z0-9][a-z0-9-]{1,63}$/");
  }

  // --- builder ---
  if (!opts?.builder || typeof opts.builder !== "object") {
    refuse("builder", "is required ({agentId, contactURI, walletAddress})");
  }
  if (typeof opts.builder.agentId !== "string" || opts.builder.agentId.length === 0) {
    refuse("builder.agentId", "is required (non-empty string)");
  }
  if (!AGENT_ID_RE.test(opts.builder.agentId)) {
    refuse(
      "builder.agentId",
      'must be an ERC-8004 AgentRegistryId matching "eip155:<chainId>:0x<address>" ' +
        "(@pcc/spec's PrincipalKey.agentId requires this format; see the module doc comment)",
    );
  }
  if (typeof opts.builder.contactURI !== "string" || opts.builder.contactURI.length === 0) {
    refuse("builder.contactURI", "is required (non-empty string)");
  }
  if (typeof opts.builder.walletAddress !== "string" || opts.builder.walletAddress.length === 0) {
    refuse(
      "builder.walletAddress",
      "is required (non-empty string) — see the module doc comment for why this field " +
        "exists beyond the D3 plan's declared builder shape",
    );
  }
  if (!WALLET_ADDRESS_RE.test(opts.builder.walletAddress)) {
    refuse("builder.walletAddress", "must be a 20-byte hex address matching /^0x[0-9a-fA-F]{40}$/");
  }

  // --- pricing ---
  if (!opts?.pricing || typeof opts.pricing !== "object") {
    refuse("pricing", "is required — no default (money-adjacent; never invented)");
  }
  if (
    typeof opts.pricing.baseUSD !== "number" ||
    !Number.isFinite(opts.pricing.baseUSD) ||
    opts.pricing.baseUSD <= 0
  ) {
    refuse("pricing.baseUSD", "must be a finite number greater than 0");
  }

  // --- maxAssuranceTier ---
  if (opts?.maxAssuranceTier === undefined || opts.maxAssuranceTier === null) {
    refuse("maxAssuranceTier", "is required — no default (liability-adjacent; never invented)");
  }
  if (
    typeof opts.maxAssuranceTier !== "number" ||
    !Number.isInteger(opts.maxAssuranceTier) ||
    opts.maxAssuranceTier < 0 ||
    opts.maxAssuranceTier > 3
  ) {
    refuse("maxAssuranceTier", "must be an integer 0, 1, 2, or 3");
  }

  // --- workflowSteps ---
  if (!Array.isArray(opts?.workflowSteps) || opts.workflowSteps.length === 0) {
    refuse("workflowSteps", "must be a non-empty array");
  }
  const seenStepIds = new Set<string>();
  opts.workflowSteps.forEach((step: ScaffoldWorkflowStep, i: number) => {
    const field = `workflowSteps[${i}]`;
    if (!step || typeof step !== "object") {
      refuse(field, "must be an object");
    }
    if (typeof step.stepId !== "string" || step.stepId.length === 0) {
      refuse(`${field}.stepId`, "is required (non-empty string)");
    }
    if (seenStepIds.has(step.stepId)) {
      refuse(`${field}.stepId`, `duplicate stepId "${step.stepId}"`);
    }
    if (typeof step.stepType !== "string" || step.stepType.length === 0) {
      refuse(`${field}.stepType`, "is required (non-empty string)");
    }
    if (typeof step.description !== "string" || step.description.length === 0) {
      refuse(`${field}.description`, "is required (non-empty string)");
    }
    if (!Array.isArray(step.dependsOn)) {
      refuse(`${field}.dependsOn`, "must be an array of stepIds");
    }
    for (const dep of step.dependsOn) {
      if (typeof dep !== "string" || !seenStepIds.has(dep)) {
        refuse(`${field}.dependsOn`, `must name an earlier step (got ${JSON.stringify(dep)})`);
      }
    }
    seenStepIds.add(step.stepId);
  });

  // --- search ---
  if (!opts?.search || typeof opts.search !== "object") {
    refuse("search", "is required — no default (search-before-build, MUST-CLOSE 5; never invented)");
  }
  if (opts.search.source !== "capabilities.search" && opts.search.source !== "capabilities.templates") {
    refuse("search.source", 'must be "capabilities.search" or "capabilities.templates"');
  }
  if (typeof opts.search.query !== "string" || opts.search.query.length === 0) {
    refuse("search.query", "is required (non-empty string)");
  }
  if (
    typeof opts.search.at !== "string" ||
    !ISO_UTC_RE.test(opts.search.at) ||
    Number.isNaN(Date.parse(opts.search.at))
  ) {
    refuse("search.at", "must be an ISO-8601 UTC timestamp, e.g. new Date().toISOString()");
  }
  if (typeof opts.search.resultCount !== "number" || !Number.isInteger(opts.search.resultCount) || opts.search.resultCount < 0) {
    refuse("search.resultCount", "must be a non-negative integer");
  }
  if (!Array.isArray(opts.search.resultIds) || opts.search.resultIds.some((id) => typeof id !== "string")) {
    refuse("search.resultIds", "must be an array of strings");
  }
  if (opts.search.resultIds.length > opts.search.resultCount) {
    refuse("search.resultIds", "length must not exceed resultCount");
  }

  // --- versions ---
  if (!opts?.versions || typeof opts.versions !== "object") {
    refuse("versions", "is required — no default (a missing range would default to a workspace: link; never invented)");
  }
  for (const key of ["spec", "kernelSdk"] as const) {
    const value = opts.versions[key];
    if (typeof value !== "string" || value.length === 0) {
      refuse(`versions.${key}`, "is required (non-empty semver range)");
    }
    for (const bad of FORBIDDEN_VERSION_SUBSTRINGS) {
      if (value.includes(bad)) {
        refuse(`versions.${key}`, `must not contain "${bad}" — the generated project must install outside the monorepo`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Small helpers shared by the file builders
// ---------------------------------------------------------------------------

/** Embeds a value as a JSON literal — always valid JS/TS syntax, and the only
 * mechanism used to embed builder-controlled strings, so a builder string
 * (quotes, backticks, ${}, newlines) can never break out of generated code. */
function toLiteral(value: unknown): string {
  return JSON.stringify(value);
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** Reconstructs a clean workflow-step list holding only the declared fields. */
function cleanWorkflowSteps(steps: ScaffoldWorkflowStep[]): ScaffoldWorkflowStep[] {
  return steps.map((s) => ({
    stepId: s.stepId,
    stepType: s.stepType,
    description: s.description,
    dependsOn: [...s.dependsOn],
  }));
}

// ---------------------------------------------------------------------------
// File builders
// ---------------------------------------------------------------------------

function buildPackageJson(opts: DigitalKernelScaffoldOptions): string {
  const pkg = sortKeysDeep({
    name: opts.projectName,
    private: true,
    type: "module",
    scripts: {
      build: "tsc",
      "dry-run": "node dist/index.js --dry-run",
      register: "node dist/register.js",
    },
    dependencies: {
      "@pcc/kernel-sdk": opts.versions.kernelSdk,
      "@pcc/spec": opts.versions.spec,
      tweetnacl: "^1.0.3",
    },
    devDependencies: {
      typescript: "^5.4.0",
      "@types/node": "^20.0.0",
    },
  });
  return JSON.stringify(pkg, null, 2) + "\n";
}

function buildTsconfigJson(): string {
  const tsconfig = {
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      outDir: "dist",
      rootDir: "src",
      strict: true,
    },
    include: ["src/**/*"],
  };
  return JSON.stringify(tsconfig, null, 2) + "\n";
}

function buildPccProjectJson(opts: DigitalKernelScaffoldOptions): string {
  const doc = {
    schema: "pcc-adk/digital-kernel-project@1",
    kernelId: opts.kernelId,
    capabilityType: opts.capabilityType,
    declaredTerms: {
      pricing: { baseUSD: opts.pricing.baseUSD },
      maxAssuranceTier: opts.maxAssuranceTier,
    },
    search: {
      source: opts.search.source,
      query: opts.search.query,
      at: opts.search.at,
      resultCount: opts.search.resultCount,
      resultIds: [...opts.search.resultIds],
    },
    generatedBy: "@pcc/adk",
  };
  return JSON.stringify(doc, null, 2) + "\n";
}

function buildManifestFile(opts: DigitalKernelScaffoldOptions): string {
  const steps = cleanWorkflowSteps(opts.workflowSteps);
  return `/**
 * Auto-generated by @pcc/adk's scaffoldDigitalKernel(). The declared fields
 * below come straight from the scaffold options — do not hand-edit them,
 * re-run the scaffolder instead. This kernel's actual work goes in
 * execute.ts, not here.
 */
import { buildManifest } from "@pcc/kernel-sdk";

const endpointURL = process.env.PCC_KERNEL_ENDPOINT_URL;
if (!endpointURL) {
  throw new Error(
    "PCC_KERNEL_ENDPOINT_URL is required: set it to the HTTPS URL this kernel's job handler will be served at.",
  );
}

export const manifest = buildManifest({
  kernelId: ${toLiteral(opts.kernelId)},
  name: ${toLiteral(opts.name)},
  description: ${toLiteral(opts.description)},
  builder: { agentId: ${toLiteral(opts.builder.agentId)}, contactURI: ${toLiteral(opts.builder.contactURI)} },
  capabilityType: ${toLiteral(opts.capabilityType)},
  workflowSteps: ${toLiteral(steps)},
  pricing: { baseUSD: ${toLiteral(opts.pricing.baseUSD)} },
  maxAssuranceTier: ${toLiteral(opts.maxAssuranceTier)},
  endpointURL,
  sessionKeyPolicy: {
    maxTTLSeconds: 600,
    allowedActions: ["evidence_submit", "workflow_step_complete"],
  },
});
`;
}

function buildExecuteFile(): string {
  return `/**
 * Auto-generated by @pcc/adk's scaffoldDigitalKernel(). This is where this
 * kernel's real work goes. The scaffold fails closed: every job fails until
 * you replace the body below with logic that reads the input and returns a
 * JSON-serialisable result.
 */
export async function execute(input: Record<string, unknown>): Promise<Record<string, unknown>> {
  throw new Error("not implemented: write this kernel's work in src/execute.ts");
}
`;
}

function buildKeysFile(): string {
  return `/**
 * Auto-generated by @pcc/adk's scaffoldDigitalKernel(). Loads (or creates,
 * on first run) this kernel's persistent Ed25519 principal key. The secret
 * key never leaves this file and this file never logs it.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import nacl from "tweetnacl";

interface StoredPrincipalKey {
  publicKey: string;
  secretKey: string;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error("invalid hex string in principal key file");
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

function isStoredPrincipalKey(value: unknown): value is StoredPrincipalKey {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as StoredPrincipalKey).publicKey === "string" &&
    typeof (value as StoredPrincipalKey).secretKey === "string"
  );
}

function keyFilePath(): string {
  return process.env.PCC_KERNEL_KEY_FILE || ".pcc/kernel-key.json";
}

/**
 * Loads this kernel's principal Ed25519 key, generating one on first run.
 *
 * The file is created exclusively ("wx"): two processes starting at once can
 * never both write a key, and a symlink at the path is never written through.
 * On POSIX an existing file that any group or other user can access is
 * refused, as is a public key that does not belong to the secret key.
 */
export function loadPrincipal(): { publicKey: Uint8Array; secretKey: Uint8Array } {
  return load(keyFilePath(), true);
}

function load(path: string, mayCreate: boolean): { publicKey: Uint8Array; secretKey: Uint8Array } {
  if (existsSync(path)) {
    const stat = statSync(path);
    if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
      throw new Error(
        "refusing to read " + path + ": group or other users can access it (mode " +
          (stat.mode & 0o777).toString(8) + "); chmod 600 it before retrying",
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      throw new Error("refusing to use " + path + ": not valid JSON");
    }
    if (!isStoredPrincipalKey(parsed)) {
      throw new Error(
        "refusing to use " + path + ": malformed key file (expected publicKey and secretKey hex strings)",
      );
    }
    let publicKey: Uint8Array;
    let secretKey: Uint8Array;
    try {
      publicKey = fromHex(parsed.publicKey);
      secretKey = fromHex(parsed.secretKey);
    } catch {
      throw new Error("refusing to use " + path + ": publicKey or secretKey is not valid hex");
    }
    if (publicKey.length !== 32 || secretKey.length !== 64) {
      throw new Error("refusing to use " + path + ": wrong key length");
    }
    if (!secretKey.subarray(32).every((byte, i) => byte === publicKey[i])) {
      throw new Error("refusing to use " + path + ": publicKey does not belong to secretKey");
    }
    return { publicKey, secretKey };
  }
  if (!mayCreate) {
    throw new Error("refusing to use " + path + ": it exists but cannot be read (a dangling symlink?)");
  }

  const dir = dirname(path);
  if (dir && dir !== "." && !existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const generated = nacl.sign.keyPair();
  const stored: StoredPrincipalKey = {
    publicKey: toHex(generated.publicKey),
    secretKey: toHex(generated.secretKey),
  };
  try {
    writeFileSync(path, JSON.stringify(stored, null, 2) + "\\n", { mode: 0o600, flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      // Another process created the key file first: use its key, never overwrite it.
      return load(path, false);
    }
    throw err;
  }
  return { publicKey: generated.publicKey, secretKey: generated.secretKey };
}
`;
}

function buildIndexFile(opts: DigitalKernelScaffoldOptions): string {
  return `/**
 * Auto-generated by @pcc/adk's scaffoldDigitalKernel(). Wires this kernel's
 * manifest, principal key, and execute() into a kernel-sdk job handler.
 * Run with --dry-run to sanity-check the wiring against one sample job
 * before deploying and registering.
 */
import { createKernelHandler, verifyBundleSignature, fromHex } from "@pcc/kernel-sdk";
import type { PrincipalKey } from "@pcc/spec";
import { execute } from "./execute.js";
import { loadPrincipal } from "./keys.js";
import { manifest } from "./manifest.js";

async function main(): Promise<void> {
  const principal = loadPrincipal();

  const principalKey: PrincipalKey = {
    agentId: manifest.builder.agentId,
    walletAddress: ${toLiteral(opts.builder.walletAddress)},
    publicKey: principal.publicKey,
  };

  const handler = createKernelHandler({
    manifest,
    principalKey,
    principalPrivateKey: principal.secretKey,
    execute,
  });

  if (process.argv.includes("--dry-run")) {
    try {
      const result = await handler({ jobId: "dry-run", input: {} });
      const signatureValid = verifyBundleSignature(
        result.evidenceBundle,
        fromHex(result.kernelSessionPublicKey),
      );
      console.log(
        JSON.stringify({
          ok: true,
          output: result.output,
          evidenceBundleHash: result.evidenceBundle.bundleHash,
          signatureValid,
          kernelSessionPublicKey: result.kernelSessionPublicKey,
        }),
      );
      return;
    } catch (err) {
      console.log(
        JSON.stringify({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      process.exitCode = 1;
      return;
    }
  }

  console.log("This kernel is wired but not serving (no server is started by this scaffold).");
  console.log("1. Implement src/execute.ts with this kernel's real work.");
  console.log(
    "2. Serve the handler this file builds over HTTP (Fastify, Express, Hono, ...) " +
      "at the URL in PCC_KERNEL_ENDPOINT_URL.",
  );
  console.log("3. Once it is reachable, run: node dist/register.js");
  console.log("Re-run with --dry-run to sanity-check the wiring without serving.");
  process.exitCode = 1;
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
`;
}

function buildRegisterFile(): string {
  return `/**
 * Auto-generated by @pcc/adk's scaffoldDigitalKernel(). Registers this
 * kernel's manifest with a PCC gateway. Requires PCC_GATEWAY_URL and
 * PCC_API_KEY in the environment; never hard-code either.
 */
import { registerKernel } from "@pcc/kernel-sdk";
import { manifest } from "./manifest.js";

async function main(): Promise<void> {
  const gatewayUrl = process.env.PCC_GATEWAY_URL;
  if (!gatewayUrl) {
    throw new Error("PCC_GATEWAY_URL is required: set it to the PCC gateway's base URL.");
  }
  const apiKey = process.env.PCC_API_KEY;
  if (!apiKey) {
    throw new Error("PCC_API_KEY is required: set it to a PCC API key authorised to register kernels.");
  }

  const response = await registerKernel(gatewayUrl, manifest, { apiKey });
  console.log(JSON.stringify(response));
}

main().catch((err) => {
  console.error("Registration failed:", err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
`;
}

function buildReadmeFile(opts: DigitalKernelScaffoldOptions): string {
  const lines: string[] = [];
  lines.push("# " + opts.name);
  lines.push("");
  lines.push(
    "Generated by @pcc/adk's digital-kernel scaffold for kernel `" +
      opts.kernelId +
      "` (capability type `" +
      opts.capabilityType +
      "`).",
  );
  lines.push("");
  lines.push(opts.description);
  lines.push("");
  lines.push("## What was generated");
  lines.push("");
  lines.push(
    "- `src/manifest.ts` — the kernel manifest built from your declared terms (pricing, " +
      "assurance tier, workflow steps). `endpointURL` is read from `PCC_KERNEL_ENDPOINT_URL` " +
      "at runtime, never baked in here.",
  );
  lines.push(
    '- `src/execute.ts` — where this kernel\'s actual work goes. Fails closed: every job ' +
      'fails with "not implemented" until you replace the body.',
  );
  lines.push(
    "- `src/keys.ts` — loads (or creates, on first run) this kernel's Ed25519 principal key " +
      "at `PCC_KERNEL_KEY_FILE` or `.pcc/kernel-key.json`, written mode 0600. The secret key " +
      "never leaves this file and nothing here logs it.",
  );
  lines.push(
    "- `src/index.ts` — wires the manifest, principal key, and `execute()` into a kernel-sdk " +
      "job handler. `--dry-run` runs one sample job and prints a JSON summary without serving.",
  );
  lines.push(
    "- `src/register.ts` — registers this kernel's manifest with a PCC gateway " +
      "(`PCC_GATEWAY_URL` and `PCC_API_KEY` from the environment).",
  );
  lines.push("");
  lines.push("## Recorded search (search-before-build)");
  lines.push("");
  lines.push("PCC requires evidence a marketplace search happened before scaffolding a new kernel:");
  lines.push("");
  lines.push("- source: `" + opts.search.source + "`");
  lines.push("- query: `" + opts.search.query + "`");
  lines.push("- at: `" + opts.search.at + "`");
  lines.push("- results seen: " + String(opts.search.resultCount));
  lines.push("");
  lines.push("## Running it");
  lines.push("");
  lines.push("1. `npm install`");
  lines.push("2. Implement `src/execute.ts` with this kernel's real work.");
  lines.push("3. `npm run build`");
  lines.push(
    "4. `PCC_KERNEL_ENDPOINT_URL=https://your-kernel.example/run npm run dry-run` — " +
      "sanity-checks the wiring against one sample job.",
  );
  lines.push(
    "5. Serve the handler `src/index.ts` builds (wire it into Fastify/Express/Hono/etc.) " +
      "so it is reachable at `PCC_KERNEL_ENDPOINT_URL`.",
  );
  lines.push("6. `PCC_GATEWAY_URL=... PCC_API_KEY=... npm run register`");
  lines.push("");
  lines.push("## Honest notes");
  lines.push("");
  lines.push(
    "- This scaffold fails closed: `src/execute.ts` throws until you implement it, and " +
      "`--dry-run` reports `ok: false` until then.",
  );
  lines.push(
    "- The declared assurance tier (" +
      String(opts.maxAssuranceTier) +
      ") and pricing are self-declarations by the builder — verifiers do not trust them; " +
      "they are checked against submitted evidence.",
  );
  lines.push(
    "- Nothing settles without verified evidence. A passing dry run only proves the wiring " +
      "is correct, not that the kernel does real work.",
  );
  lines.push("");
  return lines.join("\n");
}

function buildGitignoreFile(): string {
  return "node_modules/\ndist/\n.pcc/\n";
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generates a complete, installable digital-kernel project as an in-memory
 * map of relative file path -> file content. PURE: no filesystem, no
 * network, no clock, no randomness. Throws `ScaffoldRefused` naming the
 * field for any rule violation; nothing is defaulted or invented.
 */
export function scaffoldDigitalKernel(opts: DigitalKernelScaffoldOptions): { files: Record<string, string> } {
  validateOptions(opts);

  return {
    files: {
      "package.json": buildPackageJson(opts),
      "tsconfig.json": buildTsconfigJson(),
      "pcc-project.json": buildPccProjectJson(opts),
      "src/manifest.ts": buildManifestFile(opts),
      "src/execute.ts": buildExecuteFile(),
      "src/keys.ts": buildKeysFile(),
      "src/index.ts": buildIndexFile(opts),
      "src/register.ts": buildRegisterFile(),
      "README.md": buildReadmeFile(opts),
      ".gitignore": buildGitignoreFile(),
    },
  };
}
