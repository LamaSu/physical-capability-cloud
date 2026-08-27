import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { CapabilityDTO } from "../facades/index.js";
import { getCapabilityFacade } from "../facades/index.js";
import { loadAgentPackage, PCC_MCP_ICON_URL } from "../mcp/http-mcp-server.js";
import { DOCS_MOUNT_PATH } from "../mcp/docs-mcp-server.js";
import { getApiCapabilityTypes } from "./capabilities.js";

const PUBLIC_BASE_URL = "https://capability.network";
const NLWEB_VERSION = "0.55";
const MCP_DOCS_URL = `${PUBLIC_BASE_URL}${DOCS_MOUNT_PATH}`;

/**
 * The <publisher> segment of every urn:air identifier — a fully-qualified
 * domain name, per ARD v0.91 Appendix C. capability.network owns this domain,
 * so a domain-anchored URN (urn:air:capability.network:<namespace>:<name>) is a
 * verifiable authority anchor: a registry extracts "capability.network" and
 * cross-references it against trustManifest.identity (ARD §4.5.1). This is the
 * form the ora.ai / ARD conformance checker requires — the previous
 * "urn:ai:capability.network:*" identifiers were NOT domain-anchored urn:air
 * URNs and were rejected as invalid.
 */
const PUBLISHER_DOMAIN = "capability.network";

/**
 * Named access scopes PCC's authorization surfaces understand. Advertised by
 * both OAuth discovery documents (RFC 9728 scopes_supported / RFC 8414
 * scopes_supported) so an agent can name the access it needs. These describe
 * PCC's real access tiers: public discovery reads, job read/write, and the
 * operator/admin roles the SIWE flow already declares in the A2A agent card.
 */
const PCC_OAUTH_SCOPES = [
  "capabilities:read",
  "jobs:read",
  "jobs:write",
  "operator",
  "admin",
] as const;

/** urn:air:<publisher>:<namespace>:<agent-name> (ARD v0.91 Appendix C). */
function airUrn(namespace: string, agentName: string): string {
  return `urn:air:${PUBLISHER_DOMAIN}:${namespace}:${agentName}`;
}

/**
 * ARD trustManifest for every PCC-published entry (ARD §4.5). ARD requires only
 * trustManifest.identity, whose asserted trust domain MUST align with the
 * <publisher> in the entry's urn:air identifier (§4.5.1) — here, capability.network.
 *
 * These verification methods are REAL, already-served surfaces, not placeholders:
 *   - the Ed25519 public key is the exact one published at
 *     /.well-known/mcp-registry-auth (the same key PCC uses for MCP-Registry HTTP
 *     domain authentication — see that route in this file); a holder of the
 *     matching private key can sign a challenge that resolves back to this domain.
 *   - the JWKS is the live A2A signing key set at /.well-known/jwks.json.
 * ARD is agnostic about the trust framework (§4.5.2); we declare a
 * domain-anchored Ed25519 scheme and point governanceUri at the live proof.
 */
const PCC_TRUST_MANIFEST = {
  identity: {
    domain: PUBLISHER_DOMAIN,
    publisher: PUBLISHER_DOMAIN,
    proofUri: `${PUBLIC_BASE_URL}/.well-known/mcp-registry-auth`,
  },
  trustSchema: {
    framework: "domain-anchored-ed25519",
    governanceUri: `${PUBLIC_BASE_URL}/.well-known/mcp-registry-auth`,
    verificationMethods: [
      {
        type: "ed25519",
        publicKey: "cL5ml6MK4ndfBPt/0s3uX5CizJcGSsA5bSA0jF0n3zE=",
        proof: `${PUBLIC_BASE_URL}/.well-known/mcp-registry-auth`,
      },
      {
        type: "jwks",
        jwksUri: `${PUBLIC_BASE_URL}/.well-known/jwks.json`,
      },
    ],
  },
} as const;

/**
 * The static (non-capability-derived) ARD entries: PCC's fixed agent surfaces.
 * Shared verbatim by /.well-known/ard.json (canonical, ARD v0.91) and
 * /.well-known/ai-catalog.json (the predecessor path ARD §5.1 still lets
 * consumers consult). Every identifier is a domain-anchored urn:air URN and
 * every entry carries representativeQueries (2–5, ARD §4.2/D.2) + trustManifest.
 */
function staticArdEntries() {
  return [
    {
      identifier: airUrn("server", "mcp"),
      displayName: "PCC MCP Server",
      type: "application/mcp-server-card+json",
      url: `${PUBLIC_BASE_URL}/.well-known/mcp/server-card.json`,
      description:
        "MCP server to discover, hire, and verify real-world physical capability.",
      representativeQueries: [
        "find a 3D printer near me that can print a PLA bracket",
        "hire a CNC machine to mill an aluminum part under $50",
      ],
      trustManifest: PCC_TRUST_MANIFEST,
    },
    {
      identifier: airUrn("agent", "a2a"),
      displayName: "PCC A2A Agent Card",
      type: "application/a2a-agent-card+json",
      url: `${PUBLIC_BASE_URL}/.well-known/agent-card.json`,
      description:
        "A2A Agent Card for PCC's physical-capability discovery and task agent.",
      representativeQueries: [
        "discover a physical capability that can manufacture this part",
        "what laboratory capability is available for this protocol",
      ],
      trustManifest: PCC_TRUST_MANIFEST,
    },
    {
      identifier: airUrn("api", "openapi"),
      displayName: "PCC API (OpenAPI)",
      type: "application/openapi+json",
      url: `${PUBLIC_BASE_URL}/openapi.json`,
      description:
        "OpenAPI description of PCC's real HTTP endpoints for physical-capability discovery and orchestration.",
      representativeQueries: [
        "list the REST endpoints for hiring a physical capability",
        "how do I submit and track a physical job over HTTP",
      ],
      trustManifest: PCC_TRUST_MANIFEST,
    },
    {
      identifier: airUrn("api", "agent-package"),
      displayName: "PCC Agent Package",
      type: "application/json",
      url: `${PUBLIC_BASE_URL}/agent-package.json`,
      description:
        "Machine-readable PCC REST tools for discovering and invoking real-world physical capabilities.",
      representativeQueries: [
        "load the PCC tool package for my agent",
        "what tools can hire real-world capability",
      ],
      trustManifest: PCC_TRUST_MANIFEST,
    },
  ];
}

/** One ARD entry per live capability type (domain-anchored urn:air). */
function capabilityArdEntries(capabilityTypes: string[]) {
  return capabilityTypes.map((capabilityType) => ({
    identifier: airUrn("capability", capabilityType),
    displayName: capabilityDisplayName(capabilityType),
    type: "application/pcc-capability+json",
    url: `${PUBLIC_BASE_URL}/api/capabilities/by-type/${encodeURIComponent(capabilityType)}`,
    description: `Discover and hire ${capabilityType} capability on the PCC network.`,
    representativeQueries: [
      `find a ${capabilityType} capability I can hire`,
      `what does ${capabilityType} cost on PCC`,
    ],
    trustManifest: PCC_TRUST_MANIFEST,
  }));
}

/**
 * Registry-schema icon shape (MCP registry `icons` array convention: a list
 * of {src, mimeType} objects) for PCC's one served, verified-200 icon.
 * Shared by server-card.json and the MCP initialize handshake (see
 * http-mcp-server.ts's PCC_MCP_ICON_URL) so both surfaces name the same URL.
 */
const PCC_MCP_ICONS = [{ src: PCC_MCP_ICON_URL, mimeType: "image/svg+xml" }];

type AskBody = {
  query?: string | { text?: unknown };
  prefer?: { streaming?: boolean };
};

function sendPublicJson(reply: FastifyReply, body: unknown) {
  return reply
    .type("application/json")
    .header("access-control-allow-origin", "*")
    .header("cache-control", "public, max-age=300")
    .send(body);
}

/**
 * Route-level onSend hook that forces a bare "application/json" Content-Type
 * (no charset parameter) for agent-readability scanners that are strict
 * about it (ora's ARD/AI-Catalog validator among them).
 *
 * Verified against this repo's installed fastify@4.29.1 (lib/reply.js):
 * Reply.send() unconditionally appends "; charset=utf-8" to ANY Content-Type
 * containing the substring "json" that doesn't already declare a charset —
 * this fires inside send() itself, before serialization and before ANY
 * onSend hook runs, so neither calling reply.header()/reply.type() first NOR
 * pre-stringifying the body avoids it. The one point that reliably runs
 * AFTER that internal mutation — and wins — is a route-level onSend hook:
 * Fastify guarantees route-level onSend hooks run after app-level ones, and
 * onSendEnd() reads the final response headers only once the whole onSend
 * chain has completed. Same technique mcp-app-view.ts's registerMcpAppHttpRoute
 * already uses to override the app-wide CSP/X-Frame-Options for one route.
 */
async function forceBareJsonContentType(
  _request: FastifyRequest,
  reply: FastifyReply,
  payload: unknown,
) {
  reply.header("content-type", "application/json");
  return payload;
}

function capabilityDisplayName(capabilityType: string): string {
  return capabilityType
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part, index) => {
      if (part.toLowerCase() === "3d") return "3D";
      if (index > 0) return part.toLowerCase();
      return `${part.charAt(0).toUpperCase()}${part.slice(1)}`;
    })
    .join(" ");
}

function nlwebFailure(
  reply: FastifyReply,
  statusCode: number,
  code: string,
  message: string,
) {
  return reply.status(statusCode).send({
    _meta: {
      response_type: "failure",
      response_format: "conversational_search",
      version: NLWEB_VERSION,
    },
    error: { code, message },
  });
}

function readQuery(body: AskBody | undefined): string | undefined {
  const candidate = body?.query;
  if (typeof candidate === "string") return candidate.trim();
  if (
    candidate &&
    typeof candidate === "object" &&
    typeof candidate.text === "string"
  ) {
    return candidate.text.trim();
  }
  return undefined;
}

function toNlwebResult(capability: CapabilityDTO) {
  const url = `${PUBLIC_BASE_URL}/api/capabilities/${encodeURIComponent(String(capability.id))}`;
  const description =
    capability.description ??
    `PCC capability of type ${String(capability.type)}.`;
  const additionalProperty: Array<Record<string, unknown>> = [
    {
      "@type": "PropertyValue",
      name: "capabilityType",
      value: capability.type,
    },
    {
      "@type": "PropertyValue",
      name: "materials",
      value: capability.materials,
    },
    {
      "@type": "PropertyValue",
      name: "assuranceTiers",
      value: capability.assuranceTiers,
    },
    {
      "@type": "PropertyValue",
      name: "available",
      value: capability.available,
    },
    {
      "@type": "PropertyValue",
      name: "queueDepth",
      value: capability.queueDepth,
    },
  ];

  if (capability.kernelStatus) {
    additionalProperty.push({
      "@type": "PropertyValue",
      name: "kernelStatus",
      value: capability.kernelStatus,
    });
  }
  if (capability.reputation !== undefined) {
    additionalProperty.push({
      "@type": "PropertyValue",
      name: "operatorReputation",
      value: capability.reputation,
    });
  }

  return {
    "@context": "https://schema.org",
    "@type": "Service",
    "@id": url,
    url,
    name: capability.name,
    description,
    serviceType: capability.type,
    provider: {
      "@type": "Organization",
      identifier: capability.kernelId,
      ...(capability.kernelName ? { name: capability.kernelName } : {}),
    },
    areaServed: {
      "@type": "Place",
      geo: {
        "@type": "GeoCoordinates",
        latitude: capability.location.lat,
        longitude: capability.location.lng,
      },
    },
    additionalProperty,
    grounding: {
      source: url,
    },
  };
}

/**
 * Coerce a raw tool name (e.g. "provision_api_key") into a valid Agent Skills
 * skill `name` per the agentskills.io spec: 1–64 chars, unicode lowercase
 * alphanumeric + hyphens only, no leading/trailing/consecutive hyphens. The
 * previous index emitted raw underscore_case tool names verbatim, which the
 * Agent-Skills conformance (v0.2.0) check rejected as invalid entries.
 */
function toAgentSkillName(rawName: string): string {
  const slug = rawName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-") // underscores, spaces, dots → hyphen
    .replace(/-+/g, "-") // collapse consecutive hyphens
    .replace(/^-+|-+$/g, "") // trim leading/trailing hyphens
    .slice(0, 64)
    .replace(/-+$/g, ""); // re-trim if the 64-char cut left a trailing hyphen
  return slug || "skill";
}

/** Non-empty description, clamped to the spec's 1024-char ceiling. */
function clampSkillDescription(description: string | undefined, name: string): string {
  const text = (description ?? "").trim() || `PCC ${name} skill.`;
  return text.length > 1024 ? `${text.slice(0, 1021)}...` : text;
}

/**
 * Public agent-discovery surfaces that require explicit content types or
 * dynamic data. Register this plugin before the API authentication gate.
 */
export async function wellKnownAeoRoutes(app: FastifyInstance) {
  app.get(
    "/.well-known/api-catalog",
    {
      schema: {
        tags: ["well-known"],
        summary: "RFC 9727 API catalog",
        description:
          "Public RFC 9264 linkset pointing to PCC's live API description and documentation.",
      },
    },
    async (_request, reply) => {
      return reply
        .type(
          'application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"',
        )
        .header("access-control-allow-origin", "*")
        .header("cache-control", "public, max-age=300")
        .send({
          linkset: [
            {
              anchor: PUBLIC_BASE_URL,
              // RFC 9727 §2 — one `item` link per API PCC publishes, so a
              // catalog consumer can enumerate the individual APIs rather than
              // only the base service-desc/service-doc.
              item: [
                {
                  href: `${PUBLIC_BASE_URL}/openapi.json`,
                  type: "application/openapi+json",
                  title: "PCC REST API (OpenAPI)",
                },
                {
                  href: `${PUBLIC_BASE_URL}/.well-known/mcp`,
                  type: "application/json",
                  title: "PCC MCP server",
                },
                {
                  href: `${PUBLIC_BASE_URL}/.well-known/agent-card.json`,
                  type: "application/json",
                  title: "PCC A2A agent card",
                },
                {
                  href: `${PUBLIC_BASE_URL}/.well-known/ard.json`,
                  type: "application/json",
                  title: "PCC ARD capability catalog",
                },
              ],
              "service-desc": [
                {
                  href: `${PUBLIC_BASE_URL}/openapi.json`,
                  type: "application/json",
                  title: "PCC OpenAPI description",
                },
                {
                  href: `${PUBLIC_BASE_URL}/agent-package.json`,
                  type: "application/json",
                  title: "PCC agent tool package",
                },
              ],
              "service-doc": [
                {
                  href: `${PUBLIC_BASE_URL}/docs`,
                  type: "text/html",
                  title: "PCC documentation",
                },
                {
                  href: `${PUBLIC_BASE_URL}/llms.txt`,
                  type: "text/plain",
                  title: "PCC instructions for language models",
                },
              ],
            },
          ],
        });
    },
  );

  // Canonical ARD v0.91 manifest (§5.1). A conformant consumer resolving PCC's
  // entries MUST fetch /.well-known/ard.json (ai-catalog.json below is only the
  // predecessor path, optional for consumers). The document is a JSON object
  // with an `entries` array of ARD entries (§4); other top-level members are
  // transport-defined and ignored by ARD.
  app.get(
    "/.well-known/ard.json",
    {
      // Bare "application/json" — the ARD validator is charset-strict.
      // See forceBareJsonContentType's doc comment.
      onSend: forceBareJsonContentType,
      schema: {
        tags: ["well-known", "discovery"],
        summary: "ARD v0.91 canonical manifest",
        description:
          "Agentic Resource Discovery (ARD v0.91) manifest: PCC's agent surfaces plus one entry per live capability type, each a domain-anchored urn:air entry with representativeQueries and a trustManifest.",
      },
    },
    async (_request, reply) => {
      const capabilityTypes = await getApiCapabilityTypes(app.log);
      return sendPublicJson(reply, {
        "@context": "https://agenticresourcediscovery.org/context/v1",
        specVersion: "0.91",
        entries: [
          ...staticArdEntries(),
          ...capabilityArdEntries(capabilityTypes),
        ],
      });
    },
  );

  app.get(
    "/.well-known/ai-catalog.json",
    {
      // Bare "application/json" — ora's ARD validator is charset-strict.
      // See forceBareJsonContentType's doc comment for why this must be a
      // route-level onSend hook rather than a header set before .send().
      onSend: forceBareJsonContentType,
      schema: {
        tags: ["well-known", "discovery"],
        summary: "AI Catalog for PCC's live physical capabilities",
        description:
          "Generates an Agentic Resource Discovery AI Catalog from PCC's canonical capability-type registry at request time.",
      },
    },
    async (_request, reply) => {
      const capabilityTypes = await getApiCapabilityTypes(app.log);

      // Predecessor (ai-catalog) wrapper around the SAME domain-anchored
      // urn:air entries served at /.well-known/ard.json. ARD §5.1 lets a
      // consumer still consult this path; keeping it correct (not just present)
      // means a consumer that lands here first also gets valid urn:air URNs.
      return sendPublicJson(reply, {
        specVersion: "1.0",
        host: {
          displayName: "Physical Capability Cloud",
          identifier: airUrn("host", "pcc"),
        },
        entries: [
          ...staticArdEntries(),
          ...capabilityArdEntries(capabilityTypes),
        ],
        collections: [
          {
            identifier: airUrn("collection", "catalog"),
            displayName: "Full capability catalog",
            url: `${PUBLIC_BASE_URL}/api/capabilities`,
            description:
              "The live, complete list of hireable physical capabilities.",
          },
        ],
      });
    },
  );

  // -----------------------------------------------------------------------
  // Agent-auth discovery — RFC 9728 (Protected Resource Metadata) + RFC 8414
  // (Authorization Server Metadata). These make PCC's auth self-describing to
  // an agent that speaks the WorkOS "agent_auth" / MCP OAuth discovery dance:
  // it fetches /.well-known/oauth-protected-resource (advertised via the
  // WWW-Authenticate: Bearer resource_metadata=... header apiGate now emits on
  // 401), learns the authorization server, then fetches that AS's metadata.
  // The scopes/endpoints here DESCRIBE PCC's real API-key + SIWE surfaces;
  // /auth.md is the human walkthrough. Public, before the API auth gate.
  // -----------------------------------------------------------------------
  app.get(
    "/.well-known/oauth-protected-resource",
    {
      onSend: forceBareJsonContentType,
      schema: {
        tags: ["well-known", "discovery"],
        summary: "RFC 9728 Protected Resource Metadata",
        description:
          "OAuth 2.0 Protected Resource Metadata describing PCC's API as a protected resource: its authorization server, supported bearer methods, and access scopes.",
      },
    },
    async (_request, reply) => {
      // `resource` MUST equal the resource identifier the well-known suffix was
      // inserted into (RFC 9728 §3.3) — PCC's gateway base URL.
      return sendPublicJson(reply, {
        resource: PUBLIC_BASE_URL,
        authorization_servers: [PUBLIC_BASE_URL],
        bearer_methods_supported: ["header"],
        scopes_supported: PCC_OAUTH_SCOPES,
        resource_name: "Physical Capability Cloud API",
        resource_documentation: `${PUBLIC_BASE_URL}/auth.md`,
        jwks_uri: `${PUBLIC_BASE_URL}/.well-known/jwks.json`,
      });
    },
  );

  app.get(
    "/.well-known/oauth-authorization-server",
    {
      onSend: forceBareJsonContentType,
      schema: {
        tags: ["well-known", "discovery"],
        summary: "RFC 8414 Authorization Server Metadata",
        description:
          "OAuth 2.0 Authorization Server Metadata mapping PCC's real auth endpoints (API-key provisioning + SIWE nonce/verify) to standard OAuth discovery fields.",
      },
    },
    async (_request, reply) => {
      // `issuer` MUST be identical to the base the well-known suffix was inserted
      // into (RFC 8414 §3.3). The endpoints below are PCC's real auth surfaces:
      // SIWE nonce (authorize) + verify (token), and public key provisioning
      // (registration). token_endpoint_auth_methods_supported: ["none"] — clients
      // are public; credentials are minted, not pre-shared.
      return sendPublicJson(reply, {
        issuer: PUBLIC_BASE_URL,
        authorization_endpoint: `${PUBLIC_BASE_URL}/api/auth/nonce`,
        token_endpoint: `${PUBLIC_BASE_URL}/api/auth/verify`,
        registration_endpoint: `${PUBLIC_BASE_URL}/api/auth/provision`,
        jwks_uri: `${PUBLIC_BASE_URL}/.well-known/jwks.json`,
        scopes_supported: PCC_OAUTH_SCOPES,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code"],
        token_endpoint_auth_methods_supported: ["none"],
        service_documentation: `${PUBLIC_BASE_URL}/auth.md`,
      });
    },
  );

  app.get(
    "/.well-known/agent-directory.json",
    {
      // Bare "application/json" — see forceBareJsonContentType's doc comment.
      onSend: forceBareJsonContentType,
      schema: {
        tags: ["well-known", "discovery"],
        summary: "PCC physical-capability agent directory",
        description:
          "Lists PCC's physical-capability discovery agent and its real discovery and A2A endpoints.",
      },
    },
    async (_request, reply) => {
      return sendPublicJson(reply, {
        specVersion: "1.0",
        agents: [
          {
            identifier: "urn:ai:capability.network:a2a",
            displayName: "Physical Capability Cloud",
            description:
              "Physical-capability discovery agent backed by PCC's live capability registry.",
            agentCard: `${PUBLIC_BASE_URL}/.well-known/agent-card.json`,
            a2a: {
              method: "POST",
              url: `${PUBLIC_BASE_URL}/a2a/tasks/send`,
              transport: "JSON-RPC 2.0",
            },
            discovery: {
              naturalLanguage: {
                method: "POST",
                url: `${PUBLIC_BASE_URL}/ask`,
              },
              search: {
                method: "GET",
                url: `${PUBLIC_BASE_URL}/api/capabilities/search`,
                queryParameter: "q",
              },
              types: {
                method: "GET",
                url: `${PUBLIC_BASE_URL}/api/capabilities/types`,
              },
            },
          },
        ],
      });
    },
  );

  app.get(
    "/.well-known/mcp",
    {
      schema: {
        tags: ["well-known"],
        summary: "MCP server discovery",
        description:
          "Describes PCC's public Streamable HTTP MCP server and repository-hosted stdio transport.",
      },
    },
    async (_request, reply) => {
      const configuration = {
        command: "node",
        args: ["packages/mcp-server/dist/index.js"],
        env: { PCC_URL: PUBLIC_BASE_URL },
      };

      return sendPublicJson(reply, {
        name: "Physical Capability Cloud MCP Server",
        description:
          "MCP tools for discovering, negotiating, and orchestrating real-world physical capabilities through PCC.",
        transport: "streamable-http",
        url: `${PUBLIC_BASE_URL}/mcp`,
        serverCard: `${PUBLIC_BASE_URL}/.well-known/mcp/server-card.json`,
        serverCardUrl: `${PUBLIC_BASE_URL}/.well-known/mcp/server-card.json`,
        // Two real MCP surfaces: the product server (does things) and the
        // read-only docs server (learn things) — see docs-mcp-server.ts.
        servers: [
          {
            name: "product",
            description:
              "Discover, negotiate, and settle real-world physical capability through PCC's tool catalog.",
            url: `${PUBLIC_BASE_URL}/mcp`,
          },
          {
            name: "docs",
            description:
              "Read-only PCC documentation as MCP resources (agent guide, API reference, quickstarts) plus a search_docs tool.",
            url: MCP_DOCS_URL,
          },
        ],
        configuration: {
          mcpServers: {
            pcc: configuration,
          },
        },
        transports: [
          {
            type: "streamable-http",
            url: `${PUBLIC_BASE_URL}/mcp`,
          },
          {
            type: "stdio",
            description:
              "Run from a cloned and built physical-capability-cloud repository.",
            configuration,
          },
        ],
        documentation: `${PUBLIC_BASE_URL}/docs`,
      });
    },
  );

  // Ed25519 public-key proof for HTTP domain authentication to the official
  // MCP Registry (registry.modelcontextprotocol.io). PCC owns capability.network,
  // so domain-based auth needs no interactive OAuth: the registry fetches this
  // file and verifies a signature made with the matching private key (held
  // off-repo). A dedicated route (not a static file) so the SPA catch-all can
  // never shadow it with HTML. Public, pre-auth-gate.
  app.get(
    "/.well-known/mcp-registry-auth",
    {
      schema: {
        tags: ["well-known", "discovery"],
        summary: "MCP Registry domain-ownership proof",
        description:
          "Ed25519 public-key record so PCC can publish to the official MCP Registry via HTTP domain authentication.",
      },
    },
    async (_request, reply) => {
      return reply
        .header("content-type", "text/plain; charset=utf-8")
        .header("access-control-allow-origin", "*")
        .header("cache-control", "public, max-age=300")
        .send("v=MCPv1; k=ed25519; p=cL5ml6MK4ndfBPt/0s3uX5CizJcGSsA5bSA0jF0n3zE=\n");
    },
  );

  app.get(
    "/.well-known/mcp/server-card.json",
    {
      schema: {
        tags: ["well-known"],
        summary: "MCP server card",
        description:
          "Generates PCC's MCP server card from the current agent tool package.",
      },
    },
    async (_request, reply) => {
      const agentPackage = await loadAgentPackage();
      const stdioConfiguration = {
        command: "node",
        args: ["packages/mcp-server/dist/index.js"],
        env: { PCC_URL: PUBLIC_BASE_URL },
      };

      return sendPublicJson(reply, {
        name: `${agentPackage.name} MCP Server`,
        description: agentPackage.description,
        version: agentPackage.version,
        serverUrl: `${PUBLIC_BASE_URL}/mcp`,
        logo: `${PUBLIC_BASE_URL}/pcc-icon.svg`,
        // `icon` (singular, MCP-registry-conventional) + `icons` (the
        // {src,mimeType} array shape some registries expect) alongside the
        // pre-existing `logo` — covers field-name variants. Same served,
        // verified-200 asset the /mcp initialize handshake's serverInfo.icons
        // references (see http-mcp-server.ts's PCC_MCP_ICON_URL).
        icon: PCC_MCP_ICON_URL,
        icons: PCC_MCP_ICONS,
        // Two real MCP surfaces — see the matching `servers` array on
        // /.well-known/mcp above.
        servers: [
          { name: "product", url: `${PUBLIC_BASE_URL}/mcp` },
          { name: "docs", url: MCP_DOCS_URL },
        ],
        transport: {
          type: "streamable-http",
          url: `${PUBLIC_BASE_URL}/mcp`,
        },
        transports: [
          {
            type: "streamable-http",
            url: `${PUBLIC_BASE_URL}/mcp`,
          },
          {
            type: "stdio",
            ...stdioConfiguration,
          },
        ],
        tools: agentPackage.tools.map(({ name, description }) => ({
          name,
          description,
        })),
      });
    },
  );

  app.get(
    "/.well-known/agent-skills/index.json",
    {
      schema: {
        tags: ["well-known"],
        summary: "Agent Skills discovery index",
        description:
          "Generates the Agent Skills discovery index from the current agent tool package.",
      },
    },
    async (_request, reply) => {
      const agentPackage = await loadAgentPackage();

      // Normalize each tool into a spec-valid Agent Skills entry. Raw tool
      // names are underscore_case (e.g. "provision_api_key") which the v0.2.0
      // naming rule forbids; map them to hyphen-case skill names and keep the
      // first valid entry when the coercion collides. `skills` keeps a stable,
      // deduplicated order.
      const seen = new Set<string>();
      const skills: Array<{ name: string; description: string }> = [];
      for (const tool of agentPackage.tools) {
        const name = toAgentSkillName(tool.name);
        if (seen.has(name)) continue;
        seen.add(name);
        skills.push({
          name,
          description: clampSkillDescription(tool.description, name),
        });
      }

      return sendPublicJson(reply, {
        $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
        version: "0.2.0",
        skills,
      });
    },
  );

  app.post<{ Body: AskBody }>(
    "/ask",
    {
      schema: {
        tags: ["discovery"],
        summary: "Search PCC capabilities with an NLWeb-compatible query",
        description:
          "Accepts either {query: string} or NLWeb 0.55 {query: {text: string}} and searches the live PCC capability catalog.",
      },
    },
    async (request, reply) => {
      reply.header("access-control-allow-origin", "*");
      reply.header("cache-control", "no-store");

      const query = readQuery(request.body);
      if (!query) {
        return nlwebFailure(
          reply,
          400,
          "INVALID_QUERY",
          "query must be a non-empty string or an object with a non-empty text field",
        );
      }
      if (query.length > 500) {
        return nlwebFailure(
          reply,
          400,
          "INVALID_QUERY",
          "query must be 500 characters or fewer",
        );
      }

      // Reuse the same facade and ranking implementation as
      // GET /api/capabilities/search. A direct call is intentional: this
      // plugin is public and registered before the API auth gate.
      const search = await getCapabilityFacade().search(
        { query },
        undefined,
        { offset: 0, limit: 20 },
      );

      if (!search.success) {
        return nlwebFailure(
          reply,
          search.error.httpStatus,
          search.error.httpStatus >= 500 ? "INTERNAL_ERROR" : search.error.code,
          search.error.httpStatus >= 500
            ? "Capability search is temporarily unavailable"
            : search.error.message,
        );
      }

      return {
        _meta: {
          response_type: "answer",
          response_format: "conversational_search",
          version: NLWEB_VERSION,
        },
        results: search.data.items.map(toNlwebResult),
      };
    },
  );
}
