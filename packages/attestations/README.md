# @pcc/attestations

Ethereum Attestation Service (EAS) wrapper — composable substrate for PCC trust
signals (audits, certifications, reputation-derived attestations).

## Why EAS

EAS is the generic on-chain attestation primitive:

- Schemas registered once, used by anyone
- Both on-chain attestations (gas-paid) and off-chain (signed JSON, free)
- Indexed everywhere by major indexers (The Graph, Tenderly)
- Supports revocation
- Used by Optimism (Citizen House), Coinbase Verifications, Gitcoin

PCC's existing tier system becomes one consumer of EAS attestations rather than
a closed system.

## What this package provides

| Module                | Exports                                                            |
| --------------------- | ------------------------------------------------------------------ |
| `eas-client`          | `EASClient` — read attestations by UID, scan by recipient/schema   |
| `schema-registry`     | `SchemaRegistryClient`, `computeSchemaUID`, ABI encode/decode      |
| `off-chain`           | `OffChainSigner`, `OffChainVerifier`, deterministic UID derivation |
| `schemas/*`           | PCC-specific schema definitions (bridge tier, audit, vendor vouch) |
| `constants`           | EAS deployments on 7 chains (mainnet, Base, Optimism, Sepolia...)  |

## Supported chains

| Chain ID  | Name           | EAS                                          | Schema Registry                              |
| --------- | -------------- | -------------------------------------------- | -------------------------------------------- |
| 1         | mainnet        | `0xA1207F3BBa224E2c9c3c6D5aF63D0eb1582Ce587` | `0xA7b39296258348C78294F95B872b282326A97BDF` |
| 10        | optimism       | `0x4200000000000000000000000000000000000021` | `0x4200000000000000000000000000000000000020` |
| 137       | polygon        | `0x5E634ef5355f45A855d02D66eCD687b1502AF790` | `0x7876EEF51A891E737AF8ba5A5E0f0Fd29073D5a7` |
| 42161     | arbitrum-one   | `0xbD75f629A22Dc1ceD33dDA0b68c546A1c035c458` | `0xA310da9c5B885E7fb3fbA9D66E9Ba6Df512b78eB` |
| 8453      | base           | `0x4200000000000000000000000000000000000021` | `0x4200000000000000000000000000000000000020` |
| 11155111  | sepolia        | `0xC2679fBD37d54388Ce493F1DB75320D236e1815e` | `0x0a7E2Ff54e76B8E6659aedc9103FB21c038050D0` |
| 84532     | base-sepolia   | `0x4200000000000000000000000000000000000021` | `0x4200000000000000000000000000000000000020` |

Addresses verified 2026-05-27 from
[ethereum-attestation-service/eas-contracts](https://github.com/ethereum-attestation-service/eas-contracts/tree/master/deployments).

## Examples

### Sign an off-chain attestation

```ts
import {
  OffChainSigner,
  PCC_BRIDGE_TIER_SCHEMA_UID,
  PCC_BRIDGE_TIER_SCHEMA,
} from "@pcc/attestations";

const signer = new OffChainSigner({
  chainId: 8453, // Base mainnet
  privateKey: "0x...",
});

const attestation = await signer.attest({
  schema: PCC_BRIDGE_TIER_SCHEMA_UID,
  recipient: "0xVendorAddress...",
  data: {
    schema: PCC_BRIDGE_TIER_SCHEMA,
    values: {
      bridgeMaintainer: "0xMaintainer...",
      tier: 2,
      evidenceCID: "0x" + "ab".repeat(32),
    },
  },
});

// Share `attestation` over any transport (HTTP, IPFS, paper QR code...)
```

### Verify an off-chain attestation

```ts
import { OffChainVerifier } from "@pcc/attestations";

const verifier = new OffChainVerifier();
const result = await verifier.verify(attestation);

if (result.valid) {
  console.log(`Valid — signed by ${result.attester}`);
} else {
  console.log(`Invalid: ${result.reason}`);
}
```

### Read an on-chain attestation

```ts
import { EASClient } from "@pcc/attestations";

const client = new EASClient({
  chainId: 8453,
  rpcUrl: "https://mainnet.base.org",
});

const att = await client.getAttestation("0xabc...");
const valid = await client.isValid("0xabc...");
const all = await client.getAttestationsByRecipient(
  "0xVendor...",
  PCC_BRIDGE_TIER_SCHEMA_UID,
);
```

## Schema registration (manual, one-time per chain)

This package does NOT register schemas on-chain automatically — that's a
deploy-time decision. To register the PCC schemas:

```ts
// In a deploy script with a funded wallet:
import { SchemaRegistryClient } from "@pcc/attestations";
import {
  PCC_BRIDGE_TIER_SCHEMA,
  PCC_AUDIT_SCHEMA,
  PCC_VENDOR_VOUCH_SCHEMA,
} from "@pcc/attestations";
// ... call the on-chain register(schema, resolver, revocable) function
// (or use the official EAS web UI: https://easscan.org)
```

The `computeSchemaUID` helper deterministically predicts the UID a schema
will have once registered. The exported `*_SCHEMA_UID` constants assume
default resolver (zero address) and `revocable=true`.

## Notes

- No dependency on the official `@ethereum-attestation-service/eas-sdk`
  package — implemented directly against viem for a slimmer install
  footprint. Wire format remains compatible.
- Off-chain attestations follow EAS Version 2 (current as of 2026-05).
- On-chain attestation submission (write) is out of scope for v0.1 — this
  package focuses on the read + off-chain signing surface used by PCC
  back-office tooling.
