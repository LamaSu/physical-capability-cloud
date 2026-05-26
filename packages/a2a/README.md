# @pcc/a2a — Agent-to-Agent Protocol

Discovery, negotiation, and messaging between PCC agents. Pluggable transport
backends (in-memory for tests, NATS JetStream for cross-process / cross-host).

## Backend selection

`createBackendFromEnv()` reads `PCC_MESSAGE_BUS_BACKEND` to pick a backend:

| Value | Backend | Use case |
|-------|---------|----------|
| `memory` (default) | `InMemoryBackend` | Single-process tests, dev mode |
| `nats` | `NATSJetStreamBackend` | Production, multi-host, durable delivery |

```ts
import { createBackendFromEnv } from "@pcc/a2a";
const backend = await createBackendFromEnv();
await backend.publish("pcc.a2a.text_message", msg);
```

## Running NATS integration tests

Integration tests are gated behind `NATS_INTEGRATION=1` and require a local
NATS server with JetStream:

```bash
docker run --rm -p 4222:4222 nats:latest -js
NATS_INTEGRATION=1 pnpm --filter @pcc/a2a test nats-backend
```

CI runs unit tests only (no NATS server needed; the backend uses a
structural mock via the `connectFn` option).

## Production NATS deployment — TLS + auth

The `NATSJetStreamBackend` accepts TLS and authentication options. In
production, **always** enable TLS and at least one authentication kind.

### Programmatic options

```ts
import { NATSJetStreamBackend } from "@pcc/a2a";

const backend = new NATSJetStreamBackend({
  url: "tls://nats.prod.example.com:4222",
  streamName: "PCC_A2A",
  tls: {
    caFile: "/etc/pcc/nats/ca.pem",
    certFile: "/etc/pcc/nats/client.pem",
    keyFile: "/etc/pcc/nats/client.key",
    rejectUnauthorized: true,
    servername: "nats.prod.example.com",
  },
  auth: {
    kind: "credsFile",
    path: "/etc/pcc/nats/agent.creds",
  },
});
```

### TLS options

| Field | Type | Notes |
|-------|------|-------|
| `tls: true` | boolean | Enable TLS with system defaults (no client cert, verify server). |
| `tls.caFile` | string | Path to PEM CA bundle. Read at connect time. |
| `tls.certFile` | string | Path to PEM client certificate. |
| `tls.keyFile` | string | Path to PEM client private key. |
| `tls.rejectUnauthorized` | boolean | Default `true`. Set `false` only for self-signed dev clusters. |
| `tls.servername` | string | SNI override. |

NATS supports TLS-upgrade on the `nats://` scheme; the backend still applies
TLS in that case but logs a warning so the operator can switch to `tls://`.

### Authentication kinds

Pick exactly one. Mixing kinds is rejected at construction.

| Kind | Required fields | Notes |
|------|------------------|-------|
| `token` | `token` | Opaque bearer token. |
| `userPass` | `user`, `pass` | Username + password. |
| `nkey` | `nkeySeed` | Raw nkey seed string (e.g. `SUAA…`). Lazy-loads `nats.nkeys`. |
| `jwt` | `jwt`, `nkeySeed` | User JWT plus the nkey signing seed. Lazy-loads `nats.jwtAuthenticator`. |
| `credsFile` | `path` | Path to a `.creds` file from `nsc generate creds`. Lazy-loads `nats.credsAuthenticator`. |

### Environment variables (used by `createBackendFromEnv()`)

```bash
export PCC_MESSAGE_BUS_BACKEND=nats
export NATS_URL=tls://nats.prod.example.com:4222
export NATS_STREAM_NAME=PCC_A2A           # default PCC_A2A
export NATS_DURABLE_NAME=pcc-a2a-bus      # optional override

# TLS — any of these enables TLS
export NATS_TLS=1                          # enable with defaults
export NATS_TLS_CA_FILE=/etc/pcc/nats/ca.pem
export NATS_TLS_CERT_FILE=/etc/pcc/nats/client.pem
export NATS_TLS_KEY_FILE=/etc/pcc/nats/client.key
export NATS_TLS_REJECT_UNAUTHORIZED=1      # default 1; 0/false to disable
export NATS_TLS_SERVERNAME=nats.prod.example.com

# Auth — pick one kind via NATS_AUTH_KIND
export NATS_AUTH_KIND=credsFile            # token|userPass|nkey|jwt|credsFile
# Per-kind:
#   token:     NATS_TOKEN
#   userPass:  NATS_USER, NATS_PASS
#   nkey:      NATS_NKEY_SEED
#   jwt:       NATS_JWT, NATS_NKEY_SEED
#   credsFile: NATS_CREDS_FILE
export NATS_CREDS_FILE=/etc/pcc/nats/agent.creds
```

If `NATS_AUTH_KIND` is set but the required per-kind env vars are missing,
`createBackendFromEnv()` throws at construction. This is intentional — a
production deployment should fail fast at boot rather than reconnect-loop
against a server that will reject every handshake.

### Hardening checklist

- [ ] Use `tls://` URL scheme (not `nats://`) to make TLS explicit.
- [ ] `rejectUnauthorized: true` (the default) — never disable in production.
- [ ] Prefer `credsFile` or `jwt` auth over `token`/`userPass` in production
      (NATS account-scoped JWT is the modern recommendation).
- [ ] Mount creds files via secret manager / orchestrator, not env vars.
- [ ] Rotate creds at least every 90 days.
