# @pcc/adk

The PCC Agent Development Kit (**working name**): the one package for building, publishing and running capabilities on PCC (ledger R4).

**Status:** interface work. The package is `"private": true` until the operator decides npm publishing and the public name (operator queue 36, D1 and D2). Nothing here publishes anything.

## What it depends on

Only the public `@pcc/spec` and `@pcc/kernel-sdk`, and their third-party dependencies (today `tweetnacl`, `@noble/hashes` and `zod`). `scripts/clean-install-check.mjs` checks this when it runs. It is not in CI yet; what it checks is listed under [Clean external install](#clean-external-install-scriptsclean-install-checkmjs).

## Public surface today

The surface is an explicit list. A test pins it, so any new export is a reviewed change.

- `buildManifest` from `@pcc/kernel-sdk`: a pure builder for a digital kernel's manifest.
- **The pinned agent package.** The ADK carries no hand-written tool JSON (#2392):
  - `AGENT_PACKAGE_PIN`: `{ schema, version, toolCount, sha256 }` of the exact `agent-package.json` bytes the dashboard serves.
  - `AGENT_TOOLS`: each tool's `{ method, path, required }`, generated.

    Both are deeply frozen. `resolveToolRequest` and `checkAgentPackage` never read them after load; they use private copies.
  - `resolveToolRequest(name, input, { baseUrl })`: a tool call becomes `{ method, url, body? }` against the configured gateway. It is pure: no network and **no credentials**, so the caller decides where a key may go. It refuses:
    - tools whose endpoint is not a gateway path (the `http://localhost:3200/...` class), or not a well-formed one (an unknown method, a query, fragment, backslash, percent-escape or dot segment in the path, a malformed placeholder);
    - input that is not plain JSON data: accessors, class instances, `toJSON`, symbols, holes, cycles, non-finite numbers;
    - `.` or `..` as a path parameter;
    - a base URL that is not plain http(s).

    It reads the input once into a plain snapshot. The required check, the path parameters, the query and the body all come from that snapshot. Path parameters are URL-encoded.
  - `checkAgentPackage(text)`: compares a live `/agent-package.json` with the pin (sha256, version and tool count). A match says the bytes are the pinned ones. It does not authenticate the server that sent them, because anyone can serve these public bytes, so a match is no reason to send that server a key.
- **Operator sessions:** `buildOperatorSignInMessage`, `mintOperatorSessionKey`, `createOperatorSessionKeeper`, and `OperatorSessionError` provide origin-bound wallet sign-in and in-memory session key renewal.

Not in the kit yet: `@pcc/kernel-sdk`'s registration client and job handler.

Next, per the reconciliation note (`returns/pcc-adk.md`):

- the provenance planner (D2, `planProvenance` in `@pcc/spec`, PR #406);
- the CapabilityProject driver (D4);
- economics helpers (D6).

## Operator session keys

`createOperatorSessionKeeper` obtains a public nonce, builds a fixed EIP-4361 message for the gateway's **public origin** (including its Host port), asks your operator wallet to sign the message with EIP-191 `personal_sign`, verifies that signature, and requests a session-scoped API key. Each renewal signs in on a **fresh session** before the current key becomes unusable. The gateway, not the kit, establishes authority and grants scopes. Session keys prove the signer wallet only on a gateway version that actually proves session-key SIWE addresses; their scopes alone do not confer decision authority.

Bring your own wallet library and signing capability: the kit has no wallet, chain client, or signer dependency. A viem *local account* can supply a callback (the wallet itself must be secured by the host):

```ts
import { createOperatorSessionKeeper } from "@pcc/adk";

// `account` is a viem LocalAccount supplied and secured by your host.
const keeper = createOperatorSessionKeeper({
  baseUrl: "https://gw.example:8443", // your trusted gateway deployment's public origin
  address: account.address,
  chainId: 84532,
  signMessage: (message) => account.signMessage({ message }),
});

// During startup, race readiness against YOUR startup deadline / shutdown signal.
const firstKey = await Promise.race([
  keeper.ready(),
  new Promise<null>(resolve => setTimeout(() => resolve(null), 15_000)),
]);
if (firstKey === null) {
  await keeper.stop();
  throw new Error("operator session unavailable before startup deadline");
}

// For EACH request, acquire the current key; never cache it across renewal.
const key = keeper.key();
if (key === null) {
  // Do not send a request while there is no usable key.
} else {
  const hostKernelId = "your-host-kernel-id";
  const reply = await fetch(`https://gw.example:8443/api/operator/jobs?kernelId=${encodeURIComponent(hostKernelId)}`, {
    redirect: "error",
    headers: { Authorization: `Bearer ${key.apiKey}` },
  });
  if (reply.status === 401) keeper.invalidate(key.keyId);
  // Never invalidate for 403: a scope/proof refusal is not key expiry.
}

// During graceful shutdown:
await keeper.stop();
```

Use the same trusted, authenticated public HTTPS gateway origin for your own job requests; the helper binds **its** requests to `baseUrl`, but does not make your other HTTP clients origin-safe. Plain HTTP is accepted only for loopback development (`localhost`, `127.0.0.1`, `[::1]`). The helper never sends the minted API key itself: your host sends it only in `Authorization: Bearer <key>` on your own requests. Never write keys to disk, logs, telemetry or exception messages; keep them in memory. The helper does not log, persist secrets or hold a chain client.

Run **one keeper per host**, with a separate sign-in session per keeper; never share a session token between hosts, since re-minting on the same session revokes that session's prior keys. A keeper retains its session privately so `stop()` can log out and revoke its active key, and can log out an invalidated key. `invalidate(key.keyId)` is appropriate only after a **401 from a request that carried that exact key**, not after a 403 or a late 401 for an older key. When the keeper has no usable key, `key()` returns `null`; `ready()` waits across retries and is not itself a startup timeout.

`mintOperatorSessionKey` is the one-shot alternative. It returns a key but does **not** keep its SIWE session, so that key **cannot be revoked through this helper** and instead lives until its expiry. Use the keeper if your host needs timely renewal and revocation. The sign-in statement is fixed to `Sign in to Physical Capability Cloud as an operator host.` and a host's scoped signer may pin that exact text. The host clock must not lag the gateway by more than five minutes: the gateway rejects older SIWE messages. A crash can leave the last key active for **up to 12 hours**, and the gateway allows **at most five active API keys per operator**. Plan restarts and monitoring accordingly.

## Scripts

| Script | What it does |
|---|---|
| `pnpm --filter @pcc/adk generate` | Regenerates `src/generated/agent-pin.ts` from `apps/dashboard/public/agent-package.json`. |
| `pnpm --filter @pcc/adk check:generated` | Exits 1 if the pin is stale. The unit tests check the same thing, and CI's build-and-test job runs the unit tests. |
| `pnpm --filter @pcc/adk check:clean-install` | The clean external install (below). |

**When the agent package changes, regenerate the pin in the same PR.** The test `is generated from the package the dashboard serves, byte for byte` fails until you do.

## Clean external install (`scripts/clean-install-check.mjs`)

This proves an operator's project can install and use the kit without npm and without this workspace.

1. **Clean build.** Delete the `dist/` of `@pcc/spec`, `@pcc/kernel-sdk` and `@pcc/adk` in this workspace, and rebuild them, so no stale build output can be packed.
2. **Pack** each one. `pnpm pack` rewrites `workspace:*` to real versions.
3. **Boundary gate** on every tarball. The rules live in `scripts/boundary-policy.mjs` and are unit-tested in `src/__tests__/boundary-policy.test.ts`. It fails on any of these:
   - `workspace:` left anywhere, or a bundled dependency;
   - a dependency spec that is not a registry range (`file:`, `link:`, git, a URL, …);
   - a dependency that is an `@pcc/*` package outside the packed set or private in the workspace, or a chain client (`viem`, `ethers`, `wagmi`, the `@ethersproject/*` family, …). An `npm:` alias is checked by its target too. The one exception is an optional peer that `scripts/boundary-policy.mjs` lists, with its reason, for the package that declares it, and that `peerDependenciesMeta` marks optional (today only `viem`, for `@pcc/spec`); any other optional peer fails;
   - any payload file other than `package.json`, README, LICENSE, and `dist/` build output that has a matching `src/` source;
   - payload text that looks like a secret: a private key block, a PCC, AWS, GitHub, Stripe or Slack token, or a secret-valued key field.
4. **Install.** Create a consumer project **outside the workspace** (under `$TMPDIR`) that depends on the adk tarball, with `pnpm.overrides` pointing `@pcc/spec` and `@pcc/kernel-sdk` at their tarballs. Install it **offline** from the local pnpm store, so no network is used.
5. **Installed graph.** Check every package in the consumer's pnpm store, by the name in its own `package.json`, for chain clients and for `@pcc/*` packages outside the kit. This covers transitive dependencies. Each listed optional peer must be absent, and no module reached from an entry of `@pcc/adk`'s `exports` map may import it: `scripts/import-graph.mjs` follows the JavaScript and the type declarations into `@pcc/spec`, `@pcc/kernel-sdk` and every other installed package.
6. **Import** the kit from plain Node ESM, and **type-check** a TypeScript consumer against the installed declarations. The import check also fails if the kit exports a registration client or a kernel handler.

The chain-client list and the secret patterns are lists of known names and shapes. They catch those, not every possible chain client or secret.

Run it like this. Pass `--keep` to keep the temp project.

```
PNPM_STORE_DIR=/path/to/pnpm-store TMPDIR=/some/tmp pnpm --filter @pcc/adk check:clean-install
```

It is not in CI yet. Adding a CI step is a `ci.yml` change, which needs operator approval.
