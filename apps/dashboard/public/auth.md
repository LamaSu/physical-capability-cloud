# PCC Agent Authentication

PCC uses API keys for programmatic access and SIWE for wallet login. This document uses the WorkOS agent-auth walkthrough order while documenting PCC's implemented API-key flow. Only the endpoints named below are part of this flow.

## Discover

The API description is available at `GET https://capability.network/openapi.json`. The tool catalog is available at `GET https://capability.network/agent-package.json`. Protected REST calls use the gateway base URL `https://capability.network` and an HTTP Bearer credential.

## Discovery metadata (OAuth 2.0 / agent_auth)

PCC's authentication is self-describing for an agent that speaks the standard OAuth 2.0 / WorkOS `agent_auth` discovery dance. A protected route replies to an unauthenticated request with `401` and a `WWW-Authenticate: Bearer resource_metadata="https://capability.network/.well-known/oauth-protected-resource"` header (RFC 9728). Resolve that pointer to learn PCC's authorization server and scopes, then resolve the authorization server's own metadata.

- `GET https://capability.network/.well-known/oauth-protected-resource` — RFC 9728 Protected Resource Metadata. Declares `resource` (`https://capability.network`), `authorization_servers`, `bearer_methods_supported` (`header`), and `scopes_supported`.
- `GET https://capability.network/.well-known/oauth-authorization-server` — RFC 8414 Authorization Server Metadata. Maps PCC's real endpoints to OAuth discovery fields: `registration_endpoint` is key provisioning (`/api/auth/provision`); `authorization_endpoint`/`token_endpoint` are the SIWE nonce/verify pair; `jwks_uri` is `/.well-known/jwks.json`.

Named scopes describe PCC's access tiers: `capabilities:read` (public discovery), `jobs:read`, `jobs:write`, `operator`, and `admin`. The concrete credential is still an API key or a SIWE session as described below — the discovery documents let an `agent_auth`-aware client find the provisioning endpoint without guessing.

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

A successful provisioning response returns the new API credential as `api_key`; save it immediately because the raw key is shown once. The response also identifies the created key record. If the gateway mints an Ed25519 signing keypair, any returned private signing material is likewise shown once and must be stored separately as a secret. There is no additional claim URL and no browser redirect to follow.

## Use the credential

Send the API key on protected requests:

```http
GET /api/capabilities HTTP/1.1
Host: capability.network
Authorization: Bearer pcc_live_REDACTED
```

Never put the key in a URL, capability description, job parameter, log, public issue, or chat message. Use `GET /api/auth/keys` with the same authenticated identity to list its key records and obtain the key ID needed for revocation.

## Errors

- `400` means the identifier or another field is missing or malformed. Correct the request; do not retry it unchanged.
- `401` means the protected request has no valid credential. Provision a key or replace the invalid/revoked key.
- `404` during revocation means that key ID is unavailable to the authenticated operator.
- `409` during revocation means the key was already revoked.
- `429` means a rate limit was reached. Respect `Retry-After` when present and back off instead of rotating identities.
- `5xx` means the gateway could not complete the operation. Retry idempotent reads with bounded exponential backoff; do not blindly repeat physical or settlement writes.

## Revocation

List key records with `GET /api/auth/keys`, choose the intended `id`, then revoke it while authenticated as its owner:

```http
DELETE /api/auth/keys/<keyId> HTTP/1.1
Host: capability.network
Authorization: Bearer pcc_live_REDACTED
```

Revocation is permanent for that key. Rotate clients to a separately provisioned credential before revoking a key that is still in use.
