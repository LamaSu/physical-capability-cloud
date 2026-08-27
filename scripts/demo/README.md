# buyer-agent — the BUYER side of the "an agent mails a letter" demo

A standalone Node script whose **brain is AIsa** (OpenAI-compatible chat
completions, model `deepseek-v3.1`) and whose **tools are PCC's own agent
package**. It fetches `agent-package.json`, translates every `tools[]` entry into
an OpenAI function-calling tool, and executes a tool call by making the HTTP
request the tool's `endpoint` describes against `PCC_BASE` with
`Authorization: Bearer $PCC_API_KEY`.

It is the mirror of the operator/seller side: this agent *buys* a physical
outcome ("print this 3-page PDF and mail it") using nothing but PCC's public
tool surface.

## What it does

1. Describes the job in natural language.
2. Lets the brain drive: it calls `pcc_submit_request` → `POST /api/requests`.
   Prints the decomposed capability **DAG** and the **MATCHED** node.
3. Polls `GET /api/job-offers/open?capabilityType=<type>` until an offer appears.
   The operator-side bridge (PR #294) is what *publishes* offers; until it merges
   this legitimately returns `0`, and the script says so — it never fakes an
   offer.
4. **Negative control**: polls a `capabilityType` nobody offers. It must also
   return `0`, so an empty live feed is never mistaken for "no work".
5. Writes a timestamped transcript of every model turn and every HTTP call to
   stdout **and** to `ai/research/buyer-transcript.md`.

## Run it (local mock gateway — the safe default)

```bash
# 1. Start a local gateway in mock/in-memory mode (from the repo root):
cd packages/gateway
PORT=3200 PCC_DB_PATH=:memory: WORKFLOW_DB_PATH=:memory: \
  NODE_ENV=development PCC_AGENTIC_DECOMPOSE_DISABLED=1 \
  pnpm exec tsx src/server.ts

# 2. Provision a PCC key (public endpoint) and export it:
export PCC_API_KEY=$(curl -s -X POST http://localhost:3200/api/auth/provision \
  -H 'Content-Type: application/json' -d '{"email":"buyer-demo@example.com"}' \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.parse(s).api_key))")

# 3a. Real brain (spends a few AIsa calls):
export AISA_API_KEY=sk-...        # your AIsa key
PCC_BASE=http://localhost:3200 node scripts/demo/buyer-agent.mjs

# 3b. Keyless local run (no AIsa credit) — scripted planner, labelled [MOCK-LLM]:
PCC_BASE=http://localhost:3200 \
  AGENT_PACKAGE_URL=apps/dashboard/public/agent-package.json \
  node scripts/demo/buyer-agent.mjs --mock-llm
```

The script **refuses to run** without `PCC_API_KEY` (always) and without
`AISA_API_KEY` (unless `--mock-llm`). Keys are read from env only — never stored
in the repo.

## Environment

| Var | Default | Purpose |
|-----|---------|---------|
| `AISA_API_KEY` | — (required unless `--mock-llm`) | Bearer for AIsa |
| `PCC_API_KEY` | — (required) | Bearer for PCC tool calls |
| `PCC_BASE` | `http://localhost:3200` | PCC gateway. **Never** prod unless set to it |
| `AISA_BASE` | `https://api.aisa.one/v1` | OpenAI-compatible base |
| `AISA_MODEL` | `deepseek-v3.1` | Model id |
| `AGENT_PACKAGE_URL` | `https://capability.network/agent-package.json` | Tool source (file path OK for hermetic runs) |
| `BUYER_MAX_TOOLS` | all (253) | Cap tools exposed to the model (cost control) |
| `BUYER_MAX_TURNS` / `BUYER_MAX_TOOL_CALLS` | `4` / `3` | Brain budget ceilings |
| `BUYER_POLL_ATTEMPTS` / `BUYER_POLL_DELAY_MS` | `5` / `2000` | Offer polling |
| `TRANSCRIPT_PATH` | `ai/research/buyer-transcript.md` | Transcript output |

Pointing `PCC_BASE` at `capability.network` prints a loud PROD warning; the
default keeps you on localhost.

## Tests

Pure helpers (`toOpenAiTool[s]`, `buildEndpointMap`, `buildToolRequest`,
`extractDecomposition`, `deriveCapabilityType`, `buildAisaPayload`, …) are
verified by `buyer-agent.test.mjs` — including the whole real 253-tool
`agent-package.json`. Run:

```bash
packages/gateway/node_modules/.bin/vitest run \
  --root scripts/demo --config scripts/demo/vitest.config.mjs
```

The network round-trips (AIsa completion, PCC HTTP) are exercised end-to-end by
running the script against a local gateway with `--mock-llm`; the schema
translation is what the vitest locks down so it stays correct as the package
grows.
