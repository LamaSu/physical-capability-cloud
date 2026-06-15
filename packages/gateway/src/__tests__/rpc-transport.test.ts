/**
 * Tests for buildRpcTransport (P2-SCALE RPC failover + retry/timeout).
 *
 * Asserts the transport SHAPE without touching the network: a single URL yields
 * an `http` transport carrying the retry/timeout options; multiple URLs yield a
 * `fallback` over per-URL http transports (the failover wiring).
 */
import { describe, it, expect, afterEach } from "vitest";
import { buildRpcTransport } from "../contracts/rpc-transport.js";

// Instantiate a viem transport to read its resolved config (viem transports are
// factories: calling with {} returns { config, request, value }).
function instantiate(transport: ReturnType<typeof buildRpcTransport>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (transport as any)({});
}

describe("buildRpcTransport", () => {
  const ORIG = { ...process.env };
  afterEach(() => {
    for (const k of ["PCC_RPC_TIMEOUT_MS", "PCC_RPC_RETRY_COUNT", "PCC_RPC_RETRY_DELAY_MS"]) {
      if (ORIG[k] === undefined) delete process.env[k];
      else process.env[k] = ORIG[k];
    }
  });

  it("single URL → http transport with the supplied retry + timeout options", () => {
    const t = buildRpcTransport(["https://primary.example"], {
      timeoutMs: 1234,
      retryCount: 7,
      retryDelayMs: 50,
    });
    const inst = instantiate(t);
    expect(inst.config.type).toBe("http");
    expect(inst.config.retryCount).toBe(7);
    expect(inst.config.timeout).toBe(1234);
  });

  it("multiple URLs → fallback transport wrapping each URL", () => {
    const t = buildRpcTransport([
      "https://a.example",
      "https://b.example",
      "https://c.example",
    ]);
    const inst = instantiate(t);
    expect(inst.config.type).toBe("fallback");
    // The fallback exposes its wrapped transports; one per URL = the failover set.
    expect(inst.value?.transports).toHaveLength(3);
  });

  it("empty / whitespace-only list falls back to a single default http transport", () => {
    const t = buildRpcTransport(["", "  "]);
    const inst = instantiate(t);
    expect(inst.config.type).toBe("http");
  });

  it("honors env defaults (PCC_RPC_TIMEOUT_MS / PCC_RPC_RETRY_COUNT) when opts omitted", () => {
    process.env.PCC_RPC_TIMEOUT_MS = "2222";
    process.env.PCC_RPC_RETRY_COUNT = "4";
    const inst = instantiate(buildRpcTransport(["https://primary.example"]));
    expect(inst.config.timeout).toBe(2222);
    expect(inst.config.retryCount).toBe(4);
  });

  it("filters falsy URLs out of a multi-URL list before building", () => {
    const t = buildRpcTransport(["https://a.example", "", "https://b.example"]);
    const inst = instantiate(t);
    expect(inst.config.type).toBe("fallback");
    expect(inst.value?.transports).toHaveLength(2);
  });
});
