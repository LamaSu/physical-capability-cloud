# Third-Party Digital Kernel Marketplace

Opens the PCC digital kernel layer to external builders. Any developer can author a digital kernel, register it with a PCC gateway, pass a touchstone smoke test, and be listed in the marketplace — where jobs can be routed to them.

## Architecture

```
┌──────────────┐   POST /api/kernels/register   ┌──────────────────┐
│  Builder     │ ───────────────────────────► │  PCC Gateway     │
│  (3rd party) │                              │  (this service)  │
│              │ ◄─── 201 {kernelId, pending} │                  │
└──────────────┘                              │   in-memory      │
       │                                      │   registry       │
       │ POST /api/kernels/:id/verify         │                  │
       └────────────────────────────────────► │                  │
                                              │                  │
           smoke test (HTTPS POST)            │                  │
       ◄────────────────────────────────────  │                  │
       200 OK   ─────────────────────────────►│ mark as verified │
                                              └──────────────────┘
                                                       │
                                                       ▼
                                         GET /api/kernels/marketplace
                                             lists verified kernels
```

**Components**

| Component | Package | Role |
|-----------|---------|------|
| `DigitalKernelManifest` type | `@pcc/spec` | Declarative registration payload |
| `buildManifest()` helper | `@pcc/kernel-sdk` | Construct a structurally valid manifest |
| `createKernelHandler()` | `@pcc/kernel-sdk` | Fastify-compatible request handler |
| `registerKernel()` | `@pcc/kernel-sdk` | Client to POST a manifest to a gateway |
| `/api/kernels/register` route | `@pcc/gateway` | Manifest validation + in-memory registry |
| `/api/kernels/marketplace` | `@pcc/gateway` | Public discovery listing |
| `/api/kernels/:id/verify` | `@pcc/gateway` | Admin smoke-test runner |
| `/api/kernels/:id/suspend` | `@pcc/gateway` | Admin suspension |

## Required Dependencies

```bash
pnpm add @pcc/kernel-sdk @pcc/spec tweetnacl
```

## Step-by-Step: Register a Kernel

### 1. Author your kernel's logic

Write a `execute(input)` function that takes a JSON object and returns a JSON-serialisable output. Determinism is strongly encouraged — reproducibility is how callers audit your work.

```typescript
async function convertCelsiusToFahrenheit(input: Record<string, unknown>) {
  const celsius = Number(input.celsius);
  if (!Number.isFinite(celsius)) throw new Error("input.celsius must be a number");
  return {
    celsius,
    fahrenheit: Number(((celsius * 9) / 5 + 32).toFixed(4)),
  };
}
```

### 2. Build a manifest

```typescript
import { buildManifest } from "@pcc/kernel-sdk";

const manifest = buildManifest({
  kernelId: "k-temp-converter-acme",
  name: "Celsius → Fahrenheit Converter",
  description: "Unit conversion kernel, deterministic, 4-decimal output.",
  builder: {
    agentId: "eip155:84532:0x…your-registered-agent…" as const,
    contactURI: "mailto:support@acme.example",
  },
  capabilityType: "temperature-converter",
  workflowSteps: [
    { stepId: "parse", stepType: "validate", description: "Validate input", dependsOn: [] },
    { stepId: "convert", stepType: "transform", description: "C to F", dependsOn: ["parse"] },
  ],
  pricing: { baseUSD: 0.001 },
  maxAssuranceTier: 1,
  endpointURL: "https://kernel.acme.example/run",
  sessionKeyPolicy: {
    maxTTLSeconds: 600,
    allowedActions: ["evidence_submit", "workflow_step_complete"],
  },
});
```

**Field reference**

| Field | Constraint |
|-------|-----------|
| `manifestVersion` | Must be `"1.0.0"` — set automatically by `buildManifest`. |
| `kernelId` | Globally unique. Use DNS-style prefixing (e.g. `k-temp-converter-acme`). |
| `builder.agentId` | ERC-8004 registered agent id. Reputation flows to this identity. |
| `endpointURL` | Must be HTTPS. HTTP is rejected at register time. |
| `workflowSteps` | At least one step required. Each step contributes one evidence event. |
| `maxAssuranceTier` | Integer `0..3`. Higher tiers require richer evidence (camera, TEE, etc.). |
| `pricing.currency` | USDC only in v1. |
| `sessionKeyPolicy.maxTTLSeconds` | Conservative default is 3600. Increase only if your jobs are long-running. |

### 3. Build the request handler

```typescript
import { createKernelHandler } from "@pcc/kernel-sdk";

const handler = createKernelHandler({
  manifest,
  principalKey,                 // Your persisted PrincipalKey
  principalPrivateKey,          // 64-byte tweetnacl secret key
  execute: convertCelsiusToFahrenheit,
});

// Wire into Fastify (Express / Hono / etc. also work — the handler is a plain async fn).
fastify.post("/run", async (req) => handler(req.body));
```

The handler:
1. Verifies the inbound sessionKey signature (if `auth` is provided).
2. Mints a kernel session key (signed by your principalKey).
3. Calls `execute(input)` and times it.
4. Builds an `EvidenceBundle` with `execution_started`, one `workflow_step_completed` per manifest step, and `execution_completed` events.
5. Signs the bundle hash with the kernel session key.
6. Returns `{ evidenceBundle, output, kernelSessionPublicKey }`.

### 4. Register with a gateway

```typescript
import { registerKernel } from "@pcc/kernel-sdk";

const response = await registerKernel("https://capability.network", manifest, {
  apiKey: process.env.PCC_API_KEY,
});
console.log(response.kernelId, response.status); // "k-temp-…", "pending"
```

### 5. Trigger verification (smoke test)

Once registered, the kernel is `pending`. The gateway needs to confirm the endpoint is reachable. Either an admin or the builder themselves can trigger verification:

```bash
# Self-verify (works when the request carries X-Agent-Id header matching builder.agentId)
curl -X POST -H "X-Agent-Id: eip155:84532:0x…" \
  https://capability.network/api/kernels/k-temp-converter-acme/verify

# Admin-verify (when PCC_ADMIN_KEY is set server-side)
curl -X POST -H "X-Admin-Key: $PCC_ADMIN_KEY" \
  https://capability.network/api/kernels/k-temp-converter-acme/verify
```

The gateway POSTs `{jobId: "smoke-…", dryRun: true, input: {smokeTest: true}}` to the kernel's `endpointURL`. A 2xx response marks the kernel `verified` and it becomes visible in the marketplace.

## Marketplace Discovery

```bash
# List all verified kernels
curl https://capability.network/api/kernels/marketplace

# Filter by capabilityType
curl "https://capability.network/api/kernels/marketplace?capabilityType=temperature-converter"

# Only tier-2 or higher
curl "https://capability.network/api/kernels/marketplace?minAssuranceTier=2"

# Sort by price ascending
curl "https://capability.network/api/kernels/marketplace?sortBy=price"

# Sort by reputation-backed assuranceScore
curl "https://capability.network/api/kernels/marketplace?sortBy=assuranceScore"
```

Response:
```json
{
  "kernels": [
    {
      "kernelId": "k-temp-converter-acme",
      "name": "Celsius → Fahrenheit Converter",
      "description": "Unit conversion kernel, deterministic, 4-decimal output.",
      "capabilityType": "temperature-converter",
      "builder": { "agentId": "eip155:84532:0x…", "contactURI": "mailto:…" },
      "pricing": { "currency": "USDC", "baseUSD": 0.001 },
      "maxAssuranceTier": 1,
      "endpointURL": "https://kernel.acme.example/run",
      "status": "verified",
      "verifiedAt": "2026-04-14T21:00:00.000Z"
    }
  ],
  "count": 1
}
```

Single-kernel lookup: `GET /api/kernels/marketplace/:kernelId` returns the full manifest (including workflowSteps + sessionKeyPolicy).

## Reputation & Suspension Rules

### Reputation

Every execution emits an `EvidenceBundle` signed by a kernel session key whose `parentSignature` links back to the `builder.agentId`. Reputation feedback (ERC-8004) is therefore always attributed to the builder's persistent identity — rotating session keys does not launder bad behaviour.

Reputation tags applied by the PCC reputation facade:
- `assurance` — per assurance tier (higher tier = more weight)
- `completionRate` — fraction of jobs that completed vs. errored
- `responseTime` — P50 wall-clock for `execute()`
- `evidenceCompleteness` — fraction of expected events present in the bundle

### Suspension

The `/api/kernels/:kernelId/suspend` endpoint is admin-only. Admins suspend kernels for:
- Repeated smoke-test failures after verification (operational silence)
- Evidence tampering (signature mismatches)
- Abuse reports (prompt injection, malicious output)
- Legal takedown

Suspended kernels:
- Disappear from `/api/kernels/marketplace` listings
- Return `410 Gone` on `/marketplace/:kernelId` lookups (not 404 — the kernel exists but is muted)
- Retain their historical evidence bundles (nothing is deleted)

The builder can contest a suspension by contacting the gateway operator via the `contactURI` that PCC has on file for their `builder.agentId`.

## Example Code

A full end-to-end example lives at [`scripts/example-third-party-kernel.ts`](../scripts/example-third-party-kernel.ts):

```bash
# Dry-run: validate the manifest + print a sample signed evidence bundle
npx tsx scripts/example-third-party-kernel.ts --dry-run

# Live: register with a local gateway + start serving on port 3333
npx tsx scripts/example-third-party-kernel.ts --gateway=http://localhost:3200
```

The example is a deterministic Celsius-to-Fahrenheit converter — short enough to read in one sitting, complete enough to copy and customise.

## Roadmap

Planned follow-ups (not in v1):
- Persist the registry to the gateway's SQLite store (replacing the in-memory Map).
- Dispatch a real touchstone task during `/verify` (current smoke test is a dry-run POST).
- Gate suspension appeals behind a SWF governance vote.
- Publish the manifest schema as JSON Schema for external validators.
