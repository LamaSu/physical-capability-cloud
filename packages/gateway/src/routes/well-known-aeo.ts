import type { FastifyInstance, FastifyReply } from "fastify";
import type { CapabilityDTO } from "../facades/index.js";
import { getCapabilityFacade } from "../facades/index.js";

const PUBLIC_BASE_URL = "https://capability.network";
const NLWEB_VERSION = "0.55";

type AskBody = {
  query?: string | { text?: unknown };
  prefer?: { streaming?: boolean };
};

function sendPublicJson(reply: FastifyReply, body: unknown) {
  return reply
    .header("access-control-allow-origin", "*")
    .header("cache-control", "public, max-age=300")
    .send(body);
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
    "/.well-known/mcp",
    {
      schema: {
        tags: ["well-known"],
        summary: "MCP server discovery",
        description:
          "Describes PCC's repository-hosted stdio MCP server. PCC does not expose an HTTP MCP transport.",
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
        transport: "stdio",
        serverCard: `${PUBLIC_BASE_URL}/.well-known/mcp/server-card.json`,
        serverCardUrl: `${PUBLIC_BASE_URL}/.well-known/mcp/server-card.json`,
        configuration: {
          mcpServers: {
            pcc: configuration,
          },
        },
        transports: [
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
