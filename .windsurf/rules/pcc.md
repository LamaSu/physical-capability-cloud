---
trigger: always_on
---

# PCC — Physical Capability Cloud

"AWS for the physical world": a cloud control plane where AI agents discover,
negotiate, and orchestrate real-world physical capabilities — 3D printing, CNC
machining, lab automation, couriers — through on-chain milestone escrow with
cryptographic evidence. Operators register what their machines can do; agents
handle the rest. Live at https://capability.network.

## Repo shape (pnpm + turbo, Node ≥20, TypeScript ESM)

- `packages/spec` — types, Zod schemas, single source of truth. No other package defines wire types.
- `packages/gateway` — Fastify HTTP gateway (40+ route files, SSE streams).
- `packages/kernel` — Shop Kernel runtime (device adapters, evidence emitter); the sole interface to a physical site.
- `packages/mcp-server` — PCC MCP tools over stdio.
- `packages/kernel-sdk` — `@pcc/kernel-sdk`: SDK for building third-party digital kernels.
- `apps/dashboard` — Vite + React 19 dashboard.

Full package map + key files: `AGENTS.md`. Full project context: `CLAUDE.md`.

## Invariants

- Evidence bundles are content-addressed (SHA-256 of canonical JSON); on-chain state stores hashes only, never raw data.
- Every capability has an assurance tier (0–3); escrow settles only when evidence meets the tier's requirements.

## Agent entry points

- Agent package (REST tools + system prompt): `apps/dashboard/public/agent-package.json`, live at https://capability.network/agent-package.json
- Skill file: `skills/pcc/SKILL.md`
- MCP server: hosted Streamable HTTP at `https://capability.network/mcp` (see `.windsurf/mcp_config.json`), or local stdio via `node packages/mcp-server/dist/index.js` with `PCC_URL=https://capability.network`.

## Dev commands

```bash
pnpm install
pnpm build --concurrency=1                 # sequential — parallel builds OOM on low-RAM machines
pnpm --workspace-concurrency=1 -r test     # 3300+ tests
pnpm dev                                    # dashboard :5173, gateway :3200
```

License: Apache-2.0.
