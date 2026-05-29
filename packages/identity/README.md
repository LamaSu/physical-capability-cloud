# @pcc/identity

W3C DID (Decentralized Identifier) resolvers and Verifiable Credentials helpers for PCC.

## What it does

- **DID parsing** — W3C DID Core syntax-conformant parser.
- **`did:pkh`** — public-key-hash DIDs based on CAIP-10. PCC's canonical wallet-as-identity scheme. `did:pkh:eip155:8453:0xABC...` resolves to a synthesized DIDDocument with the address as the controller (no network calls).
- **`did:web`** — DNS-based DIDs. Resolves `did:web:hamilton.com` by fetching `https://hamilton.com/.well-known/did.json`. Easiest onboarding path for any vendor with a domain.
- **`did:ens`** — ENS-name-based DIDs (stretch goal). Resolves on mainnet or Base via viem.
- **Verifiable Credentials verifier** — structural + temporal + DID-resolution checks, with a pluggable cryptographic JWS verifier.

## Install

```bash
pnpm add @pcc/identity
```

## Quick start

```ts
import { DIDResolver, VCVerifier } from "@pcc/identity";

const resolver = new DIDResolver();

// did:pkh — deterministic, no network call
const pkhDoc = await resolver.resolve(
  "did:pkh:eip155:8453:0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"
);
console.log(pkhDoc.verificationMethod);

// did:web — fetches /.well-known/did.json
const webDoc = await resolver.resolve("did:web:hamilton.com");

// Parse without resolving
const parsed = resolver.parse("did:pkh:eip155:8453:0xABC123...");
// -> { method: "pkh", methodSpecificId: "eip155:8453:0xABC123...", did: "did:pkh:..." }
```

### Verify a Verifiable Credential

```ts
const verifier = new VCVerifier(resolver, {
  // Optional: supply your own JWS verifier. Without it, structural and
  // temporal checks still run but the cryptographic signature cannot be
  // checked.
  jwsVerifier: async (proof, verificationMethod, payload) => {
    // e.g. use @noble/curves to verify the detached JWS
    return true;
  },
});

const result = await verifier.verify(vc);
if (!result.valid) {
  console.error(result.errors);
}

// Quick expiration check
if (verifier.isExpired(vc)) {
  console.warn("Credential has expired");
}
```

## Supported DID methods

| Method | Network | Resolver behavior |
|--------|---------|-------------------|
| `did:pkh:eip155:<chainId>:<address>` | none | Synthesizes DIDDocument with `EcdsaSecp256k1RecoveryMethod2020` verificationMethod. Address is EIP-55 checksummed. |
| `did:pkh:bip122:<chainHash>:<address>` | none | `EcdsaSecp256k1VerificationKey2019` |
| `did:pkh:solana:<chainRef>:<address>` | none | `Ed25519VerificationKey2018` |
| `did:pkh:tezos:<chainRef>:<address>` | none | `Ed25519VerificationKey2018` |
| `did:web:<domain>[:<path>...]` | HTTPS | Fetches `https://<domain>/[path/]did.json` or `/.well-known/did.json` |
| `did:ens:[<chain>:]<name>` | RPC (mainnet/Base) | Resolves ENS → address → synthesized did:pkh-style DIDDocument |

## Why not use a third-party DID library?

PCC's identity model is wallet-first and we ship to React Native / hybrid mobile (Capacitor) where bundle size matters. The popular libraries (`did-resolver`, `key-did-resolver`, `web-did-resolver`) pull in ~80 KB of methods PCC doesn't use and tie us to specific cryptosuites. This package:

- **No transitive crypto dep** — JWS verification is a pluggable hook.
- **viem ^2.x only** — already in our monorepo, no duplicate Ethereum stacks.
- **Tree-shakeable** — bring only the methods you import.

## Specs implemented

- DID Core 1.0: https://www.w3.org/TR/did-core/
- did:pkh method: https://w3c-ccg.github.io/did-method-pkh/
- did:web method: https://w3c-ccg.github.io/did-method-web/
- VC Data Model 1.1: https://www.w3.org/TR/vc-data-model/
- CAIP-10 (chain account IDs): https://github.com/ChainAgnostic/CAIPs/blob/main/CAIPs/caip-10.md
