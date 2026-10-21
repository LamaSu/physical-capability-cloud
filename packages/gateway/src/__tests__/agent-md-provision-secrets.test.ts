/**
 * What the buyer path and the supply runbook say about the POST /api/auth/provision response, checked
 * against the real route with the ERC-8004 identity-write service mocked (nothing touches a chain).
 * The guards, and their limits:
 * - Every leaf of every 201 variant the route returns (identity write off; on with the registration,
 *   the wallet generation or the assignment rejected; on and assigned; publicKey omitted or sent) must
 *   be a buyer field to read or store-only. A new response field fails until someone classifies it.
 * - Every leaf holding the API key or a value of a field named like private_key must be store-only.
 *   The check is by value, so a copy under another name counts. A new secret that copies neither is
 *   caught only by the classification above, which a human decides.
 * - The supply runbook must name each of those secret paths.
 * - Each buyer store-only entry, word for word, states a condition that the test also holds as a predicate;
 *   every predicate is checked against what the route returns in each variant (ChatGPT r1 L3).
 * - The supply runbook's own request (it always sends publicKey) goes through the route in each identity
 *   outcome; every secret it gets back must be one step 4 names, on the condition step 4 states.
 * - In-suite negative controls feed a reversed condition, a reversed predicate and a supply runbook with a
 *   secret dropped to the same checks, which must fail.
 */

import { execFile, spawnSync } from "node:child_process";
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
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
import { generateApiKey } from "../auth/api-key-auth.js";
import { traceIdPlugin } from "../middleware/trace-id.js";
import { initStore, closeStore, getRepos, getStore } from "../db.js";

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
 * Opus r1 F1: a tool call returns the 201 body (including an API key) into the conversation, and
 * returns the upstream body. Its response must stay out of the conversation; publicKey transport is not blocked.
 */
const NO_TOOL =
  "Do not call the `provision_api_key` tool, or any tool that hands this response back to you: " +
  "its response includes the API key, and a tool result enters the conversation.";

const STORE_ENV = ["DATABASE_URL", "RAILWAY_VOLUME_MOUNT_PATH", "PCC_DB_PATH"] as const;
let savedStoreEnv: Array<[typeof STORE_ENV[number], string | undefined]> | undefined;

function closeTestStore(): void {
  try { closeStore(); }
  finally {
    for (const [name, value] of savedStoreEnv ?? []) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    savedStoreEnv = undefined;
  }
}

async function buildApp(): Promise<FastifyInstance> {
  // initStore selects DATABASE_URL ahead of Railway and PCC_DB_PATH. Own that highest priority.
  closeTestStore();
  savedStoreEnv = STORE_ENV.map((name) => [name, process.env[name]]);
  process.env.DATABASE_URL = ":memory:";
  delete process.env.RAILWAY_VOLUME_MOUNT_PATH;
  process.env.PCC_DB_PATH = ":memory:";
  const app = Fastify({ logger: false });
  try {
    initStore({ seed: true });
    await app.register(traceIdPlugin);
    await app.register(provisionRoutes);
    await app.ready();
    return app;
  } catch (error) {
    await app.close();
    closeTestStore();
    throw error;
  }
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

/**
 * Dotted path of every leaf of a body. An array of plain values is one leaf; an array of objects
 * becomes "path[].child".
 */
function leafPaths(value: unknown, path = ""): string[] {
  if (Array.isArray(value) && value.some((item) => item !== null && typeof item === "object"))
    return [...new Set(value.flatMap((item) => leafPaths(item, `${path}[]`)))];
  if (value !== null && typeof value === "object" && !Array.isArray(value))
    return Object.entries(value).flatMap(([key, child]) => leafPaths(child, path ? `${path}.${key}` : key));
  return [path];
}

/**
 * ChatGPT r1 L1: every leaf of a 201 body is listed in the buyer path either as a field to read or
 * as store-only, never both. A new response field fails here until someone classifies it.
 */
function expectEveryLeafClassified(body: Record<string, unknown>): void {
  const provision = provisionAction();
  for (const path of leafPaths(body)) {
    const toRead = names(provision.responseFields, path);
    const storeOnly = names(provision.storeOnlyFields, path);
    expect(toRead || storeOnly, `${path} is unclassified: list it as a field to read or as store-only`).toBe(true);
    expect(toRead && storeOnly, `${path} is listed both as a field to read and as store-only`).toBe(false);
  }
}

/** Only these three leaves carry API-key material in the merged provisioning response. */
const SECRET_PATHS = [...API_KEY_PATHS];
/** The supply runbook's step 4, where it describes the provision response. */
const supplyStep4 = () => {
  const runbook = read("starter/runbook/00-prerequisites.md");
  return runbook.slice(runbook.indexOf("## 4. "), runbook.indexOf("## 5. "));
};
/** Exact sentences from the supply guide, buyer path, and credential-recovery guidance. */
const SUPPLY_API_KEY =
  "The response contains your **API key** three times: in `api_key`, and again inside `usage.header` and `usage.example`.";
const SUPPLY_NO_PRIVATE_KEY =
  'It never contains a private key: `ed25519` holds only the public key you sent, and `operator_wallet` is `{"source": "none"}`.';
const BUYER_NO_PRIVATE_KEY =
  "The response never contains a private key: provisioning never generates or assigns a wallet, and operator_wallet.source is always none.";
const BUYER_OTHER_CLIENTS =
  "For other clients, a body with no publicKey field gets an API key with no signing key on file (ed25519.source none); the gateway never generates or returns a private key.";
const BUYER_ORPHAN =
  "A new key cannot revoke the lost one; only the gateway admin can, or, if you provisioned with walletAddress, a Sign-In with Ethereum session for that address. Tell the human.";
const SUPPLY_ORPHAN =
  "A new key cannot revoke the lost one; only the gateway admin can. Tell the human.";
const FORBIDDEN_CLAIMS = [
  "ed25519.private_key", "operator_wallet.private_key", "server-minted", "server-made",
  "wallet assignment", "onchain_error", "authenticated session",
] as const;

/** A regression guard for published buyer/supply guidance, not hostile-response fixtures. */
function expectNoForbiddenClaims(text: string): void {
  for (const claim of FORBIDDEN_CLAIMS) {
    expect(text.toLowerCase(), `obsolete provisioning claim: ${claim}`).not.toContain(claim.toLowerCase());
  }
}

/** Raw diagnostics stay private; the only printed status is fixed. */
const ERROR_FIELDS = ["provision_status"];
const DIAGNOSTIC_STORE_ONLY = [
  "message (raw server diagnostic; may contain secrets)",
  "error (raw error body; only fixed route codes are printed)",
];

/** The value at a dotted path, or undefined. */
const valueAt = (body: unknown, path: string): unknown => path.split(".").reduce<unknown>(
  (value, key) => (value !== null && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined), body);
/** Whether a response carries a nonempty string at the path. */
const carries = (body: unknown, path: string) => {
  const value = valueAt(body, path);
  return typeof value === "string" && value.length > 0;
};

/** One provisioning call: how the identity write went, and whether the request sent publicKey. */
interface Variant { outcome: IdentityOutcome; publicKey: boolean }
/** Identity writes are best effort, and none of them generate a wallet. */
type Condition = [entry: string, path: string, when: (variant: Variant) => boolean];
/**
 * ChatGPT r1 L3: each buyer store-only entry word for word, with the condition it states as a predicate. Each
 * predicate is checked against the real route's responses below, so a wrong condition fails twice: once as text and
 * once against what the route returns.
 */
const STORE_ONLY_CONDITIONS: Condition[] = [
  ["api_key", "api_key", () => true],
  ["usage.header (holds api_key)", "usage.header", () => true],
  ["usage.example (holds api_key)", "usage.example", () => true],
];

/** Throws unless the store-only entries are exactly the documented conditions, word for word and in order. */
function checkStoreOnlyText(storeOnlyFields: string[] | undefined): void {
  expect(storeOnlyFields).toEqual([...STORE_ONLY_CONDITIONS.map(([entry]) => entry), ...DIAGNOSTIC_STORE_ONLY]);
}

/** Throws unless the response carries each secret exactly when its documented condition holds. */
function checkConditions(body: Record<string, any>, variant: Variant, conditions = STORE_ONLY_CONDITIONS): void {
  const label = `identity ${variant.outcome}, publicKey ${variant.publicKey ? "sent" : "omitted"}`;
  for (const [entry, path, when] of conditions) expect(carries(body, path), `${entry}, ${label}`).toBe(when(variant));
  expect(body.usage.header, "usage.header (holds api_key)").toContain(body.api_key);
  expect(body.usage.example, "usage.example (holds api_key)").toContain(body.api_key);
  expect(body.operator_wallet, `operator_wallet, ${label}`).toEqual({ source: "none" });
  expect(privateKeyPaths(body), `private-key paths, ${label}`).toEqual([]);
}

/** Throws unless the supply runbook's step 4 names each secret path its own request got back, in its own words. */
function checkSupplyNames(step: string, returned: string[]): void {
  for (const path of returned) expect(step, `00-prerequisites.md step 4 must name ${path}`).toContain("`" + path + "`");
  for (const sentence of [SUPPLY_API_KEY, SUPPLY_NO_PRIVATE_KEY]) expect(step).toContain(sentence);
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

/** How the mocked ERC-8004 identity write goes for a provisioning call on master. */
type IdentityOutcome = "off" | "registration-rejected" | "written";
const IDENTITY_OUTCOMES: IdentityOutcome[] = ["off", "registration-rejected", "written"];
const REGISTRY = "0x8004A818BFB912233c491871b3d84c89A494BD9e";

/** Only the identity registration service is invoked by the merged route. */
function mockIdentity(outcome: IdentityOutcome): void {
  mockIsIdentityWriteEnabled.mockReturnValue(outcome !== "off");
  if (outcome === "registration-rejected") {
    mockRegisterAgentOnChain.mockRejectedValue(new Error("registration rejected in tests"));
  } else {
    mockRegisterAgentOnChain.mockResolvedValue({
      agentId: 42n, txHash: "0x" + "de".repeat(32), registryAddress: REGISTRY, chainId: 84532,
    });
  }
}

let lastAddress = 0;
/** POST /api/auth/provision from a fresh TEST-NET address: the 5-per-IP-per-hour limit is module state. */
function provisionFrom(app: FastifyInstance, payload: Record<string, unknown>) {
  lastAddress += 1;
  return app.inject({ method: "POST", url: "/api/auth/provision", payload, remoteAddress: `198.51.100.${lastAddress}` });
}

describe("the buyer path documents the private-key fields of two provisioning responses, by name", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildApp();
  });

  afterEach(async () => {
    try { if (app) await app.close(); }
    finally { closeTestStore(); }
  });

  it("AT1 identity write on, own publicKey sent: 201 holds no private keys", async () => {
    mockIdentity("written");
    const sentKey = localEd25519PublicKeyHex();
    const res = await app.inject({
      method: "POST", url: "/api/auth/provision",
      payload: { email: "byok-identity@example.com", publicKey: sentKey },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.ed25519).toEqual({ public_key: sentKey, source: "byok" });
    expect(body.operator_wallet).toEqual({ source: "none" });
    expect(privateKeyPaths(body)).toEqual([]);
    expect(mockGenerateOperatorWallet).not.toHaveBeenCalled();
    expect(mockSetAgentWalletOnChain).not.toHaveBeenCalled();
    expect(expectSecretValuesStoreOnly(body)).toEqual(API_KEY_PATHS);
  });

  it("AT2 identity write off, no publicKey: 201 holds no signing key", async () => {
    mockIdentity("off");
    const res = await app.inject({
      method: "POST", url: "/api/auth/provision",
      payload: { email: "no-publickey@example.com" },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.ed25519).toEqual({ public_key: null, source: "none" });
    expect(body.operator_wallet).toEqual({ source: "none" });
    expect(privateKeyPaths(body)).toEqual([]);
    expect(mockRegisterAgentOnChain).not.toHaveBeenCalled();
    expect(mockGenerateOperatorWallet).not.toHaveBeenCalled();
    expect(mockSetAgentWalletOnChain).not.toHaveBeenCalled();
    expect(expectSecretValuesStoreOnly(body)).toEqual(API_KEY_PATHS);
  });
});

describe("no identity outcome generates or assigns a wallet", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildApp();
  });

  afterEach(async () => {
    try { if (app) await app.close(); }
    finally { closeTestStore(); }
  });

  it.each(IDENTITY_OUTCOMES.flatMap((outcome) => [false, true].map((publicKey) => ({ outcome, publicKey }))))(
    "AT3 identity $outcome, publicKey $publicKey: never creates or assigns a wallet",
    async ({ outcome, publicKey }) => {
      mockIdentity(outcome);
      const res = await provisionFrom(app, {
        email: `no-wallet-${outcome}-${publicKey ? "sent" : "omitted"}@example.com`,
        ...(publicKey ? { publicKey: localEd25519PublicKeyHex() } : {}),
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.operator_wallet).toEqual({ source: "none" });
      expect(body.onchain.status).toBe(
        outcome === "off" ? "disabled" : outcome === "registration-rejected" ? "pending" : "written",
      );
      if (outcome === "off") expect(mockRegisterAgentOnChain).not.toHaveBeenCalled();
      else expect(mockRegisterAgentOnChain).toHaveBeenCalledTimes(1);
      expect(mockGenerateOperatorWallet).not.toHaveBeenCalled();
      expect(mockSetAgentWalletOnChain).not.toHaveBeenCalled();
      expect(privateKeyPaths(body)).toEqual([]);
    },
  );
});

/** CI images carry all four; elsewhere the run-it-as-written case needs them on PATH. */
const recipeTools = spawnSync("sh", ["-c", "command -v bash && command -v curl && command -v python3 && command -v git"]).status === 0;
const captureToolsRequired = recipeTools || process.env.CI === "true";
if (!captureToolsRequired) console.info("Capture recipe tests skipped: bash, curl, python3 and git are required locally.");
const tmpdirInGit = spawnSync("git", ["rev-parse", "--git-dir"], { cwd: tmpdir(), stdio: "ignore" }).status === 0;
if (tmpdirInGit) console.info("Outside-repository tests skipped: the temporary directory is inside a Git repository.");

describe.runIf(captureToolsRequired)("every leaf of every 201 the route returns is classified, and every secret copy is named (ChatGPT r1 L1)", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildApp();
  });

  afterEach(async () => {
    try { if (app) await app.close(); }
    finally { closeTestStore(); }
  });

  for (const outcome of IDENTITY_OUTCOMES) {
    for (const sent of [false, true]) {
      it(`identity ${outcome}, publicKey ${sent ? "sent" : "omitted"}: each leaf is a field to read or store-only, each secret copy store-only`, async () => {
        mockIdentity(outcome);
        const res = await provisionFrom(app, {
          email: `${outcome}-${sent ? "sent" : "omitted"}@example.com`,
          ...(sent ? { publicKey: localEd25519PublicKeyHex() } : {}),
        });
        expect(res.statusCode).toBe(201);
        const body = res.json();
        expect(typeof body.trace_id).toBe("string");
        expectEveryLeafClassified(body);
        expect(expectSecretValuesStoreOnly(body)).toEqual(expect.arrayContaining(API_KEY_PATHS));
      });
    }
  }

  it("AT4 published guides and buyer events carry no obsolete provisioning claims", () => {
    const buyer = JSON.parse(read("starter/buyer/buyer-path.json"));
    const key = buyer.steps[0];
    const provision = key.actions[0];
    for (const [label, text] of [
      ["get-key request", provision.request],
      ["get-key recipe", (provision.recipe ?? []).join("\n")],
      ["get-key responseFields", provision.responseFields.join(" ")],
      ["get-key storeOnlyFields", (provision.storeOnlyFields ?? []).join(" ")],
      ["buyer events", JSON.stringify(buyer.events)],
      ["supply step 4", supplyStep4()],
      ["generated agent.md", read("apps/dashboard/public/.well-known/agent.md")],
    ] as Array<[string, string]>) {
      expect(() => expectNoForbiddenClaims(text), label).not.toThrow();
    }
  });

  it("AT16 every advertised read field exists in a real 201; every response leaf is classified", async () => {
    const observed = new Set<string>();
    for (const outcome of IDENTITY_OUTCOMES) {
      for (const publicKey of [false, true]) {
        mockIdentity(outcome);
        const res = await provisionFrom(app, {
          email: `leaf-coverage-${outcome}-${publicKey ? "sent" : "omitted"}@example.com`,
          ...(publicKey ? { publicKey: localEd25519PublicKeyHex() } : {}),
        });
        expect(res.statusCode).toBe(201);
        const body = res.json();
        expectEveryLeafClassified(body);
        for (const path of leafPaths(body)) observed.add(path);
      }
    }
    for (const field of provisionAction().responseFields) {
      expect(observed.has(field), `responseFields advertises a missing 201 leaf: ${field}`).toBe(true);
    }
  });

  it("marks every secret path store-only and lists each field to read once", () => {
    const provision = provisionAction();
    for (const path of SECRET_PATHS) expect(names(provision.storeOnlyFields, path), path).toBe(true);
    expect(new Set(provision.responseFields).size).toBe(provision.responseFields.length);
  });

  it("the recipe prints a fixed classification, then exactly the fields to read", () => {
    const f = captureFixture();
    try {
      const result = f.run();
      expect(result.status).toBe(0);
      const printed = result.stdout.trim().split("\n").map((line) => line.slice(0, line.indexOf(": ")));
      expect(printed).toEqual([...ERROR_FIELDS, ...provisionAction().responseFields]);
    } finally { f.cleanup(); }
  });

  it("AT25 the supply runbook names every secret copy the route can return", () => {
    const step = supplyStep4();
    for (const path of SECRET_PATHS) expect(step, `00-prerequisites.md step 4 must name ${path}`).toContain("`" + path + "`");
    expect(step).toContain(SUPPLY_API_KEY);
    expect(step).toContain(SUPPLY_NO_PRIVATE_KEY);
  });
});

describe("each documented secret condition holds on the real route, for the buyer path and the supply runbook (ChatGPT r1 L3)", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildApp();
  });

  afterEach(async () => {
    try { if (app) await app.close(); }
    finally { closeTestStore(); }
  });

  it("AT5 the buyer path's store-only entries are exactly the three key copies and two diagnostics", () => {
    expect(provisionAction().storeOnlyFields).toEqual([
      "api_key", "usage.header (holds api_key)", "usage.example (holds api_key)",
      "message (raw server diagnostic; may contain secrets)",
      "error (raw error body; only fixed route codes are printed)",
    ]);
    checkStoreOnlyText(provisionAction().storeOnlyFields);
  });

  for (const outcome of IDENTITY_OUTCOMES) {
    it(`AT6 identity ${outcome}: API-key copies always return; wallet and private keys never do`, async () => {
      for (const publicKey of [false, true]) {
        mockIdentity(outcome);
        const res = await provisionFrom(app, {
          email: `conditions-${outcome}-${publicKey ? "sent" : "omitted"}@example.com`,
          ...(publicKey ? { publicKey: localEd25519PublicKeyHex() } : {}),
        });
        expect(res.statusCode).toBe(201);
        const body = res.json();
        checkConditions(body, { outcome, publicKey });
        expect(body.operator_wallet).toEqual({ source: "none" });
        expect(privateKeyPaths(body)).toEqual([]);
        expect(SECRET_PATHS.filter((path) => carries(body, path))).toEqual(API_KEY_PATHS);
      }
    });
  }

  it("AT7 the supply runbook request gets only the three named API-key copies", async () => {
    const step = supplyStep4();
    // Step 4 builds its request from the node's public key, the email and the name.
    expect(step).toContain('"publicKey": Path(".pcc/node-public-key").read_text().strip()');
    expect(step).toContain('with open(Path(sys.argv[1]) / "provision-request.json", "x")');
    for (const outcome of IDENTITY_OUTCOMES) {
      mockIdentity(outcome);
      const res = await provisionFrom(app, {
        publicKey: localEd25519PublicKeyHex(), email: `supply-${outcome}@example.org`, name: "Bench plate reader",
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      const returned = SECRET_PATHS.filter((path) => carries(body, path));
      // Exactly the three documented copies; no server-generated credentials.
      expect(returned, outcome).toEqual(API_KEY_PATHS);
      expect(privateKeyPaths(body)).toEqual([]);
      expect(body.operator_wallet).toEqual({ source: "none" });
      for (const holder of expectSecretValuesStoreOnly(body)) expect(returned, `${holder} holds a secret value`).toContain(holder);
      checkSupplyNames(step, returned);
    }
  });

  it("AT8 negative controls refuse an old wallet entry, a missing key copy, an obsolete claim and a reversed predicate", async () => {
    const entries = provisionAction().storeOnlyFields ?? [];
    expect(() => checkStoreOnlyText([
      ...entries, "operator_wallet.private_key (when operator_wallet.source is server-minted)",
    ])).toThrow();

    const step = supplyStep4();
    checkSupplyNames(step, API_KEY_PATHS);
    expect(() => checkSupplyNames(step.replace(" and `usage.example`", ""), API_KEY_PATHS)).toThrow();
    expect(() => expectNoForbiddenClaims(
      step + " It may also contain `operator_wallet.private_key`, a wallet key the gateway mints.",
    )).toThrow();

    mockIdentity("written");
    const res = await provisionFrom(app, { email: "negative-controls@example.com", publicKey: localEd25519PublicKeyHex() });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    const variant: Variant = { outcome: "written", publicKey: true };
    checkConditions(body, variant);
    const reversed: Condition[] = STORE_ONLY_CONDITIONS.map(([entry, candidate, original]): Condition => [
      entry, candidate, candidate === "api_key" ? () => false : original,
    ]);
    expect(() => checkConditions(body, variant, reversed)).toThrow();
  });
});

/**
 * ChatGPT r1 gap 1: which publicKey values mint, store or refuse, as the buyer path states it. The route's type guard
 * (provision.ts:65-67) refuses a non-string; provisionApiKey() (api-key-auth.ts:159-171) mints only when publicKey is
 * undefined and otherwise stores normalizePublicKeyHex()'s result or throws invalid_public_key (ed25519.ts:89-95).
 */
const BUYER_PUBLIC_KEY =
  "The buyer path requires its own locally generated Ed25519 publicKey.";

describe("other clients: only a body with no publicKey field gets a minted Ed25519 key (ChatGPT r1 gap 1)", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildApp();
  });

  afterEach(async () => {
    try { if (app) await app.close(); }
    finally { closeTestStore(); }
  });

  const OMIT = Symbol("no publicKey field");
  const hex = localEd25519PublicKeyHex();
  const raw = Buffer.from(hex, "hex");
  const cases: Array<[label: string, value: unknown, outcome: "none" | "stored" | "invalid_type" | "invalid_public_key", storedAs?: string]> = [
    ["omitted", OMIT, "none"],
    ["null", null, "invalid_type"],
    ["a number", 64, "invalid_type"],
    ["an object", { hex }, "invalid_type"],
    ["an empty string", "", "invalid_public_key"],
    ["whitespace", "   ", "invalid_public_key"],
    ["64 hex and a trailing newline", `${hex}\n`, "invalid_public_key"],
    ["a space and 64 hex", ` ${hex}`, "invalid_public_key"],
    ["base64 of the 32 raw bytes", raw.toString("base64"), "invalid_public_key"],
    ["malformed base64", `${raw.toString("base64").slice(0, 40)}!!`, "invalid_public_key"],
    ["62 hex characters", hex.slice(2), "invalid_public_key"],
    ["66 hex characters", `${hex}ab`, "invalid_public_key"],
    ["64 characters, one not hex", `${hex.slice(1)}g`, "invalid_public_key"],
    ["0x alone", "0x", "invalid_public_key"],
    ["64 hex", hex, "stored", hex],
    ["0x and 64 hex", `0x${hex}`, "stored", hex],
    ["0X and 64 upper-case hex", `0X${hex.toUpperCase()}`, "stored", hex],
    ["64 hex the gateway does not check as a curve point", "f".repeat(64), "stored", "f".repeat(64)],
  ];

  cases.forEach(([label, value, outcome, storedAs], index) => {
    it(`${label === "omitted" ? "AT9 " : ""}publicKey ${label}: ${outcome}`, async () => {
      mockIdentity("off");
      const email = `public-key-${index}@example.com`;
      const res = await provisionFrom(app, { email, ...(value === OMIT ? {} : { publicKey: value }) });
      const body = res.json();
      const stored = getRepos().apiKeys.findByOperator(email).map((row) => row.publicKey);
      if (outcome === "none") {
        expect(res.statusCode).toBe(201);
        expect(body.ed25519).toEqual({ public_key: null, source: "none" });
        expect(privateKeyPaths(body)).toEqual([]);
        expect(stored).toEqual([null]);
      } else if (outcome === "stored") {
        expect(res.statusCode).toBe(201);
        expect(body.ed25519).toEqual({ public_key: storedAs, source: "byok" });
        expect(stored).toEqual([storedAs]);
      } else {
        expect(res.statusCode).toBe(400);
        expect(body.error).toBe(outcome);
        expect(body).not.toHaveProperty("api_key");
        expect(stored).toEqual([]);
      }
    });
  });

  it("the buyer path says so, word for word", () => {
    expect(provisionAction().request).toContain(BUYER_PUBLIC_KEY);
  });
});

describe("agent golden path provisions over direct HTTP, never through a tool (Opus r1 F1)", () => {
  it("AT10 F7: explains that the tool response exposes credentials to the conversation", () => {
    expectDocumented([]); // No server-returned private-key paths; still enforce the direct-HTTP rule.
    const request = provisionAction().request;
    expect(request).not.toContain("the tool cannot send publicKey");
    expect(request).toContain("its response includes the API key, and a tool result enters the conversation");
    expect(request).not.toContain("any returned private key");
    expect(request).toContain("a tool result enters the conversation");
  });

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

describe("agent golden path captures the provision response without leaking it (Opus r1 F2)", () => {
  it("makes .pcc private and git-ignored before the request, writes the response and header to files, and validates from the header file", () => {
    const recipe = provisionAction().recipe ?? [];
    const at = (needle: string) => recipe.findIndex((line) => line.includes(needle));
    const curl = at("/api/auth/provision");
    expect(recipe[0]).toBe("set -euo pipefail");
    expect(recipe).toContain("umask 077");
    expect(at("chmod 700 .pcc")).toBeLessThan(curl);
    expect(at('git check-ignore -q -- "$credential"')).toBeGreaterThan(0);
    expect(recipe.join("\n")).toContain("info/exclude");
    expect(at("git check-ignore")).toBeLessThan(curl);
    expect(recipe[curl]).toContain('--data-binary @"$capture_dir/provision-request.json"');
    expect(recipe[curl]).toContain('--output "$capture_dir/provision.json"');
    expect(recipe[curl]).toContain('--dump-header "$capture_dir/response.headers"');
    expect(at('with open(stage / "auth.header", "x")')).toBeGreaterThan(curl);
    expect(recipe).toContain('    os.link(stage / name, Path(".pcc") / name)');
    // Nothing dumps the response or the key: no cat, no echo of a variable, no print of the whole body or key.
    expect(recipe.join("\n")).not.toMatch(/\bcat\b|\becho\s+"?\$|print\(r\)|print\(k\)/);
    expect(provisionAction().request).toContain("never print, cat or paste .pcc/provision.json");
    expect(validateAction().recipe).toEqual(['curl -s "$PCC_BASE/api/auth/validate" -H @.pcc/auth.header']);
    expect(validateAction().request).toContain("atomic, no-overwrite importer");
    const getKey = JSON.parse(read("starter/buyer/buyer-path.json")).steps[0] as { doneWhen: string[] };
    expect(getKey.doneWhen.join(" ")).toContain("(.pcc/ is 0700 and ignored by git when working in a repository), no key or private key was printed");
  });

  it("AT11 agent.md renders both recipes and exactly the five store-only fields", () => {
    const doc = read("apps/dashboard/public/.well-known/agent.md");
    expect(doc).toContain(["```bash", ...(provisionAction().recipe ?? []), "```"].join("\n"));
    expect(doc).toContain(["```bash", ...(validateAction().recipe ?? []), "```"].join("\n"));
    expect(doc).toContain(`Read response fields: ${provisionAction().responseFields.join(", ")}.`);
    expect(doc).toContain(
      "Store only, never read into the conversation: " +
      [
        "api_key",
        "usage.header (holds api_key)",
        "usage.example (holds api_key)",
        "message (raw server diagnostic; may contain secrets)",
        "error (raw error body; only fixed route codes are printed)",
      ].join(", ") + ".",
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
      try { if (app) await app.close(); }
      finally { closeTestStore(); }
    });

    it.runIf(recipeTools || process.env.CI === "true")(
      "AT12 prints no secret, leaves .pcc 0700 and git-ignored with 0600 files, and its header validates",
      async () => {
        // The recipe sends its locally generated publicKey; master returns no private key.
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
          await run("git", ["init", "-q"], { cwd: dir, timeout: 10_000 });
          // The agent writes the request body with its file-writing tool before running the recipe.
          mkdirSync(join(dir, ".pcc"));
          writeFileSync(join(dir, ".pcc/provision-request.json"), JSON.stringify({ email: "recipe-run@example.com" }));
          const provision = await run("bash", ["-c", (provisionAction().recipe ?? []).join("\n")], { cwd: dir, env, timeout: 20_000 });
          const validate = await run("bash", ["-c", (validateAction().recipe ?? []).join("\n")], { cwd: dir, env, timeout: 20_000 });

          const body = JSON.parse(readFileSync(join(dir, ".pcc/provision.json"), "utf8"));
          expectSecretValuesStoreOnly(body);
          const secrets: string[] = [
            body.api_key, readFileSync(join(dir, ".pcc/ed25519-private.pem"), "utf8"),
          ];
          for (const secret of secrets) expect(typeof secret === "string" && secret.length >= 32).toBe(true);
          const printed = provision.stdout + provision.stderr + validate.stdout + validate.stderr;
          secrets.forEach((secret, index) => expect(printed.includes(secret), `secret #${index} was printed`).toBe(false));
          expect(provision.stdout).toContain("provision_status: provisioned");
          expect(provision.stdout).toContain(`key_id: ${JSON.stringify(body.key_id)}`);
          // One "name: value" line per field: the error fields, then exactly the fields to read (ChatGPT r1 L1).
          const printedNames = provision.stdout.trim().split("\n").map((line) => line.slice(0, line.indexOf(": ")));
          expect(printedNames).toEqual([...ERROR_FIELDS, ...provisionAction().responseFields]);
          expect(JSON.parse(validate.stdout)).toMatchObject({ valid: true });
          expect(statSync(join(dir, ".pcc")).mode & 0o777).toBe(0o700);
          for (const file of ["provision.json", "auth.header", "ed25519-private.pem"])
            expect(statSync(join(dir, ".pcc", file)).mode & 0o777, file).toBe(0o600);
          expect(readFileSync(join(dir, ".pcc/auth.header"), "utf8") === `Authorization: Bearer ${body.api_key}\n`).toBe(true);
          expect(existsSync(join(dir, ".pcc/provision-request.json"))).toBe(false);
          // check-ignore exits 1 (and execFile rejects) when the path is not ignored.
          for (const credential of ["provision.json", "auth.header", "ed25519-private.pem"])
            await expect(run("git", ["check-ignore", "-q", "--", `.pcc/${credential}`], { cwd: dir })).resolves.toBeDefined();
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
      30_000,
    );
  });
});

describe("states that the response carries no private key", () => {
  it("L1: preserves compact buyer source formatting and literal punctuation", () => {
    const source = read("starter/buyer/buyer-path.json");
    expect(source).toMatch(/^    "buyer\.identifier-required": \{"phase": "get-key", "trigger": /m);
    expect(source).not.toMatch(/"responseFields": \[\s*\n/);
    expect(source).toContain("assurance tier (0–3)");
  });

  it("AT13 buyer path and supply runbook state no server-produced private key", () => {
    expect(provisionAction().request).toContain(BUYER_NO_PRIVATE_KEY);
    expect(provisionAction().request).toContain(BUYER_OTHER_CLIENTS);
    const runbook = read("starter/runbook/00-prerequisites.md");
    expect(supplyStep4()).toContain(SUPPLY_NO_PRIVATE_KEY);
    expect(runbook).not.toContain("no private key ever travels");
  });
});

/** No socket or real credentials: curl is a subprocess fixture; bash executes the published recipe. */
function captureFixture() {
  const dir = mkdtempSync(join(tmpdir(), "agent-capture-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const token = ["pcc", "live", randomBytes(32).toString("hex")].join("_");
  const body = { api_key: token, key_id: "fixture", ed25519: { source: "byok" } };
  writeFileSync(join(dir, "body.json"), JSON.stringify(body));
  const executable = (name: string, source: string) => writeFileSync(join(bin, name), source, { mode: 0o700 });
  executable("curl", `#!/usr/bin/env python3
import os, pathlib, sys
pathlib.Path("requested").write_text("yes")
args = sys.argv[1:]
pathlib.Path("curl-args.json").write_text(__import__("json").dumps(args))
request = next((args[i+1][1:] for i, a in enumerate(args) if a == "--data-binary"), None)
if request: pathlib.Path("sent.json").write_text(pathlib.Path(request).read_text())
output = next((args[i+1] for i, a in enumerate(args) if a in ("--output", "-o")), None)
body = pathlib.Path("body.json").read_text()
if output: pathlib.Path(output).write_text(body)
else: sys.stdout.write(body)
if "--write-out" in args or "-w" in args: sys.stdout.write(os.environ.get("FIXTURE_HTTP", "201"))
headers = next((args[i+1] for i, a in enumerate(args) if a == "--dump-header"), None)
if headers: pathlib.Path(headers).write_text("x-pcc-trace-id: tr_" + "a" * 16 + "\\r\\n" + os.environ.get("FIXTURE_EXTRA_HEADERS", ""))
if os.environ.get("FIXTURE_RACE"): pathlib.Path(".pcc/auth.header").write_text("late destination")
if os.environ.get("FIXTURE_LOSE_IGNORE"): pathlib.Path(".git/info/exclude").write_text("")
sys.exit(int(os.environ.get("FIXTURE_EXIT", "0")))
`);
  spawnSync("git", ["init", "-q"], { cwd: dir });
  mkdirSync(join(dir, ".pcc"), { mode: 0o755 });
  writeFileSync(join(dir, ".pcc/provision-request.json"), JSON.stringify({ email: "fixture@example.com" }));
  const run = (extra: Record<string, string | undefined> = {}) => spawnSync("bash", ["-c", (provisionAction().recipe ?? []).join("\n")], {
    cwd: dir, env: { ...process.env, PCC_BASE: "https://fixture.invalid", PATH: `${bin}:${process.env.PATH}`, ...extra },
    encoding: "utf8", timeout: 15_000,
  });
  return { dir, body, executable, run, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe.runIf(captureToolsRequired)("F2: capture fails closed and never overwrites credentials", () => {
  it.each(["unset", "malformed"])("L-e: importer refuses %s PCC_API_KEY without leaving a temporary header", (kind) => {
    const f = captureFixture();
    try {
      chmodSync(join(f.dir, ".pcc"), 0o700);
      writeFileSync(join(f.dir, ".git/info/exclude"), ".pcc/\n");
      const key = kind === "unset" ? undefined : randomBytes(32).toString("hex");
      const snippet = validateAction().request.match(/`(python3 -c[^`]*)`/)?.[1];
      const result = spawnSync("bash", ["-c", snippet ?? ""], { cwd: f.dir, env: { ...process.env, PCC_API_KEY: key }, encoding: "utf8", timeout: 10_000 });
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("Private header import refused; preserve existing state and verify private-directory and Git setup.\n");
      expect(readdirSync(join(f.dir, ".pcc")).filter((name) => name.startsWith("auth.header"))).toEqual([]);
      if (key) expect(result.stdout + result.stderr).not.toContain(key);
    } finally { f.cleanup(); }
  });

  it.each(["uppercase", "short"])("L-d: capture refuses a 201 with an invalid api_key (%s)", (kind) => {
    const f = captureFixture();
    try {
      const key = ["pcc", "live", kind === "uppercase" ? "A".repeat(64) : randomBytes(32).toString("hex").slice(0, 63)].join("_");
      writeFileSync(join(f.dir, "body.json"), JSON.stringify({ ...f.body, api_key: key }));
      const result = f.run();
      expect(result.status).not.toBe(0);
      for (const name of ["provision.json", "auth.header", "ed25519-private.pem"])
        expect(existsSync(join(f.dir, ".pcc", name))).toBe(false);
      expect(result.stdout + result.stderr).not.toContain(key);
    } finally { f.cleanup(); }
  });

  it.each([undefined, "", "http://example.com", "http://localhost:4310", "https://x.example/", "https://user@x.example", "https://x.example?q=1", "https://x.example#frag", "https://x.example/white space"])("N3: refuses invalid PCC_BASE %s before creating private state", (base) => {
    const f = captureFixture();
    try {
      const result = f.run({ PCC_BASE: base });
      expect(result.status).toBe(1);
      expect(result.stderr).toBe("Invalid gateway base; request refused.\n");
      expect(existsSync(join(f.dir, "requested"))).toBe(false);
      expect(readdirSync(join(f.dir, ".pcc"))).toEqual(["provision-request.json"]);
      expect(statSync(join(f.dir, ".pcc")).mode & 0o777).toBe(0o755);
    } finally { f.cleanup(); }
  });

  it.each(["https://fixture.invalid", "https://fixture.invalid:4310/api", "http://127.0.0.1:4310", "http://[::1]:4310"])("N3: accepts assigned gateway base %s", (base) => {
    const f = captureFixture();
    try { expect(f.run({ PCC_BASE: base }).status).toBe(0); }
    finally { f.cleanup(); }
  });

  it.each([1, 3, 6, 7])("N3: curl exit %s removes unissued staging and permits one rerun", (code) => {
    const f = captureFixture();
    try {
      const result = f.run({ FIXTURE_EXIT: String(code) });
      expect(result.status).toBe(1);
      expect(result.stderr).toBe("Provision request not sent; no key was issued.\n");
      expect(readdirSync(join(f.dir, ".pcc"))).toEqual(["provision-request.json"]);
      expect(f.run().status).toBe(0);
    } finally { f.cleanup(); }
  });

  it.each([28, 56])("N3: curl exit %s preserves capture for possible issuance", (code) => {
    const f = captureFixture();
    try {
      const result = f.run({ FIXTURE_EXIT: String(code) });
      expect(result.status).toBe(1);
      const captures = readdirSync(join(f.dir, ".pcc")).filter((name) => name.startsWith("capture."));
      expect(captures).toHaveLength(1);
      expect(existsSync(join(f.dir, ".pcc", captures[0], "ed25519-private.pem"))).toBe(true);
    } finally { f.cleanup(); }
  });

  it("N1: preserves an exclude rule without a trailing newline", () => {
    const f = captureFixture();
    try {
      writeFileSync(join(f.dir, ".git/info/exclude"), "*.log");
      writeFileSync(join(f.dir, "app.log"), "local log");
      const result = f.run();
      expect(result.status, result.stderr).toBe(0);
      expect(spawnSync("git", ["check-ignore", "-q", "--", "app.log"], { cwd: f.dir }).status).toBe(0);
      expect(readFileSync(join(f.dir, ".git/info/exclude"), "utf8")).toBe("*.log\n.pcc/\n");
    } finally { f.cleanup(); }
  });

  it("N2: a rejected request followed by success adds only one exclusion", () => {
    const f = captureFixture();
    try {
      expect(f.run({ FIXTURE_HTTP: "400" }).status).not.toBe(0);
      expect(f.run().status).toBe(0);
      expect(readFileSync(join(f.dir, ".git/info/exclude"), "utf8").split("\n").filter((line) => line === ".pcc/")).toHaveLength(1);
    } finally { f.cleanup(); }
  });

  it.each(["readonly", "missing"])("N2: already ignored state needs no writable info/exclude (%s)", (kind) => {
    const f = captureFixture();
    try {
      writeFileSync(join(f.dir, ".gitignore"), ".pcc/\n");
      if (kind === "readonly") chmodSync(join(f.dir, ".git/info/exclude"), 0o400);
      else rmSync(join(f.dir, ".git/info"), { recursive: true });
      const result = f.run();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toBe("");
    } finally { f.cleanup(); }
  });

  it("N2: impossible exclusion append prints only its fixed failure and sends nothing", () => {
    const f = captureFixture();
    try {
      rmSync(join(f.dir, ".git/info"), { recursive: true });
      const result = f.run();
      expect(result.status).toBe(1);
      expect(result.stderr).toBe("Git exclusion setup failed.\n");
      expect(existsSync(join(f.dir, "requested"))).toBe(false);
    } finally { f.cleanup(); }
  });

  it.each(["live", "test", "other", "uppercase", "short", "nonhex"])("L5: importer accepts exactly gateway-issued key format (%s)", (kind) => {
    const f = captureFixture();
    try {
      chmodSync(join(f.dir, ".pcc"), 0o700);
      writeFileSync(join(f.dir, ".git/info/exclude"), ".pcc/\n");
      const issued = generateApiKey().rawKey;
      const key = kind === "live" ? issued : kind === "test" ? issued.replace("live", "test")
        : kind === "other" ? issued.replace("live", "other") : kind === "uppercase" ? ["pcc", "live", "A".repeat(64)].join("_")
        : kind === "short" ? issued.slice(0, -1) : ["pcc", "live", "z".repeat(64)].join("_");
      const snippet = validateAction().request.match(/`(python3 -c[^`]*)`/)?.[1];
      const result = spawnSync("bash", ["-c", snippet ?? ""], { cwd: f.dir, env: { ...process.env, PCC_API_KEY: key }, encoding: "utf8", timeout: 10_000 });
      expect(result.status === 0).toBe(kind === "live");
      expect(existsSync(join(f.dir, ".pcc/auth.header"))).toBe(kind === "live");
      expect(result.stdout + result.stderr).not.toContain(key);
    } finally { f.cleanup(); }
  });

  it("AT15 L4: allows on-chain registration and correctly limits orphan revocation", () => {
    const f = captureFixture();
    try {
      const result = f.run({ FIXTURE_EXIT: "28", FIXTURE_HTTP: "000" });
      expect(result.status).not.toBe(0);
      const args = JSON.parse(readFileSync(join(f.dir, "curl-args.json"), "utf8")) as string[];
      expect(Number(args[args.indexOf("--max-time") + 1])).toBeGreaterThanOrEqual(600);
      expect(result.stdout + result.stderr).toContain("Provision request timed out; a key may have been issued and cannot be recovered;");
      for (const advice of ["cannot be recovered", "counts toward the 5-key cap", "Report the failure once", "archive the capture with the archive command", "provision again at most once", "stop and report if that fails too", "A new key cannot revoke the lost one", "only the gateway admin can", "Sign-In with Ethereum", "Tell the human"])
        expect(result.stderr).toContain(advice);
      expect(result.stdout + result.stderr).not.toContain(f.body.api_key);
      expect(result.stderr).not.toContain("authenticated session");
      expect(readdirSync(join(f.dir, ".pcc")).some((name) => name.startsWith("capture."))).toBe(true);
    } finally { f.cleanup(); }
  });

  it.each(["missing", "malformed", "invalid-email", "invalid-type"])("L3: validates %s request input before staging", (kind) => {
    const f = captureFixture();
    try {
      const path = join(f.dir, ".pcc/provision-request.json");
      if (kind === "missing") rmSync(path);
      else writeFileSync(path, kind === "malformed" ? "{" : JSON.stringify({ email: kind === "invalid-email" ? "bad" : 123 }));
      f.executable("mktemp", "#!/bin/sh\nprintf yes > staged\nexit 1\n");
      const result = f.run();
      expect(result.status).not.toBe(0);
      expect(existsSync(join(f.dir, "staged")), "input must be checked before mktemp").toBe(false);
      expect(result.stdout + result.stderr).toContain(kind === "missing" ? "Provisioning input file missing." : "Invalid provisioning input; request refused.");
    } finally { f.cleanup(); }
  });

  it("L3: a missing Python executable has its own fixed prerequisite message", () => {
    const f = captureFixture();
    try {
      f.executable("python3", "#!/bin/sh\nexit 127\n");
      const result = f.run();
      expect(result.status).not.toBe(0);
      expect(result.stdout + result.stderr).toContain("Python3 is required; request refused.");
      expect(existsSync(join(f.dir, "requested"))).toBe(false);
    } finally { f.cleanup(); }
  });

  it("L3: failure after generating a key removes unissued staging and permits a retry", () => {
    const f = captureFixture();
    try {
      const mktemp = spawnSync("bash", ["-c", "command -v mktemp"], { encoding: "utf8" }).stdout.trim();
      f.executable("mktemp", `#!/bin/sh\nstage=$('${mktemp}' "$@") || exit 1\nprintf late > "$stage/provision-request.json"\nprintf '%s' "$stage"\n`);
      const result = f.run();
      expect(result.status).not.toBe(0);
      expect(existsSync(join(f.dir, ".pcc/ed25519-private.pem"))).toBe(false);
      expect(readdirSync(join(f.dir, ".pcc")).filter((name) => name.startsWith("capture."))).toEqual([]);
      rmSync(join(f.dir, "bin/mktemp"));
      expect(f.run().status).toBe(0);
    } finally { f.cleanup(); }
  });

  it("L2 P1: refuses a leftover capture directory with no key or final credentials", () => {
    const f = captureFixture();
    try {
      mkdirSync(join(f.dir, ".pcc/capture.leftover"), { mode: 0o700 });
      expect(f.run().status).not.toBe(0);
      expect(existsSync(join(f.dir, "requested"))).toBe(false);
    } finally { f.cleanup(); }
  });

  it("L2 P3: refuses success when the exclusion is lost during the request", () => {
    const f = captureFixture();
    try {
      const result = f.run({ FIXTURE_LOSE_IGNORE: "yes" });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Git exclusion verification failed after capture");
    } finally { f.cleanup(); }
  });

  it("L2 P4: refuses a server-minted 201 without publishing a header", () => {
    const f = captureFixture();
    try {
      writeFileSync(join(f.dir, "body.json"), JSON.stringify({ ...f.body, ed25519: { source: "server-minted", private_key: randomBytes(32).toString("hex") } }));
      expect(f.run().status).not.toBe(0);
      expect(existsSync(join(f.dir, ".pcc/auth.header"))).toBe(false);
    } finally { f.cleanup(); }
  });

  it.each([false, true])("L2 P5: importer refuses an existing header with private and ignored state (race=%s)", (race) => {
    const f = captureFixture();
    try {
      chmodSync(join(f.dir, ".pcc"), 0o700);
      writeFileSync(join(f.dir, ".git/info/exclude"), ".pcc/\n");
      const prior = randomBytes(32).toString("hex");
      const path = join(f.dir, ".pcc/auth.header");
      if (race) {
        const git = spawnSync("bash", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
        f.executable("git", `#!/bin/sh\nif [ "$1" = check-ignore ]; then case "$4" in */.pcc/auth.header.*) printf '%s' '${prior}' > .pcc/auth.header;; esac; fi\nexec '${git.replace(/'/g, "'\\''")}' "$@"\n`);
      } else writeFileSync(path, prior);
      const snippet = validateAction().request.match(/`(python3 -c[^`]*)`/)?.[1];
      const result = spawnSync("bash", ["-c", snippet ?? ""], {
        cwd: f.dir, env: { ...process.env, PATH: `${join(f.dir, "bin")}:${process.env.PATH}`, PCC_API_KEY: f.body.api_key }, encoding: "utf8", timeout: 10_000,
      });
      expect(result.status).not.toBe(0);
      expect(readFileSync(path, "utf8") === prior).toBe(true);
      if (!race) expect(readdirSync(join(f.dir, ".pcc")).filter((name) => name.startsWith("auth.header."))).toEqual([]);
      expect(result.stdout + result.stderr).not.toContain(f.body.api_key);
    } finally { f.cleanup(); }
  });

  it("the existing-key import refuses a captured header", () => {
    const f = captureFixture();
    try {
      const prior = randomBytes(32).toString("hex");
      const path = join(f.dir, ".pcc/auth.header");
      writeFileSync(path, prior);
      const snippet = validateAction().request.match(/`([^`]*(?:printf|python3)[^`]*)`/)?.[1];
      expect(snippet).toBeDefined();
      const result = spawnSync("bash", ["-c", snippet ?? ""], {
        cwd: f.dir, env: { ...process.env, PCC_API_KEY: f.body.api_key }, encoding: "utf8", timeout: 10_000,
      });
      expect(result.status, "existing-key import must refuse overwrite").not.toBe(0);
      expect(readFileSync(path, "utf8") === prior, "existing-key import destroyed a captured header").toBe(true);
    } finally { f.cleanup(); }
  });

  it("imports an environment key privately only after verified directory and Git setup", () => {
    const f = captureFixture();
    try {
      const snippet = validateAction().request.match(/`(python3 -c[^`]*)`/)?.[1];
      expect(snippet).toBeDefined();
      const runImport = () => spawnSync("bash", ["-c", snippet ?? ""], {
        cwd: f.dir, env: { ...process.env, PCC_API_KEY: f.body.api_key }, encoding: "utf8", timeout: 10_000,
      });
      // Neither loose permissions nor missing effective Git exclusions may allow a secret to be written.
      expect(runImport().status).not.toBe(0);
      chmodSync(join(f.dir, ".pcc"), 0o700);
      expect(runImport().status).not.toBe(0);
      writeFileSync(join(f.dir, ".git/info/exclude"), ".pcc/\n");
      const result = runImport();
      expect(result.status).toBe(0);
      expect((result.stdout + result.stderr).includes(f.body.api_key)).toBe(false);
      const path = join(f.dir, ".pcc/auth.header");
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(readFileSync(path, "utf8") === `Authorization: Bearer ${f.body.api_key}\n`).toBe(true);
    } finally { f.cleanup(); }
  });

  it.each(["mkdir", "chmod"])("stops before requesting if %s fails", (command) => {
    const f = captureFixture();
    try {
      f.executable(command, "#!/bin/sh\nexit 1\n");
      const result = f.run();
      expect(result.status, "failed security setup must exit nonzero").not.toBe(0);
      expect(existsSync(join(f.dir, "requested")), "request ran after failed setup").toBe(false);
      expect(existsSync(join(f.dir, ".pcc/provision.json"))).toBe(false);
    } finally { f.cleanup(); }
  });

  it("stops before requesting if Git exclusion setup fails", () => {
    const f = captureFixture();
    try {
      rmSync(join(f.dir, ".git/info/exclude"));
      mkdirSync(join(f.dir, ".git/info/exclude"));
      const result = f.run();
      expect(result.status, "failed exclusion setup must exit nonzero").not.toBe(0);
      expect(existsSync(join(f.dir, "requested"))).toBe(false);
    } finally { f.cleanup(); }
  });

  it.each(["provision.json", "auth.header"])("refuses an existing %s and preserves both prior files", (name) => {
    const f = captureFixture();
    try {
      const path = join(f.dir, ".pcc", name);
      const prior = randomBytes(32).toString("hex");
      writeFileSync(path, prior);
      const result = f.run({ FIXTURE_EXIT: "7" });
      expect(result.status, "rerun must fail").not.toBe(0);
      expect(readFileSync(path, "utf8") === prior, "prior credential was destroyed").toBe(true);
      expect(existsSync(join(f.dir, "requested"))).toBe(false);
      expect(result.stderr).toContain("archive command");
    } finally { f.cleanup(); }
  });

  it.each([
    { FIXTURE_EXIT: "7", FIXTURE_HTTP: "201" },
    { FIXTURE_EXIT: "0", FIXTURE_HTTP: "500" },
  ])("rejects transport/HTTP failure without publishing a header", (env) => {
    const f = captureFixture();
    try {
      const result = f.run(env);
      expect(result.status, "failed provisioning must exit nonzero").not.toBe(0);
      expect(existsSync(join(f.dir, ".pcc/auth.header"))).toBe(false);
      expect(result.stdout + result.stderr).not.toContain(f.body.api_key);
    } finally { f.cleanup(); }
  });

  it.each(["not JSON", JSON.stringify({ error: "fixture" })])("rejects malformed/non-success bodies", (body) => {
    const f = captureFixture();
    try {
      writeFileSync(join(f.dir, "body.json"), body);
      expect(f.run().status, "invalid success body must exit nonzero").not.toBe(0);
      expect(existsSync(join(f.dir, ".pcc/auth.header"))).toBe(false);
    } finally { f.cleanup(); }
  });

  it.each([".pcc", ".pcc/provision.json", ".pcc/auth.header"])("refuses a symlink at %s", (name) => {
    const f = captureFixture();
    try {
      const target = join(f.dir, "outside");
      if (name === ".pcc") { mkdirSync(target); rmSync(join(f.dir, ".pcc"), { recursive: true }); }
      else writeFileSync(target, "unchanged");
      symlinkSync(target, join(f.dir, name));
      expect(f.run().status, "unsafe symlink must be refused").not.toBe(0);
      expect(existsSync(join(f.dir, "requested"))).toBe(false);
      if (name !== ".pcc") expect(readFileSync(target, "utf8")).toBe("unchanged");
    } finally { f.cleanup(); }
  });

  it("publishes complete private files on success and refuses the next capture", () => {
    const f = captureFixture();
    try {
      expect(f.run().status).toBe(0);
      const response = readFileSync(join(f.dir, ".pcc/provision.json"), "utf8");
      const header = readFileSync(join(f.dir, ".pcc/auth.header"), "utf8");
      expect(JSON.parse(response).api_key === f.body.api_key).toBe(true);
      expect(header === `Authorization: Bearer ${f.body.api_key}\n`).toBe(true);
      expect(statSync(join(f.dir, ".pcc")).mode & 0o777).toBe(0o700);
      for (const file of ["provision.json", "auth.header", "ed25519-private.pem"])
        expect(statSync(join(f.dir, ".pcc", file)).mode & 0o777).toBe(0o600);
      expect(f.run().status).not.toBe(0);
      expect(readFileSync(join(f.dir, ".pcc/provision.json"), "utf8") === response).toBe(true);
      expect(readFileSync(join(f.dir, ".pcc/auth.header"), "utf8") === header).toBe(true);
    } finally { f.cleanup(); }
  });

  it("does not overwrite a destination created during the request", () => {
    const f = captureFixture();
    try {
      expect(f.run({ FIXTURE_RACE: "yes" }).status).not.toBe(0);
      expect(readFileSync(join(f.dir, ".pcc/auth.header"), "utf8")).toBe("late destination");
      expect(JSON.parse(readFileSync(join(f.dir, ".pcc/provision.json"), "utf8")).api_key === f.body.api_key).toBe(true);
    } finally { f.cleanup(); }
  });

  it("M2: a rejected request leaves no credential and permits a retry", () => {
    const f = captureFixture();
    try {
      expect(f.run({ FIXTURE_HTTP: "500" }).status).not.toBe(0);
      rmSync(join(f.dir, "requested"));
      const result = f.run();
      expect(result.status).toBe(0);
      expect(existsSync(join(f.dir, "requested"))).toBe(true);
    } finally { f.cleanup(); }
  });

  it("M2: the exact archive command keeps every credential private and ignored, then permits a rerun", () => {
    const f = captureFixture();
    try {
      expect(f.run().status).toBe(0);
      const prior = readFileSync(join(f.dir, ".pcc/ed25519-private.pem"), "utf8");
      mkdirSync(join(f.dir, ".pcc/capture.leftover"), { mode: 0o700 });
      writeFileSync(join(f.dir, ".pcc/capture.leftover/provision.json"), JSON.stringify(f.body));
      const snippet = provisionAction().request.match(/`(python3 -c[^`]*)`/)?.[1];
      expect(snippet, "the guide must give the exact archive command").toBeDefined();
      const archived = spawnSync("bash", ["-c", snippet ?? ""], { cwd: f.dir, encoding: "utf8", timeout: 10_000 });
      expect(archived.status).toBe(0);
      const walk = (rel: string): void => {
        const path = join(f.dir, rel);
        const s = statSync(path);
        expect(s.mode & 0o777).toBe(s.isDirectory() ? 0o700 : 0o600);
        expect(spawnSync("git", ["check-ignore", "-q", "--", rel], { cwd: f.dir }).status).toBe(0);
        if (s.isDirectory()) for (const name of readdirSync(path)) walk(`${rel}/${name}`);
      };
      walk(".pcc/archive");
      const archives = readdirSync(join(f.dir, ".pcc/archive"));
      expect(archives).toHaveLength(1);
      expect(archives[0]).toMatch(/^\d{8}T\d{6}Z-/);
      expect(readFileSync(join(f.dir, ".pcc/archive", archives[0], "ed25519-private.pem"), "utf8") === prior).toBe(true);
      writeFileSync(join(f.dir, ".pcc/provision-request.json"), JSON.stringify({ email: "retry@example.com" }));
      expect(f.run().status).toBe(0);
      expect(archived.stdout + archived.stderr).not.toContain(f.body.api_key);
      expect(provisionAction().request).not.toContain("move .pcc aside");
      expect(validateAction().request).not.toContain("move .pcc aside");
    } finally { f.cleanup(); }
  });
});

describe.runIf(captureToolsRequired)("F1: every credential destination is untracked and effectively ignored", () => {
  it("L8: the tracked-file fixture resolves Git from PATH", () => {
    expect(read("packages/gateway/src/__tests__/agent-md-provision-secrets.test.ts")).not.toContain(["/usr/bin", "git"].join("/"));
  });

  it("protects the header when only provision.json was ignored initially", () => {
    const f = captureFixture();
    try {
      writeFileSync(join(f.dir, ".gitignore"), ".pcc/provision.json\n");
      expect(f.run().status).toBe(0);
      for (const name of ["provision.json", "auth.header"])
        expect(spawnSync("git", ["check-ignore", "-q", "--", `.pcc/${name}`], { cwd: f.dir }).status,
          `${name} is eligible for commit`).toBe(0);
    } finally { f.cleanup(); }
  });

  it("refuses a tracked credential destination even if absent from the working tree", () => {
    const f = captureFixture();
    try {
      // Model Git's tracked-but-deleted index entry without mutating an index.
      const git = spawnSync("bash", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
      expect(git).not.toBe("");
      f.executable("git", `#!/bin/sh\nif [ "$1" = ls-files ]; then printf '.pcc/auth.header\\n'; exit 0; fi\nexec '${git.replace(/'/g, "'\\''")}' "$@"\n`);
      const result = f.run();
      expect(result.status, "tracked destination must be refused").not.toBe(0);
      expect(existsSync(join(f.dir, "requested"))).toBe(false);
    } finally { f.cleanup(); }
  });

  it("refuses an exclusion overridden by a higher-priority Git rule", () => {
    const f = captureFixture();
    try {
      writeFileSync(join(f.dir, ".gitignore"), "!.pcc/\n!.pcc/auth.header\n");
      expect(f.run().status, "unverified exclusion must be refused").not.toBe(0);
      expect(existsSync(join(f.dir, "requested"))).toBe(false);
    } finally { f.cleanup(); }
  });

  it.skipIf(tmpdirInGit)("L6: captures privately outside a Git repository and prints one fixed note", () => {
    const f = captureFixture();
    try {
      rmSync(join(f.dir, ".git"), { recursive: true });
      const result = f.run();
      expect(result.status, result.stderr).toBe(0);
      const getKey = JSON.parse(read("starter/buyer/buyer-path.json")).steps[0] as { doneWhen: string[] };
      expect(getKey.doneWhen.join(" ")).toContain("ignored by git when working in a repository");
      expect(existsSync(join(f.dir, "requested"))).toBe(true);
      expect(result.stdout.match(/Outside a Git repository; private state uses filesystem permissions\./g)).toHaveLength(1);
      expect(statSync(join(f.dir, ".pcc")).mode & 0o777).toBe(0o700);
      for (const name of ["provision.json", "auth.header", "ed25519-private.pem"])
        expect(statSync(join(f.dir, ".pcc", name)).mode & 0o777).toBe(0o600);
      expect(result.stdout + result.stderr).not.toContain(f.body.api_key);
    } finally { f.cleanup(); }
  });

  it.skipIf(tmpdirInGit)("L6: existing-key import also works privately outside Git", () => {
    const f = captureFixture();
    try {
      rmSync(join(f.dir, ".git"), { recursive: true });
      chmodSync(join(f.dir, ".pcc"), 0o700);
      const snippet = validateAction().request.match(/`(python3 -c[^`]*)`/)?.[1];
      const result = spawnSync("bash", ["-c", snippet ?? ""], { cwd: f.dir, env: { ...process.env, PCC_API_KEY: f.body.api_key }, encoding: "utf8", timeout: 10_000 });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("Outside a Git repository; private state uses filesystem permissions.");
      expect(statSync(join(f.dir, ".pcc/auth.header")).mode & 0o777).toBe(0o600);
      expect(result.stdout + result.stderr).not.toContain(f.body.api_key);
    } finally { f.cleanup(); }
  });

  it("L6: failed Git detection in an existing repository still refuses capture", () => {
    const f = captureFixture();
    try {
      f.executable("git", "#!/bin/sh\nexit 1\n");
      expect(f.run().status).not.toBe(0);
      expect(existsSync(join(f.dir, "requested"))).toBe(false);
    } finally { f.cleanup(); }
  });

  it.skipIf(tmpdirInGit)("L6: import and archive work outside a repository even without a Git executable", () => {
    const f = captureFixture();
    try {
      rmSync(join(f.dir, ".git"), { recursive: true });
      chmodSync(join(f.dir, ".pcc"), 0o700);
      const resolve = (name: string) => spawnSync("bash", ["-c", `command -v ${name}`], { encoding: "utf8" }).stdout.trim();
      const python = resolve("python3");
      f.executable("python3", `#!/bin/sh\nexec '${python.replace(/'/g, "'\\''")}' "$@"\n`);
      const env = { ...process.env, PATH: join(f.dir, "bin"), PCC_API_KEY: f.body.api_key };
      for (const action of [validateAction(), provisionAction()]) {
        const snippet = action.request.match(/`(python3 -c[^`]*)`/)?.[1];
        const result = spawnSync(resolve("bash"), ["-c", snippet ?? ""], { cwd: f.dir, env, encoding: "utf8", timeout: 10_000 });
        expect(result.status).toBe(0);
        expect(result.stdout + result.stderr).not.toContain(f.body.api_key);
      }
      expect(existsSync(join(f.dir, ".pcc/auth.header"))).toBe(false);
      expect(readdirSync(join(f.dir, ".pcc/archive"))).toHaveLength(1);
    } finally { f.cleanup(); }
  });
});

type KeyProvider = "python" | "pynacl" | "openssl" | "node";
function fixturePythonPath(dir: string): string {
  return [join(dir, "bin"), process.env.PYTHONPATH].filter(Boolean).join(delimiter);
}
type ProviderProbe = (command: string, args: string[]) => { status: number | null; stdout: string };
function providerSkipReason(provider: KeyProvider, probe: ProviderProbe = (command, args) => {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 10_000 });
  return { status: result.status, stdout: result.stdout ?? "" };
}): string | undefined {
  if (provider === "node") return undefined; // Vitest's own Node executable is always available.
  if (provider === "openssl") {
    const version = probe("openssl", ["version"]);
    if (version.stdout.includes("LibreSSL")) return "LibreSSL has no Ed25519 genpkey support";
    if (version.status !== 0 || probe("openssl", ["genpkey", "-algorithm", "ed25519"]).status !== 0)
      return "OpenSSL Ed25519 generation unavailable";
    return undefined;
  }
  const script = provider === "python"
    ? "from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey; Ed25519PrivateKey.generate()"
    : "from nacl.signing import SigningKey; SigningKey.generate()";
  if (probe("python3", ["-c", script]).status !== 0)
    return provider === "python" ? "Python cryptography Ed25519 unavailable" : "Python PyNaCl Ed25519 unavailable";
  return undefined;
}

describe.runIf(captureToolsRequired)("F5: buyer generates and sends its own Ed25519 key", () => {
  it("N5: provider isolation preserves imports from inherited PYTHONPATH", () => {
    const f = captureFixture();
    const inherited = process.env.PYTHONPATH;
    try {
      const modules = join(f.dir, "inherited-modules");
      mkdirSync(modules);
      writeFileSync(join(modules, "inherited_marker.py"), "value = 'inherited import works'\n");
      process.env.PYTHONPATH = modules;
      f.executable("sitecustomize.py", "import inherited_marker\nfrom pathlib import Path\nPath('inherited-pythonpath').write_text(inherited_marker.value)\n");
      expect(f.run({ PYTHONPATH: fixturePythonPath(f.dir) }).status).toBe(0);
      expect(existsSync(join(f.dir, "inherited-pythonpath"))).toBe(true);
      expect(readFileSync(join(f.dir, "inherited-pythonpath"), "utf8")).toBe("inherited import works");
    } finally {
      if (inherited === undefined) delete process.env.PYTHONPATH;
      else process.env.PYTHONPATH = inherited;
      f.cleanup();
    }
  });

  it("M4: constructs PEM armor at runtime in the published recipe", () => {
    const recipe = (provisionAction().recipe ?? []).join("\n");
    expect(recipe).not.toContain(["PRIVATE", "KEY"].join(" "));
  });

  it("M3: availability gates explain bare Python and LibreSSL while Node always runs", () => {
    const unavailable: ProviderProbe = () => ({ status: 1, stdout: "" });
    expect(providerSkipReason("python", unavailable)).toBe("Python cryptography Ed25519 unavailable");
    expect(providerSkipReason("pynacl", unavailable)).toBe("Python PyNaCl Ed25519 unavailable");
    expect(providerSkipReason("openssl", () => ({ status: 0, stdout: "LibreSSL 3.3.6" }))).toBe("LibreSSL has no Ed25519 genpkey support");
    expect(providerSkipReason("openssl", unavailable)).toBe("OpenSSL Ed25519 generation unavailable");
    expect(providerSkipReason("node", unavailable)).toBeUndefined();
  });

  for (const provider of ["python", "pynacl", "openssl", "node"] as const) {
    const reason = providerSkipReason(provider);
    if (reason) console.info(`F5 skip ${provider}: ${reason}`);
    it.skipIf(Boolean(reason))(`keeps the private key locally with the ${provider} generator chain${reason ? ` [skip: ${reason}]` : ""}`, () => {
    const f = captureFixture();
    try {
      const blocked = provider === "python" ? ["nacl"] : provider === "pynacl" ? ["cryptography"] : ["cryptography", "nacl"];
      f.executable("sitecustomize.py", `import builtins\noriginal = builtins.__import__\ndef guarded(name, *args, **kwargs):\n    if name.split(".")[0] in ${JSON.stringify(blocked)}: raise ImportError("fixture")\n    return original(name, *args, **kwargs)\nbuiltins.__import__ = guarded\n`);
      // Force each named provider, so an earlier/later fallback cannot conceal a broken branch.
      if (provider !== "openssl") f.executable("openssl", "#!/bin/sh\nexit 1\n");
      if (provider !== "node") f.executable("node", "#!/bin/sh\nexit 1\n");
      else f.executable("node", `#!/bin/sh\nexec '${process.execPath.replace(/'/g, "'\\''")}' "$@"\n`);
      const result = f.run({ PYTHONPATH: fixturePythonPath(f.dir) });
      expect(result.status, "local generation must succeed").toBe(0);
      const sent = JSON.parse(readFileSync(join(f.dir, "sent.json"), "utf8"));
      expect(sent.publicKey, "every buyer request requires publicKey").toMatch(/^[0-9a-f]{64}$/);
      const path = join(f.dir, ".pcc/ed25519-private.pem");
      const pem = readFileSync(path, "utf8");
      const privateKey = createPrivateKey(pem);
      const pub = createPublicKey(privateKey).export({ type: "spki", format: "der" }).subarray(-32);
      expect(pub.toString("hex")).toBe(sent.publicKey);
      const message = randomBytes(24);
      expect(verify(null, message, createPublicKey(privateKey), sign(null, message, privateKey))).toBe(true);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect((result.stdout + result.stderr).includes(pem), "private PEM was printed").toBe(false);
      const raw = privateKey.export({ type: "pkcs8", format: "der" });
      expect((result.stdout + result.stderr).includes(raw.toString("base64")), "private DER was printed").toBe(false);
      expect(spawnSync("git", ["check-ignore", "-q", "--", ".pcc/ed25519-private.pem"], { cwd: f.dir }).status).toBe(0);
    } finally { f.cleanup(); }
  });
  }

  it("fails closed with a clear message if no key generator is available", () => {
    const f = captureFixture();
    try {
      f.executable("sitecustomize.py", 'import builtins\noriginal = builtins.__import__\ndef guarded(name, *args, **kwargs):\n    if name.split(".")[0] in ("cryptography", "nacl"): raise ImportError("fixture")\n    return original(name, *args, **kwargs)\nbuiltins.__import__ = guarded\n');
      for (const command of ["openssl", "node"]) f.executable(command, "#!/bin/sh\nexit 1\n");
      const result = f.run({ PYTHONPATH: fixturePythonPath(f.dir) });
      expect(result.status, "must never request a server-minted Ed25519 key").not.toBe(0);
      expect(result.stderr).toContain("No Ed25519 generator available");
      expect(existsSync(join(f.dir, "requested"))).toBe(false);
    } finally { f.cleanup(); }
  });

  it("refuses an existing local private key without changing it", () => {
    const f = captureFixture();
    try {
      const path = join(f.dir, ".pcc/ed25519-private.pem");
      const prior = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" });
      writeFileSync(path, prior);
      expect(f.run().status).not.toBe(0);
      expect(readFileSync(path, "utf8") === prior).toBe(true);
      expect(existsSync(join(f.dir, "requested"))).toBe(false);
    } finally { f.cleanup(); }
  });
});

describe.runIf(captureToolsRequired)("F3: diagnostics stay private and output uses fixed classifications", () => {
  it.each([500, 502, 429])("N4: HTTP %s prints advice for that status", (status) => {
    const f = captureFixture();
    try {
      writeFileSync(join(f.dir, "body.json"), JSON.stringify({ error: status === 429 ? "rate_limited" : "provision_failed" }));
      const result = f.run({ FIXTURE_HTTP: String(status) });
      expect(result.stderr).toBe(status === 429
        ? "Provision request limited; honor retry_after_seconds; do not loop.\n"
        : "Provision server failure; a key may exist server-side and counts toward the 5-key cap; report once with the printed trace_id; do not loop.\n");
    } finally { f.cleanup(); }
  });

  it.each([
    ["42", undefined, 42], ["Wed, 21 Oct 2026 07:28:00 GMT", undefined, undefined],
    ["42", 17, 17], ["42", "bad", 42], ["٤٢", undefined, undefined],
  ])("N4: Retry-After %s with body retry %s projects only an integer (%s)", (header, bodyRetry, expected) => {
    const f = captureFixture();
    try {
      writeFileSync(join(f.dir, "body.json"), JSON.stringify({ error: "rate_limited", retry_after_seconds: bodyRetry }));
      const result = f.run({ FIXTURE_HTTP: "429", FIXTURE_EXTRA_HEADERS: `Retry-After: ${header}\r\n` });
      if (expected === undefined) expect(result.stdout).not.toContain("retry_after_seconds:");
      else expect(result.stdout).toContain(`retry_after_seconds: ${expected}\n`);
    } finally { f.cleanup(); }
  });

  it("N4: an unknown 413 prints the output named by its get-key event", () => {
    const f = captureFixture();
    try {
      writeFileSync(join(f.dir, "body.json"), JSON.stringify({ error: "FST_ERR_CTP_BODY_TOO_LARGE", message: f.body.api_key }));
      const result = f.run({ FIXTURE_HTTP: "413" });
      expect(result.stdout).toContain("http_status: 413\nerror: unrecognised\n");
      const event = JSON.parse(read("starter/buyer/buyer-path.json")).events["buyer.unrecognised-rejection"];
      expect(event?.phase).toBe("get-key");
      expect(event?.trigger).toContain("http_status: 4xx; error: unrecognised");
      for (const advice of ["report once", "http_status", "trace_id", "do not retry blindly"]) expect(event?.do).toContain(advice);
      expect(result.stdout + result.stderr).not.toContain(f.body.api_key);
    } finally { f.cleanup(); }
  });

  it("N4: request guidance distinguishes discarded rejections and the published success file", () => {
    const request = provisionAction().request;
    expect(request).not.toContain("keep them in the private capture");
    expect(request).not.toContain("find and validate the issued key");
    expect(request).toContain("A rejection deletes its capture");
    expect(request).toContain("on success they stay in .pcc/provision.json");
    expect(request).toContain("provision again at most once");
  });

  it.each([
    [400, "identifier_required"], [400, "invalid_type"], [400, "invalid_email"],
    [400, "invalid_wallet_address"], [400, "invalid_public_key"],
    [429, "rate_limited"], [429, "too_many_keys"], [500, "provision_failed"],
  ])("M1: projects HTTP %s and fixed error %s", (status, error) => {
    const f = captureFixture();
    try {
      writeFileSync(join(f.dir, "body.json"), JSON.stringify({ error, message: f.body.api_key, retry_after_seconds: 3600 }));
      const result = f.run({ FIXTURE_HTTP: String(status) });
      expect(result.status).not.toBe(0);
      expect(result.stdout).toContain(`http_status: ${status}\nerror: ${error}\nretry_after_seconds: 3600\ntrace_id: "tr_${"a".repeat(16)}"`);
      expect(result.stdout + result.stderr).not.toContain(f.body.api_key);
    } finally { f.cleanup(); }
  });

  it("M1: prints unrecognised for free-text errors and excludes noninteger retries", () => {
    const f = captureFixture();
    try {
      writeFileSync(join(f.dir, "body.json"), JSON.stringify({ error: f.body.api_key + "\nfree text", retry_after_seconds: "3600", trace_id: f.body.api_key }));
      const result = f.run({ FIXTURE_HTTP: "400" });
      expect(result.stdout).toContain("http_status: 400\nerror: unrecognised\n");
      expect(result.stdout).not.toContain("retry_after_seconds:");
      expect(result.stdout + result.stderr).not.toContain(f.body.api_key);
      expect(result.stdout + result.stderr).not.toContain("free text");
    } finally { f.cleanup(); }
  });

  it("AT14 never prints secret-bearing or multiline wallet diagnostics or a server message", () => {
    const f = captureFixture();
    try {
      const diagnostic = f.body.api_key + "\nsecond diagnostic line";
      writeFileSync(join(f.dir, "body.json"), JSON.stringify({ ...f.body,
        message: diagnostic, operator_wallet: { onchain_status: "failed", onchain_error: diagnostic },
      }));
      const result = f.run();
      expect(result.status).toBe(0);
      expect((result.stdout + result.stderr).includes(f.body.api_key), "diagnostic printed a secret").toBe(false);
      expect(result.stdout + result.stderr).not.toContain("second diagnostic line");
      expect(result.stdout).toContain("provision_status: provisioned");
      const capture = JSON.parse(readFileSync(join(f.dir, ".pcc/provision.json"), "utf8"));
      expect(capture.message === diagnostic && capture.operator_wallet.onchain_error === diagnostic).toBe(true);
      expect(names(provisionAction().storeOnlyFields, "operator_wallet.onchain_error")).toBe(false);
      expect(names(provisionAction().responseFields, "operator_wallet.onchain_error")).toBe(false);
    } finally { f.cleanup(); }
  });

  it("AT17 orphan-recovery guidance is present exactly three times per path and never delegates to a plain key", () => {
    const buyer = read("starter/buyer/buyer-path.json");
    const supply = read("starter/runbook/00-prerequisites.md");
    expect(buyer.split(BUYER_ORPHAN).length - 1).toBe(3);
    expect(supply.split(SUPPLY_ORPHAN).length - 1).toBe(3);
    expect(buyer).not.toContain("authenticated session");
    expect(supply).not.toContain("authenticated session");
  });

  it("keeps rejected-request exception text private", () => {
    const f = captureFixture();
    try {
      writeFileSync(join(f.dir, "body.json"), JSON.stringify({ error: "provision_failed", message: f.body.api_key + "\nraw exception" }));
      const result = f.run({ FIXTURE_HTTP: "500" });
      expect(result.status).not.toBe(0);
      expect((result.stdout + result.stderr).includes(f.body.api_key)).toBe(false);
      expect(result.stdout + result.stderr).not.toContain("raw exception");
    } finally { f.cleanup(); }
  });
});

describe("F4: provisioning fixture owns a fresh in-memory database", () => {
  it.each(["DATABASE_URL", "RAILWAY_VOLUME_MOUNT_PATH"])("cannot be redirected by %s", async (variable) => {
    const dir = mkdtempSync(join(tmpdir(), "agent-md-db-boundary-"));
    let app: FastifyInstance | undefined;
    try {
      closeTestStore();
      // Vitest 1.x stringifies undefined in stubEnv; register restoration, then truly unset.
      vi.stubEnv("DATABASE_URL", "");
      vi.stubEnv("RAILWAY_VOLUME_MOUNT_PATH", "");
      delete process.env.DATABASE_URL;
      delete process.env.RAILWAY_VOLUME_MOUNT_PATH;
      vi.stubEnv(variable, variable === "DATABASE_URL" ? join(dir, "sentinel.db") : dir);
      app = await buildApp();
      expect(existsSync(join(dir, "sentinel.db")) || existsSync(join(dir, "pcc.db")), "fixture opened a persistent store").toBe(false);
    } finally {
      await app?.close();
      closeTestStore();
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("replaces a stale singleton with a fresh store", async () => {
    let app: FastifyInstance | undefined;
    try {
      closeTestStore();
      vi.stubEnv("DATABASE_URL", ":memory:");
      const stale = initStore({ seed: false });
      app = await buildApp();
      expect(getStore() === stale, "fixture reused stale singleton").toBe(false);
    } finally {
      await app?.close();
      closeTestStore();
      vi.unstubAllEnvs();
    }
  });

  it("restores all database environment settings on teardown", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-md-db-restore-"));
    const original = { DATABASE_URL: join(dir, "sentinel.db"), RAILWAY_VOLUME_MOUNT_PATH: dir, PCC_DB_PATH: join(dir, "legacy.db") };
    let app: FastifyInstance | undefined;
    try {
      for (const name of STORE_ENV) vi.stubEnv(name, original[name]);
      app = await buildApp();
      expect(process.env.DATABASE_URL).toBe(":memory:");
      await app.close();
      app = undefined;
      closeTestStore();
      for (const name of STORE_ENV) expect(process.env[name]).toBe(original[name]);
      expect(() => getStore()).toThrow(/Store not initialised/);
    } finally {
      await app?.close();
      closeTestStore();
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
