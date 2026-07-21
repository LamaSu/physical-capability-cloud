# @pcc/adapter-galaxy-synbiocad

A PCC **digital-kernel** adapter for the [Galaxy-SynBioCAD](https://galaxy-synbiocad.org)
tool suite ([brsynth/galaxytools](https://github.com/brsynth/galaxytools)) — the
synthetic-biology / metabolic-engineering pipeline behind Faulon lab's
[Nature Communications 2022](https://www.nature.com/articles/s41467-022-32661-x) paper.

It exposes ~50 tools (RetroPath2.0, the rpTools suite, Selenzyme, PartsGenie,
OptDOE, DNA Weaver, DNA-Bot, LCR Genie, StrainDesign, iCFree, AMN/DAMN, …) as a
single catalog-driven kernel. Because Galaxy-SynBioCAD is **computational**, it
registers via `@pcc/kernel-sdk`'s `DigitalKernelManifest` + `createKernelHandler`
(not the physical `MachineAdapter` path). It composes with physical kernels:
*design a pathway → synthesize the DNA → run it on an OT-2 (via `@pcc/adapter-pylabrobot`)*.

## What ships

| Artifact | What it is |
|---|---|
| `src/catalog.json` | **63 tools, 491 typed input params, 87 outputs, 13 pipeline stages.** Every tool has a JSON-Schema (Draft-07) `input_schema` / `output_schema`. This is the menu agents choose from. |
| `getCatalog()` / `listTools()` / `searchTools()` / `toolsByStage()` | Catalog selection helpers. `listTools()` returns the advertised set (stable only; deprecated/draft excluded). |
| `toWorkflowStep(id)` | Turns any tool into a `DigitalWorkflowStep` (carries `inputSchema`/`outputSchema`/`dependsOn`) so Galaxy steps compose with physical steps in one CWM DAG. |
| `validateParams(tool, params)` | Dependency-free validation of params against a tool's schema (required / enum / min-max / unknown-key). |
| `GalaxyRestClient` | Runs tools over the live Galaxy REST API. |
| `MockGalaxyClient` | Deterministic, no-server transport (tests + `mockMode`). |
| `GalaxySynBioCadKernel` | Manifest + catalog-driven executor + signed job handler. |

## Quick start (mock — no server, no creds)

```ts
import { GalaxySynBioCadKernel, listTools, toolsByStage } from "@pcc/adapter-galaxy-synbiocad";

const kernel = new GalaxySynBioCadKernel({
  endpointURL: "https://my-kernel.example.com/run",
  builderAgentId: "eip155:84532:0xYourAgent",
  mockMode: true,
});

listTools({ stage: "retrosynthesis" });   // pick a tool from the catalog
toolsByStage();                            // browse the whole pipeline

const out = await kernel.execute({
  tool_id: "retropath2",
  params: {
    rulesfile: "hda-<datasetId>",          // a dataset ref: id | url | {src,...}
    source_inchi: "InChI=1S/C6H6/c1-2-4-6-5-3-1/h1-6H",
    max_steps: 3,
  },
});
// -> { provider, tool_id, stage, state: "ok", jobId, historyId, outputs }
```

## Going live (real Galaxy server)

```ts
const kernel = new GalaxySynBioCadKernel({
  endpointURL: "https://my-kernel.example.com/run",
  builderAgentId: "eip155:84532:0xYourAgent",
  galaxyUrl: process.env.GALAXY_URL,       // e.g. https://galaxy-synbiocad.org
  galaxyApiKey: process.env.GALAXY_API_KEY, // Galaxy → Preferences → Manage API key
});
```

Params are keyed by **dotted path** (`adv.topx`, `sink.emptysink`); the client maps
`.` → Galaxy's `|` nested-input convention and wraps `data` inputs as `{src,id}`.
Dataset inputs accept an existing history id (`"hda-..."`), a URL, or inline content
(`{src:"inline", content, ext}`) — inline/URL refs are staged via `/api/tools/fetch`
before the run.

> **Honest status:** live-verified against `galaxy-synbiocad.org` (v21.09, 350 tools) —
> `health()`, `listTools()`, and short-id → toolshed tool_id resolution all work. The
> **authenticated job-execution** path is implemented-to-spec + mock-tested but not yet
> run end-to-end against a live server (needs a Galaxy API key; anonymous writes → 403).
> Mock mode is fully working and is what CI runs.

## Deploy & register with a PCC gateway

Two turnkey scripts. The gateway touchstone POSTs `{jobId, dryRun:true, ...}` to your
endpoint and requires a 2xx — `serve.mjs` answers that (and runs real jobs):

```bash
# 1. serve the kernel's job handler on a port
PORT=8790 node scripts/serve.mjs

# 2. expose it on a public HTTPS URL (quick tunnel, or a real host)
cloudflared tunnel --url http://localhost:8790     # -> https://<name>.trycloudflare.com

# 3. register + self-verify (builder self-auth via X-Agent-Id)
GATEWAY_URL=https://pcc-gateway-staging.up.railway.app \
PCC_API_KEY=pcc_live_... \
ENDPOINT_URL=https://<name>.trycloudflare.com/ \
  node scripts/register-kernel.mjs
```

Get `PCC_API_KEY` from `POST <gateway>/api/auth/provision` (public). The gateway's kernel
registry is in-memory (self-clears on restart), so staging registration is low-stakes. For
production settlement, swap `createEphemeralHandler()` for
`kernel.createHandler({ principalKey, principalPrivateKey })` with an operator-owned Ed25519
key — the same one you bind via `registerKernel`'s `signingKey` option.

## Regenerating the catalog

The catalog is generated deterministically from the upstream Galaxy tool XMLs:

```bash
git clone --depth 1 https://github.com/brsynth/galaxytools.git scripts/galaxytools
python scripts/build_catalog.py          # writes galaxy-synbiocad-catalog.json
cp galaxy-synbiocad-catalog.json src/catalog.json
```

Only `<tool>`-rooted XMLs become capabilities (macros/config/SBML-model files are
auto-skipped); `<expand macro>` params (e.g. StrainDesign) are resolved; pipeline
stage + status (stable/experimental/deprecated/draft) are tagged.

## Design notes

- **One executor, catalog-driven.** Galaxy's REST API runs any tool uniformly by id,
  so all tools share one `execute({tool_id, params})` path — "all tools" is one
  executor + N typed manifests, not N× the code.
- **Types live in `@pcc/spec`.** This package defines no wire types of its own beyond
  the Galaxy-specific catalog shapes.
- **Zero heavy deps.** Runtime deps are `@pcc/spec`, `@pcc/kernel-sdk`, and `tweetnacl`
  (already used across PCC) — clean for Gate-A `/vet`.

## Build & test

```bash
pnpm --filter @pcc/adapter-galaxy-synbiocad build
pnpm --filter @pcc/adapter-galaxy-synbiocad test
```
