import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { resolveGatewayAsset } from "../mcp/mcp-app-view.js";

// This artifact is committed source that reaches the image through COPY . .;
// Vite also copies it into dashboard/dist.
// HTTP and the docs MCP resource deliberately resolve the same source asset.
export const AGENT_MD_SEGMENTS = [
  "apps", "dashboard", "public", ".well-known", "agent.md",
];

export function loadAgentMd(): string {
  return readFileSync(resolveGatewayAsset(AGENT_MD_SEGMENTS), "utf8");
}

/**
 * Public: apiGate's hook reaches every route, whatever the registration order, and skips non-/api
 * paths ("/.well-known/" is a public prefix too). well-known-agent.gateway.test.ts pins it.
 */
export async function wellKnownAgentRoutes(app: FastifyInstance): Promise<void> {
  const markdown = loadAgentMd(); // Fail at startup if the image lost the asset.
  app.get("/.well-known/agent.md", {
    schema: {
      tags: ["well-known", "docs"],
      summary: "PCC agent golden path for buying and supplying capabilities",
    },
  }, async (_request, reply) => reply
    .type("text/markdown; charset=utf-8")
    .header("access-control-allow-origin", "*")
    .header("cache-control", "public, max-age=300")
    .send(markdown));
}
