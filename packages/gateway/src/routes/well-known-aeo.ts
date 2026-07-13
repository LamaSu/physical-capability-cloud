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
      const capabilityEntries = capabilityTypes.map((capabilityType) => ({
        identifier: `urn:ai:capability.network:capability:${encodeURIComponent(capabilityType)}`,
        displayName: capabilityDisplayName(capabilityType),
        type: "application/pcc-capability+json",
        url: `${PUBLIC_BASE_URL}/api/capabilities/by-type/${encodeURIComponent(capabilityType)}`,
        description: `Discover and hire ${capabilityType} capability on the PCC network.`,
      }));

      return sendPublicJson(reply, {
        specVersion: "1.0",
        host: {
          displayName: "Physical Capability Cloud",
          identifier: "urn:ai:capability.network",
        },
        entries: [
          {
            identifier: "urn:ai:capability.network:mcp",
            displayName: "PCC MCP Server",
            type: "application/mcp-server+json",
            url: `${PUBLIC_BASE_URL}/mcp`,
            description:
              "254-tool MCP server to discover, hire, and verify real-world physical capability.",
          },
          {
            identifier: "urn:ai:capability.network:agent-package",
            displayName: "PCC Agent Package",
            type: "application/json",
            url: `${PUBLIC_BASE_URL}/agent-package.json`,
            description:
              "Machine-readable PCC REST tools for discovering and invoking real-world physical capabilities.",
          },
          {
            identifier: "urn:ai:capability.network:openapi",
            displayName: "PCC API",
            type: "application/openapi+json",
            url: `${PUBLIC_BASE_URL}/openapi.json`,
            description:
              "OpenAPI description of PCC's real HTTP endpoints for physical-capability discovery and orchestration.",
          },
          {
            identifier: "urn:ai:capability.network:a2a",
            displayName: "PCC A2A Agent Card",
            type: "application/json",
            url: `${PUBLIC_BASE_URL}/.well-known/agent-card.json`,
            description:
              "A2A Agent Card for PCC's physical-capability discovery and task agent.",
          },
          ...capabilityEntries,
        ],
        collections: [
          {
            identifier: "urn:ai:capability.network:catalog",
            displayName: "Full capability catalog",
            url: `${PUBLIC_BASE_URL}/api/capabilities`,
            description:
              "The live, complete list of hireable physical capabilities.",
          },
        ],
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

      return sendPublicJson(reply, {
        $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
        skills: agentPackage.tools.map(({ name, description }) => ({
          name,
          description,
        })),
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
