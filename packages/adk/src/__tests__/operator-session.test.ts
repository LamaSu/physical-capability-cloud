import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inspect } from "node:util";
import {
  OperatorSessionError, buildOperatorSignInMessage, createOperatorSessionKeeper, mintOperatorSessionKey,
  type OperatorSessionEvent, type OperatorSessionKeeperOptions, type OperatorSignInFields,
} from "../operator-session.js";

const ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const OTHER_ADDRESS = "0x00000000000000000000000000000000000000ab";
const SIGNATURE = `0x${"11".repeat(65)}`;
const BASE = "https://gw.example:8443/pcc/";
const STATEMENT = "Sign in to Physical Capability Cloud as an operator host.";
const HOUR = 3_600_000;
const KEY_LIFETIME = 12 * HOUR;
const FIRST_DATE = "2026-10-17T12:00:00.000Z";

type Route = "nonce" | "verify" | "session-key" | "logout";
type RecordedCall = {
  readonly at: number;
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body?: string;
  readonly redirect: RequestRedirect | undefined;
};
type Script =
  | { readonly kind: "reply"; readonly value: Response }
  | { readonly kind: "reject" }
  | { readonly kind: "hang" }
  | { readonly kind: "transform"; readonly fn: (value: Response) => Response }
  | { readonly kind: "hold"; readonly gate: Promise<void>; readonly commitFirst: boolean };

function json(value: unknown, status = 200, contentType = "application/json"): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": contentType } });
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(res => { resolve = res; });
  return { promise, resolve };
}

/** Real Response/streams, one-use nonces, session ownership and key revocation. */
class FakeGateway {
  readonly calls: RecordedCall[] = [];
  readonly sessions = new Map<string, { address: string; expiresAtMs: number }>();
  readonly issuedNonces = new Map<string, number>();
  readonly keys = new Map<string, { token: string; address: string; revoked: boolean; expiresAtMs: number }>();
  readonly scripts = new Map<Route, Script[]>();
  readonly sessionTokens: string[] = [];
  readonly mintedKeys: string[] = [];
  clockOffsetMs = 0;
  private nonceNumber = 0;
  private sessionNumber = 0;
  private keyNumber = 0;

  queue(route: Route, script: Script): void {
    const queue = this.scripts.get(route) ?? [];
    queue.push(script);
    this.scripts.set(route, queue);
  }

  count(route: Route): number {
    return this.calls.filter(call => call.url.endsWith(`/api/auth/${route}`)).length;
  }

  routeCalls(route: Route): RecordedCall[] {
    return this.calls.filter(call => call.url.endsWith(`/api/auth/${route}`));
  }

  isRevoked(rawKey: string): boolean {
    return this.keys.get(rawKey)?.revoked === true;
  }

  fetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const call: RecordedCall = {
      at: Date.now(), url, method: init?.method ?? "GET", headers,
      ...(init?.body === undefined ? {} : { body: String(init.body) }),
      redirect: init?.redirect,
    };
    this.calls.push(call);
    const match = /\/api\/auth\/(nonce|verify|session-key|logout)$/.exec(new URL(url).pathname);
    if (!match) return json({ error: "route_not_found" }, 404);
    const route = match[1] as Route;
    const script = this.scripts.get(route)?.shift();
    if (script?.kind === "reply") return script.value;
    if (script?.kind === "reject") throw new Error("secret: test network failure");
    if (script?.kind === "hang") return new Promise<Response>(() => undefined);
    if (script?.kind === "hold" && !script.commitFirst) await script.gate;
    const response = this.handle(route, call);
    if (script?.kind === "hold" && script.commitFirst) await script.gate;
    if (script?.kind === "transform") return script.fn(response);
    return response;
  };

  private handle(route: Route, call: RecordedCall): Response {
    const now = Date.now() + this.clockOffsetMs;
    if (route === "nonce") {
      const nonce = (++this.nonceNumber).toString(16).padStart(32, "0");
      this.issuedNonces.set(nonce, now + 5 * 60_000);
      return json({ nonce });
    }
    if (route === "verify") {
      let body: { message?: unknown; signature?: unknown };
      try { body = JSON.parse(call.body ?? ""); } catch { return json({ error: "bad_json" }, 400); }
      if (body.signature !== SIGNATURE || typeof body.message !== "string") return json({ error: "bad_signature" }, 401);
      const parts = /^([^\n]+) wants you to sign in with your Ethereum account:\n(0x[0-9a-fA-F]{40})\n\n([^\n]+)\n\nURI: ([^\n]+)\nVersion: 1\nChain ID: (\d+)\nNonce: ([^\n]+)\nIssued At: ([^\n]+)$/.exec(body.message);
      if (!parts) return json({ error: "bad_message" }, 400);
      const [, domain, address, statement, uri, chain, nonce, issuedAt] = parts;
      const fields: OperatorSignInFields = { domain, address, statement, uri, version: "1", chainId: Number(chain), nonce, issuedAt };
      if (buildOperatorSignInMessage(fields) !== body.message || statement !== STATEMENT ||
        domain !== new URL(call.url).host || uri !== new URL(call.url).origin ||
        !this.issuedNonces.has(nonce) || this.issuedNonces.get(nonce)! < now ||
        now - Date.parse(issuedAt) > 5 * 60_000) return json({ error: "bad_challenge" }, 401);
      this.issuedNonces.delete(nonce);
      const token = `session-${++this.sessionNumber}`;
      const expiresAtMs = now + 24 * HOUR;
      this.sessions.set(token, { address, expiresAtMs });
      this.sessionTokens.push(token);
      return json({ token, address, expiresAt: new Date(expiresAtMs).toISOString() });
    }
    if (route === "session-key") {
      const authorization = call.headers.authorization;
      if (!authorization || authorization.startsWith("Bearer pcc_")) return json({ error: "session_required" }, 403);
      const token = authorization.slice("Bearer ".length);
      const session = authorization.startsWith("Bearer ") ? this.sessions.get(token) : undefined;
      if (!session || session.expiresAtMs <= now) return json({ error: "session_required" }, 401);
      // Same-session replacement, including after a committed-but-lost reply.
      for (const key of this.keys.values()) {
        if (key.token === token || (key.address === session.address && key.expiresAtMs <= now)) key.revoked = true;
      }
      const activeCount = [...this.keys.values()].filter(k => k.address === session.address && !k.revoked && k.expiresAtMs > now).length;
      if (activeCount >= 5) return json({ error: "too_many_keys" }, 429);
      const apiKey = `pcc_live_${(++this.keyNumber).toString(16).padStart(64, "0")}`;
      const expiresAtMs = Math.min(session.expiresAtMs, now + KEY_LIFETIME);
      const keyId = `key-${this.keyNumber}`;
      this.keys.set(apiKey, { token, address: session.address, revoked: false, expiresAtMs });
      this.mintedKeys.push(apiKey);
      return json({ api_key: apiKey, key_id: keyId, operator_id: session.address,
        expires_at: new Date(expiresAtMs).toISOString(), created_at: new Date(now).toISOString() }, 201);
    }
    const authorization = call.headers.authorization;
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!this.sessions.has(token)) return json({ error: "session_required" }, 401);
    for (const key of this.keys.values()) if (key.token === token) key.revoked = true;
    this.sessions.delete(token);
    return json({ ok: true });
  }
}

function setup(gateway = new FakeGateway()) {
  const signer = vi.fn(async (_message: string, _fields: OperatorSignInFields) => SIGNATURE);
  const options: OperatorSessionKeeperOptions = {
    baseUrl: BASE, address: ADDRESS, chainId: 84532,
    signMessage: signer, fetchImpl: gateway.fetch, now: () => Date.now(), timeoutMs: 15_000,
  };
  return { gateway, signer, options };
}

async function flush() { await vi.advanceTimersByTimeAsync(0); }
async function tick(ms: number) { await vi.advanceTimersByTimeAsync(ms); }

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(FIRST_DATE));
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("T1 — one mint, bounded origin and exact wire protocol", () => {
  it("sends nonce, verify and key in order, preserving the base path and the bearer-only mint", async () => {
    const { gateway, signer, options } = setup();
    const start = Date.now();
    const key = await mintOperatorSessionKey(options);
    expect(gateway.calls.map(call => `${call.method} ${call.url}`)).toEqual([
      "GET https://gw.example:8443/pcc/api/auth/nonce",
      "POST https://gw.example:8443/pcc/api/auth/verify",
      "POST https://gw.example:8443/pcc/api/auth/session-key",
    ]);
    expect(gateway.calls.map(call => call.redirect)).toEqual(["error", "error", "error"]);
    expect(gateway.calls[0].headers).toEqual({ accept: "application/json" });
    expect(gateway.calls[1].headers).toEqual({ accept: "application/json", "content-type": "application/json" });
    const { message, signature } = JSON.parse(gateway.calls[1].body!);
    expect(signature).toBe(SIGNATURE);
    expect(message).toBe(buildOperatorSignInMessage(signer.mock.calls[0][1]));
    expect(signer.mock.calls[0][0]).toBe(message);
    expect(Object.isFrozen(signer.mock.calls[0][1])).toBe(true);
    expect(gateway.calls[2].headers).toEqual({ accept: "application/json", authorization: `Bearer ${gateway.sessionTokens[0]}` });
    expect(gateway.calls[2].body).toBeUndefined();
    expect(key.expiresAtMs).toBe(start + KEY_LIFETIME);
    expect(Object.isFrozen(key)).toBe(true);
  });

  it("computes expiry from server lifetime and local sent time even with a two-hour server skew", async () => {
    const { gateway, options } = setup();
    // Keep SIWE freshness realistic: shift the gateway clock after verify,
    // so the 2h skew affects key timestamps without invalidating sign-in.
    gateway.queue("verify", { kind: "transform", fn: reply => {
      gateway.clockOffsetMs = 2 * HOUR;
      return reply;
    } });
    const start = Date.now();
    const key = await mintOperatorSessionKey(options);
    expect(key.expiresAtMs).toBe(start + KEY_LIFETIME);
    expect(key.expiresAtMs).not.toBe(new Date(start + gateway.clockOffsetMs + KEY_LIFETIME).getTime());
  });
});

describe("T2 — pure message builder and immutable signer fields", () => {
  const fields: OperatorSignInFields = {
    domain: "gw.example:8443", address: ADDRESS, statement: STATEMENT,
    uri: "https://gw.example:8443", version: "1", chainId: 84532,
    nonce: "0123456789abcdef0123456789abcdef", issuedAt: FIRST_DATE,
  };
  it("matches the dashboard's EIP-4361 layout byte for byte and never reads time", () => {
    const expected = [
      "gw.example:8443 wants you to sign in with your Ethereum account:", ADDRESS, "", STATEMENT, "",
      "URI: https://gw.example:8443", "Version: 1", "Chain ID: 84532",
      "Nonce: 0123456789abcdef0123456789abcdef", "Issued At: 2026-10-17T12:00:00.000Z",
    ].join("\n");
    expect(buildOperatorSignInMessage(fields)).toBe(expected);
    vi.setSystemTime(new Date("2027-02-01T00:00:00.000Z"));
    expect(buildOperatorSignInMessage(fields)).toBe(expected);
  });

  it("uses .host including the port and .origin without the configured base path", async () => {
    const { signer, options } = setup();
    await mintOperatorSessionKey(options);
    expect(signer.mock.calls[0][1]).toMatchObject({ domain: "gw.example:8443", uri: "https://gw.example:8443" });
  });

  it("rejects every invalid field, unsafe line break, missing value and throwing getter", () => {
    const cases: Record<string, unknown>[] = [
      { domain: "gw.example\nother" }, { domain: "gw.example/path" }, { address: "0x123" },
      { statement: "good\nBad" }, { statement: "" }, { uri: "https://gw.example\nspoof" },
      { version: "2" }, { chainId: 0 }, { chainId: 1.5 }, { nonce: "abc" },
      { nonce: "aaaaaaaa\nInjected: x" }, { issuedAt: "not-a-date" },
    ];
    for (const change of cases) {
      expect(() => buildOperatorSignInMessage({ ...fields, ...change } as any), JSON.stringify(change)).toThrowError("bad_fields");
    }
    const withoutVersion: Record<string, unknown> = { ...fields };
    const withoutStatement: Record<string, unknown> = { ...fields };
    delete withoutVersion.version;
    delete withoutStatement.statement;
    for (const bad of [withoutVersion, withoutStatement, {
      ...fields, get nonce() { throw new Error("secret: getter value"); },
    }]) {
      expect(() => buildOperatorSignInMessage(bad as any)).toThrowError("bad_fields");
    }
  });
});

describe("T3/T4 — fail-closed option snapshot before network", () => {
  it("refuses hostile gateway URLs, but allows HTTPS and explicit HTTP loopback", async () => {
    const { gateway, options } = setup();
    const bad = ["http://gw.example", "https://u:p@gw.example", "https://gw.example?x",
      "https://gw.example#x", " https://gw.example", "https:/gw.example",
      "https:\\gw.example", "ftp://gw.example", "not a url"];
    for (const baseUrl of bad) {
      await expect(mintOperatorSessionKey({ ...options, baseUrl }), baseUrl).rejects.toMatchObject({ code: "bad_base_url" });
      expect(() => createOperatorSessionKeeper({ ...options, baseUrl })).toThrowError("bad_base_url");
    }
    expect(gateway.calls).toHaveLength(0);
    for (const baseUrl of ["https://gw.example", "https://gw.example:8443/pcc/",
      "http://127.0.0.1:3200", "http://localhost:3200", "http://[::1]:3200"]) {
      const key = await mintOperatorSessionKey({ ...options, baseUrl });
      expect(key.keyId).toMatch(/^key-/);
    }
  });

  it("classifies bad options, including throwing getters, on both APIs without requests", async () => {
    const { gateway, options } = setup();
    const cases: Array<[unknown, string]> = [
      [{ ...options, address: "wrong" }, "bad_address"],
      ...[0, -1, 1.5, NaN].map(value => [{ ...options, chainId: value }, "bad_chain_id"] as [unknown, string]),
      [{ ...options, signMessage: false }, "bad_signer"], [{ ...options, fetchImpl: "bad" }, "bad_fetch"],
      [{ ...options, now: 2 }, "bad_clock"], [{ ...options, onEvent: 42 }, "bad_config"],
      [{ ...options, renewBeforeMs: 119_999 }, "bad_timing"],
      [{ ...options, renewBeforeMs: 21_600_001 }, "bad_timing"],
      [{ ...options, timeoutMs: 0 }, "bad_timing"],
      [{ ...options, timeoutMs: 2_147_483_648 }, "bad_timing"],
      [null, "bad_config"],
      [{ ...options, get baseUrl() { throw new Error("secret: getter value"); } }, "bad_config"],
    ];
    for (const [value, expected] of cases) {
      expect(() => createOperatorSessionKeeper(value as any), expected).toThrowError(expected);
      await expect(mintOperatorSessionKey(value as any), expected).rejects.toMatchObject({ code: expected });
    }
    expect(gateway.calls).toHaveLength(0);
  });

  it("reads each supplied option only once", async () => {
    const { gateway, options } = setup();
    let reads = 0;
    const tricky = { ...options, get baseUrl() { reads++; return reads === 1 ? BASE : "http://wrong.example"; } };
    const key = await mintOperatorSessionKey(tricky);
    expect(key.keyId).toMatch(/^key-/);
    expect(reads).toBe(1);
    expect(gateway.calls.every(call => call.url.startsWith("https://gw.example:8443/"))).toBe(true);
  });
});

describe("T5 — invalid nonces never reach the signer", () => {
  it.each(["abc\ndefghijk", "short", "abcdefgh-", "", null])("rejects nonce %s", async nonce => {
    const { gateway, signer, options } = setup();
    gateway.queue("nonce", { kind: "reply", value: json({ nonce }) });
    await expect(mintOperatorSessionKey(options)).rejects.toMatchObject({ code: "malformed_response", status: 200 });
    expect(signer).not.toHaveBeenCalled();
    expect(gateway.count("verify")).toBe(0);
  });
  it("rejects a non-JSON success and overlong nonce", async () => {
    for (const value of [new Response("no", { headers: { "content-type": "text/plain" } }),
      json({ nonce: "A".repeat(129) })]) {
      const { gateway, signer, options } = setup();
      gateway.queue("nonce", { kind: "reply", value });
      await expect(mintOperatorSessionKey(options)).rejects.toMatchObject({ code: "malformed_response" });
      expect(signer).not.toHaveBeenCalled();
    }
  });
});

describe("T6 — checked response fields, bytes and content types", () => {
  it("rejects bad verify tokens and address mismatch; accepts case-insensitive address", async () => {
    for (const change of [{ token: undefined }, { token: "has space" }, { address: OTHER_ADDRESS }]) {
      const { gateway, options } = setup();
      gateway.queue("verify", { kind: "transform", fn: response => {
        // The fake's valid session remains as if the gateway had returned a malformed reply.
        void response;
        return json({ token: "token", address: ADDRESS, expiresAt: FIRST_DATE, ...change });
      } });
      await expect(mintOperatorSessionKey(options)).rejects.toMatchObject({
        code: "address" in change ? "address_mismatch" : "malformed_response", status: 200,
      });
      expect(gateway.count("session-key")).toBe(0);
    }
    const { gateway, options } = setup();
    gateway.queue("verify", { kind: "transform", fn: () => json({ token: "session-1", address: ADDRESS.toUpperCase() }) });
    expect((await mintOperatorSessionKey(options)).keyId).toBe("key-1");
  });

  it("rejects all bad session-key fields and lifetime at the 60-second margin", async () => {
    const broken: Array<[Record<string, unknown>, string]> = [
      [{ api_key: "invalid" }, "malformed_response"], [{ key_id: undefined }, "malformed_response"],
      [{ key_id: "x".repeat(201) }, "malformed_response"], [{ key_id: "a\nb" }, "malformed_response"],
      [{ expires_at: "invalid" }, "malformed_response"], [{ created_at: "invalid" }, "malformed_response"],
      [{ expires_at: new Date(Date.now() + 60_000).toISOString(),
        created_at: new Date(Date.now()).toISOString() }, "malformed_response"],
      [{ operator_id: OTHER_ADDRESS }, "address_mismatch"],
    ];
    for (const [change, expected] of broken) {
      const { gateway, options } = setup();
      gateway.queue("session-key", { kind: "transform", fn: () => {
        const original = {
          api_key: gateway.mintedKeys[0], key_id: "key-1", operator_id: ADDRESS,
          expires_at: new Date(Date.now() + KEY_LIFETIME).toISOString(), created_at: new Date(Date.now()).toISOString(),
        };
        return json({ ...original, ...change }, 201);
      } });
      await expect(mintOperatorSessionKey(options)).rejects.toMatchObject({ code: expected, status: 201 });
    }
  });

  it("rejects an oversized but otherwise valid JSON nonce, so size is the only failure", async () => {
    const { gateway, options } = setup();
    gateway.queue("nonce", { kind: "reply", value: json({
      nonce: "0123456789abcdef0123456789abcdef", padding: "x".repeat(65_536),
    }) });
    await expect(mintOperatorSessionKey(options)).rejects.toMatchObject({
      code: "malformed_response", status: 200,
    });
    expect(gateway.count("verify")).toBe(0);
  });

  it("rejects oversized bodies, wrong content type and invalid UTF-8 on any success step", async () => {
    for (const route of ["nonce", "verify", "session-key"] as const) {
      for (const response of [
        new Response("x".repeat(65_537), { status: route === "session-key" ? 201 : 200,
          headers: { "content-type": "application/json" } }),
        new Response("{}", { status: route === "session-key" ? 201 : 200,
          headers: { "content-type": "text/plain" } }),
        new Response(new Uint8Array([0xff, 0xfe]), { status: route === "session-key" ? 201 : 200,
          headers: { "content-type": "application/json" } }),
      ]) {
        const { gateway, options } = setup();
        gateway.queue(route, { kind: "reply", value: response });
        await expect(mintOperatorSessionKey(options)).rejects.toMatchObject({ code: "malformed_response" });
      }
    }
  });
});

describe("T7/T8 — the status table, deadline race and signer failures", () => {
  it.each([
    ["verify", 400, "sign_in_refused"], ["verify", 401, "sign_in_refused"],
    ["verify", 429, "rate_limited"], ["verify", 503, "unavailable"],
    ["session-key", 401, "session_refused"], ["session-key", 403, "session_refused"],
    ["session-key", 429, "rate_limited"], ["session-key", 500, "unavailable"],
    ["nonce", 404, "unexpected_status"],
  ] as const)("maps %s %s to %s with HTTP status", async (route, status, expected) => {
    const { gateway, options } = setup();
    gateway.queue(route, { kind: "reply", value: json({ error: "refusal" }, status) });
    await expect(mintOperatorSessionKey(options)).rejects.toMatchObject({ code: expected, status });
  });

  it("maps only the session-key 429 too_many_keys discriminator specially", async () => {
    const { gateway, options } = setup();
    gateway.queue("session-key", { kind: "reply", value: json({ error: "too_many_keys" }, 429) });
    await expect(mintOperatorSessionKey(options)).rejects.toMatchObject({ code: "too_many_keys", status: 429 });
  });

  it("maps rejected fetches to network and an abort-ignoring hang to timeout", async () => {
    for (const route of ["nonce", "verify", "session-key"] as const) {
      const { gateway, options } = setup();
      gateway.queue(route, { kind: "reject" });
      await expect(mintOperatorSessionKey(options)).rejects.toMatchObject({ code: "network", status: null });
    }
    for (const route of ["nonce", "verify", "session-key"] as const) {
      const { gateway, options } = setup();
      gateway.queue(route, { kind: "hang" });
      const caught = mintOperatorSessionKey({ ...options, timeoutMs: 101 }).catch(error => error);
      await tick(100);
      expect(gateway.count(route)).toBe(1);
      await tick(1);
      expect(await caught).toMatchObject({ code: "timeout", status: null });
    }
  });

  it("refuses thrown, non-string, invalid and non-hex signatures without verify", async () => {
    for (const signerResult of ["throw", 123, "0x12", `0x${"gg".repeat(65)}`]) {
      const { gateway, options } = setup();
      const signMessage = vi.fn(async () => {
        if (signerResult === "throw") throw new Error("secret: signer rejected");
        return signerResult as string;
      });
      await expect(mintOperatorSessionKey({ ...options, signMessage })).rejects.toMatchObject({
        code: "signer_failed", status: null,
      });
      expect(gateway.count("verify")).toBe(0);
    }
  });

  it("bounds an abort-ignoring signer independently of the network", async () => {
    const { gateway, options } = setup();
    const promise = mintOperatorSessionKey({ ...options, timeoutMs: 101,
      signMessage: async () => new Promise<string>(() => undefined),
    }).catch(error => error);
    await tick(101);
    expect(await promise).toMatchObject({ code: "signer_failed", status: null });
    expect(gateway.count("verify")).toBe(0);
  });
});

describe("T9 — no logs, secret-safe values and request headers", () => {
  it("keeps key secret from JSON, strings and node inspection, including errors and events", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const)
      .map(method => vi.spyOn(console, method).mockImplementation(() => undefined));
    const { gateway, options } = setup();
    const events: OperatorSessionEvent[] = [];
    const keeper = createOperatorSessionKeeper({ ...options, onEvent: event => events.push(event) });
    const key = await keeper.ready();
    expect(key).not.toBeNull();
    const secretValues = [gateway.sessionTokens[0], gateway.mintedKeys[0], SIGNATURE,
      [...gateway.issuedNonces.keys()][0] ?? "00000000000000000000000000000001"];
    const representations = [JSON.stringify(key), String(key), inspect(key), ...events.map(JSON.stringify)];
    expect(JSON.stringify(key)).not.toContain(key!.apiKey);
    expect(inspect(key)).toBe(`[OperatorSessionKey ${key!.keyId}]`);
    for (const representation of representations) {
      for (const secret of secretValues) expect(representation).not.toContain(secret);
    }
    expect(Object.isFrozen(events[0])).toBe(true);
    const failing = setup();
    failing.gateway.queue("verify", { kind: "reply", value: json({ error: `secret: ${SIGNATURE}` }, 401) });
    const error = await mintOperatorSessionKey(failing.options).catch(error => error);
    expect(error).toBeInstanceOf(OperatorSessionError);
    expect(error.message).toBe(error.code);
    expect(Object.hasOwn(error, "cause")).toBe(false);
    for (const representation of [String(error), error.message, JSON.stringify(error), inspect(error),
      ...Object.values(error).map(String)]) {
      for (const secret of [SIGNATURE, ...failing.gateway.sessionTokens, ...failing.gateway.mintedKeys]) {
        expect(representation).not.toContain(secret);
      }
      expect(representation).not.toContain("secret: ");
    }
    await keeper.stop();
    expect(gateway.routeCalls("logout")[0].headers).toEqual({
      accept: "application/json", authorization: `Bearer ${gateway.sessionTokens[0]}`,
    });
    expect(gateway.calls.every(call => !Object.values(call.headers).includes(key!.apiKey))).toBe(true);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});

describe("T10/T11 — renewal, atomic key swap and single flight", () => {
  it("renews exactly at the threshold through a newly signed session, not the old session", async () => {
    const { gateway, options } = setup();
    const keeper = createOperatorSessionKeeper(options);
    expect(keeper.key()).toBeNull();
    await flush();
    const first = keeper.key()!;
    expect(first).not.toBeNull();
    await tick(KEY_LIFETIME - 1_800_000 - 1);
    expect(gateway.count("nonce")).toBe(1);
    await tick(1);
    expect(gateway.count("nonce")).toBe(2);
    expect(gateway.count("verify")).toBe(2);
    expect(gateway.count("session-key")).toBe(2);
    expect(gateway.routeCalls("session-key")[1].headers.authorization).toBe(`Bearer ${gateway.sessionTokens[1]}`);
    expect(gateway.sessionTokens[0]).not.toBe(gateway.sessionTokens[1]);
    expect(keeper.key()?.keyId).not.toBe(first.keyId);
    await keeper.stop();
  });

  it("keeps the old frozen record until a held renewal completes, preserving the old gateway key", async () => {
    const { gateway, options } = setup();
    const keeper = createOperatorSessionKeeper(options);
    const first = await keeper.ready();
    expect(first).not.toBeNull();
    const gate = deferred();
    gateway.queue("session-key", { kind: "hold", gate: gate.promise, commitFirst: false });
    await tick(KEY_LIFETIME - 1_800_000);
    expect(keeper.key()).toBe(first);
    expect(gateway.count("nonce")).toBe(2);
    gate.resolve();
    await flush();
    const second = keeper.key();
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    expect(second?.keyId).not.toBe(first?.keyId);
    expect(second?.apiKey).not.toBe(first?.apiKey);
    expect(second?.expiresAtMs).not.toBe(first?.expiresAtMs);
    expect(gateway.isRevoked(first!.apiKey)).toBe(false);
    await keeper.stop();
  });

  it("a due timer and repeated invalidations join a held renewal instead of signing in twice", async () => {
    const { gateway, options } = setup();
    const keeper = createOperatorSessionKeeper(options);
    const first = (await keeper.ready())!;
    const gate = deferred();
    gateway.queue("session-key", { kind: "hold", gate: gate.promise, commitFirst: false });
    await tick(KEY_LIFETIME - 1_800_000);
    expect(gateway.count("nonce")).toBe(2);
    keeper.invalidate(first.keyId);
    keeper.invalidate(first.keyId);
    expect(keeper.key()).toBeNull();
    await tick(1_000);
    expect(gateway.count("nonce")).toBe(2);
    gate.resolve();
    await flush();
    expect(keeper.key()).not.toBeNull();
    expect(gateway.count("nonce")).toBe(2);
    await keeper.stop();
  });
});

describe("T12 — failure preserves key, exact margin, backoff and event steps", () => {
  it("fails closed at the margin even before the expiry timer runs; emits expiry once", async () => {
    const { gateway, options } = setup();
    const events: OperatorSessionEvent[] = [];
    const keeper = createOperatorSessionKeeper({ ...options, onEvent: value => events.push(value) });
    const first = (await keeper.ready())!;
    // Override every renewal session-key, so the old key is never replaced.
    for (let i = 0; i < 40; i++) gateway.queue("session-key", {
      kind: "reply", value: json({ error: "busy" }, 503),
    });
    const boundary = first.expiresAtMs - 60_000;
    await tick(boundary - Date.now() - 1);
    expect(keeper.key()).toBe(first);
    // A clock jump does not need a timer callback to fail closed.
    vi.setSystemTime(new Date(boundary));
    expect(keeper.key()).toBeNull();
    await tick(1);
    expect(events.filter(e => e.kind === "key_expired")).toHaveLength(1);
    await tick(6 * 60_000);
    expect(events.filter(e => e.kind === "key_expired")).toHaveLength(1);
    expect(gateway.count("session-key")).toBeGreaterThan(2);
    await keeper.stop();
  });

  it("retries at 5, 10, 20 seconds up to 300 seconds, and recovers after expiry", async () => {
    const { gateway, options } = setup();
    const events: OperatorSessionEvent[] = [];
    const keeper = createOperatorSessionKeeper({ ...options, onEvent: value => events.push(value) });
    await keeper.ready();
    for (let i = 0; i < 20; i++) gateway.queue("session-key", {
      kind: "reply", value: json({ error: "unavailable" }, 503),
    });
    await tick(KEY_LIFETIME - 1_800_000);
    expect(events.filter(e => e.kind === "mint_failed")).toHaveLength(1);
    const firstRetryAt = Date.now();
    await tick(5_000); await tick(10_000); await tick(20_000);
    const failures = events.filter((e): e is Extract<OperatorSessionEvent, {kind:"mint_failed"}> => e.kind === "mint_failed");
    expect(failures.slice(0, 4).map(e => e.retryInMs)).toEqual([5_000, 10_000, 20_000, 40_000]);
    expect(gateway.routeCalls("session-key").slice(1, 5).map(c => c.at - firstRetryAt)).toEqual([0, 5_000, 15_000, 35_000]);
    await tick(18 * 60_000);
    expect(failures[0].step).toBe("session_key");
    expect(events.filter(e => e.kind === "mint_failed")
      .every(e => e.kind !== "mint_failed" || e.retryInMs <= 300_000)).toBe(true);
    await tick(15 * 60_000); // The initial key is past its expiry margin now.
    expect(keeper.key()).toBeNull();
    // Drain scripted refusals and recover after expiry.
    gateway.scripts.set("session-key", []);
    await tick(300_000);
    expect(keeper.key()).not.toBeNull();
    await keeper.stop();
  });

  it("classifies an invalid runtime clock as bad_clock at the sign step and sends no verify", async () => {
    const { gateway, options } = setup();
    const events: OperatorSessionEvent[] = [];
    const keeper = createOperatorSessionKeeper({ ...options, now: () => Number.NaN,
      onEvent: value => events.push(value),
    });
    await flush();
    expect(events[0]).toMatchObject({ kind: "mint_failed", code: "bad_clock", step: "sign" });
    expect(gateway.count("nonce")).toBe(1);
    expect(gateway.count("verify")).toBe(0);
    expect(keeper.key()).toBeNull();
    await keeper.stop();
  });

  it("identifies nonce, sign, verify and session_key failures in keeper events", async () => {
    for (const target of ["nonce", "sign", "verify", "session_key"] as const) {
      const { gateway, options } = setup();
      const events: OperatorSessionEvent[] = [];
      if (target !== "sign") gateway.queue(target === "session_key" ? "session-key" : target, {
        kind: "reply", value: json({ error: "no" }, 503),
      });
      const keeper = createOperatorSessionKeeper({ ...options,
        signMessage: target === "sign" ? async () => { throw new Error("secret"); } : options.signMessage,
        onEvent: e => events.push(e),
      });
      await flush();
      expect(events[0]).toMatchObject({ kind: "mint_failed", step: target,
        code: target === "sign" ? "signer_failed" : "unavailable" });
      await keeper.stop();
    }
  });
});

describe("T13 — pending session reuse and drop rules", () => {
  it("retries step 3 with the same session after a committed-but-lost reply, revoking the lost key", async () => {
    const { gateway, options } = setup();
    const events: OperatorSessionEvent[] = [];
    gateway.queue("session-key", { kind: "reject" });
    // Reconfigure to commit before rejecting using an explicit one-shot interceptor.
    gateway.scripts.set("session-key", [{ kind: "transform", fn: () => { throw new Error("reply lost"); } }]);
    const keeper = createOperatorSessionKeeper({ ...options, onEvent: e => events.push(e) });
    await flush();
    expect(events[0]).toMatchObject({ kind: "mint_failed", step: "session_key", code: "network" });
    const lostKey = gateway.mintedKeys[0];
    expect(lostKey).toBeDefined();
    await tick(5_000);
    expect(gateway.count("nonce")).toBe(1);
    expect(gateway.count("verify")).toBe(1);
    expect(gateway.count("session-key")).toBe(2);
    expect(gateway.routeCalls("session-key")[0].headers.authorization)
      .toBe(gateway.routeCalls("session-key")[1].headers.authorization);
    expect(gateway.isRevoked(lostKey)).toBe(true);
    expect(keeper.key()).not.toBeNull();
    await keeper.stop();
  });

  it("on session_refused drops pending and signs in afresh after the next backoff", async () => {
    const { gateway, options } = setup();
    gateway.queue("session-key", { kind: "reply", value: json({ error: "server" }, 503) });
    gateway.queue("session-key", { kind: "reply", value: json({ error: "session_required" }, 401) });
    const keeper = createOperatorSessionKeeper(options);
    await flush();
    expect(gateway.count("nonce")).toBe(1);
    await tick(5_000);
    expect(gateway.count("nonce")).toBe(1);
    await tick(10_000);
    expect(gateway.count("nonce")).toBe(2);
    expect(gateway.count("verify")).toBe(2);
    expect(keeper.key()).not.toBeNull();
    await keeper.stop();
  });

  it("does not reuse a pending session older than ten minutes", async () => {
    const { gateway, options } = setup();
    gateway.queue("session-key", { kind: "reply", value: json({ error: "server" }, 503) });
    const keeper = createOperatorSessionKeeper(options);
    await flush();
    vi.setSystemTime(new Date(Date.now() + 11 * 60_000));
    await tick(5_000);
    expect(gateway.count("nonce")).toBe(2);
    expect(gateway.count("verify")).toBe(2);
    await keeper.stop();
  });
});

describe("T14 — invalidation, stop, best-effort logout and late completions", () => {
  it("logs out current and pending sessions with the session bearer; stop resolves on 503", async () => {
    const { gateway, options } = setup();
    const events: OperatorSessionEvent[] = [];
    const keeper = createOperatorSessionKeeper({ ...options, onEvent: e => events.push(e) });
    const first = (await keeper.ready())!;
    gateway.queue("session-key", { kind: "reply", value: json({ error: "busy" }, 503) });
    await tick(KEY_LIFETIME - 1_800_000);
    expect(gateway.sessionTokens).toHaveLength(2);
    gateway.queue("logout", { kind: "reply", value: json({ error: "offline" }, 503) });
    await expect(keeper.stop()).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0); // even a stopped timer must not linger
    expect(keeper.key()).toBeNull();
    expect(await keeper.ready()).toBeNull();
    expect(gateway.routeCalls("logout")).toHaveLength(2);
    expect(gateway.routeCalls("logout").map(c => c.headers.authorization).sort()).toEqual(
      gateway.sessionTokens.map(token => `Bearer ${token}`).sort(),
    );
    for (const call of gateway.routeCalls("logout")) {
      expect(call.method).toBe("POST");
      expect(call.headers).toEqual({ accept: "application/json", authorization: expect.stringMatching(/^Bearer session-/) });
      expect(call.body).toBeUndefined();
      expect(call.redirect).toBe("error");
    }
    expect(events.filter(e => e.kind === "stopped")).toHaveLength(1);
    const sent = gateway.calls.length;
    await tick(24 * HOUR);
    expect(gateway.calls).toHaveLength(sent);
    expect(first.keyId).toBe("key-1");
  });

  it("never exposes a key that minted while stop awaited its delayed reply", async () => {
    const { gateway, options } = setup();
    const gate = deferred();
    gateway.queue("session-key", { kind: "hold", gate: gate.promise, commitFirst: true });
    const keeper = createOperatorSessionKeeper(options);
    await flush();
    expect(gateway.mintedKeys).toHaveLength(1);
    expect(keeper.key()).toBeNull();
    const stopping = keeper.stop();
    expect(keeper.key()).toBeNull();
    gate.resolve();
    await expect(stopping).resolves.toBeUndefined();
    expect(keeper.key()).toBeNull();
    expect(gateway.isRevoked(gateway.mintedKeys[0])).toBe(true);
    expect(gateway.routeCalls("logout").every(c => !Object.values(c.headers).includes(gateway.mintedKeys[0]))).toBe(true);
  });

  it("invalidates only the current id, no sooner than one minute after success", async () => {
    const { gateway, options } = setup();
    const keeper = createOperatorSessionKeeper(options);
    const first = (await keeper.ready())!;
    const mintAt = Date.now();
    keeper.invalidate(first.keyId);
    expect(keeper.key()).toBeNull();
    await flush();
    expect(gateway.routeCalls("logout")).toHaveLength(1);
    expect(gateway.isRevoked(first.apiKey)).toBe(true);
    await tick(59_999);
    expect(gateway.count("nonce")).toBe(1);
    await tick(1);
    expect(gateway.count("nonce")).toBe(2);
    expect(Date.now() - mintAt).toBe(60_000);
    const second = keeper.key()!;
    expect(second.keyId).not.toBe(first.keyId);
    const calls = gateway.calls.length;
    keeper.invalidate(first.keyId);
    keeper.invalidate("other");
    keeper.invalidate(12 as any);
    expect(keeper.key()).toBe(second);
    expect(gateway.calls).toHaveLength(calls);
    await keeper.stop();
    keeper.invalidate(second.keyId);
    expect(gateway.count("nonce")).toBe(2);
  });

  it("logout failure, including a rejection, does not reject stop", async () => {
    const { gateway, options } = setup();
    const keeper = createOperatorSessionKeeper(options);
    await keeper.ready();
    gateway.queue("logout", { kind: "reject" });
    await expect(keeper.stop()).resolves.toBeUndefined();
    await expect(keeper.stop()).resolves.toBeUndefined();
  });
});

describe("T16 — ready() waits for a usable key or stop, never a failure", () => {
  it("initial ready resolves with the same record as key(), and an already ready keeper resolves immediately", async () => {
    const { options } = setup();
    const keeper = createOperatorSessionKeeper(options);
    const pending = keeper.ready();
    expect(keeper.key()).toBeNull();
    const resolved = await pending;
    expect(resolved).toBe(keeper.key());
    await expect(keeper.ready()).resolves.toBe(resolved);
    await keeper.stop();
  });

  it("ready remains pending across failed mints and resolves on recovery, including after expiry", async () => {
    const { gateway, options } = setup();
    for (let i = 0; i < 3; i++) gateway.queue("nonce", { kind: "reply", value: json({ error: "offline" }, 503) });
    const keeper = createOperatorSessionKeeper(options);
    let settled = false;
    const pending = keeper.ready().then(result => { settled = true; return result; });
    await tick(5_000 + 10_000 + 20_000);
    expect(settled).toBe(true); // first success follows the third backoff
    const first = await pending;
    expect(first).toBe(keeper.key());
    const stop = await keeper.stop();
    expect(stop).toBeUndefined();
  });

  it("waits after the old key's margin and never resolves with the expired record", async () => {
    const { gateway, options } = setup();
    const keeper = createOperatorSessionKeeper(options);
    const oldKey = (await keeper.ready())!;
    for (let i = 0; i < 30; i++) gateway.queue("session-key", {
      kind: "reply", value: json({ error: "busy" }, 503),
    });
    await tick(oldKey.expiresAtMs - 60_000 - Date.now());
    expect(keeper.key()).toBeNull();
    let settled = false;
    const awaiting = keeper.ready().then(value => { settled = true; return value; });
    await tick(20_000);
    expect(settled).toBe(false);
    gateway.scripts.set("session-key", []);
    await tick(300_000);
    const fresh = await awaiting;
    expect(fresh).not.toBeNull();
    expect(fresh).toBe(keeper.key());
    expect(fresh).not.toBe(oldKey);
    await keeper.stop();
  });

  it("does not resolve ready on repeated signer or network errors, only on stop", async () => {
    for (const kind of ["signer", "fetch"] as const) {
      const { gateway, options } = setup();
      if (kind === "fetch") for (let i = 0; i < 10; i++) gateway.queue("nonce", { kind: "reject" });
      const keeper = createOperatorSessionKeeper({ ...options,
        ...(kind === "signer" ? { signMessage: async () => { throw new Error("secret"); } } : {}),
      });
      let settled = false;
      const pending = keeper.ready().then(value => { settled = true; return value; });
      await tick(20_000);
      expect(settled).toBe(false);
      await keeper.stop();
      expect(await pending).toBeNull();
      expect(await keeper.ready()).toBeNull();
    }
  });
});
