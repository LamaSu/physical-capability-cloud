// buyer-agent.test.mjs — verifies the schema translation and request-building
// that the buyer demo hinges on. No network, no keys: pure functions only.
//
// The headline case runs against the REAL apps/dashboard/public/agent-package.json
// so the PCC-tool → OpenAI-function translation is checked against production
// data (253 tools), not a hand-written fixture that could drift.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  toOpenAiTool,
  toOpenAiTools,
  buildEndpointMap,
  buildToolRequest,
  extractDecomposition,
  deriveCapabilityType,
  renderDag,
  aisaCompletionsUrl,
  buildAisaPayload,
} from "./buyer-agent.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_PATH = resolve(__dirname, "..", "..", "apps", "dashboard", "public", "agent-package.json");
const realPkg = JSON.parse(readFileSync(PKG_PATH, "utf8"));

describe("toOpenAiTool — single PCC tool → OpenAI function tool", () => {
  const pccTool = {
    name: "pcc_submit_request",
    description: "Submit a capability request.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short title" },
        description: { type: "string" },
        urgency: { type: "string", enum: ["standard", "rush", "emergency"] },
      },
      required: ["title", "description"],
    },
    endpoint: { method: "POST", path: "/api/requests" },
  };

  it("wraps the tool in the {type:'function', function:{…}} envelope", () => {
    const out = toOpenAiTool(pccTool);
    expect(out.type).toBe("function");
    expect(out.function.name).toBe("pcc_submit_request");
    expect(out.function.description).toBe("Submit a capability request.");
  });

  it("maps input_schema → parameters VERBATIM (required, enum, nested preserved)", () => {
    const out = toOpenAiTool(pccTool);
    // Same object shape — this is the crux of the translation.
    expect(out.function.parameters).toEqual(pccTool.input_schema);
    expect(out.function.parameters.required).toEqual(["title", "description"]);
    expect(out.function.parameters.properties.urgency.enum).toEqual([
      "standard",
      "rush",
      "emergency",
    ]);
  });

  it("does NOT carry the endpoint into the model-facing tool", () => {
    const out = toOpenAiTool(pccTool);
    expect(out.function.endpoint).toBeUndefined();
    expect(out.function.parameters.endpoint).toBeUndefined();
  });

  it("defaults parameters to an empty object schema when input_schema is missing", () => {
    const out = toOpenAiTool({ name: "noargs", description: "d" });
    expect(out.function.parameters).toEqual({ type: "object", properties: {} });
  });

  it("tolerates a missing description (→ empty string, never undefined)", () => {
    const out = toOpenAiTool({ name: "x", input_schema: { type: "object" } });
    expect(out.function.description).toBe("");
  });
});

describe("toOpenAiTools — whole array + real agent-package.json", () => {
  it("translates every tool and preserves order + count", () => {
    const tools = toOpenAiTools(realPkg.tools);
    expect(tools).toHaveLength(realPkg.tools.length);
    expect(tools[0].function.name).toBe(realPkg.tools[0].name);
  });

  it("produces a valid OpenAI tool for ALL 253 real tools", () => {
    const tools = toOpenAiTools(realPkg.tools);
    expect(tools.length).toBeGreaterThan(200); // real package is ~253
    for (const t of tools) {
      expect(t.type).toBe("function");
      expect(typeof t.function.name).toBe("string");
      expect(t.function.name.length).toBeGreaterThan(0);
      expect(typeof t.function.description).toBe("string");
      expect(t.function.parameters).toBeTypeOf("object");
      // OpenAI requires parameters to be a JSON-Schema object (or object-typed).
      if (t.function.parameters.type !== undefined) {
        expect(t.function.parameters.type).toBe("object");
      }
    }
  });

  it("emits unique tool names (OpenAI rejects duplicates)", () => {
    const tools = toOpenAiTools(realPkg.tools);
    const names = tools.map((t) => t.function.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("honors the maxTools cap for cost control", () => {
    const tools = toOpenAiTools(realPkg.tools, 5);
    expect(tools).toHaveLength(5);
  });

  it("is JSON-serializable (what actually goes on the wire to AIsa)", () => {
    const tools = toOpenAiTools(realPkg.tools);
    expect(() => JSON.stringify(tools)).not.toThrow();
  });

  it("handles a non-array input safely", () => {
    expect(toOpenAiTools(undefined)).toEqual([]);
  });
});

describe("buildEndpointMap", () => {
  it("indexes name → {method, path} from the real package", () => {
    const map = buildEndpointMap(realPkg.tools);
    expect(map.get("pcc_submit_request")).toEqual({ method: "POST", path: "/api/requests" });
    expect(map.has("provision_api_key")).toBe(true);
  });
});

describe("buildToolRequest — tool call → concrete HTTP request", () => {
  const base = "http://localhost:3200";

  it("POST with a body carries the model's args as JSON", () => {
    const req = buildToolRequest({
      endpoint: { method: "POST", path: "/api/requests" },
      input: { title: "T", description: "D" },
      base,
    });
    expect(req.method).toBe("POST");
    expect(req.url).toBe("http://localhost:3200/api/requests");
    expect(JSON.parse(req.body)).toEqual({ title: "T", description: "D" });
  });

  it("fills {curly} path params and REMOVES them from the body", () => {
    const req = buildToolRequest({
      endpoint: { method: "GET", path: "/api/requests/{requestId}/dag" },
      input: { requestId: "req_abc" },
      base,
    });
    expect(req.url).toBe("http://localhost:3200/api/requests/req_abc/dag");
    expect(req.body).toBeUndefined();
  });

  it("fills :colon path params too", () => {
    const req = buildToolRequest({
      endpoint: { method: "GET", path: "/api/job-offers/:id" },
      input: { id: "offer_1" },
      base,
    });
    expect(req.url).toBe("http://localhost:3200/api/job-offers/offer_1");
  });

  it("puts leftover GET args on the querystring, not the body", () => {
    const req = buildToolRequest({
      endpoint: { method: "GET", path: "/api/requests" },
      input: { status: "open", urgency: "rush" },
      base,
    });
    const u = new URL(req.url);
    expect(u.pathname).toBe("/api/requests");
    expect(u.searchParams.get("status")).toBe("open");
    expect(u.searchParams.get("urgency")).toBe("rush");
    expect(req.body).toBeUndefined();
  });

  it("keeps non-path args in the body on POST while consuming the path arg", () => {
    const req = buildToolRequest({
      endpoint: { method: "POST", path: "/api/requests/{requestId}/nodes/{nodeId}/assign" },
      input: { requestId: "r1", nodeId: "n1", operatorId: "op1" },
      base,
    });
    expect(req.url).toBe("http://localhost:3200/api/requests/r1/nodes/n1/assign");
    expect(JSON.parse(req.body)).toEqual({ operatorId: "op1" });
  });

  it("normalizes a trailing slash on the base", () => {
    const req = buildToolRequest({
      endpoint: { method: "POST", path: "/api/requests" },
      input: {},
      base: "http://localhost:3200/",
    });
    expect(req.url).toBe("http://localhost:3200/api/requests");
  });

  it("url-encodes path param values", () => {
    const req = buildToolRequest({
      endpoint: { method: "GET", path: "/api/job-offers/open" },
      input: {},
      base,
    });
    // sanity: no params, clean url
    expect(req.url).toBe("http://localhost:3200/api/job-offers/open");
  });
});

describe("extractDecomposition", () => {
  it("prefers decomposition.nodes", () => {
    const { nodes, request, decomposition } = extractDecomposition({
      request: { id: "req_1", capabilityDag: [{ id: "old" }] },
      decomposition: { nodes: [{ id: "a" }, { id: "b" }], matchedCount: 1 },
    });
    expect(request.id).toBe("req_1");
    expect(decomposition.matchedCount).toBe(1);
    expect(nodes.map((n) => n.id)).toEqual(["a", "b"]);
  });

  it("falls back to request.capabilityDag when decomposition has no nodes", () => {
    const { nodes } = extractDecomposition({
      request: { id: "req_2", capabilityDag: [{ id: "x" }] },
      decomposition: {},
    });
    expect(nodes.map((n) => n.id)).toEqual(["x"]);
  });

  it("returns an empty node list for a malformed result", () => {
    expect(extractDecomposition(null).nodes).toEqual([]);
    expect(extractDecomposition({}).nodes).toEqual([]);
  });
});

describe("deriveCapabilityType — what the buyer shops for", () => {
  it("prefers a capability-matched node", () => {
    const d = deriveCapabilityType([
      { name: "print", capabilityType: "document_printing", matchStatus: "none" },
      { name: "mail", capabilityType: "courier_delivery", matchStatus: "matched", matchedCapabilityName: "PostCo" },
    ]);
    expect(d.type).toBe("courier_delivery");
    expect(d.reason).toContain("PostCo");
  });

  it("falls back to a keyword (print/mail/courier) node when nothing matched", () => {
    const d = deriveCapabilityType([
      { name: "design", capabilityType: "graphic_design", matchStatus: "none" },
      { name: "mail", capabilityType: "courier_delivery", matchStatus: "none" },
    ]);
    expect(d.type).toBe("courier_delivery");
    expect(d.reason).toContain("keyword");
  });

  it("falls back to the first node when neither matched nor keyword", () => {
    const d = deriveCapabilityType([
      { name: "a", capabilityType: "alpha", matchStatus: "none" },
      { name: "b", capabilityType: "beta", matchStatus: "none" },
    ]);
    expect(d.type).toBe("alpha");
  });

  it("reports an empty DAG honestly", () => {
    const d = deriveCapabilityType([]);
    expect(d.type).toBeNull();
    expect(d.reason).toBe("empty DAG");
  });

  it("picks the transport leg from the REAL offline-decomposer DAG (name≠type)", () => {
    // This is exactly what POST /api/requests returns locally for the print+mail
    // job: names are human ("Delivery"), types are generic ("logistics"/"ipp").
    const d = deriveCapabilityType([
      { name: "Document preparation", capabilityType: "documentation" },
      { name: "Printing", capabilityType: "ipp" },
      { name: "Courier pickup", capabilityType: "logistics" },
      { name: "Delivery", capabilityType: "logistics" },
    ]);
    expect(d.type).toBe("logistics");
    expect(d.node.name).toBe("Courier pickup");
    expect(d.reason).toContain("transport");
  });

  it("falls back to the print leg when there is no transport node", () => {
    const d = deriveCapabilityType([
      { name: "Document preparation", capabilityType: "documentation" },
      { name: "Printing", capabilityType: "ipp" },
    ]);
    expect(d.type).toBe("ipp");
    expect(d.reason).toContain("print");
  });
});

describe("AIsa request shape (the live round-trip is written-not-verified)", () => {
  it("builds the chat/completions URL, trimming a trailing slash", () => {
    expect(aisaCompletionsUrl("https://api.aisa.one/v1")).toBe(
      "https://api.aisa.one/v1/chat/completions",
    );
    expect(aisaCompletionsUrl("https://api.aisa.one/v1/")).toBe(
      "https://api.aisa.one/v1/chat/completions",
    );
  });

  it("sends model + messages + tools with tool_choice=auto and temperature 0", () => {
    const messages = [
      { role: "system", content: "sys" },
      { role: "user", content: "do the thing" },
    ];
    const tools = toOpenAiTools(realPkg.tools, 3);
    const payload = buildAisaPayload(messages, tools, "deepseek-v3.1");
    expect(payload.model).toBe("deepseek-v3.1");
    expect(payload.messages).toBe(messages);
    expect(payload.tools).toHaveLength(3);
    expect(payload.tools[0].type).toBe("function");
    expect(payload.tool_choice).toBe("auto");
    expect(payload.temperature).toBe(0);
    // Must serialize cleanly — this is the actual wire body.
    expect(() => JSON.stringify(payload)).not.toThrow();
  });
});

describe("renderDag", () => {
  it("marks the MATCHED node with a star and the matched capability", () => {
    const out = renderDag([
      { name: "print", capabilityType: "document_printing", estimatedCost: 5, matchStatus: "none" },
      {
        name: "mail",
        capabilityType: "courier_delivery",
        estimatedCost: 12,
        matchStatus: "matched",
        matchedCapabilityName: "PostCo",
      },
    ]);
    expect(out).toContain("document_printing");
    expect(out).toContain("★MATCHED");
    expect(out).toContain("→ PostCo");
  });

  it("handles an empty DAG", () => {
    expect(renderDag([])).toBe("(empty DAG)");
  });
});
