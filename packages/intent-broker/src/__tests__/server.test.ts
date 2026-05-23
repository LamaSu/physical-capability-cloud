/**
 * Tests for @pcc/intent-broker — Phase 2.1 register_intent tool surface.
 *
 * Strategy mirrors @pcc/mcp-server/__tests__/capture-tools.test.ts: we do
 * NOT import the CLI module (it spawns a stdio transport). We test the
 * pure exports (forwardEnvelope, createIntentBrokerServer, the input
 * schema) and the underlying DemandEnvelopeSchema contract.
 */

import { describe, it, expect, vi } from "vitest";
import {
  forwardEnvelope,
  loadConfig,
  createIntentBrokerServer,
  RegisterIntentInputShape,
  type BrokerConfig,
} from "../server.js";
import { DemandEnvelopeSchema, computeCompositionSignature } from "@pcc/spec";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_ENVELOPE = {
  id: "intent-broker-test-001",
  source: "mcp_broker" as const,
  compositionSignature: computeCompositionSignature(["3d-printing"], []),
  capabilityTypes: ["3d-printing"],
  summary: "Print a small ABS bracket",
  budgetBand: "100_1k" as const,
  urgencyBand: "standard" as const,
  createdAt: new Date().toISOString(),
};

function makeConfig(overrides: Partial<BrokerConfig> = {}): BrokerConfig {
  return {
    ingestUrl: "https://capability.network/api/intents/ingest",
    apiKey: "pcc_live_test_xxx",
    logLevel: "silent",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Suite: loadConfig
// ---------------------------------------------------------------------------

describe("loadConfig", () => {
  it("uses defaults when no env vars are set", () => {
    const cfg = loadConfig({} as NodeJS.ProcessEnv);
    expect(cfg.ingestUrl).toBe("https://capability.network/api/intents/ingest");
    expect(cfg.apiKey).toBeUndefined();
    expect(cfg.logLevel).toBe("warn");
  });

  it("strips trailing slash from ingestUrl", () => {
    const cfg = loadConfig({
      PCC_INTENT_INGEST_URL: "https://example.com/api/intents/ingest/",
    } as NodeJS.ProcessEnv);
    expect(cfg.ingestUrl).toBe("https://example.com/api/intents/ingest");
  });

  it("picks up PCC_API_KEY and INTENT_BROKER_LOG_LEVEL", () => {
    const cfg = loadConfig({
      PCC_API_KEY: "pcc_live_abc",
      INTENT_BROKER_LOG_LEVEL: "info",
    } as NodeJS.ProcessEnv);
    expect(cfg.apiKey).toBe("pcc_live_abc");
    expect(cfg.logLevel).toBe("info");
  });
});

// ---------------------------------------------------------------------------
// Suite: DemandEnvelopeSchema contract
// ---------------------------------------------------------------------------

describe("RegisterIntent input contract (DemandEnvelopeSchema)", () => {
  it("accepts the minimal valid envelope", () => {
    const parsed = DemandEnvelopeSchema.safeParse(VALID_ENVELOPE);
    expect(parsed.success).toBe(true);
  });

  it("rejects an envelope with a malformed compositionSignature", () => {
    const bad = { ...VALID_ENVELOPE, compositionSignature: "0xnothex" };
    const parsed = DemandEnvelopeSchema.safeParse(bad);
    expect(parsed.success).toBe(false);
  });

  it("rejects an envelope with an unknown source enum value", () => {
    const bad = { ...VALID_ENVELOPE, source: "not_a_source" as never };
    const parsed = DemandEnvelopeSchema.safeParse(bad);
    expect(parsed.success).toBe(false);
  });

  it("rejects a summary over 200 chars", () => {
    const bad = { ...VALID_ENVELOPE, summary: "x".repeat(201) };
    const parsed = DemandEnvelopeSchema.safeParse(bad);
    expect(parsed.success).toBe(false);
  });

  it("exposes the envelope key in RegisterIntentInputShape", () => {
    // Sanity — the MCP tool registers exactly this single input shape.
    expect(Object.keys(RegisterIntentInputShape)).toEqual(["envelope"]);
  });
});

// ---------------------------------------------------------------------------
// Suite: forwardEnvelope — happy path + error paths
// ---------------------------------------------------------------------------

describe("forwardEnvelope", () => {
  it("returns no_api_key when PCC_API_KEY is unset", async () => {
    const cfg = makeConfig({ apiKey: undefined });
    const result = await forwardEnvelope(VALID_ENVELOPE, cfg, vi.fn());
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe("no_api_key");
  });

  it("POSTs to the configured ingest URL with Bearer auth and JSON body", async () => {
    const cfg = makeConfig();
    const recorder = vi.fn(
      async (url: RequestInfo | URL, init?: RequestInit) =>
        new Response(
          JSON.stringify({
            accepted: true,
            envelopeId: "intent-server-001",
            dedupeKey: "op-x:0xabc",
          }),
          { status: 202, headers: { "content-type": "application/json" } },
        ),
    );

    const result = await forwardEnvelope(
      VALID_ENVELOPE,
      cfg,
      recorder as unknown as typeof fetch,
    );

    expect(recorder).toHaveBeenCalledTimes(1);
    const [url, init] = recorder.mock.calls[0];
    expect(String(url)).toBe(cfg.ingestUrl);
    expect((init as RequestInit).method).toBe("POST");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["authorization"]).toBe(`Bearer ${cfg.apiKey}`);
    expect(headers["content-type"]).toBe("application/json");
    const sentBody = JSON.parse((init as RequestInit).body as string);
    expect(sentBody.id).toBe(VALID_ENVELOPE.id);

    expect(result.accepted).toBe(true);
    expect(result.status).toBe(202);
    expect(result.envelopeId).toBe("intent-server-001");
    expect(result.dedupeKey).toBe("op-x:0xabc");
  });

  it("returns upstream_error when the gateway responds non-2xx", async () => {
    const cfg = makeConfig();
    const failingFetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "invalid_envelope" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
    );
    const result = await forwardEnvelope(
      VALID_ENVELOPE,
      cfg,
      failingFetch as unknown as typeof fetch,
    );
    expect(result.accepted).toBe(false);
    expect(result.status).toBe(400);
    expect(result.reason).toBe("upstream_error");
    expect(result.error).toContain("invalid_envelope");
  });

  it("returns transport_error when fetch throws", async () => {
    const cfg = makeConfig();
    const throwingFetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED 127.0.0.1:80");
    });
    const result = await forwardEnvelope(
      VALID_ENVELOPE,
      cfg,
      throwingFetch as unknown as typeof fetch,
    );
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe("transport_error");
    expect(result.error).toContain("ECONNREFUSED");
  });
});

// ---------------------------------------------------------------------------
// Suite: createIntentBrokerServer — surface check
// ---------------------------------------------------------------------------

describe("createIntentBrokerServer", () => {
  it("constructs an McpServer without throwing", () => {
    const server = createIntentBrokerServer({ config: makeConfig() });
    expect(server).toBeDefined();
    // The MCP SDK doesn't expose a public listTools() on the server instance,
    // but ensuring construction succeeds is the meaningful smoke test for the
    // tool-registration code path. Wire-level coverage is owned by the MCP
    // SDK's own tests.
  });
});
