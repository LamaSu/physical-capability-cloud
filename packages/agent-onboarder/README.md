# @pcc/agent-onboarder

Agent-driven operator onboarding for the Physical Capability Cloud. Drives the
"website -> live PCC capability listing" flow that used to live in the
hackathon-era `LamaSu/navi` backend.

## Public exports

```ts
import {
  OnboarderAgent,           // main class — wraps LLMAgent + 5 tool callers
  ONBOARDER_SYSTEM_PROMPT,  // discovery flow system prompt
  startSession,             // state-machine: started -> ... -> built
  getSession,
  advanceSession,
  extractStructured,        // camoufox + Claude tool-use scrape
  publishOperator,          // POST /api/onboard/register + DHT announce
  writeOperatorMirror,      // static SEO HTML + JSON-LD
  createAgentWallet,        // viem-only Base Sepolia wallet
  searchCapabilities,       // PCC capability search
} from "@pcc/agent-onboarder";
```

## Quickstart

```ts
import { OnboarderAgent } from "@pcc/agent-onboarder";

const onboarder = new OnboarderAgent();
const result = await onboarder.chat(
  "I run Oakland Titanium Mills, my site is https://oaklandtitanium.example",
);
console.log(result.text);
// "Got it — pulled 3 machines from your site. Look right?
//  1) Mazak Integrex i-400 — 5-axis mill-turn ..."
```

## Tool surface (5 callable from the LLM)

| Tool | Purpose |
|---|---|
| `extract_url` | camoufox + Claude tool-use scrape of an operator's website |
| `search_pcc` | search PCC's existing capability network |
| `publish_operator` | POST `/api/onboard/register` + best-effort DHT announce |
| `write_static_mirror` | generate the operator's static SEO mirror (HTML + JSON-LD) |
| `create_wallet` | viem-only Base Sepolia wallet (no CDP gating) |

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | required for non-mock paths | Anthropic SDK auth |
| `MOCK_WEB_EXTRACT` | `false` | Skip camoufox + Claude in tests |
| `MOCK_PCC_DISCOVERY` | `true` (until `false`) | Skip live `/api/onboard/register` |
| `MOCK_CDP` | `true` (until `false`) | Skip viem private-key generation |
| `PCC_BASE_URL` | `https://capability.network` | Override gateway URL |
| `PCC_API_KEY` | `""` | Bearer token for DHT announce (optional) |
| `WEB_EXTRACT_MODEL` | `claude-sonnet-4-5` | Override extraction model |
| `WEB_EXTRACT_HTML_LIMIT` | `100000` | Max HTML chars sent to Claude |
| `CAMOUFOX_BIN` | `camoufox` | Override stealth fetch binary path |

## Migration context

This package was created in **Wave 2** of the Navi v2 migration (2026-04-24).
See:

- [NAVI-V2-MIGRATION-PLAN.md](../../docs/agent-onboarder/NAVI-V2-MIGRATION-PLAN.md)
- [NAVI-V2-TARGET-ARCHITECTURE.md](../../docs/agent-onboarder/NAVI-V2-TARGET-ARCHITECTURE.md)

Pending work (in priority order):

- **Wave 2.5**: integrate `BaseAgent` from `@pcc/agent-runtime` so
  `OnboarderAgent extends BaseAgent` and gets the wallet + messaging
  primitives for free. Currently OnboarderAgent ships standalone with a
  TODO marker.
- **Wave 3**: voice doorway via `@pcc/voice-onboarder` (Pipecat) routes its
  tool calls through `OnboarderAgent`'s HTTP API. The brain stays here.
- **Wave 4**: replace the in-memory `state-machine.ts` Map with PCC's
  Postgres + RLS so sessions resume across restart.
