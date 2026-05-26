# @pcc/a2a

Agent-to-Agent protocol: discovery, negotiation, and messaging between PCC
agents. Crypto, persistence, encrypted bus, networked transport, and a
pluggable `MessageBusBackend` (in-memory by default; NATS JetStream opt-in).

## Backends

The message bus is pluggable through `MessageBusBackend`
(`src/backends/backend.ts`):

| Backend | Source | Default? | When to use |
|---|---|---|---|
| In-memory | `src/backends/in-memory-backend.ts` | yes | tests, single-process, dev |
| NATS JetStream | `src/backends/nats-jetstream-backend.ts` | no | multi-process, multi-host, durable |

Switch via env: `PCC_MESSAGE_BUS_BACKEND=nats`. The default remains `memory`
so existing deployments are unaffected.

## Running tests

Always-on unit suite (no external services):

```bash
pnpm --filter @pcc/a2a test
```

This runs every test under `src/__tests__/*` including the 27 NATS unit
tests that use a fully mocked `nats.js` client via the backend's
`connectFn` option. No NATS server is required and the real `nats` module
is not loaded.

## Running NATS integration tests

The NATS suite has one additional test gated behind `NATS_INTEGRATION=1`
that round-trips a real message through a live JetStream server. The
harness brings the container up, waits for healthy, runs the suite, tears
the container down — pass or fail.

**Prerequisites:** Docker with `docker compose` v2.

### Option A — one command (recommended)

POSIX / Git Bash:

```bash
pnpm --filter @pcc/a2a test:nats
```

Windows PowerShell 7+:

```powershell
pnpm --filter @pcc/a2a test:nats:windows
```

Both invoke `scripts/nats-integration.{sh,ps1}`, which:

1. `docker compose -f packages/a2a/docker-compose.nats.yml up -d`
2. Polls `http://localhost:8222/healthz?js-enabled-only=true` for up to 60s
   (override with `NATS_WAIT_TIMEOUT` env var)
3. Runs `NATS_INTEGRATION=1 pnpm test -- nats-backend` from the package dir
4. `docker compose ... down -v --remove-orphans` (trap / `finally` — runs
   even on Ctrl-C or test failure)

Exit code is the test runner's exit code.

### Option B — manual

```bash
# 1. start NATS
docker compose -f packages/a2a/docker-compose.nats.yml up -d

# 2. wait for healthy
curl -fsS http://localhost:8222/healthz?js-enabled-only=true

# 3. run the gated test(s)
NATS_INTEGRATION=1 pnpm --filter @pcc/a2a test -- nats-backend

# 4. tear down
docker compose -f packages/a2a/docker-compose.nats.yml down -v
```

### Running in CI

The integration suite is **not** in the default CI matrix — it requires a
service container and adds time that's wasted on the 99% of PRs that don't
touch the NATS backend. It's wired as a manual-dispatch workflow:

GitHub UI → **Actions** → **NATS Integration Tests** → **Run workflow**

The workflow at `.github/workflows/nats-integration.yml`:

- Uses the same `docker-compose.nats.yml` as the local runner (single source
  of truth — CI behavior matches local behavior).
- Optional `ref` input lets you test arbitrary branches/SHAs.
- Streams NATS container logs on failure for inline diagnostics.
- Tears down with `if: always()`.

Run it when:

- Editing `src/backends/nats-jetstream-backend.ts`
- Bumping the `nats` dependency
- Investigating an integration-only failure

### What the integration test does

`src/__tests__/nats-backend.test.ts` has one `describe.skipIf(!runIntegration)`
block that:

1. Constructs a `NATSJetStreamBackend` against `nats://localhost:4222` with
   a uniquely-suffixed stream name `PCC_A2A_INT_<random>` (no cross-run
   collisions).
2. Subscribes to `pcc.a2a.text_message`.
3. Publishes one message and polls for delivery (up to 2s — JetStream
   delivery is async).
4. Asserts the round-tripped message id matches the publish.
5. Unsubscribes and closes the backend (drains the connection and deletes
   the durable consumer).

This is intentionally minimal — the 27 unit tests already cover encoding,
ack/nak, reconnect, idempotent stream creation, close idempotency, etc.
The integration test exists to catch contract drift between our mocked
client and the real `nats.js` API.
