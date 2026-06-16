/**
 * Static "paste this into your LLM" snippet (closes owner ask #178).
 *
 * `curl https://capability.network/snippet.md` returns a short Markdown
 * prompt that primes any tool-using LLM (Claude.ai, ChatGPT, Gemini,
 * Cursor, etc.) to fetch the agent-package.json and interview the user
 * the same way the in-browser /onboard/chat agent (#159) does.
 *
 * Routes:
 *   GET /snippet.md           → text/markdown body, CORS *
 *   GET /onboard/snippet      → same body, also no-auth (alias)
 *   GET /onboard/snippet.json → JSON wrapper for the dashboard `Copy` tile
 *
 * All endpoints are PUBLIC — no auth, no API key, no rate limit beyond
 * the platform default. The snippet is intentionally short and stable so
 * we can update it independently of the agent-package.json itself.
 */

import type { FastifyInstance } from "fastify";

export const SNIPPET_BODY = `I want to onboard to Physical Capability Cloud (PCC) at https://capability.network.

Please:
1. Fetch https://capability.network/agent-package.json
2. Adopt the \`system_prompt\` field as your operating instructions
3. Use the \`tools\` field as your tool registry. Each tool has an \`endpoint\` ({method, path}) — call it at https://capability.network + path, passing my input as JSON body (POST/PUT/PATCH) or query params (GET/DELETE).
4. Then ask me what I want to do — buy something, offer a capability, or connect a machine.

I'll tell you about my role and we'll go from there.
`;

export const SNIPPET_VERSION = "1";

export async function snippetRoutes(app: FastifyInstance): Promise<void> {
  // /snippet.md — raw markdown for `curl`
  app.get("/snippet.md", async (_req, reply) => {
    reply
      .header("content-type", "text/markdown; charset=utf-8")
      .header("access-control-allow-origin", "*")
      .header("cache-control", "public, max-age=300, s-maxage=300")
      .header("x-pcc-snippet-version", SNIPPET_VERSION);
    return SNIPPET_BODY;
  });

  // /onboard/snippet — alias, same payload
  app.get("/onboard/snippet", async (_req, reply) => {
    reply
      .header("content-type", "text/markdown; charset=utf-8")
      .header("access-control-allow-origin", "*")
      .header("cache-control", "public, max-age=300, s-maxage=300")
      .header("x-pcc-snippet-version", SNIPPET_VERSION);
    return SNIPPET_BODY;
  });

  // /onboard/snippet.json — for dashboard / programmatic consumers
  app.get("/onboard/snippet.json", async (_req, reply) => {
    reply.header("access-control-allow-origin", "*");
    return {
      version: SNIPPET_VERSION,
      gateway: "https://capability.network",
      body: SNIPPET_BODY,
      npx: "npx @pcc/onboard",
      docs: "https://capability.network",
    };
  });
}
