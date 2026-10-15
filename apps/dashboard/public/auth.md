# PCC Agent Authentication

PCC uses API keys for programmatic access and SIWE for wallet login. This document uses the WorkOS agent-auth walkthrough order while documenting PCC's implemented API-key flow. Only the endpoints named below are part of this flow.

## Discover

The API description is available at `GET https://capability.network/openapi.json`. The tool catalog is available at `GET https://capability.network/agent-package.json`. Protected REST calls use the gateway base URL `https://capability.network` and an HTTP Bearer credential.

## Pick a method

For an autonomous HTTP client, pick a PCC API key. Provisioning accepts one operator identifier: either an `email` string or an EVM `walletAddress` string. The optional `name` and `capability` fields add operator context. A separate SIWE flow exists at `GET /api/auth/nonce` and `POST /api/auth/verify`, but it is not required for API-key clients.

## Register

Send a public provisioning request. One identifier is required:

```http
POST /api/auth/provision HTTP/1.1
Host: capability.network
Content-Type: application/json

{
  "email": "operator@example.com",
  "name": "Example operator",
  "capability": "CNC routing"
}
```

For wallet-based registration, replace `email` with a valid `walletAddress` such as `0x` followed by 40 hexadecimal characters. Do not send a wallet private key. Provisioning is abuse-sensitive and has a stricter limit than the API's default 200 requests per minute per-IP limit.

## Claim

A successful provisioning response returns the new API credential as `api_key`; save it immediately because the raw key is shown once. The response also identifies the created key record. The gateway stores an Ed25519 signing public key only when you send `publicKey`; otherwise no signing key is on file. The gateway never generates or returns a private signing key. There is no additional claim URL and no browser redirect to follow.

## Use the credential

Send the API key on protected requests:

```http
GET /api/capabilities HTTP/1.1
Host: capability.network
Authorization: Bearer pcc_live_REDACTED
```

Never put the key in a URL, capability description, job parameter, log, public issue, or chat message. With an API key, `GET /api/auth/keys` lists only that key, which gives you its ID for revocation. A wallet sign-in (SIWE) session for the address, or a session key minted from one, lists every key of that address.

## Errors

- `400` means the identifier or another field is missing or malformed. Correct the request; do not retry it unchanged.
- `401` means the protected request has no valid credential. Provision a key or replace the invalid/revoked key.
- `404` during revocation means the key does not exist, or it is not the calling key and the caller has no wallet sign-in for its address.
- `409` during revocation means the key was already revoked.
- `429` means a rate limit was reached. Respect `Retry-After` when present and back off instead of rotating identities.
- `5xx` means the gateway could not complete the operation. Retry idempotent reads with bounded exponential backoff; do not blindly repeat physical or settlement writes.

## Revocation

Revoke a key with itself: send the DELETE with that key's own `Authorization` header. Find its `id` with `GET /api/auth/keys`, sent with the same key. Another key provisioned for the same email or wallet cannot revoke it (`404`). A wallet sign-in (SIWE) session for the address, or a session key minted from one, can revoke any key of that address. The gateway admin can revoke any key.

```http
DELETE /api/auth/keys/<keyId> HTTP/1.1
Host: capability.network
Authorization: Bearer pcc_live_REDACTED
```

Revocation is permanent for that key. To rotate a key that is still in use, provision the new key, move your clients to it, then revoke the old key with the old key's own header before you discard it. If a key leaked, revoke it with itself first, then provision its replacement. If provisioning answers `429` `too_many_keys`, the identity already has 5 unrevoked keys (expired keys count too): revoke one you hold with itself, then provision. After a key revokes itself, every request with it answers `401`, a repeated DELETE included; that `401` confirms the revocation.
