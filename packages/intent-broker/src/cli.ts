#!/usr/bin/env node

/**
 * @pcc/intent-broker — stdio CLI entry point.
 *
 * Boots an MCP server on stdin/stdout. Logs go to stderr so they don't
 * interfere with the MCP wire protocol on stdout.
 *
 * Usage:
 *   PCC_API_KEY=pcc_live_... npx @pcc/intent-broker
 *
 * Add to Claude Desktop / Cursor / Goose / ChatGPT Apps config:
 *   {
 *     "mcpServers": {
 *       "pcc-intent-broker": {
 *         "command": "npx",
 *         "args": ["-y", "@pcc/intent-broker"],
 *         "env": { "PCC_API_KEY": "pcc_live_..." }
 *       }
 *     }
 *   }
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createIntentBrokerServer, loadConfig } from "./server.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  const server = createIntentBrokerServer({ config: cfg });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(
    `[intent-broker] running (ingestUrl=${cfg.ingestUrl}, apiKey=${cfg.apiKey ? "set" : "MISSING"})\n`,
  );
}

main().catch((err) => {
  process.stderr.write(
    `[intent-broker] fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
