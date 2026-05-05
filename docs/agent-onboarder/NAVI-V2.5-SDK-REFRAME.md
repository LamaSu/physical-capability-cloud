# Navi v2.5 — From Industrial-Operator Tool to Orchestrator SDK

**Date:** 2026-04-28
**Trigger:** User vision expansion mid-Wave-2: *"we want this tool to be for orchestrators, more of an sdk kind of thing… automate any part of any business… optimize any part of any business with AI… encompass any digital capability."*

This reframes Navi from a vertical (industrial operator onboarding to PCC) into a horizontal (an orchestrator SDK + template library that lets anyone wire any business process — physical or digital — onto PCC's substrate).

---

## 1. The shift in three sentences

| Before (v2) | After (v2.5) |
|---|---|
| `@pcc/agent-onboarder` onboards machine shops, fleets, and labs to PCC | `@pcc/orchestrator-sdk` lets anyone build an onboarding/automation/optimization agent for any business process — and the machine-shop case is one of many shipped templates |
| One brain, four doorways (phone/chat/MCP/REST) | Same four doorways, but the brain is configurable per-template |
| PCC handles physical capabilities (kernels, devices, captures) | PCC handles physical AND digital capabilities (kernels for shops, kernels for SaaS APIs, kernels for AI models, kernels for data products) |

The substrate (PCC) is already neutral about whether a kernel is a physical shop or a digital service. v2.5 just stops treating the agent-onboarder as the only consumer.

---

## 2. New package boundaries

```
physical-capability-cloud/
├── packages/
│   ├── orchestrator-sdk/                  ← NEW · the horizontal core
│   │   └── src/
│   │       ├── core/
│   │       │   ├── llm-agent.ts          (already in agent-runtime — re-exported here)
│   │       │   ├── state-machine.ts      (template-driven, schema-defined states)
│   │       │   ├── event-bus.ts          (already exists)
│   │       │   ├── snapshot.ts           (deterministic replay)
│   │       │   └── runner.ts             (the wave-orchestration loop, similar to /go's logic)
│   │       ├── adapters/
│   │       │   ├── voice/                (Pipecat plugin contract)
│   │       │   ├── chat/                 (HTTP + WS contract for any UI)
│   │       │   ├── mcp/                  (MCP-server scaffolding)
│   │       │   └── data/                 (dlt-runtime contract)
│   │       ├── tools/
│   │       │   ├── web-extract.ts        (camoufox+Claude — already ported)
│   │       │   ├── pcc-discovery.ts      (already ported)
│   │       │   ├── static-mirror.ts      (already ported)
│   │       │   ├── wallet.ts             (viem — already ported)
│   │       │   └── connectors/           (registered dlt-source factories)
│   │       └── templates/
│   │           └── registry.ts           (loads templates by slug, validates, runs)
│   │
│   ├── template-physical-operator/        ← (formerly @pcc/agent-onboarder)
│   │   └── src/
│   │       ├── manifest.ts               (slug, system prompt, required adapters)
│   │       ├── flow.ts                   (state machine instance)
│   │       └── tests/
│   │
│   ├── template-saas-customer/            ← NEW · onboard a SaaS company's workflow
│   ├── template-data-product/             ← NEW · publish a dataset as a paid PCC capability
│   ├── template-ai-model-publisher/       ← NEW · ship an AI model as a PCC kernel
│   ├── template-fleet-operator/           ← NEW · vehicles + dispatch (digital cousin of physical-operator)
│   ├── template-warehouse-operator/       ← NEW
│   ├── template-lab-operator/             ← NEW
│   └── template-knowledge-worker/         ← NEW · automate a single human role's workflow
│
├── packages/agent-runtime/                ← extend with LLMAgent (DONE in 43cd105)
├── packages/onboard-kit/                  ← stays — physical-side device adapter library
├── packages/digital-kit/                  ← NEW · digital-side analog of onboard-kit
│       └── src/templates/                 (rest-api, graphql, mcp, kafka, postgres-source)
│
└── apps/dashboard/                        ← bravo's chat + operator UI generalizes:
    ├── routes/orchestrator/[template]/chat   ← was /onboard/chat
    └── routes/<entity-type>/[id]              ← was /operator/[id]
        (entity-type: operator | data-product | ai-model | knowledge-worker | …)
```

---

## 3. The template contract

A template is a tiny declarative manifest plus a flow file. Anything else inherits from the SDK.

```typescript
// packages/template-physical-operator/src/manifest.ts
import { defineTemplate } from "@pcc/orchestrator-sdk";

export default defineTemplate({
  slug: "physical-operator",
  display_name: "Physical Operator",
  description: "Onboard a machine shop, fleet, lab, or warehouse to PCC.",

  // What kind of PCC entity this template produces
  produces: { kind: "kernel-agent", capability_class: "physical" },

  // Adapter requirements — SDK auto-wires these
  adapters: {
    chat: { required: true },
    voice: { required: false, fallback: "chat" },
    mcp:  { required: false }
  },

  // Connectors the template might need to attach to the operator's existing systems
  connectors_optional: [
    "postgres", "salesforce", "sharepoint", "sap", "csv",
    "octoprint", "modbus", "opcua", "sila", "generic-http"
  ],

  // The system prompt that drives the LLM during this template's flow
  system_prompt: `You are the PCC physical-operator onboarder. ...`,

  // The state machine — declarative; the SDK runner walks it
  flow: () => import("./flow.js")
});
```

Anyone (you, a customer, an open-source contributor) can write a new `template-X` package that imports `@pcc/orchestrator-sdk` and exports the above. The dashboard auto-discovers them via the registry; the gateway routes `/api/orchestrator/<slug>/*` automatically.

---

## 4. Generalizing the entity model

PCC's existing types focus on physical primitives (kernel, device, capture, evidence). v2.5 adds:

| Entity kind | Examples | Already in PCC? |
|---|---|---|
| `kernel-agent` (physical) | Machine shop, fleet, lab | ✅ |
| `kernel-agent` (digital) | SaaS workflow API, MCP server, hosted model | partially — kernel-sdk supports digital, just no templates yet |
| `data-product` | "Real-time Postgres of titanium parts pricing" | NEW (use `@pcc/digital-kit/templates/postgres-source`) |
| `ai-model` | "GPU-served inference for surface defect detection" | NEW (use `@pcc/digital-kit/templates/inference-endpoint`) |
| `knowledge-worker` | "Automate the 'review purchase orders' workflow" | NEW (purely human-input-driven flow) |

The PCC `agent-package` (218 tools today) needs minimal additions — mostly registry-side: `register_data_product`, `register_ai_model`, `match_digital_capabilities`. Most of the existing 218 tools (auth, escrow, evidence, settlement, reputation) work for digital just as well as physical.

---

## 5. What the dashboard becomes

bravo's port at `apps/dashboard/src/routes/onboard/chat` and `apps/dashboard/src/routes/operator/[id]` was scoped to physical-operator. Generalize:

```
/orchestrator                   ← landing: pick a template
/orchestrator/[slug]/chat       ← the onboarding/automation flow for any template
/orchestrator/[slug]/voice      ← phone hand-off for that flow

/entity                         ← directory of all PCC entities (kernel-agents, data-products, ai-models, …)
/entity/[type]/[id]             ← entity dashboard (operator-style for physical; spec-sheet-style for digital)

/marketplace                    ← buyer side: search across all entity types
/marketplace?match=<query>      ← unified ranked match (replaces Senso/cited.md)
```

Bravo's components (`ChatThread`, `ActivityFeed`, `input-parser`, `activity-feed-logic`) all generalize cleanly — they don't assume "operator." Just rename the route and feed it the chosen template's system prompt + flow.

---

## 6. Migration plan v2.5 (delta from v2)

Wave 2 stays largely the same but gets a name change at the end:
- alpha's `@pcc/agent-onboarder` becomes `@pcc/template-physical-operator` (rename + thin SDK extraction)
- alpha's `LLMAgent` in `@pcc/agent-runtime` stays
- Most of `@pcc/agent-onboarder/src/tools/*` migrates to `@pcc/orchestrator-sdk/src/tools/*`
- bravo's UI routes get re-namespaced under `/orchestrator/[slug]/`

Net additions over v2:
- New package: `@pcc/orchestrator-sdk` (extract the horizontal core)
- New package: `@pcc/digital-kit` (digital-side analog of onboard-kit)
- New `defineTemplate()` contract + registry
- 3-5 starter digital templates (data-product, ai-model, saas-customer, knowledge-worker)
- Dashboard route generalization (`/orchestrator/[slug]/chat`)

**Wave breakdown updated:**

| Wave | Days | Focus | What changes from v2 |
|---|---|---|---|
| 0 | ✓ DONE | tag · branch · docs | (no change) |
| 1 | ✓ DONE | Vendor-free swaps in v1 | (no change) |
| 2 | partial (alpha+bravo committed pre-quota) | Port to PCC packages | Rename target: `@pcc/agent-onboarder` → `@pcc/template-physical-operator` + extract `@pcc/orchestrator-sdk` |
| **2.5** | **NEW · 3 days** | **SDK extraction + template contract + 2 starter digital templates** | NEW |
| 3 | 3 | Voice (Pipecat) + connectors (dlt) | adapter contracts move into SDK |
| 4 | 3 | Production hardening (RLS · auth · persistence) | (no change) |
| 5 | 1 | Freeze v1 + sunset Railway/Vapi/InsForge | (no change) |

Total estimate moves from 14 working days → 17 working days.

---

## 7. Why this matters strategically

**v2 (pre-reframe):** Navi is a *feature* of PCC for one vertical. Useful, narrow, ships in 2-3 weeks.

**v2.5 (post-reframe):** Navi is a *platform* on top of PCC. Anyone can ship a new business-automation template in a day by writing a manifest + system prompt + connector list. The flywheel: each template that ships proves the SDK; each customer using a template surfaces gaps the SDK has to fill; each new entity type expands what PCC can monetize.

The substrate (PCC's discovery + escrow + reputation + verification) was always built to be neutral — v2.5 just stops calling it a "physical capability cloud" and starts treating it as a **capability cloud, period**.

> Branding note: the "Physical" prefix is now a *legacy* qualifier. The substrate handles digital capabilities natively. Marketing doesn't need to change immediately, but eventually `physical-capability-cloud` becomes `capability-cloud` (the actual domain `capability.network` already drops the "physical" — good intuition there).

---

## 8. What unblocks Wave 2.5 starting *after the quota resets*

1. **Rename gate**: confirm `@pcc/agent-onboarder` → `@pcc/template-physical-operator`. Cheap, clean.
2. **SDK extraction**: identify the universal vs vertical bits in alpha's package.json + src/ — extract universal to `@pcc/orchestrator-sdk`.
3. **2 starter digital templates** to prove the contract works:
   - `template-data-product` (publish a queryable dataset as a PCC kernel)
   - `template-knowledge-worker` (automate a single recurring human task)
4. **Dashboard route generalization**: bravo's routes get prefixed under `/orchestrator/[slug]/`.

All of this is achievable inside the existing Wave 2 worktree — no new branches needed. Reuses the work alpha + bravo already shipped.

---

## 9. Honest caveats

- This expands the surface area significantly. Don't ship 10 templates day-one; ship the SDK + 1 physical template + 1 digital template, then add templates by demand.
- The `defineTemplate()` contract WILL evolve as we ship templates. Don't lock the schema in a v1; it's intentionally a living contract for the first 6 months.
- Some of PCC's terminology (kernel, capture, evidence) is physical-flavored. We'll need to either generalize the language (entity, snapshot, attestation) or accept the legacy and document the digital mapping (digital kernel = "always-on service", digital capture = "API call/snapshot at time T", digital evidence = "signed log + result hash").
- Buyer-side UX: the marketplace currently surfaces operators. Adding data-products and ai-models means the matching UI needs to handle different result shapes per entity type. ~1 day of dashboard polish at Wave 5.

---

## 10. Bottom line

**Wave 2 work that landed before the rate limit IS RIGHT** — just needs a rename pass and an SDK extraction pass on top. Nothing thrown away.

After the 4:50pm quota reset, the smart next move is a **single agent** (not parallel — we just hit the wall) that does the rename + SDK extraction in one focused 90-minute Ralph loop. After that lands, we re-evaluate parallelism.

See `NAVI-V2-MIGRATION-PLAN.md` for the wave-by-wave detail; this doc is the architectural delta.
