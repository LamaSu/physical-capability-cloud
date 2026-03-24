## Landscape Report: MCP Server to CLI Conversion

**Generated**: 2026-03-24
**Problem**: Convert 49 PCC MCP server tools to CLI equivalents for lower token cost and MCP-free environments.

### Existing Solutions Found

| # | Solution | Stars | Recommendation |
|---|----------|-------|----------------|
| 1 | mcp2cli (knowsuchagency) | 1,700 | Adopt (runtime bridge, Python/uv) |
| 2 | clihub (thellimist) | 639 | Adopt (compiled Go binary per server) |
| 3 | mcp-cli (philschmid) | 1,000 | Extend (Bun-based lazy discovery) |
| 4 | mcptools (f) | 1,500 | Extend (Go Swiss Army Knife) |
| 5 | pi-mcp-adapter | 257 | Skip (Pi-specific) |
| 6 | mcp-to-pi-tools | 16 | Skip (stale, Pi-only) |
| 7 | mcp-cli-adapter | - | Skip (inverse: CLI→MCP) |

### Decision

**BUILD native CLI** in the existing TypeScript package. Rationale:
- PCC MCP tools are just HTTP wrappers around `pccFetch()` — trivial to expose as CLI
- Zero new dependencies (no Python/Go toolchain needed)
- Same package, same build step, same gateway URL
- mcp2cli/clihub solve the general case; we solved the specific case more efficiently

### Key Insight (from research)
"CLI Beats MCP for AI Agents" (Feb 2026) — 35x token reduction when models use familiar CLI patterns vs. loading MCP schemas. Models are trained on massive CLI corpora (git, docker, kubectl) and already know shell tools.
