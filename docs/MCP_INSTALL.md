# Connect an MCP client to PCC

This page has one copy:
[`apps/dashboard/public/MCP_INSTALL.md`](../apps/dashboard/public/MCP_INSTALL.md),
which the gateway also serves at https://capability.network/MCP_INSTALL.md.

The short version: the gateway serves MCP over Streamable HTTP, so there is
nothing to install.

```bash
claude mcp add --transport http pcc https://capability.network/mcp
```

Read-only tools work without a key. For the rest, provision one with
`POST /api/auth/provision` and send it as `Authorization: Bearer <key>`.

> **Looking for the lightest path?** If you have Claude Max, the agent package
> plus the skill is enough, with no MCP server at all. See
> [`docs/quickstart/`](quickstart/) (visualized at https://capability.network/start).
