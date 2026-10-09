/**
 * The agent golden path must name every private key POST /api/auth/provision
 * can return. These tests drive the real route with the ERC-8004 identity-write
 * service mocked (nothing touches a chain), collect every private-key field in
 * the 201 body, and check the buyer path and the supply runbook against them.
 */

import { execFile, spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/posthog-service.js", () => ({
  trackServerEvent: vi.fn(),
}));
vi.mock("../services/audit-service.js", () => ({
  auditService: {
    log: vi.fn(),
    query: vi.fn().mockReturnValue([]),
    stats: vi.fn().mockReturnValue([]),
  },
}));

// vi.mock is hoisted; use vi.hoisted to create the mocks BEFORE hoisting.
const {
  mockRegisterAgentOnChain,
  mockIsIdentityWriteEnabled,
  mockGetIdentityRegistryAddress,
  mockGenerateOperatorWallet,
  mockSetAgentWalletOnChain,
} = vi.hoisted(() => ({
  mockRegisterAgentOnChain: vi.fn(),
  mockIsIdentityWriteEnabled: vi.fn(),
  mockGetIdentityRegistryAddress: vi.fn(
    () => "0x8004A818BFB912233c491871b3d84c89A494BD9e",
  ),
  mockGenerateOperatorWallet: vi.fn(),
  mockSetAgentWalletOnChain: vi.fn(),
}));

vi.mock("../services/erc8004-identity-write.js", () => ({
  registerAgentOnChain: mockRegisterAgentOnChain,
  isIdentityWriteEnabled: mockIsIdentityWriteEnabled,
  getIdentityRegistryAddress: mockGetIdentityRegistryAddress,
  generateOperatorWallet: mockGenerateOperatorWallet,
  setAgentWalletOnChain: mockSetAgentWalletOnChain,
  checkSignerFunding: vi.fn(async () => ({
    signer: undefined,
    balanceWei: 0n,
    balanceEth: "0",
    sufficientForOneRegister: false,
  })),
  resetClientsForTest: vi.fn(),
  readAgentURI: vi.fn(),
  getIdentityWriteSigner: vi.fn(),
}));

import { provisionRoutes } from "../routes/provision.js";
import { initStore, closeStore } from "../db.js";

const root = new URL("../../../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
interface BuyerAction {
  tool: string | null;
  route: string;
  request: string;
  recipe?: string[];
  responseFields: string[];
  storeOnlyFields?: string[];
}
const getKeyActions = () => JSON.parse(read("starter/buyer/buyer-path.json")).steps[0].actions as BuyerAction[];
const provisionAction = () => getKeyActions()[0];
const validateAction = () => getKeyActions()[1];
/** A field list names `path` exactly or as `path (condition)`. */
const names = (fields: string[] | undefined, path: string) =>
  (fields ?? []).some((field) => field === path || field.startsWith(`${path} (`));
/** The API key's own path and the two usage strings that repeat it (Opus r1 F2). */
const API_KEY_PATHS = ["api_key", "usage.header", "usage.example"];

/**
 * Opus r1 F1: a tool call returns the 201 body (API key, private keys) into the conversation, and
 * the provision_api_key tool cannot send publicKey. The get-key step names no tool and says why.
 */
const NO_TOOL =
  "Do not call the `provision_api_key` tool, or any tool that hands this response back to you: " +
  "a tool result enters the conversation, and the tool cannot send publicKey.";

async function buildApp(): Promise<FastifyInstance> {
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: true });
  const app = Fastify({ logger: false });
  await app.register(provisionRoutes);
  await app.ready();
  return app;
}

/** A real Ed25519 public key as 64 hex characters: the SPKI DER's last 32 bytes. */
function localEd25519PublicKeyHex(): string {
  const der = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" });
  return der.subarray(der.length - 32).toString("hex");
}

/** Dotted path of every key named like a private key, anywhere in the body. */
function privateKeyPaths(value: unknown, path: string[] = []): string[] {
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => [
    ...(/private_key/.test(key) ? [[...path, key].join(".")] : []),
    ...privateKeyPaths(child, [...path, key]),
  ]);
}

/** Every string leaf of a body, with its dotted path. */
function stringLeaves(value: unknown, path: string[] = []): Array<[string, string]> {
  if (typeof value === "string") return [[path.join("."), value]];
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => stringLeaves(child, [...path, key]));
}

/**
 * Opus r1 F6: a name-based scan misses a secret under another name (usage.header and usage.example
 * repeat the raw key). Every path whose string holds the API key or a private-key value must be
 * store-only and absent from the fields to read. Returns the paths it found.
 */
function expectSecretValuesStoreOnly(body: Record<string, unknown>): string[] {
  const leaves = stringLeaves(body);
  const secrets = [
    body.api_key as string,
    ...leaves.filter(([path]) => /private_key/.test(path.split(".").at(-1) ?? "")).map(([, value]) => value),
  ];
  for (const secret of secrets) expect(typeof secret === "string" && secret.length >= 32).toBe(true);
  const holders = leaves.filter(([, value]) => secrets.some((secret) => value.includes(secret))).map(([path]) => path);
  const provision = provisionAction();
  for (const path of holders) {
    expect(names(provision.storeOnlyFields, path), `${path} holds a secret value: it must be store-only`).toBe(true);
    expect(names(provision.responseFields, path), `${path} holds a secret value: it must not be read`).toBe(false);
  }
  return holders;
}

/** Every emitted path must be a documented response field and named in the request prose. */
function expectDocumented(paths: string[]): void {
  const provision = provisionAction();
  expect(provision.route).toBe("/api/auth/provision");
  expect(provision.tool, "the get-key step must send provisioning over direct HTTP, never a tool").toBeNull();
  expect(provision.request.startsWith(NO_TOOL), "the request must open with the no-tool rule").toBe(true);
  for (const path of paths) {
    expect(names(provision.storeOnlyFields, path), `buyer path must mark ${path} store-only`).toBe(true);
    expect(names(provision.responseFields, path), `${path} must not be listed as a field to read`).toBe(false);
    expect(provision.request, `buyer path request must name ${path}`).toContain(path);
  }
  for (const path of API_KEY_PATHS) {
    expect(names(provision.storeOnlyFields, path), `buyer path must mark ${path} store-only`).toBe(true);
    expect(names(provision.responseFields, path), `${path} must not be listed as a field to read`).toBe(false);
  }
}

/** How the mocked ERC-8004 identity write goes for one provisioning call (provision.ts:181-318). */
type IdentityOutcome = "off" | "registration-rejected" | "wallet-rejected" | "assignment-rejected" | "assigned";
const IDENTITY_OUTCOMES: IdentityOutcome[] = ["off", "registration-rejected", "wallet-rejected", "assignment-rejected", "assigned"];
const REGISTRY = "0x8004A818BFB912233c491871b3d84c89A494BD9e";

/** Sets the identity-write mocks for one outcome; returns the fake operator wallet (built at runtime). */
function mockIdentity(outcome: IdentityOutcome): { address: string; privateKey: string } {
  const wallet = { address: "0x" + "cd".repeat(20), privateKey: "0x" + "ab".repeat(32) };
  mockIsIdentityWriteEnabled.mockReturnValue(outcome !== "off");
  if (outcome === "registration-rejected") mockRegisterAgentOnChain.mockRejectedValue(new Error("registration rejected in tests"));
  else mockRegisterAgentOnChain.mockResolvedValue({ agentId: 42n, txHash: "0x" + "de".repeat(32), registryAddress: REGISTRY, chainId: 84532 });
  if (outcome === "wallet-rejected") mockGenerateOperatorWallet.mockRejectedValue(new Error("wallet generation rejected in tests"));
  else mockGenerateOperatorWallet.mockResolvedValue(wallet);
  if (outcome === "assigned") {
    mockSetAgentWalletOnChain.mockResolvedValue({ txHash: "0x" + "ee".repeat(32), registryAddress: REGISTRY, chainId: 84532, agentWallet: wallet.address });
  } else mockSetAgentWalletOnChain.mockRejectedValue(new Error("assignment rejected in tests"));
  return wallet;
}

let lastAddress = 0;
/** POST /api/auth/provision from a fresh TEST-NET address: the 5-per-IP-per-hour limit is module state. */
function provisionFrom(app: FastifyInstance, payload: Record<string, unknown>) {
  lastAddress += 1;
  return app.inject({ method: "POST", url: "/api/auth/provision", payload, remoteAddress: `198.51.100.${lastAddress}` });
}

/** ChatGPT r1 L2: the wallet key's condition, word for word, in the supply runbook and the buyer path. */
const SUPPLY_WALLET =
  "It may also contain `operator_wallet.private_key`, a wallet key the gateway mints and keeps for the account: " +
  "only when this call registers the account's on-chain identity and the gateway then generates the wallet. " +
  "A failed on-chain assignment of that wallet afterwards does not remove the key. This runbook never uses it.";
const BUYER_WALLET =
  "Whether or not you send publicKey, the response may also carry operator_wallet.private_key, an EVM wallet key: " +
  "only when this call registers an on-chain identity for you and the gateway then generates the wallet; " +
  "a failed on-chain assignment of that wallet afterwards does not remove the key. " +
  "operator_wallet.source reads server-minted exactly when the key is there. It stays in the same private 0600 file and is never printed.";

describe("agent golden path names every private key the provision response carries", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildApp();
  });

  afterEach(async () => {
    if (app) await app.close();
    closeStore();
  });

  it("identity write on, own publicKey sent: operator_wallet.private_key and no Ed25519 private key", async () => {
    mockIsIdentityWriteEnabled.mockReturnValue(true);
    mockRegisterAgentOnChain.mockResolvedValue({
      agentId: 42n,
      txHash: "0xdeadbeef" + "0".repeat(56),
      registryAddress: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
      chainId: 84532,
    });
    // Fake wallet built at runtime: no key-shaped literal in this file.
    const wallet = { address: "0x" + "cd".repeat(20), privateKey: "0x" + "ab".repeat(32) };
    mockGenerateOperatorWallet.mockResolvedValue(wallet);
    mockSetAgentWalletOnChain.mockRejectedValue(new Error("no chain in tests"));

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/provision",
      payload: { email: "byok-identity@example.com", publicKey: localEd25519PublicKeyHex() },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.ed25519.source).toBe("byok");
    expect(body.operator_wallet.private_key).toBe(wallet.privateKey);
    const paths = privateKeyPaths(body);
    expect(paths).toContain("operator_wallet.private_key");
    expect(paths.filter((path) => /^ed25519\..*private_key/.test(path))).toEqual([]);
    expectDocumented(paths);
    expect(expectSecretValuesStoreOnly(body)).toEqual(expect.arrayContaining(["api_key", "usage.header", "usage.example", ...paths]));
  });

  it("identity write off, no publicKey: both encodings of the minted Ed25519 private key", async () => {
    mockIsIdentityWriteEnabled.mockReturnValue(false);

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/provision",
      payload: { email: "minted-ed25519@example.com" },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.ed25519.source).toBe("server-minted");
    expect(mockRegisterAgentOnChain).not.toHaveBeenCalled();
    // The raw API key comes back twice more, in usage.header and usage.example (Opus r1 F2).
    expect(body.usage.header).toContain(body.api_key);
    expect(body.usage.example).toContain(body.api_key);
    const paths = privateKeyPaths(body);
    expect(paths).toEqual(expect.arrayContaining(["ed25519.private_key", "ed25519.private_key_pkcs8_base64"]));
    expectDocumented(paths);
    expect(expectSecretValuesStoreOnly(body)).toEqual(expect.arrayContaining(["api_key", "usage.header", "usage.example", ...paths]));
  });
});

describe("the wallet key comes back only when this call registered the identity and generated the wallet (ChatGPT r1 L2)", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildApp();
  });

  afterEach(async () => {
    if (app) await app.close();
    closeStore();
  });

  it("registration rejected: a 201 with no wallet key and the identity still pending", async () => {
    mockIdentity("registration-rejected");
    const res = await provisionFrom(app, { email: "registration-rejected@example.com", publicKey: localEd25519PublicKeyHex() });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(mockRegisterAgentOnChain).toHaveBeenCalledTimes(1);
    expect(mockGenerateOperatorWallet).not.toHaveBeenCalled();
    expect(body.onchain.status).toBe("pending");
    expect(body.operator_wallet).toEqual({ source: "none" });
  });

  it("wallet generation rejected after the registration: a 201 with no wallet key", async () => {
    mockIdentity("wallet-rejected");
    const res = await provisionFrom(app, { email: "wallet-rejected@example.com" });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.onchain.status).toBe("written");
    expect(mockGenerateOperatorWallet).toHaveBeenCalledTimes(1);
    expect(mockSetAgentWalletOnChain).not.toHaveBeenCalled();
    expect(body.operator_wallet).toEqual({ source: "none" });
  });

  it("assignment rejected after both: the generated wallet key still comes back", async () => {
    const wallet = mockIdentity("assignment-rejected");
    const res = await provisionFrom(app, { email: "assignment-rejected@example.com", publicKey: localEd25519PublicKeyHex() });
    expect(res.statusCode).toBe(201);
    expect(res.json().operator_wallet).toMatchObject({ source: "server-minted", private_key: wallet.privateKey, onchain_status: "failed" });
  });

  it("assignment written: the wallet key comes back as well", async () => {
    const wallet = mockIdentity("assigned");
    const res = await provisionFrom(app, { email: "assigned@example.com" });
    expect(res.statusCode).toBe(201);
    expect(res.json().operator_wallet).toMatchObject({ source: "server-minted", private_key: wallet.privateKey, onchain_status: "written" });
  });

  it("the supply runbook and the buyer path say the wallet key may come back, on exactly that condition", () => {
    const runbook = read("starter/runbook/00-prerequisites.md");
    expect(runbook).toContain(SUPPLY_WALLET);
    expect(runbook).not.toMatch(/also contains `operator_wallet\.private_key`/);
    expect(provisionAction().request).toContain(BUYER_WALLET);
    expect(provisionAction().request).not.toContain("the gateway mints when it writes an on-chain identity");
  });
});

describe("agent golden path provisions over direct HTTP, never through a tool (Opus r1 F1)", () => {
  it("no buyer action names provision_api_key, and agent.md renders the get-key step as direct HTTP", () => {
    const buyer = JSON.parse(read("starter/buyer/buyer-path.json")) as {
      steps: Array<{ actions: Array<{ tool: string | null }> }>;
      reporting: { tool: string | null };
    };
    const tools = [...buyer.steps.flatMap((step) => step.actions), buyer.reporting].map((action) => action.tool);
    expect(tools).not.toContain("provision_api_key");
    const doc = read("apps/dashboard/public/.well-known/agent.md");
    expect(doc).toContain("Direct HTTP → `POST /api/auth/provision`");
    expect(doc).not.toContain("Tool: `provision_api_key`");
    expect(doc).toContain(`Request: ${NO_TOOL}`);
  });
});

const run = promisify(execFile);
/** CI images carry all four; elsewhere the run-it-as-written case needs them on PATH. */
const recipeTools = spawnSync("sh", ["-c", "command -v bash && command -v curl && command -v python3 && command -v git"]).status === 0;

describe("agent golden path captures the provision response without leaking it (Opus r1 F2)", () => {
  it("makes .pcc private and git-ignored before the request, writes the response and header to files, and validates from the header file", () => {
    const recipe = provisionAction().recipe ?? [];
    const at = (needle: string) => recipe.findIndex((line) => line.includes(needle));
    const curl = at("/api/auth/provision");
    expect(recipe[0]).toBe("umask 077 && mkdir -p .pcc && chmod 700 .pcc");
    expect(at("git check-ignore -q .pcc/provision.json")).toBeGreaterThan(0);
    expect(recipe[at("git check-ignore")]).toContain("info/exclude");
    expect(at("git check-ignore")).toBeLessThan(curl);
    expect(recipe[curl]).toMatch(/--data-binary @\.pcc\/provision-request\.json > \.pcc\/provision\.json$/);
    expect(at(".pcc/auth.header")).toBeGreaterThan(curl);
    expect(recipe).toContain("chmod 600 .pcc/provision.json .pcc/auth.header");
    // Nothing dumps the response or the key: no cat, no echo of a variable, no print of the whole body or key.
    expect(recipe.join("\n")).not.toMatch(/\bcat\b|\becho\s+"?\$|print\(r\)|print\(k\)/);
    expect(provisionAction().request).toContain("never print, cat or paste .pcc/provision.json");
    expect(validateAction().recipe).toEqual(['curl -s "$PCC_BASE/api/auth/validate" -H @.pcc/auth.header']);
    expect(validateAction().request).toContain("printf is a shell builtin");
    const getKey = JSON.parse(read("starter/buyer/buyer-path.json")).steps[0] as { doneWhen: string[] };
    expect(getKey.doneWhen.join(" ")).toContain("(.pcc/ is 0700 and ignored by git), no key or private key was printed");
  });

  it("agent.md renders both recipes as bash blocks, lists only non-secret fields to read, and marks the rest store-only", () => {
    const doc = read("apps/dashboard/public/.well-known/agent.md");
    expect(doc).toContain(["```bash", ...(provisionAction().recipe ?? []), "```"].join("\n"));
    expect(doc).toContain(["```bash", ...(validateAction().recipe ?? []), "```"].join("\n"));
    expect(doc).toContain("Read response fields: key_id, operator_id, trace_id, ed25519.public_key.");
    expect(doc).toContain(
      "Store only, never read into the conversation: api_key, usage.header (holds api_key), usage.example (holds api_key), " +
      "ed25519.private_key (only when publicKey was omitted), ed25519.private_key_pkcs8_base64 (only when publicKey was omitted), " +
      "operator_wallet.private_key (when operator_wallet.source is server-minted).",
    );
    expect(doc).toContain("Keep API keys, private keys and transcripts out of logs, chat, reports and version control.");
  });

  describe("the recipe, run as written against the real provision route", () => {
    let app: FastifyInstance;

    beforeEach(async () => {
      vi.clearAllMocks();
      app = await buildApp();
    });

    afterEach(async () => {
      if (app) await app.close();
      closeStore();
    });

    it.runIf(recipeTools || process.env.CI === "true")(
      "prints no secret, leaves .pcc 0700 and git-ignored with 0600 files, and its header validates",
      async () => {
        // Identity write on and no publicKey: every secret the 201 can carry comes back at once.
        mockIsIdentityWriteEnabled.mockReturnValue(true);
        mockRegisterAgentOnChain.mockResolvedValue({
          agentId: 7n,
          txHash: "0xfeed" + "0".repeat(60),
          registryAddress: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
          chainId: 84532,
        });
        mockGenerateOperatorWallet.mockResolvedValue({ address: "0x" + "ce".repeat(20), privateKey: "0x" + "9f".repeat(32) });
        mockSetAgentWalletOnChain.mockRejectedValue(new Error("no chain in tests"));
        await app.listen({ port: 0, host: "127.0.0.1" });
        const env = { ...process.env, PCC_BASE: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}` };
        const dir = mkdtempSync(join(tmpdir(), "agent-md-recipe-"));
        try {
          await run("git", ["init", "-q"], { cwd: dir });
          // The agent writes the request body with its file-writing tool before running the recipe.
          mkdirSync(join(dir, ".pcc"));
          writeFileSync(join(dir, ".pcc/provision-request.json"), JSON.stringify({ email: "recipe-run@example.com" }));
          const provision = await run("bash", ["-c", (provisionAction().recipe ?? []).join("\n")], { cwd: dir, env });
          const validate = await run("bash", ["-c", (validateAction().recipe ?? []).join("\n")], { cwd: dir, env });

          const body = JSON.parse(readFileSync(join(dir, ".pcc/provision.json"), "utf8"));
          expectSecretValuesStoreOnly(body);
          const secrets: string[] = [
            body.api_key, body.ed25519.private_key, body.ed25519.private_key_pkcs8_base64, body.operator_wallet.private_key,
          ];
          for (const secret of secrets) expect(typeof secret === "string" && secret.length >= 32).toBe(true);
          const printed = provision.stdout + provision.stderr + validate.stdout + validate.stderr;
          secrets.forEach((secret, index) => expect(printed.includes(secret), `secret #${index} was printed`).toBe(false));
          expect(provision.stdout).toContain("'error': None");
          expect(provision.stdout).toContain(body.key_id);
          expect(JSON.parse(validate.stdout)).toMatchObject({ valid: true });
          expect(statSync(join(dir, ".pcc")).mode & 0o777).toBe(0o700);
          for (const file of ["provision.json", "auth.header"])
            expect(statSync(join(dir, ".pcc", file)).mode & 0o777, file).toBe(0o600);
          expect(readFileSync(join(dir, ".pcc/auth.header"), "utf8") === `Authorization: Bearer ${body.api_key}\n`).toBe(true);
          expect(existsSync(join(dir, ".pcc/provision-request.json"))).toBe(false);
          // check-ignore exits 1 (and execFile rejects) when the path is not ignored.
          await expect(run("git", ["check-ignore", "-q", ".pcc/provision.json"], { cwd: dir })).resolves.toBeDefined();
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
      30_000,
    );
  });
});

describe("agent golden path drops the claims that no private key comes back", () => {
  it("buyer path request and supply runbook", () => {
    expect(provisionAction().request).not.toContain("no private key comes back");
    const runbook = read("starter/runbook/00-prerequisites.md");
    expect(runbook).toContain("operator_wallet.private_key");
    expect(runbook).not.toContain("no private key ever travels");
  });
});
