# @pcc/kernel-sdk

SDK for building **third-party digital kernels** on the [Physical Capability
Cloud](https://capability.network) (PCC) marketplace — manifest assembly, a
server-agnostic job handler, and gateway registration (including the Ed25519
settlement-signer bind).

A *digital kernel* is a hosted service that fulfils PCC jobs and returns a
signed evidence bundle. This SDK gives you the three pieces you need to put one
on the network: describe it (`buildManifest`), serve it (`createKernelHandler`),
and register it (`registerKernel`).

## Install

```bash
npm install @pcc/kernel-sdk
# or: pnpm add @pcc/kernel-sdk
```

ESM-only, Node ≥ 20. Depends on [`@pcc/spec`](https://www.npmjs.com/package/@pcc/spec)
(shared types/schemas) and `tweetnacl` (Ed25519).

## Quick start

```ts
import { buildManifest, registerKernel } from "@pcc/kernel-sdk";

// 1. Describe what your kernel does. buildManifest stamps sensible defaults
//    (manifest version, session-key policy, free-tier pricing) and validates
//    the required fields locally before the gateway ever sees them.
const manifest = buildManifest({
  kernelId: "my-kernel",
  name: "My Digital Kernel",
  builder: { agentId: "did:pcc:my-builder" },
  capabilityType: "research.report",
  endpointURL: "https://my-kernel.example.com/job", // must be HTTPS
  workflowSteps: [{ /* your step definitions */ }],
  maxAssuranceTier: 1,                               // 0–3
});

// 2. Register it with a PCC gateway. Returns { kernelId, status, ... }.
const res = await registerKernel("https://capability.network", manifest, {
  apiKey: process.env.PCC_API_KEY,
});
console.log(res.kernelId, res.status); // e.g. "my-kernel" "pending"
```

### Serving jobs

`createKernelHandler` wraps your `execute` function with inbound Ed25519
session-signature verification, a scope/expiry check against the manifest's
`sessionKeyPolicy`, and signed evidence-bundle assembly. It's a plain async
function (Fastify-compatible, but no hard Fastify dependency — wire it into
Express, Hono, or anything else) that you mount at your `endpointURL`:

```ts
import { createKernelHandler } from "@pcc/kernel-sdk";

// See the CreateKernelHandlerOptions type (src/job-handler.ts) for the full
// shape — it takes your manifest, the kernel's signing key, and execute().
const handler = createKernelHandler({ /* manifest, signing key, execute */ });

// Fastify example:
app.post("/job", async (req) => handler({ body: req.body }));
```

### Binding a settlement signer (optional, #235)

At settlement the gateway matches evidence signatures against a registered
Ed25519 signer. To bind that signer at registration time, pass `signingKey` to
`registerKernel` — it proves possession of the key via `POST /api/kernels`
after marketplace registration succeeds. The `principalPrivateKey` **must** be
the same key your handler uses to sign evidence bundles; `expectedPublicKey` is
mandatory confirmation you're binding the intended key. A mismatch throws
`KernelRegistrationError` rather than silently continuing.

## API

| Export | Kind | Purpose |
|--------|------|---------|
| `buildManifest(input)` | fn | Assemble a `DigitalKernelManifest` with defaults + local validation |
| `createKernelHandler(opts)` | fn | Server-agnostic job handler (session verify + evidence signing) |
| `registerKernel(gatewayUrl, manifest, opts?)` | fn | POST a manifest to a gateway; optional Ed25519 signer bind |
| `verifyBundleSignature(bundle, publicKey)` | fn | Verify a kernel-signed `EvidenceBundle` |
| `buildEd25519RegistrationProof(...)` | fn | Build the #235 signing proof from a principal key |
| `signingProofMessage(...)` | fn | The canonical message a registration proof signs |
| `toHex` / `fromHex` | fn | Hex ⇄ `Uint8Array` helpers |
| `KernelAuthError`, `KernelRegistrationError` | class | Typed errors |
| `ManifestBuilderInput`, `CreateKernelHandlerOptions`, `KernelJobRequest`, `KernelJobResponse`, `RegisterKernelOptions`, `RegisterKernelResponse`, `RegisteredSigner`, `SigningRegistrationResult`, `Ed25519RegistrationProof`, `Ed25519RegistrationKey` | type | Public types |

## Assurance tiers

Every capability declares a `maxAssuranceTier` (0–3) — how much evidence backs a
completed job, from self-attested (0) to full multi-verifier proof (3). Escrow
releases only when the submitted evidence meets the tier. Default to tier 1 for
standard production work.

## Links

- Network + docs: https://capability.network
- Agent package (REST tools): https://capability.network/agent-package.json
- Skill file: [`skills/pcc/SKILL.md`](https://github.com/LamaSu/physical-capability-cloud/blob/master/skills/pcc/SKILL.md)
- Repo + architecture: [`AGENTS.md`](https://github.com/LamaSu/physical-capability-cloud/blob/master/AGENTS.md)

## License

Apache-2.0
