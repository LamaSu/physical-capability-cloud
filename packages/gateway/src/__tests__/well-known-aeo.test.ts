import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { closeStore, initStore } from "../db.js";
import { getCapabilityFacade } from "../facades/index.js";
import { wellKnownAeoRoutes } from "../routes/well-known-aeo.js";

describe("public AEO discovery routes", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.PCC_DB_PATH = ":memory:";
    initStore({ seed: true });
    app = Fastify({ logger: false });
    await app.register(wellKnownAeoRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    closeStore();
    delete process.env.PCC_DB_PATH;
  });

  it("serves an RFC 9727 API catalog with only real discovery URLs", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/.well-known/api-catalog",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain(
      "application/linkset+json",
    );
    expect(response.body).toContain("https://capability.network/openapi.json");
    expect(response.body).toContain(
      "https://capability.network/agent-package.json",
    );
    expect(response.body).not.toContain("graphql");
  });

  it("generates the AI Catalog from the live capability-type registry", async () => {
    const capabilityType = "robot-polishing";
    const before = await app.inject({
      method: "GET",
      url: "/.well-known/ai-catalog.json",
    });
    expect(before.statusCode).toBe(200);
    expect(before.json().entries).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          identifier: `urn:air:capability.network:capability:${capabilityType}`,
        }),
      ]),
    );

    const created = await getCapabilityFacade().create({
      id: "cap-ai-catalog-robot-polishing",
      kernelId: "kernel-nyc",
      type: capabilityType,
      name: "Robot polishing",
    });
    expect(created.success).toBe(true);

    const response = await app.inject({
      method: "GET",
      url: "/.well-known/ai-catalog.json",
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    // Bare "application/json" — no "; charset=utf-8". ora's ARD validator is
    // charset-strict; Fastify's Reply.send() auto-appends charset to any
    // json-ish Content-Type unless a route-level onSend hook overrides it
    // after the fact (see forceBareJsonContentType in well-known-aeo.ts).
    expect(response.headers["content-type"]).toBe("application/json");
    expect(body.specVersion).toBe("1.0");
    expect(body.host).toEqual({
      displayName: "Physical Capability Cloud",
      identifier: "urn:air:capability.network:host:pcc",
    });
    expect(body.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          identifier: "urn:air:capability.network:server:mcp",
          type: "application/mcp-server-card+json",
          url: "https://capability.network/.well-known/mcp/server-card.json",
        }),
        expect.objectContaining({
          identifier: `urn:air:capability.network:capability:${capabilityType}`,
          type: "application/pcc-capability+json",
          url: `https://capability.network/api/capabilities/by-type/${capabilityType}`,
        }),
      ]),
    );
    expect(
      body.entries.some(
        (entry: { type?: string }) =>
          entry.type === "application/pcc-capability+json",
      ),
    ).toBe(true);
    expect(body.collections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          identifier: "urn:air:capability.network:collection:catalog",
          url: "https://capability.network/api/capabilities",
        }),
      ]),
    );
  });

  it("serves the canonical ARD v0.91 manifest with domain-anchored urn:air entries", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/.well-known/ard.json",
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    // Bare application/json — the ARD validator is charset-strict.
    expect(response.headers["content-type"]).toBe("application/json");
    expect(body.specVersion).toBe("0.91");
    expect(body["@context"]).toBe(
      "https://agenticresourcediscovery.org/context/v1",
    );
    expect(Array.isArray(body.entries)).toBe(true);
    expect(body.entries.length).toBeGreaterThan(0);

    // Every identifier is a domain-anchored urn:air URN (ARD Appendix C):
    // urn:air:<fqdn-publisher>:<namespace>:<agent-name>.
    for (const entry of body.entries) {
      expect(entry.identifier).toMatch(
        /^urn:air:capability\.network:[a-z0-9-]+:.+/,
      );
      // Publisher-authority binding (ARD §4.5.1): trustManifest.identity domain
      // MUST align with the <publisher> in the URN.
      expect(entry.trustManifest?.identity?.domain).toBe("capability.network");
      // representativeQueries present (ARD §4.2 / D.2).
      expect(Array.isArray(entry.representativeQueries)).toBe(true);
      expect(entry.representativeQueries.length).toBeGreaterThanOrEqual(2);
    }

    const mcp = body.entries.find(
      (e: { identifier: string }) =>
        e.identifier === "urn:air:capability.network:server:mcp",
    );
    expect(mcp?.type).toBe("application/mcp-server-card+json");
  });

  it("serves RFC 9728 protected-resource metadata whose resource is the gateway base", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/.well-known/oauth-protected-resource",
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("application/json");
    // resource MUST equal the resource identifier (RFC 9728 §3.3).
    expect(body.resource).toBe("https://capability.network");
    expect(body.authorization_servers).toContain("https://capability.network");
    expect(body.bearer_methods_supported).toContain("header");
    expect(body.scopes_supported).toEqual(
      expect.arrayContaining(["capabilities:read", "jobs:write"]),
    );
    expect(body.resource_documentation).toBe(
      "https://capability.network/auth.md",
    );
  });

  it("serves RFC 8414 authorization-server metadata whose issuer is the gateway base", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/.well-known/oauth-authorization-server",
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    // issuer MUST equal the base the well-known suffix was inserted into
    // (RFC 8414 §3.3).
    expect(body.issuer).toBe("https://capability.network");
    expect(body.authorization_endpoint).toBe(
      "https://capability.network/api/auth/nonce",
    );
    expect(body.token_endpoint).toBe(
      "https://capability.network/api/auth/verify",
    );
    // response_types_supported is REQUIRED by RFC 8414.
    expect(Array.isArray(body.response_types_supported)).toBe(true);
    expect(body.response_types_supported.length).toBeGreaterThan(0);
  });

  it("lists PCC's physical-capability discovery agent with real endpoints", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/.well-known/agent-directory.json",
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("application/json");
    expect(body.agents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          displayName: "Physical Capability Cloud",
          agentCard:
            "https://capability.network/.well-known/agent-card.json",
          discovery: expect.objectContaining({
            naturalLanguage: expect.objectContaining({
              url: "https://capability.network/ask",
            }),
            search: expect.objectContaining({
              url: "https://capability.network/api/capabilities/search",
            }),
          }),
        }),
      ]),
    );
  });

  it("advertises the Streamable HTTP MCP server and retains stdio", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/.well-known/mcp",
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.transport).toBe("streamable-http");
    expect(body.url).toBe("https://capability.network/mcp");
    expect(body.transports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "streamable-http",
          url: "https://capability.network/mcp",
        }),
        expect.objectContaining({ type: "stdio" }),
      ]),
    );
    expect(body.serverCardUrl).toBe(
      "https://capability.network/.well-known/mcp/server-card.json",
    );
    // Both real MCP surfaces advertised: the product server and the
    // read-only docs server.
    expect(body.servers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "product", url: "https://capability.network/mcp" }),
        expect.objectContaining({ name: "docs", url: "https://capability.network/mcp/docs" }),
      ]),
    );
  });

  it("generates the MCP server card from the live agent package", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/.well-known/mcp/server-card.json",
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.name).toBe("Physical Capability Cloud MCP Server");
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(body.serverUrl).toBe("https://capability.network/mcp");
    expect(body.transports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "streamable-http",
          url: "https://capability.network/mcp",
        }),
        expect.objectContaining({ type: "stdio" }),
      ]),
    );
    expect(body.tools.length).toBeGreaterThanOrEqual(50);
    expect(body.tools[0]).toEqual(
      expect.objectContaining({
        name: expect.any(String),
        description: expect.any(String),
      }),
    );
    // Registry branding: name+icon+description, not just name+description.
    // ora's scanner reported 0/2 because only `logo` (not `icon`/`icons`)
    // was present.
    expect(body.name).toEqual(expect.any(String));
    expect(body.description).toEqual(expect.any(String));
    expect(body.icon).not.toBeNull();
    expect(body.icon).toBe("https://capability.network/pcc-icon.svg");
    expect(body.icons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ src: "https://capability.network/pcc-icon.svg" }),
      ]),
    );
    expect(body.servers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "product", url: "https://capability.network/mcp" }),
        expect.objectContaining({ name: "docs", url: "https://capability.network/mcp/docs" }),
      ]),
    );
  });

  it("generates the Agent Skills index from the live agent package", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/.well-known/agent-skills/index.json",
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.$schema).toBe(
      "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
    );
    expect(body.skills.length).toBeGreaterThanOrEqual(50);
    expect(body.skills[0]).toEqual(
      expect.objectContaining({
        name: expect.any(String),
        description: expect.any(String),
      }),
    );
  });

  it("backs NLWeb /ask with the real capability search facade", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/ask",
      payload: { query: "HPLC" },
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body._meta).toMatchObject({
      response_type: "answer",
      version: "0.55",
    });
    expect(Array.isArray(body.results)).toBe(true);
    expect(body.results.length).toBeGreaterThan(0);
    expect(body.results[0]["@type"]).toBe("Service");
    expect(body.results[0].url).toMatch(
      /^https:\/\/capability\.network\/api\/capabilities\//,
    );
  });

  it("returns a typed NLWeb error for an invalid query", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/ask",
      payload: { query: "" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      _meta: { response_type: "failure", version: "0.55" },
      error: { code: "INVALID_QUERY" },
    });
  });
});
