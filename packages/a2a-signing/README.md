# @pcc/a2a-signing

A2A v1.0 Signed Agent Cards (spec §4.4.7 + §8.4).

JWS (RFC 7515) over JCS-canonicalized JSON (RFC 8785) using ES256
(P-256 ECDSA). Signature is embedded back into the card as a
`signatures` array (JWS JSON Flattened style, with payload omitted
because verifiers reconstruct it by re-canonicalizing the body).

## Public API

```ts
import {
  signAgentCard,
  verifyAgentCard,
  loadSigningKey,
  generateJWKS,
} from "@pcc/a2a-signing";

// 1. Load the signing key from env (returns null if not configured)
const key = await loadSigningKey();

// 2. Sign a card
const signed = await signAgentCard(card, {
  privateKey: key.privateKey,
  kid: key.kid,
  jwksUrl: "https://capability.network/.well-known/jwks.json",
});

// 3. Serve JWKS document at /.well-known/jwks.json
const jwks = await generateJWKS(key.publicKey, key.kid);

// 4. Verify (any consumer)
const result = await verifyAgentCard(signed, {
  jwksUrl: "https://capability.network/.well-known/jwks.json",
});
// → { valid: true, card: {...}, kid: "pcc-2026-q2" }
```

## Environment variables

| Var | Required | Default | Description |
|---|---|---|---|
| `PCC_AGENT_CARD_SIGNING_KEY` | no | unset | PEM-encoded **PKCS#8** P-256 private key. If unset, `loadSigningKey()` returns `null` and the gateway serves an unsigned card (backwards compat). |
| `PCC_AGENT_CARD_SIGNING_KID` | no | `pcc-2026-q2` | Key identifier embedded in JWS `kid` header. Used by verifiers to select a matching public key from JWKS. |

## Key generation

One-time, during deploy bootstrap:

```bash
# 1. Generate a P-256 private key (SEC1 format)
openssl ecparam -name prime256v1 -genkey -noout -out card-sk.sec1.pem

# 2. Convert to PKCS#8 (what loadSigningKey expects)
openssl pkcs8 -topk8 -nocrypt -in card-sk.sec1.pem -out card-sk.pem

# 3. (Optional) extract the public key for reference
openssl ec -in card-sk.pem -pubout -out card-pk.pem

# 4. Paste card-sk.pem contents into Railway env var PCC_AGENT_CARD_SIGNING_KEY
#    Use multi-line input in Railway UI, or escape \n if your env layer requires it
#    (loadSigningKey handles both forms).
```

The private key file should **never live on a server disk in
production** — paste it directly into Railway's environment variable
UI. The harness pulls it into process memory at boot.

## Key rotation

Default cadence: quarterly. `kid` format: `pcc-<year>-q<N>` (e.g.
`pcc-2026-q3`).

Process:

1. Generate a new key pair offline (as above).
2. Update `PCC_AGENT_CARD_SIGNING_KEY` env on Railway (triggers
   restart, zero-downtime via Railway's rolling deploy).
3. Update `PCC_AGENT_CARD_SIGNING_KID` to the new kid.
4. The next card fetch will use the new key.
5. (Future) Old kid stays in JWKS with `exp` for a 30-day grace
   period so caches still verify — v1 ships single-key only.

Emergency rotation: same process, immediate. Verifiers that have
cached the old public key will fail until they re-fetch JWKS (cache
TTL: 5 min per `Cache-Control: public, max-age=300`).

## How it integrates with the gateway

`packages/gateway/src/routes/well-known.ts`:

- On boot, the gateway calls `loadSigningKey()`. If it returns a
  key, every `/.well-known/agent-card.json` response is signed
  in-flight. If it returns `null`, the unsigned legacy shape is
  served (backwards compat).
- New route `/.well-known/jwks.json` serves the public JWKS so any
  verifier can resolve the `kid` from the signature header back to
  a key.
- Both endpoints are public (`access-control-allow-origin: *`,
  `cache-control: public, max-age=300`).

## Spec references

- A2A spec §4.4.7 — `AgentCardSignature`
- A2A spec §8.4 — Agent Card Signature
- RFC 7515 — JSON Web Signature (JWS)
- RFC 7517 — JSON Web Key (JWK)
- RFC 7518 — JWA (ES256)
- RFC 8785 — JSON Canonicalization Scheme (JCS)
