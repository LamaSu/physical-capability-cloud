/**
 * Tests for the OTel semantic-convention → DemandEnvelope mapper.
 *
 * The mapper is a pure function over a MinimalSpan struct, so these tests do
 * NOT boot the OTel SDK. They cover the four precedence rules
 * (pcc.* > gen_ai.* > mcp.* > span.name) plus the validate-or-reject
 * downstream contract (DemandEnvelopeSchema).
 */

import { describe, expect, it } from "vitest";
import { DemandEnvelopeSchema } from "@pcc/spec";
import {
  isIntentShapedSpan,
  spanToDemandEnvelope,
  type MinimalSpan,
} from "../attribute-mapper.js";

// ── helpers ───────────────────────────────────────────────────────────────

function span(partial: Partial<MinimalSpan> = {}): MinimalSpan {
  return {
    name: partial.name ?? "test.span",
    attributes: partial.attributes ?? {},
    resource: partial.resource,
    startTimeISO: partial.startTimeISO ?? "2026-05-23T10:00:00.000Z",
    kindName: partial.kindName,
  };
}

// ── isIntentShapedSpan ────────────────────────────────────────────────────

describe("isIntentShapedSpan", () => {
  it("recognizes tool.* span names", () => {
    expect(isIntentShapedSpan(span({ name: "tool.execute" }))).toBe(true);
    expect(isIntentShapedSpan(span({ name: "Tool.Call" }))).toBe(true);
  });

  it("recognizes mcp.* span names", () => {
    expect(isIntentShapedSpan(span({ name: "mcp.tool.invocation" }))).toBe(true);
  });

  it("recognizes agent.* span names", () => {
    expect(isIntentShapedSpan(span({ name: "agent.run" }))).toBe(true);
  });

  it("recognizes gen_ai.* span names", () => {
    expect(isIntentShapedSpan(span({ name: "gen_ai.chat" }))).toBe(true);
  });

  it("recognizes http.request when no gen_ai attrs are present", () => {
    expect(isIntentShapedSpan(span({ name: "http.request" }))).toBe(true);
  });

  it("recognizes spans by attribute key presence (gen_ai.tool.name)", () => {
    expect(
      isIntentShapedSpan(
        span({ name: "unrelated.span", attributes: { "gen_ai.tool.name": "browser_search" } }),
      ),
    ).toBe(true);
  });

  it("recognizes spans by attribute key presence (pcc.capability_types)", () => {
    expect(
      isIntentShapedSpan(
        span({ name: "unrelated.span", attributes: { "pcc.capability_types": ["3d-printing"] } }),
      ),
    ).toBe(true);
  });

  it("rejects spans with no recognized prefix and no recognized attribute", () => {
    expect(
      isIntentShapedSpan(
        span({ name: "db.query", attributes: { "db.statement": "SELECT 1" } }),
      ),
    ).toBe(false);
  });
});

// ── spanToDemandEnvelope ──────────────────────────────────────────────────

describe("spanToDemandEnvelope — minimal valid output", () => {
  it("produces an envelope that passes DemandEnvelopeSchema validation", () => {
    const env = spanToDemandEnvelope(
      span({
        name: "tool.search",
        attributes: {
          "gen_ai.tool.name": "browser_search",
          "gen_ai.system": "anthropic",
        },
      }),
    );
    const parsed = DemandEnvelopeSchema.safeParse(env);
    expect(parsed.success).toBe(true);
  });

  it("source defaults to 'otel'", () => {
    const env = spanToDemandEnvelope(span({ name: "tool.x" }));
    expect(env.source).toBe("otel");
  });

  it("source can be overridden via opts.source", () => {
    const env = spanToDemandEnvelope(span({ name: "tool.x" }), { source: "sdk" });
    expect(env.source).toBe("sdk");
  });
});

describe("spanToDemandEnvelope — capabilityTypes precedence", () => {
  it("prefers pcc.capability_types when present (array form)", () => {
    const env = spanToDemandEnvelope(
      span({
        name: "tool.invoke",
        attributes: {
          "pcc.capability_types": ["fdm-3d-printing", "post-process-acetone"],
          "gen_ai.tool.name": "should_be_ignored",
        },
      }),
    );
    expect(env.capabilityTypes).toEqual(["fdm-3d-printing", "post-process-acetone"]);
  });

  it("falls back to gen_ai.tool.name when pcc.capability_types is absent", () => {
    const env = spanToDemandEnvelope(
      span({
        name: "tool.invoke",
        attributes: { "gen_ai.tool.name": "browser_search" },
      }),
    );
    expect(env.capabilityTypes).toEqual(["browser_search"]);
  });

  it("falls back to mcp.tool.name when gen_ai.tool.name is also absent", () => {
    const env = spanToDemandEnvelope(
      span({
        name: "mcp.tool.call",
        attributes: { "mcp.tool.name": "filesystem_read" },
      }),
    );
    expect(env.capabilityTypes).toEqual(["filesystem_read"]);
  });

  it("accepts comma-separated pcc.capability_types as string fallback", () => {
    const env = spanToDemandEnvelope(
      span({
        name: "tool.x",
        attributes: { "pcc.capability_types": "a, b, c" },
      }),
    );
    expect(env.capabilityTypes).toEqual(["a", "b", "c"]);
  });

  it("falls back to span.name as last resort", () => {
    const env = spanToDemandEnvelope(span({ name: "tool.unspecified", attributes: {} }));
    expect(env.capabilityTypes).toEqual(["tool.unspecified"]);
  });
});

describe("spanToDemandEnvelope — summary precedence", () => {
  it("prefers pcc.summary when present (truncated to 200 chars)", () => {
    const long = "x".repeat(250);
    const env = spanToDemandEnvelope(
      span({ name: "tool.x", attributes: { "pcc.summary": long } }),
    );
    expect(env.summary.length).toBe(200);
    expect(env.summary).toBe("x".repeat(200));
  });

  it("synthesizes from gen_ai.operation.name + gen_ai.tool.name when no pcc.summary", () => {
    const env = spanToDemandEnvelope(
      span({
        name: "tool.x",
        attributes: {
          "gen_ai.operation.name": "tool_use",
          "gen_ai.tool.name": "browser_search",
        },
      }),
    );
    expect(env.summary).toBe("tool_use browser_search");
  });

  it("synthesizes from http.method + url.full as HTTP fallback", () => {
    const env = spanToDemandEnvelope(
      span({
        name: "http.request",
        attributes: {
          "http.method": "POST",
          "url.full": "https://api.example.com/v1/orders",
        },
      }),
    );
    expect(env.summary).toBe("POST https://api.example.com/v1/orders");
  });

  it("falls back to span name when nothing else is present", () => {
    const env = spanToDemandEnvelope(span({ name: "agent.run" }));
    expect(env.summary).toBe("agent.run");
  });
});

describe("spanToDemandEnvelope — band normalization", () => {
  it("defaults budgetBand to under_100 and urgencyBand to standard", () => {
    const env = spanToDemandEnvelope(span({ name: "tool.x" }));
    expect(env.budgetBand).toBe("under_100");
    expect(env.urgencyBand).toBe("standard");
  });

  it("accepts valid pcc.budget_band values", () => {
    const env = spanToDemandEnvelope(
      span({ name: "tool.x", attributes: { "pcc.budget_band": "10k_100k" } }),
    );
    expect(env.budgetBand).toBe("10k_100k");
  });

  it("falls back to default for invalid budget_band values", () => {
    const env = spanToDemandEnvelope(
      span({ name: "tool.x", attributes: { "pcc.budget_band": "1_billion" } }),
    );
    expect(env.budgetBand).toBe("under_100");
  });

  it("accepts valid pcc.urgency_band values", () => {
    const env = spanToDemandEnvelope(
      span({ name: "tool.x", attributes: { "pcc.urgency_band": "emergency" } }),
    );
    expect(env.urgencyBand).toBe("emergency");
  });

  it("accepts assuranceTier as number 0-3", () => {
    const env = spanToDemandEnvelope(
      span({ name: "tool.x", attributes: { "pcc.assurance_tier": 2 } }),
    );
    expect(env.assuranceTier).toBe(2);
  });

  it("accepts assuranceTier as numeric string 0-3", () => {
    const env = spanToDemandEnvelope(
      span({ name: "tool.x", attributes: { "pcc.assurance_tier": "3" } }),
    );
    expect(env.assuranceTier).toBe(3);
  });

  it("drops assuranceTier when out of range", () => {
    const env = spanToDemandEnvelope(
      span({ name: "tool.x", attributes: { "pcc.assurance_tier": 7 } }),
    );
    expect(env.assuranceTier).toBeUndefined();
  });
});

describe("spanToDemandEnvelope — vendor extraction", () => {
  it("prefers pcc.origin_agent_vendor when present", () => {
    const env = spanToDemandEnvelope(
      span({
        name: "tool.x",
        attributes: {
          "pcc.origin_agent_vendor": "lamasu",
          "gen_ai.system": "anthropic",
        },
      }),
    );
    expect(env.originAgentVendor).toBe("lamasu");
  });

  it("falls back to gen_ai.system", () => {
    const env = spanToDemandEnvelope(
      span({ name: "tool.x", attributes: { "gen_ai.system": "openai" } }),
    );
    expect(env.originAgentVendor).toBe("openai");
  });

  it("falls back to service.name from resource attributes", () => {
    const env = spanToDemandEnvelope(
      span({
        name: "tool.x",
        attributes: {},
        resource: { attributes: { "service.name": "langchain-server" } },
      }),
    );
    expect(env.originAgentVendor).toBe("langchain-server");
  });

  it("leaves vendor undefined when no signal is present", () => {
    const env = spanToDemandEnvelope(span({ name: "tool.x" }));
    expect(env.originAgentVendor).toBeUndefined();
  });
});

describe("spanToDemandEnvelope — composition signature", () => {
  it("is deterministic for the same capabilityTypes regardless of input order", () => {
    const env1 = spanToDemandEnvelope(
      span({
        name: "tool.x",
        attributes: { "pcc.capability_types": ["a", "b", "c"] },
      }),
    );
    const env2 = spanToDemandEnvelope(
      span({
        name: "tool.x",
        attributes: { "pcc.capability_types": ["c", "b", "a"] },
      }),
    );
    expect(env1.compositionSignature).toBe(env2.compositionSignature);
  });

  it("differs for different capability sets", () => {
    const a = spanToDemandEnvelope(
      span({ name: "tool.x", attributes: { "pcc.capability_types": ["a"] } }),
    );
    const b = spanToDemandEnvelope(
      span({ name: "tool.y", attributes: { "pcc.capability_types": ["b"] } }),
    );
    expect(a.compositionSignature).not.toBe(b.compositionSignature);
  });
});

describe("spanToDemandEnvelope — createdAt + id", () => {
  it("uses span.startTimeISO when available", () => {
    const env = spanToDemandEnvelope(
      span({ name: "tool.x", startTimeISO: "2026-01-01T00:00:00.000Z" }),
    );
    expect(env.createdAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("uses opts.now() when span.startTimeISO is absent", () => {
    const fixedNow = () => new Date("2026-02-02T00:00:00.000Z");
    const env = spanToDemandEnvelope(
      { name: "tool.x", attributes: {} },
      { now: fixedNow },
    );
    expect(env.createdAt).toBe("2026-02-02T00:00:00.000Z");
  });

  it("prefers gen_ai.tool.call.id in the synthesized id", () => {
    const env = spanToDemandEnvelope(
      span({
        name: "tool.x",
        attributes: { "gen_ai.tool.call.id": "call-abc-123" },
      }),
    );
    expect(env.id).toContain("call-abc-123");
  });
});

describe("spanToDemandEnvelope — optional fields", () => {
  it("does NOT emit a key when the optional value is undefined", () => {
    const env = spanToDemandEnvelope(span({ name: "tool.x" }));
    expect(Object.prototype.hasOwnProperty.call(env, "originAgentId")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(env, "geographicRegion")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(env, "requesterIdHash")).toBe(false);
  });

  it("emits originAgentId, geographicRegion, requesterIdHash when present", () => {
    const env = spanToDemandEnvelope(
      span({
        name: "tool.x",
        attributes: {
          "pcc.origin_agent_id": "agent-uuid-123",
          "pcc.geographic_region": "US-CA",
          "pcc.requester_id_hash": "abcdef0123",
        },
      }),
    );
    expect(env.originAgentId).toBe("agent-uuid-123");
    expect(env.geographicRegion).toBe("US-CA");
    expect(env.requesterIdHash).toBe("abcdef0123");
  });
});
