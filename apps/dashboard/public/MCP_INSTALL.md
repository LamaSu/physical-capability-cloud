# Connect Claude Desktop, Claude Code, or any MCP client to PCC

The Physical Capability Cloud ships an MCP (Model Context Protocol) server
that exposes 63 of the gateway's most-used tools — capability discovery,
contract building, job submission, escrow lifecycle, evidence verification,
Story Protocol royalties, fiat on/off-ramps — over the standard MCP stdio
transport. Any MCP-compatible client speaks to it: Claude Desktop, Claude
Code CLI, Cursor, Goose, ChatGPT Apps, your own MCP host.

This page is the 5-minute install. The detailed package README lives at
`C:\Users\globa\pcc-onboard-ui\packages\mcp-server\README.md` (or
[GitHub](https://github.com/LamaSu/physical-capability-cloud/tree/master/packages/mcp-server)).

## 30-second install

Pick the install path that matches how you got the code.

### Claude Code CLI

```bash
claude mcp add pcc -- npx -y @pcc/mcp-server
```

Or with an environment override pointing at the live gateway:

```bash
claude mcp add pcc --env PCC_URL=https://capability.network -- npx -y @pcc/mcp-server
```

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`
(macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "pcc": {
      "command": "npx",
      "args": ["-y", "@pcc/mcp-server"],
      "env": {
        "PCC_URL": "https://capability.network"
      }
    }
  }
}
```

Restart Claude Desktop. The 63 PCC tools appear in the tool list.

### Smithery (Cursor, Goose, any Smithery host)

```bash
smithery install @pcc/mcp-server
```

Smithery config lives at
`C:\Users\globa\pcc-onboard-ui\packages\mcp-server\smithery.yaml` and
declares the `pccUrl` + `pccApiKey` config schema so the host can prompt
you for both at install time.

### From source (this repo)

If you don't want to wait for the npm publish:

```bash
pnpm --filter @pcc/mcp-server build
```

Then point your MCP client at the built file:

```json
{
  "mcpServers": {
    "pcc": {
      "command": "node",
      "args": ["C:/Users/globa/pcc-onboard-ui/packages/mcp-server/dist/index.js"],
      "env": { "PCC_URL": "https://capability.network" }
    }
  }
}
```

## Authentication

Most read endpoints work without an API key. Write endpoints (registering
a kernel, funding escrow, claiming royalties) need one.

Provision one — no signup form, the gateway mints it:

```bash
curl -X POST https://capability.network/api/auth/provision \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","name":"Your operator name"}'
```

Save the `api_key` from the response. Pass it via `PCC_API_KEY`:

```json
{
  "mcpServers": {
    "pcc": {
      "command": "npx",
      "args": ["-y", "@pcc/mcp-server"],
      "env": {
        "PCC_URL": "https://capability.network",
        "PCC_API_KEY": "pcc_live_..."
      }
    }
  }
}
```

## Verify the install

After the MCP server is installed, run this probe to confirm the tools
loaded and reach the live gateway:

```bash
claude mcp list
```

You should see `pcc` in the output. Then ask Claude in chat:

> Using the pcc MCP tools, list capability types.

Claude calls `pcc_list_capabilities` and returns a comma-separated list of
the active types on the network (3d-printing, cnc, hplc, etc.).

Alternative manual probe (without an MCP client):

```bash
curl -s https://capability.network/api/capabilities/types | python -m json.tool
```

Same response shape as the MCP tool returns; verifies your network can
reach the gateway.

## What's in it

63 tools across these surfaces:

| Surface | Example tools |
|---|---|
| Discovery | `pcc_list_capabilities`, `pcc_search_capabilities`, `pcc_list_kernels`, `pcc_get_kernel` |
| Contract build | `pcc_build_options`, `pcc_calculate_price`, `pcc_build_contract` |
| Jobs | `pcc_list_jobs`, `pcc_get_job`, `pcc_subnet_status` |
| Escrow | `pcc_list_escrows`, `pcc_get_evidence` |
| Evidence | `pcc_list_evidence`, `pcc_get_evidence` |
| Setup / onboarding | `pcc_setup_detect`, `pcc_setup_generate_config`, `pcc_setup_validate_config`, `pcc_setup_register_device`, `pcc_setup_test_job`, `pcc_setup_status` |
| CSD registry | `pcc_csd_list`, `pcc_csd_get`, `pcc_csd_register` |
| Discovery / onboarding | `pcc_discover_scan`, `pcc_discover_onboard` |
| Story Protocol IP | `pcc_ip_register_capability`, `pcc_ip_revenue_snapshot`, `pcc_ip_claim`, `pcc_ip_lineage`, `pcc_ip_set_splits` |
| Sovereign Wealth Fund | `pcc_swf_summary`, `pcc_swf_participant_dashboard`, `pcc_swf_list_proposals` |
| Fiat ramp | `pcc_get_wallet_balance`, `pcc_get_funding_options`, `pcc_create_onramp_session`, `pcc_submit_withdrawal`, `pcc_send_enterprise_payout` |
| DePIN + rewards | `pcc_depin_stats` |
| Reputation | `pcc_get_reputation`, `pcc_get_agent_identity` |
| Protocols | `pcc_list_protocols`, `pcc_compile_workflow` |
| Sensors | `pcc_list_sensors`, `pcc_get_sensor_data` |

Full schema for every tool ships in the package's source at
`C:\Users\globa\pcc-onboard-ui\packages\mcp-server\src\`.

## Three other ways to talk to PCC

The MCP server is one of three independent surfaces. Pick the one that
matches your client:

| Client | Best surface | Endpoint |
|---|---|---|
| Claude Desktop, Claude Code, Cursor, Goose, ChatGPT Apps | **MCP** (this page) | `npx -y @pcc/mcp-server` |
| ChatGPT Custom GPTs, OpenAI Custom Tools, Codex, Anthropic Custom Tools, Zapier, n8n, Make | **OpenAPI 3.0.3** | `https://capability.network/openapi.json` (700+ paths) |
| A2A-native agents, your own LLM tool-use loop, any HTTP-aware agent | **agent-package.json** | `https://capability.network/agent-package.json` (248 tools, system prompt, input schemas, endpoint mappings) |

Any of the three gives full read access. Write access needs the same
Bearer token across all three.

## Troubleshooting

**`claude mcp list` shows pcc but every tool call fails with 401.**
The API key isn't being passed. Confirm `PCC_API_KEY` is in the `env`
block of your MCP config (above). If you used the npm shortcut, the
key must be on the install command's env or the calling process's env.

**Server starts but no tools appear.**
The Claude Desktop tool registry caches per session. Quit completely
(not just close window — `Cmd-Q` on macOS) and reopen.

**Connection refused / can't reach capability.network.**
Verify direct gateway reach: `curl -s https://capability.network/api/health`.
Should return `{"status":"ok"}`. If that fails, the issue is network-level,
not MCP-level.

**Want to point at a self-hosted gateway.**
Set `PCC_URL` to your endpoint. The default is `https://capability.network`.
For a local dev gateway: `PCC_URL=http://localhost:3200`.

## Where this is headed

The MCP server is one of four surfaces in PCC's connection matrix. Each
mature MCP host (Claude Desktop, Cursor, Goose, etc.) lights up the
substrate's full toolset on install. Once `@pcc/mcp-server` ships to the
public npm registry (tracking issue: the package is `private: true` in
the monorepo today), the install shortens to one line: every client
adopting MCP gains PCC capabilities by typing the server's name.

The substrate underneath does not change between MCP, OpenAPI, A2A, or
agent-package paths. Pick the path your client speaks; the network is
the same.
