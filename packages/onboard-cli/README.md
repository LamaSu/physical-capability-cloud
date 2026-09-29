# @pcc/onboard

A terminal walkthrough for **Physical Capability Cloud** (PCC).

The @pcc packages are not on npm yet, so run it from a clone of the repository:

```bash
git clone https://github.com/LamaSu/physical-capability-cloud
cd physical-capability-cloud
pnpm install
pnpm --filter "@pcc/onboard..." build
node packages/onboard-cli/dist/cli.js
```

The CLI talks to **capability.network** through your own Anthropic key,
end to end. The same 219-tool agent package that drives the dashboard
chat at https://capability.network/onboard/chat drives this CLI too — so
whatever the in-browser agent can do for you, this can do, in your
terminal.

## Why this exists

Three ways for a layperson to onboard to PCC:

1. **Chat in the browser** — https://capability.network/onboard/chat
2. **Paste a prompt into your own AI** — Claude.ai, ChatGPT, Cursor,
   Gemini, etc. Run the CLI with `--print-snippet` to grab it.
3. **This CLI** (`packages/onboard-cli`) — talks to the gateway from
   your laptop with your own Anthropic key, no browser required.

All three paths end up at the same place: a real registered capability,
kernel, or channel on https://capability.network.

## Install / run

From the repository root, after the build above:

```bash
node packages/onboard-cli/dist/cli.js                                  # default: live chat
node packages/onboard-cli/dist/cli.js --role buyer                     # bias the opener
node packages/onboard-cli/dist/cli.js --gateway http://localhost:3000  # local dev gateway
node packages/onboard-cli/dist/cli.js --print-snippet                  # print the prompt; exit
node packages/onboard-cli/dist/cli.js --help                           # all flags
```

## Configuration

The CLI reads, in priority order:

1. CLI flag (`--api-key`, `--gateway`, `--model`, `--role`)
2. Environment variable
3. `~/.pcc/config.json` (only written when you pass `--persist`)

| Setting | Flag | Env | File key |
|---|---|---|---|
| Anthropic API key | `--api-key` | `ANTHROPIC_API_KEY` | `anthropicApiKey` |
| Gateway URL | `--gateway` | `PCC_GATEWAY_URL` (or `PCC_URL`) | `gatewayUrl` |
| Model | `--model` | `ANTHROPIC_MODEL` | `model` |
| PCC bearer (optional) | `--pcc-key` | — | — |

If `ANTHROPIC_API_KEY` is unset, the CLI prompts you once (interactive
shells only). Use `--persist` to save the resolved settings to
`~/.pcc/config.json` with mode `0600`.

## What the CLI actually does

```
┌──────────────┐    ┌──────────────────────────────────────────┐
│  this CLI    │    │  https://capability.network              │
│  onboard     │    │                                          │
│              │    │  GET /agent-package.json                 │
│ 1. fetch agent-pkg ──────────────────────────────────────→   │
│ 2. read system_prompt + 219 tools                            │
│                                                              │
│ 3. send user msg to Anthropic ──→ Anthropic Messages API     │
│    (model: claude-sonnet-4-6)                                │
│                                                              │
│ 4. for each tool_use block:                                  │
│    POST /api/kernels  ──────────────→ Gateway                │
│    GET  /api/capabilities/types ────→ Gateway                │
│    (Authorization: Bearer if --pcc-key)                      │
│                                                              │
│ 5. feed tool_result back to Anthropic                        │
│    until stop_reason = end_turn                              │
└──────────────┘    └──────────────────────────────────────────┘
```

Hard caps per user turn:

- 8 LLM round-trips
- 12 tool calls

These match the gateway's `/api/onboard/chat` endpoint (#159) so the CLI
and the dashboard behave identically.

## Privacy

- Your transcript stays on your machine. The CLI never POSTs the
  conversation anywhere except Anthropic.
- The CLI never reads `~/.pcc/config.json` unless you've previously
  written it with `--persist`.
- `--print-snippet` makes zero network calls.

## License

Apache-2.0
