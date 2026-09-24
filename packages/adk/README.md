# @pcc/adk

The PCC Agent Development Kit (**working name**): the one package for building, publishing and running capabilities on PCC (ledger R4).

**Status:** interface work. The package is `"private": true` until the operator decides npm publishing and the public name (operator queue 36, D1 and D2). Nothing here publishes anything.

## What it depends on

Only the public `@pcc/spec` and `@pcc/kernel-sdk`. No private `@pcc/*` package, no chain client, and no `workspace:` specifier survives packing. `scripts/clean-install-check.mjs` enforces all three.

## Public surface today

- Everything `@pcc/kernel-sdk` exports: the digital-kernel backend (R2). That includes `buildManifest`, `createKernelHandler`, `registerKernel` and `verifyBundleSignature`.
- **The pinned agent package.** The ADK carries no hand-written tool JSON (#2392):
  - `AGENT_PACKAGE_PIN`: `{ schema, version, toolCount, sha256 }` of the exact `agent-package.json` bytes the dashboard serves.
  - `AGENT_TOOLS`: each tool's `{ method, path, required }`, generated.
  - `resolveToolRequest(name, input, { baseUrl })`: a tool call becomes `{ method, url, body? }` against the configured gateway. It is pure: no network and **no credentials**, so the caller decides where a key may go. It refuses:
    - tools whose endpoint is not a gateway path (the `http://localhost:3200/...` class);
    - `.` or `..` as a path parameter;
    - a base URL that is not plain http(s).

    Path parameters are URL-encoded.
  - `checkAgentPackage(text)`: compares a live `/agent-package.json` with the pin (sha256, version and tool count).

Next, per the reconciliation note (`returns/pcc-adk.md`):

- the provenance planner (D2, `planProvenance` in `@pcc/spec`, PR #406);
- the CapabilityProject driver (D4);
- economics helpers (D6).

## Scripts

| Script | What it does |
|---|---|
| `pnpm --filter @pcc/adk generate` | Regenerates `src/generated/agent-pin.ts` from `apps/dashboard/public/agent-package.json`. |
| `pnpm --filter @pcc/adk check:generated` | Exits 1 if the pin is stale. The unit tests check the same thing. |
| `pnpm --filter @pcc/adk check:clean-install` | The clean external install (below). |

**When the agent package changes, regenerate the pin in the same PR.** The test `is generated from the package the dashboard serves, byte for byte` fails until you do.

## Clean external install (`scripts/clean-install-check.mjs`)

This proves an operator's project can install and use the kit without npm and without this workspace.

1. **Build and pack** `@pcc/spec`, `@pcc/kernel-sdk` and `@pcc/adk`. `pnpm pack` rewrites `workspace:*` to real versions.
2. **Boundary gate** on every tarball. It fails on any of these:
   - `workspace:` left anywhere;
   - an `@pcc/*` dependency outside the packed set, or private in the workspace;
   - a chain client (`viem`, `ethers`, `wagmi`, …);
   - a key or env file in the payload.
3. **Install.** Create a consumer project **outside the workspace** (under `$TMPDIR`) that depends on the adk tarball, with `pnpm.overrides` pointing `@pcc/spec` and `@pcc/kernel-sdk` at their tarballs. Install it **offline** from the local pnpm store, so no network is used.
4. **Import** the kit from plain Node ESM, and **type-check** a TypeScript consumer against the installed declarations.

Run it like this. Pass `--keep` to keep the temp project.

```
PNPM_STORE_DIR=/path/to/pnpm-store TMPDIR=/some/tmp pnpm --filter @pcc/adk check:clean-install
```

It is not in CI yet. Adding a CI step is a `ci.yml` change, which needs operator approval.
