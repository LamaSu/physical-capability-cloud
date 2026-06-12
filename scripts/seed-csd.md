# seed-csd — CSD catalog seeder

Registers the top-50 Capability StructureDefinition (CSD) catalog against a PCC
gateway so a freshly-deployed instance has a capability vocabulary for the
**compose engine** and **graph-search** to plan against. Operators later register
their concrete CapabilityInstances against these CSDs.

## Run

```bash
PCC_BASE=http://localhost:8080 PCC_API_KEY=pcc_live_... pnpm tsx scripts/seed-csd.ts
```

- `PCC_BASE` — gateway base URL. Default `http://localhost:8080`.
- `PCC_API_KEY` — bearer token. Optional; sent as `Authorization: Bearer <key>`
  when set. Omit it for a local gateway that doesn't enforce auth on this route.

## What it does

- Reads `scripts/seed-csd-catalog.json` (50 CSDs).
- POSTs each CSD to `POST /api/csd` on the target gateway — the register route in
  `packages/gateway/src/routes/csd.ts`.
- Prints a progress bar and a final `registered / skipped / failed` summary.
- Exits non-zero if any CSD failed to register.

No external dependencies — it uses native `fetch` (Node ≥ 18) and `node:fs`.

## Idempotency

- The in-memory `CsdRegistry` overwrites on re-register, so re-running is safe and
  reports everything as `registered` again.
- A DB-backed gateway that enforces URL uniqueness returns HTTP `409`; those CSDs
  are counted as `skipped` and the run continues.

## Catalog (50 CSDs)

| Lane | Count | Examples |
|------|-------|----------|
| Machine — manufacturing | 10 | `3d-printing-fdm`, `cnc-milling`, `pcb-fabrication` |
| Machine — laboratory | 10 | `hplc`, `gc-ms`, `dna-sequencing` |
| Machine — agriculture/biology | 5 | `hydroponic-grow`, `mycelium-fermentation` |
| Human-skill | 10 | `courier`, `inspection`, `translation` |
| Asset | 10 | `warehouse-bay`, `compute-time-gpu`, `server-rack` |
| Computational | 5 | `llm-inference`, `image-generation`, `code-execution` |

Each CSD conforms to `CsdSchema` (`packages/spec/src/csd/schema.ts`): canonical
`url` (`pcc://capabilities/<slug>/v1`), semver `version`, `kind: "base"`, typed
`parameters` (enum/number/boolean/string), optional `constraints`, tiered
`evidence` (`tier0`–`tier3`), and `pricing`. Regulated lab/bio types (`hplc`,
`gc-ms`, `dna-sequencing`, `mass-spec`, `cell-culture`) define a tier-3
(Sovereign) evidence requirement; most others top out at tier 2.

## Endpoint note

The register route is **`POST /api/csd`** (not `/api/csd/register`). The CSD object
is the raw request body. Confirmed in `packages/gateway/src/routes/csd.ts` and
`packages/gateway/src/server.ts`.
