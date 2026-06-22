# Claude Desktop Quickstart

PCC ships an MCP server (Model Context Protocol). Connect it once and
Claude Desktop gets 63 tools spanning kernels, jobs, escrow, evidence,
fiat ramps, DePIN rewards, IP licensing — everything you'd want.

## Option A: Run the MCP server locally

Best if you're developing or want offline access.

### 1. Install the server

```bash
git clone https://github.com/LamaSu/physical-capability-cloud
cd physical-capability-cloud
pnpm install
pnpm --filter @pcc/mcp-server build
```

### 2. Add to Claude Desktop config

Open `~/Library/Application Support/Claude/claude_desktop_config.json`
(macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows). Add:

```json
{
  "mcpServers": {
    "pcc": {
      "command": "node",
      "args": [
        "/absolute/path/to/physical-capability-cloud/packages/mcp-server/dist/index.js"
      ],
      "env": {
        "PCC_URL": "https://capability.network",
        "PCC_API_KEY": "pcc_live_..."
      }
    }
  }
}
```

Replace `/absolute/path/to/...` with where you cloned. Provision an API
key first if you don't have one:

```bash
curl -X POST https://capability.network/api/auth/provision \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com"}'
```

### 3. Restart Claude Desktop

The 63 PCC tools are now in Claude's tool palette. Try:

> "Order me a pizza for delivery to 728 Geary St SF."

Claude will use `pcc_search_capabilities`, `pcc_list_kernels`, and the
job-offer tools end-to-end.

## Option B: HTTP-only (no local install)

Don't want to clone the repo? Skip the MCP server and feed Claude
Desktop the agent-package URL directly:

> "Use this PCC spec: https://capability.network/agent-package.json. Order me a pizza for delivery to 728 Geary St SF."

Claude will fetch the JSON, read the system_prompt, and use WebFetch
to call the HTTP endpoints. Slower than MCP but zero install.

## What tools you get with MCP

| # | Tool | What it does |
|---|------|--------------|
| 1 | `pcc_list_capabilities` | All registered capability types |
| 2 | `pcc_search_capabilities` | Full-text + filter search |
| 3 | `pcc_list_kernels` | Kernel directory + status |
| 4 | `pcc_get_kernel` | Kernel details + devices |
| 5 | `pcc_list_jobs` | Job feed |
| 6 | `pcc_get_job` | Job detail + evidence |
| 7-9 | `pcc_build_*` | Contract building (options, price, contract) |
| 10-11 | `pcc_list_escrows`, `pcc_list_evidence` | Settlement + evidence |
| 12-14 | `pcc_list_protocols`, `pcc_depin_stats`, `pcc_subnet_status` | Protocols + DePIN |
| 15-19 | `pcc_*_identity`, `pcc_*_reputation`, `pcc_*_sensors`, `pcc_*_evidence` | Identity, rep, sensors |
| 22-29 | `pcc_setup_*` | Setup flow (detect, generate, validate, register, test) |
| 30-32 | `pcc_csd_*` | CSD (Capability StructureDefinition) registry |
| 33-34 | `pcc_discover_*` | Device discovery + auto-onboarding |
| 35-39 | `pcc_ip_*` | Story Protocol IP licensing |
| 40-42 | `pcc_swf_*` | Sovereign Wealth Fund participation |
| 43-49 | `pcc_*_wallet`, `pcc_*_onramp`, `pcc_*_withdrawal`, `pcc_*_payout` | Fiat ramps |
| 50+ | A2A, observability, agent feedback, more | |

Full list: `packages/mcp-server/README.md` in the repo.

## What if MCP doesn't fit?

Use the Claude Code skill instead — it's lighter weight and doesn't need
the desktop app. See [claude-code.md](./claude-code.md).

## Troubleshoot

| Symptom | Fix |
|---------|-----|
| Claude Desktop doesn't show the tools | Confirm the config JSON is valid (no trailing commas). Re-quit Claude Desktop completely, not just close the window. |
| `pcc_*` calls return 401 | `PCC_API_KEY` env in the MCP server config is missing or wrong. Re-provision and update. |
| MCP server crashes on launch | Run `node packages/mcp-server/dist/index.js` directly to see the error. Usually a missing build step. |
| Slow responses | Add `"PCC_TIMEOUT_MS": "30000"` to the env in the config. |

## More

- MCP server source: `packages/mcp-server/`
- Agent-package: https://capability.network/agent-package.json
- Other surfaces: [claude-code.md](./claude-code.md), [claude-web.md](./claude-web.md)
