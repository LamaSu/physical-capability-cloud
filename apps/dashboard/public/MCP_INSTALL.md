# Connect Claude Code, Claude Desktop, or any MCP client to PCC

The PCC gateway serves an MCP (Model Context Protocol) server over Streamable
HTTP at **`https://capability.network/mcp`**. Its tools are generated from the
same agent package the gateway publishes (`/agent-package.json`), so they
follow the API as it changes. Any MCP client that can connect to a remote
(Streamable HTTP) server can use it.

The repository also has a local (stdio) server, `packages/mcp-server`, which
you can build from source. **It is not published to npm or Smithery yet**, so
there is no package to install from either registry. Publishing is an open
decision.

## 1. Get an API key

Read-only tools that call public endpoints work without a key. Everything else
needs one. The gateway mints a key without a signup form:

```bash
curl -X POST https://capability.network/api/auth/provision \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","name":"Your operator name"}'
```

The response shows `api_key` once. Keep it somewhere safe; below it appears as
`pcc_live_...`.

## 2. Connect

### Claude Code

```bash
claude mcp add --transport http pcc https://capability.network/mcp \
  --header "Authorization: Bearer pcc_live_..."
```

Or add it to a project's `.mcp.json`:

```json
{
  "mcpServers": {
    "pcc": {
      "type": "http",
      "url": "https://capability.network/mcp",
      "headers": { "Authorization": "Bearer pcc_live_..." }
    }
  }
}
```

### Other clients (Claude Desktop, Cursor, Goose, …)

If your client can add a remote MCP server by URL with a custom header, use
`https://capability.network/mcp` with the header
`Authorization: Bearer pcc_live_...`. If it runs only local (stdio) servers,
build the stdio server from source.

### From source (stdio)

```bash
git clone https://github.com/LamaSu/physical-capability-cloud.git
cd physical-capability-cloud
pnpm install
pnpm --filter @pcc/mcp-server build
```

Then point your client at the built file, using the absolute path of your clone:

```json
{
  "mcpServers": {
    "pcc": {
      "command": "node",
      "args": ["/absolute/path/to/physical-capability-cloud/packages/mcp-server/dist/index.js"],
      "env": {
        "PCC_URL": "https://capability.network",
        "PCC_API_KEY": "pcc_live_..."
      }
    }
  }
}
```

Set `PCC_URL` explicitly: the stdio server's built-in default is not
`capability.network`. Its tool list is maintained by hand, so it differs from
the remote endpoint's.

## 3. Verify

In Claude Code, `claude mcp list` should show `pcc`. Then ask:

> Using the pcc MCP tools, list the capability types.

To check that your network reaches the gateway at all, without an MCP client:

```bash
curl -s https://capability.network/api/capabilities/types | python -m json.tool
```

## Other ways to talk to PCC

The substrate is the same whichever surface your client speaks:

| Client | Surface | Endpoint |
|---|---|---|
| MCP hosts (Claude Code, Claude Desktop, Cursor, Goose, …) | **MCP** (this page) | `https://capability.network/mcp` |
| OpenAPI tool importers (Custom GPTs, Zapier, n8n, Make, …) | **OpenAPI** | `https://capability.network/openapi.json` |
| Your own tool-use loop, A2A agents, any HTTP-aware agent | **agent package** | `https://capability.network/agent-package.json` |

Writes need the same Bearer key on every surface.

## Troubleshooting

**Every tool call fails with 401.** The key is not reaching the server: check
the `Authorization` header (remote) or `PCC_API_KEY` in the `env` block
(stdio).

**Connection refused, or capability.network can't be reached.** Check direct
reach with `curl -s https://capability.network/api/health`. If that fails too,
the problem is the network, not MCP.

**A self-hosted gateway.** Remote: use your gateway's `/mcp` URL. Stdio: set
`PCC_URL` to your gateway, for example `http://localhost:3200` for a local
development gateway.
