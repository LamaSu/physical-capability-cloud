# Research: Noir WASM in Docker for PCC ZK Proofs

**Date**: 2026-03-26
**Researcher**: Claude Opus 4.6 (1M context)
**Context**: PCC already has Noir circuits (`evidence_inclusion`, `tier_compliance`) with compiled JSON artifacts in `packages/verifier/circuits/*/target/`. The `NoirProofService` exists but falls back to mock proofs because `@noir-lang/noir_js` and `@noir-lang/backend_barretenberg` are devDependencies only, not production dependencies. Goal: make real ZK proofs work in the Railway Docker deployment.

---

## Executive Summary

**Noir WASM works in Node.js and Docker. The PCC repo is 90% there already.** The main gap is that the Noir packages are listed as devDependencies in `packages/verifier/package.json`, so they're not installed in production builds. Promoting them to dependencies and adjusting the import patterns will enable real ZK proof generation on Railway.

However, there is a **critical version mismatch** that must be resolved: the repo uses `@noir-lang/backend_barretenberg@^0.36.0` (old API) alongside `@noir-lang/noir_js@1.0.0-beta.19` (new API). These are from different eras of the Noir toolchain. The circuits were compiled with `nargo` and the JSON artifacts exist, but they need to be compiled with a matching `nargo` version.

---

## 1. Can Noir Compile Circuits to WASM?

**Yes, but you don't need to.** The workflow is:

1. **Compile circuits with `nargo compile`** (native CLI) -- produces `target/<name>.json` containing ACIR bytecode
2. **Load the JSON artifact in Node.js** via `@noir-lang/noir_js` -- this is a WASM package that executes the ACIR
3. **Generate/verify proofs** via `@aztec/bb.js` (Barretenberg backend) -- also WASM, no native deps

The WASM is in the npm packages themselves (`@noir-lang/noir_js`, `@aztec/bb.js`). You ship the pre-compiled circuit JSON, not the Noir source, to production.

**PCC already does this correctly**: the `.json` artifacts exist at:
- `packages/verifier/circuits/evidence_inclusion/target/evidence_inclusion.json` (73.5KB)
- `packages/verifier/circuits/tier_compliance/target/tier_compliance.json` (59.4KB)

## 2. Can noir_js Run in Node.js Without Native Dependencies?

**Yes.** Both `@noir-lang/noir_js` and `@aztec/bb.js` are pure WASM packages. They have zero native dependencies (no node-gyp, no C++ compilation, no system libraries).

Node.js has built-in WebAssembly support via the global `WebAssembly` object. The packages load their `.wasm` binaries at runtime.

### Package versions (current state of the art)

| Package | Latest Stable | Latest Beta | PCC Uses |
|---------|--------------|-------------|----------|
| `@noir-lang/noir_js` | 0.36.0 | 1.0.0-beta.19 | 1.0.0-beta.19 (devDep) |
| `@noir-lang/backend_barretenberg` | 0.36.0 | 1.0.0-beta.19 | ^0.36.0 (devDep) |
| `@aztec/bb.js` | 3.0.0-nightly.* | 3.0.0-nightly.20251104 | not installed |
| `nargo` (CLI) | 0.36.0 | 1.0.0-beta.18 | unknown |

### Critical: Version Alignment

The Noir ecosystem recently underwent a major API change:

**Old API (v0.x):**
```typescript
import { Noir } from "@noir-lang/noir_js";
import { BarretenbergBackend } from "@noir-lang/backend_barretenberg";

const backend = new BarretenbergBackend(circuit);
const noir = new Noir(circuit);
const { witness } = await noir.execute(inputs);
const proof = await backend.generateProof(witness);
const verified = await backend.verifyProof(proof);
```

**New API (v1.0.0-beta / bb.js 3.x):**
```typescript
import { Noir } from "@noir-lang/noir_js";
import { Barretenberg, UltraHonkBackend } from "@aztec/bb.js";

const barretenbergAPI = await Barretenberg.new();
const backend = new UltraHonkBackend(circuit.bytecode, barretenbergAPI);
const noir = new Noir(circuit);
const { witness } = await noir.execute(inputs);
const proof = await backend.generateProof(witness);
const verified = await backend.verifyProof(proof);
```

**PCC's current `noir.d.ts` declares the old API** (`@noir-lang/backend_barretenberg` with `BarretenbergBackend`), but the `package.json` has `@noir-lang/noir_js@1.0.0-beta.19` alongside `@noir-lang/backend_barretenberg@^0.36.0`. These may not be compatible.

### Recommendation: Pick ONE version line

**Option A: Stay on v0.36.0 (stable, proven)**
```json
{
  "dependencies": {
    "@noir-lang/noir_js": "0.36.0",
    "@noir-lang/backend_barretenberg": "0.36.0"
  }
}
```
- Recompile circuits with `nargo@0.36.0`
- Keep the existing `NoirProofService` API calls as-is
- Stable, well-tested

**Option B: Go to v1.0.0-beta (latest, UltraHonk)**
```json
{
  "dependencies": {
    "@noir-lang/noir_js": "1.0.0-beta.19",
    "@aztec/bb.js": "3.0.0-nightly.20251104"
  }
}
```
- Recompile circuits with `nargo@1.0.0-beta.18`
- Update `NoirProofService` to use `UltraHonkBackend`
- Beta, but UltraHonk is significantly faster than UltraPlonk

**For a hackathon: Option A is safer.** Option B is better long-term but risks breaking changes in beta.

## 3. Docker Compatibility

**Noir WASM works perfectly in Docker.** The WASM modules only need:
- Node.js >= 18 (for WebAssembly support)
- No system dependencies

### Docker considerations for Railway:

```dockerfile
FROM node:20-slim

# No additional system packages needed for Noir WASM
# No nargo needed at runtime - circuits are pre-compiled

WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build

CMD ["node", "packages/gateway/dist/server.js"]
```

The key insight: **`nargo` is a build-time tool, not a runtime dependency.** The circuits are compiled to JSON ahead of time and committed to the repo. The WASM packages load the JSON at runtime.

### Memory Considerations

Barretenberg WASM proof generation is memory-intensive:
- **Proof generation**: ~200-500MB RAM depending on circuit size
- **Proof verification**: ~50-100MB RAM
- Railway free tier: 512MB RAM. **This is tight.**
- Railway Pro tier: 8GB RAM. Should be fine.

For the hackathon, the circuits are small (73KB and 59KB compiled). Proof generation should work within 512MB, but monitor Railway memory usage.

### Multi-threaded WASM

Barretenberg supports multi-threaded WASM via `SharedArrayBuffer`. This requires:
- Node.js `--experimental-shared-memory` flag (or Node 20+ where it's default)
- In Docker: no special configuration needed

If you hit issues, disable threading:
```typescript
const backend = new BarretenbergBackend(circuit, { threads: 1 });
```

## 4. Current State of noir_js npm Packages

### Stability Assessment

| Package | Status | Notes |
|---------|--------|-------|
| `@noir-lang/noir_js@0.36.0` | Stable | Last major stable release |
| `@noir-lang/noir_js@1.0.0-beta.19` | Beta | Active development, API mostly frozen |
| `@noir-lang/backend_barretenberg@0.36.0` | Stable | Works with noir_js 0.36.0 |
| `@aztec/bb.js@3.0.0-nightly.*` | Nightly | Replaces backend_barretenberg in v1.0 |
| `@noir-lang/noir_wasm` | Exists | For in-browser compilation (not needed server-side) |

### API Surface

**`@noir-lang/noir_js`** exports:
- `Noir` class -- takes compiled circuit JSON, provides `execute(inputs)` -> `{ witness }`
- `InputMap` type -- `Record<string, string>` for circuit inputs
- Various helper utilities

**`@noir-lang/backend_barretenberg`** (v0.36.0) exports:
- `BarretenbergBackend` class -- constructor takes circuit, provides:
  - `generateProof(witness)` -> `{ proof: Uint8Array, publicInputs: string[] }`
  - `verifyProof(proofData)` -> `boolean`
  - `getVerificationKey()` -> `Uint8Array`
  - `generateRecursiveProofArtifacts(proof)` -- for recursive proofs
  - `destroy()` -- cleanup WASM resources

## 5. How to Make PCC's Noir Proofs Work in Production

### Step-by-step plan:

#### Step 1: Fix the dependency versions

In `packages/verifier/package.json`, move from devDependencies to dependencies and align versions:

```json
{
  "dependencies": {
    "@pcc/spec": "workspace:*",
    "@noir-lang/noir_js": "0.36.0",
    "@noir-lang/backend_barretenberg": "0.36.0",
    "starknet": "^9.4.2",
    "tweetnacl": "^1.0.3",
    "viem": "^2.21.0"
  }
}
```

#### Step 2: Recompile circuits with matching nargo version

```bash
# Install nargo 0.36.0
curl -L https://raw.githubusercontent.com/noir-lang/noirup/refs/heads/main/install | bash
noirup -v 0.36.0

# Recompile both circuits
cd packages/verifier/circuits/evidence_inclusion && nargo compile
cd packages/verifier/circuits/tier_compliance && nargo compile
```

The compiled JSON artifacts should be committed to the repo so they're available at deploy time.

**For Docker/CI**, add nargo to the build step:
```dockerfile
# Only needed if you want to compile circuits in CI
RUN curl -L https://raw.githubusercontent.com/noir-lang/noirup/refs/heads/main/install | bash
RUN ~/.nargo/bin/noirup -v 0.36.0
RUN cd packages/verifier/circuits/evidence_inclusion && ~/.nargo/bin/nargo compile
RUN cd packages/verifier/circuits/tier_compliance && ~/.nargo/bin/nargo compile
```

Or (simpler): just commit the compiled `.json` files and skip nargo in Docker entirely.

#### Step 3: Update NoirProofService for robustness

The current `NoirProofService` at `packages/verifier/src/noir-proof-service.ts` is already well-structured. The dynamic import pattern is good:

```typescript
try {
  this.noirModule = await import("@noir-lang/noir_js");
  this.backendModule = await import("@noir-lang/backend_barretenberg");
  this.noirAvailable = true;
} catch {
  this.noirAvailable = false;
}
```

This gracefully falls back to mock proofs if the packages aren't installed. Once they're in `dependencies`, they'll always be available in production.

Key changes needed:
1. Move packages from devDependencies to dependencies
2. Update `noir.d.ts` to match the actual API of the version you're using
3. Add error handling for WASM initialization failures
4. Add memory cleanup (`backend.destroy()`) after proof operations

#### Step 4: Node.js-specific WASM initialization

Unlike the browser tutorial (which requires explicit WASM init via `fetch()`), **Node.js handles WASM loading automatically** for these packages. The packages detect they're running in Node.js and load WASM from the file system.

No special initialization code needed beyond:
```typescript
import { Noir } from "@noir-lang/noir_js";
import { BarretenbergBackend } from "@noir-lang/backend_barretenberg";

// These "just work" in Node.js -- no WASM init ceremony needed
const backend = new BarretenbergBackend(circuit);
const noir = new Noir(circuit);
```

The `initACVM()` and `initNoirC()` calls in the official tutorial are for browser environments only.

#### Step 5: Example integration for PCC (complete working snippet)

```typescript
// packages/verifier/src/noir-proof-service.ts
// Updated for production deployment

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// These are now regular dependencies, not optional
import { Noir } from "@noir-lang/noir_js";
import { BarretenbergBackend } from "@noir-lang/backend_barretenberg";

interface CircuitArtifact {
  bytecode: string;
  abi: unknown;
}

interface CircuitInstance {
  noir: Noir;
  backend: BarretenbergBackend;
}

const __dir = dirname(fileURLToPath(import.meta.url));

async function loadCircuit(name: string): Promise<CircuitInstance> {
  const artifactPath = join(__dir, "..", "circuits", name, "target", `${name}.json`);
  const raw = await readFile(artifactPath, "utf-8");
  const artifact: CircuitArtifact = JSON.parse(raw);

  const backend = new BarretenbergBackend(artifact as any);
  const noir = new Noir(artifact as any);

  return { noir, backend };
}

// Generate an evidence inclusion proof
async function proveEvidenceInclusion(inputs: {
  merkle_root: string;
  leaf_hash: string;
  sibling_path: string[];
  path_indices: string[];
  tree_depth: string;
}): Promise<{ proof: Uint8Array; publicInputs: string[] }> {
  const { noir, backend } = await loadCircuit("evidence_inclusion");

  try {
    const { witness } = await noir.execute(inputs);
    const proof = await backend.generateProof(witness);
    return proof;
  } finally {
    // Clean up WASM resources
    backend.destroy();
  }
}

// Verify a proof
async function verifyProof(
  circuitName: string,
  proofData: { proof: Uint8Array; publicInputs: string[] },
): Promise<boolean> {
  const { backend } = await loadCircuit(circuitName);

  try {
    return await backend.verifyProof(proofData);
  } finally {
    backend.destroy();
  }
}
```

## 6. Alternative: Sindri Cloud Proving Service

If in-process WASM proving is too slow or too memory-intensive for Railway, **Sindri** offers a cloud proving API:

- **What**: Serverless ZK proof generation as a service
- **Supports**: Noir, Circom, and other frameworks
- **How**: Upload circuit, call API with inputs, get proof back
- **Pricing**: Free tier available, pay-per-proof after that
- **Docs**: https://sindri.app/docs/how-to-guides/frameworks/noir/

This would replace in-process Barretenberg with an HTTP call:

```typescript
// Upload circuit once
const circuitId = await sindri.createCircuit("evidence_inclusion", circuitJson);

// Generate proof via API
const proof = await sindri.prove(circuitId, inputs);
```

**For the hackathon**: in-process WASM is simpler and has no external dependency. Use Sindri only if you hit Railway memory limits.

## 7. Risks and Mitigations

| Risk | Severity | Mitigation |
|------|----------|------------|
| Version mismatch (nargo vs npm packages) | HIGH | Pin all versions to same release (0.36.0 or 1.0.0-beta.18) |
| Railway OOM during proof generation | MEDIUM | Monitor memory; use `threads: 1`; consider Sindri |
| Beta package breaking changes | MEDIUM | Pin exact versions, no ^ ranges |
| Slow proof generation (5-30s) | LOW | Cache proofs in DB (already done); generate async |
| WASM startup time (~2s first load) | LOW | Warm up on server start; cache circuit instances |

## 8. Recommended Action Plan (Hackathon Priority Order)

1. **Pin versions**: Change `packages/verifier/package.json` to use `@noir-lang/noir_js@0.36.0` and `@noir-lang/backend_barretenberg@0.36.0` as regular dependencies
2. **Recompile circuits**: Install `nargo@0.36.0`, recompile both circuits, commit the JSON
3. **Test locally**: Run the existing tests (`packages/verifier/src/__tests__/noir-proof-service.test.ts`)
4. **Deploy**: Push to Railway -- no Docker changes needed, WASM just works
5. **Monitor**: Watch Railway memory usage during proof generation

Total effort: ~2-3 hours, most of which is waiting for compilation and testing.

---

## Sources

- [Noir Documentation - Building a web app](https://noir-lang.org/docs/tutorials/noirjs_app)
- [Noir Quick Start](https://noir-lang.org/docs/getting_started/quick_start)
- [@noir-lang/noir_wasm npm](https://www.npmjs.com/package/@noir-lang/noir_wasm)
- [@noir-lang/backend_barretenberg npm](https://www.npmjs.com/package/@noir-lang/backend_barretenberg)
- [Noir v1.0.0-beta.18 Release](https://github.com/noir-lang/noir/releases/tag/v1.0.0-beta.18)
- [bb.js TypeScript Bindings (DeepWiki)](https://deepwiki.com/AztecProtocol/aztec-packages/3.2-blob-batching-and-kzg-evaluation-system)
- [Sindri Noir Integration](https://sindri.app/docs/how-to-guides/frameworks/noir/)
- [Nargo Commands Reference](https://noir-lang.org/docs/reference/nargo_commands)
