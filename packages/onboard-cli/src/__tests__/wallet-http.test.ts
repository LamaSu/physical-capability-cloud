import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { walletRequest } from "../wallet/http.js";

afterEach(() => { vi.restoreAllMocks(); });

describe("wallet HTTP transport", () => {
  it("refuses public HTTP before fetch even for a direct client call", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    await expect(walletRequest("http://pcc.example", "/x", "GET")).rejects.toThrow("insecure_gateway_origin");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it.each(["http://127.0.0.1:3200", "http://127.9.8.7", "http://[::1]:3200", "http://localhost:3200", "https://pcc.example"])("accepts secure or loopback origin %s", async (origin) => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    await expect(walletRequest(origin, "/x", "GET")).resolves.toEqual({});
    expect(fetchSpy).toHaveBeenCalledOnce();
  });
});

describe("wallet security transport pins", () => {
  it("refuses invalid UTF-8 inside a JSON string", async () => {
    const bytes = new Uint8Array([...new TextEncoder().encode('{"status":"'), 0xff, ...new TextEncoder().encode('"}')]);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(bytes, { status: 200 }));
    await expect(walletRequest("http://127.0.0.1:9", "/x", "GET")).rejects.toThrow("invalid_gateway_response");
  });
  it.each(["seed_phrase_required", "private_key_missing", "privatekey_required", "secret_expired", "mnemonic_invalid"])("refuses secret-named gateway error %s and retains its HTTP status", async error => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ error }), { status: 400 }));
    await expect(walletRequest("http://127.0.0.1:9", "/x", "GET")).rejects.toMatchObject({
      code: "invalid_gateway_response", httpStatus: 400,
    });
  });
  it("pins H1: every request refuses redirect following", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    await walletRequest("http://127.0.0.1:9", "/revoke", "POST", {}, "owner-api-token");
    expect(fetchSpy.mock.calls[0]?.[1]?.redirect).toBe("error");
  });
  it("bounds a stalled response body with an injectable timeout", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      return new Response(new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener("abort", () => controller.error(new DOMException("timeout", "TimeoutError")), { once: true });
        },
      }));
    });
    const result = await Promise.race([
      walletRequest("http://127.0.0.1:9", "/stalled", "GET", undefined, undefined, 20).then(() => "accepted", (error: unknown) => String(error)),
      new Promise<string>((resolve) => setTimeout(() => resolve("timeout_not_enforced"), 100)),
    ]);
    expect(result).toBe("WalletError: gateway_unavailable");
  });
});

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("stub_address_unavailable");
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("wallet native HTTP security", () => {
  it("pins H1: refuses a307 that would resend the approving bearer", async () => {
    const targetHits: string[] = [];
    const server = createServer((req, res) => {
      if (req.url === "/target") {
        targetHits.push(String(req.headers.authorization));
        res.end('{"status":"revoked"}');
      } else {
        res.writeHead(307, { location: "/target" });
        res.end();
      }
    });
    try {
      const origin = await listen(server);
      await expect(walletRequest(origin, "/revoke", "POST", {}, "owner-api-token")).rejects.toThrow("gateway_unavailable");
      expect(targetHits).toEqual([]);
    } finally { await close(server); }
  });
  it("bounds a native stalled response body", async () => {
    const server = createServer((_req, res) => { res.writeHead(200); res.write('{"status":'); });
    try {
      const origin = await listen(server);
      await expect(walletRequest(origin, "/stall", "GET", undefined, undefined, 25)).rejects.toThrow("gateway_unavailable");
    } finally { await close(server); }
  });
});

describe("gateway response size cap", () => {
  const limit = 64 * 1024;
  function payload(bytes: number): string { return JSON.stringify({ padding: "a".repeat(bytes - JSON.stringify({ padding: "" }).length) }); }
  it("accepts a JSON response at exactly64KiB", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(payload(limit)));
    await expect(walletRequest("http://127.0.0.1:9", "/x", "GET")).resolves.toHaveProperty("padding");
  });
  it.each([200, 400, 404, 503])("refuses a gateway response over64KiB (HTTP%i)", async (status) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(payload(limit + 1), { status }));
    await expect(walletRequest("http://127.0.0.1:9", "/x", "GET")).rejects.toThrow("gateway_response_too_large");
  });
  it("counts fragmented UTF8 bytes and cancels the oversized body", async () => {
    let cancelled = false;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(new ReadableStream({
      start(controller) {
        const chunk = new TextEncoder().encode("é".repeat(1024));
        for (let index = 0; index < 33; index++) controller.enqueue(chunk);
      },
      cancel() { cancelled = true; },
    })));
    await expect(walletRequest("http://127.0.0.1:9", "/x", "GET")).rejects.toThrow("gateway_response_too_large");
    expect(cancelled).toBe(true);
  });
  it("caps funding404 bodies before declaring the route unavailable", async () => {
    const { requestFunding } = await import("../wallet/http.js");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(payload(limit + 1), { status: 404 }));
    await expect(requestFunding("http://127.0.0.1:9", "lr_test")).rejects.toThrow("gateway_response_too_large");
  });
});
