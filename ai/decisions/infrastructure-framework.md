# PCC Infrastructure Decision Framework

> Date: 2026-04-03 | Status: Draft | Author: AI Research Agent | Version: 1.0

---

## Executive Summary

Physical Capability Cloud is a manufacturing-grade control plane where reliability and evidence integrity take precedence over throughput. Four infrastructure decisions must be made to support the transition from a single-node development deployment to a production multi-tenant platform capable of serving global operators.

**Decision 1 — Database (SQLite → PostgreSQL):** Migrate immediately to Neon Serverless Postgres. The 20 existing IRepository interfaces and Drizzle ORM facade mean this is a dialect-swap, not a rewrite. SQLite's lack of concurrent write support is already a bottleneck as soon as two operator nodes submit job results simultaneously. Neon's scale-to-zero pricing fits PCC's intermittent workload patterns, and its Databricks acquisition has driven significant 2026 price reductions. Estimated production cost: $30-80/month.

**Decision 2 — Message Bus (In-Memory → NATS JetStream):** Adopt NATS JetStream as the distributed message bus. Its sub-millisecond latency, at-least-once and exactly-once delivery guarantees, lightweight operational footprint, and purpose-built design for IoT/manufacturing command planes make it the right fit over Kafka (over-engineered) or Redis Streams (memory-constrained for large evidence payloads). Deploy managed via Synadia Cloud initially; self-host when operator count exceeds 50. Estimated cost: $25-100/month managed.

**Decision 3 — Durable Workflows (Temporal.io):** Adopt Temporal Cloud for manufacturing job lifecycle management. The multi-step nature of capability execution (submit → negotiate → escrow → execute → evidence → verify → settle) maps precisely to Temporal's durable workflow model with saga compensation patterns. BullMQ is insufficient: Redis-backed queues do not survive process crashes in a way that is safe for escrow flows with financial settlement. Start with 3 workflow types. Estimated cost: $100-300/month at current scale.

**Decision 4 — Workload Identity (SPIFFE/SPIRE):** Implement SPIFFE/SPIRE for workload-to-workload authentication, but phase the rollout. Start with the gateway-to-kernel boundary (highest trust consequence), then extend to agent-to-gateway. SPIRE complements rather than competes with ERC-8004/DID identity — DID governs on-chain operator identity, SPIRE governs runtime service identity. Estimated infrastructure cost: $0 (self-hosted on existing Railway VMs).

**Implementation order:** Decision 1 (database) → Decision 2 (message bus) → Decision 3 (workflows) → Decision 4 (identity). Each decision unlocks the next: Postgres is required as NATS JetStream's durable storage backend for deduplication tables; NATS is the transport layer Temporal workers use; SPIRE provides the mTLS that protects all of the above at runtime.

**Total estimated monthly infrastructure addition: $155-480/month** at current scale, scaling to $500-1500/month at 100+ concurrent operators.

---

## Decision 1: Database Migration (SQLite → PostgreSQL)

### Current State

All packages use `better-sqlite3` via Drizzle ORM. SQLite is embedded, single-file, and process-local. This means:

- No concurrent writes from multiple processes — SQLite serializes writes with file-level locking
- No connection from external services (Railway containers, Temporal workers, external verifier nodes)
- No replication or point-in-time recovery
- No row-level locking for the escrow/settlement tables where race conditions could cause double-settlement

The existing architecture is well-prepared for migration: 20 IRepository interfaces already define the data layer contract, and Drizzle ORM supports PostgreSQL with a dialect switch in configuration. The facade layer means no business logic touches SQL directly.

### Options Evaluated

**Neon Serverless Postgres**
- Architecture: Compute and storage are separated; compute autoscales and suspends after idle timeout (configurable, default 5 min)
- Free tier: 100 CU-hours/month, 0.5 GB storage
- Launch tier: $5/month minimum, $0.14/CU-hour compute, $0.35/GB-month storage
- Scale tier: $0.26/CU-hour, production PITR, read replicas
- Branch databases: Instant schema branches for staging/preview environments — directly useful for PCC's multi-operator testing
- 2026 context: Databricks acquisition drove 15-25% compute price cuts and storage dropped from $1.75 → $0.35/GB-month
- Weaknesses: Scale-to-zero has cold start latency (100-500ms); not suitable if queries must respond in <50ms constantly

**Supabase**
- Full backend platform: Postgres + Auth + Storage + Realtime + Edge Functions
- Free tier generous but limited; Pro plan $25/month per project
- Strong built-in Row Level Security — relevant for PCC's multi-tenant operator isolation
- Weaknesses: Bundles features PCC already has (custom Auth, Storacha for storage). You pay for the platform, not just the database. Less control over compute scaling.

**Railway Postgres**
- Integrated with existing Railway deployment; simplest migration path
- $5/month starting, usage-based thereafter
- Weaknesses: No horizontal scaling; max 100 connections by default (PgBouncer required separately); no branching; limited extension support (no PostGIS, TimescaleDB, pgvector by default); documented production issues with connection exhaustion at scale

**CockroachDB Serverless**
- Distributed SQL with strong ACID guarantees across regions
- Free tier: 5 GiB + 50M Request Units
- Strengths: Multi-region active-active with no data loss; PostgreSQL-compatible wire protocol
- Weaknesses: Different SQL dialect quirks (no `SERIAL`, different sequence handling); overkill for current PCC scale; higher latency for simple OLTP queries; pricing model (Request Units) is harder to predict than Neon's compute-hours

### Trade-off Matrix

| Dimension            | Neon          | Supabase      | Railway Postgres | CockroachDB   |
|----------------------|---------------|---------------|------------------|---------------|
| Drizzle compatibility| Full          | Full          | Full             | Partial       |
| Cost (prod starter)  | $30-60/mo     | $25/mo flat   | $10-30/mo        | $0-50/mo      |
| Concurrent writes    | Full          | Full          | Full (100 conn)  | Full          |
| Branching            | Native        | None          | None             | None          |
| PITR                 | Yes           | Yes (Pro)     | No               | Yes           |
| Scale-to-zero        | Yes           | No            | No               | Yes           |
| Operational burden   | Low           | Low           | Low              | Medium        |
| Multi-region         | Single (beta) | Single        | Single           | Native        |
| Cold start risk      | Yes           | No            | No               | Yes           |

### Recommendation

**Adopt Neon Serverless Postgres on the Scale plan.**

Rationale: PCC's workload is intermittent — operator jobs do not run 24/7 during early growth. Neon's scale-to-zero means you pay for actual database activity, not idle uptime. The branch database feature directly supports PCC's development workflow (each GitHub PR can get its own database branch). Drizzle ORM compatibility is complete — migration is configuration, not code.

Disable scale-to-zero for the production database once you have >10 concurrent operators to eliminate cold start latency on job submissions. Keep scale-to-zero on staging/preview branches.

Do not use Railway's built-in Postgres for the primary data store. The connection limit issues are already documented in Railway's own support forums and require PgBouncer as a separate service — adding operational surface area without adding capability.

### Migration Plan

1. Add Neon project in dashboard; create `pcc-production` and `pcc-staging` databases with branch from `pcc-production`
2. Update `drizzle.config.ts` in each package: change `dialect: 'sqlite'` to `dialect: 'postgresql'` and provide `DATABASE_URL` from Neon connection string
3. Run `drizzle-kit generate` to produce PostgreSQL-dialect migration files; review for SQLite-specific types (`INTEGER` → `SERIAL`, `BLOB` → `BYTEA`, `TEXT` for JSON → `JSONB`)
4. Update all `IRepository` implementations to use the Postgres driver (`@neondatabase/serverless` or standard `pg`)
5. Run integration test suite against Neon staging database
6. Deploy with `DATABASE_URL` env var pointing to Neon; keep SQLite as fallback behind feature flag for first 2 weeks
7. After 2 weeks stable, remove SQLite fallback and the `better-sqlite3` dependency
8. Configure PITR to 7 days on production database; set up daily snapshot exports to Storacha for evidence chain compliance

### Timeline

- Week 1: Schema generation + driver swap (estimated 4-6 hours of engineering)
- Week 2: Integration testing on Neon staging
- Week 3: Production cutover
- Month 2: Performance tuning, index review, connection pool sizing

### Estimated Monthly Cost

| Scale | Monthly |
|-------|---------|
| Development (now) | $5-15 |
| 10 concurrent operators | $30-60 |
| 100 concurrent operators | $80-200 |
| 1000 concurrent operators | $300-800 |

---

## Decision 2: Distributed Message Bus

### Current State

PCC has two message bus implementations:

- `InMemoryMessageBus`: Pure in-process pub/sub. Zero persistence. Process restart loses all in-flight intents.
- `PersistentMessageBus`: SQLite-backed replay. Single process. The persistence interface is already abstracted — a `IPersistenceAdapter` interface exists.

The A2A protocol defines 34 intent types spanning job lifecycle events: `CAPABILITY_DISCOVERY`, `JOB_SUBMIT`, `EVIDENCE_SUBMIT`, `PAYMENT_TRIGGER`, `VERIFICATION_REQUEST`, etc. Messages include evidence bundles (photo hashes, CIDs), settlement triggers (transaction hashes), and job commands (instrument parameters).

The critical constraint for PCC: **this is a manufacturing control plane**. Messages are not analytics events — they are commands that cause physical equipment to operate. A lost `JOB_EXECUTE` command means an operator's CNC machine didn't start a job. A duplicate `PAYMENT_TRIGGER` could cause double-payment from escrow.

### Options Evaluated

**Redis Pub/Sub + Streams**
- Pub/Sub: Fire-and-forget, no persistence, no consumer groups — unsuitable for PCC's reliability requirements
- Redis Streams: Append-only log, consumer groups, ACK-based delivery, at-least-once guarantees
- Latency: Sub-millisecond for typical payloads
- Weaknesses: Memory-bound — evidence bundles (photo hashes, CID arrays, SSIM scores) can be kilobytes to tens of kilobytes each. Redis holds streams in memory; large evidence payloads will drive up RAM costs significantly. No built-in message deduplication. Managed options (Redis Cloud, Upstash) add cost complexity. No native stream retention policies beyond memory pressure.

**NATS JetStream**
- Purpose-built cloud-native messaging; CNCF graduated project
- JetStream layer adds persistence, at-least-once and exactly-once delivery, consumer groups, and replay
- Latency: 11-12M msgs/sec single node, sub-millisecond tail latency; JetStream persistent ~1M msgs/sec
- Exactly-once delivery via message deduplication window (configurable, e.g., 2-minute dedup window for idempotent job submission)
- Subject hierarchy maps cleanly to PCC's intent taxonomy: `pcc.job.submit`, `pcc.evidence.upload`, `pcc.payment.trigger`, `pcc.verify.request`
- Leaf nodes: NATS supports edge deployments (a NATS leaf node on the operator's PCC node can bridge to the cloud NATS cluster)
- Managed option: Synadia Cloud — global multi-geo NATS fabric; pricing based on resource pools allocated to accounts
- Self-hosted: Single NATS binary, no external dependencies (no ZooKeeper, no separate disk controller). A 3-node JetStream cluster fits on 3 small VMs or Railway containers.

**Apache Kafka**
- Industry standard for high-throughput event streaming; designed for millions of events/second
- Exactly-once semantics with idempotent producers and transactional APIs
- Excellent long-term event retention (days to forever)
- Managed options: Confluent Cloud ($0.11/GB ingress + $0.25/GB storage), Redpanda Cloud, MSK on AWS
- Weaknesses for PCC: Kafka's minimum production deployment is complex (historically ZooKeeper, now KRaft mode). Confluent Cloud minimum commitment is $15-50/month but latency is 5-50ms, not sub-millisecond. Designed for stream processing workloads (analytics, log aggregation) rather than request-response command dispatch. Overkill at PCC's current message volume. Schema Registry, Connect, ksqlDB are useful but add to operational and cost overhead.

### Trade-off Matrix

| Dimension                | NATS JetStream    | Redis Streams     | Apache Kafka      |
|--------------------------|-------------------|-------------------|-------------------|
| Latency (p99)            | <1ms              | <1ms              | 5-50ms            |
| Exactly-once delivery    | Native (dedup)    | No (at-least-once)| Native (txn API)  |
| Persistence              | File-backed       | Memory (+ AOF)    | File-backed       |
| Evidence payload size    | Configurable      | Memory-limited    | Configurable      |
| Edge/leaf nodes          | Native            | No                | MirrorMaker only  |
| Operational complexity   | Low               | Low               | High              |
| Managed cost (starter)   | $25-50/mo         | $10-30/mo         | $50-100/mo        |
| A2A intent routing       | Subject hierarchy | Key prefixes       | Topic-per-intent  |
| IPersistenceAdapter fit  | Direct            | Direct            | Direct            |
| Manufacturing command fit| Excellent         | Adequate          | Poor              |

### Recommendation

**Adopt NATS JetStream. Deploy managed via Synadia Cloud initially; self-host at 50+ concurrent operators.**

Rationale: NATS JetStream's exactly-once delivery semantics via a configurable deduplication window directly addresses the double-payment risk for `PAYMENT_TRIGGER` intents. The subject-hierarchy model (`pcc.{operator_id}.job.{job_id}.submit`) enables per-operator message isolation without separate topics. The leaf-node architecture means a future `pcc-node` installation can run a NATS leaf and bridge to the cloud cluster — preserving message ordering and delivery guarantees even across intermittent connectivity.

Redis Streams is viable for pure pub/sub but memory costs will become significant as evidence bundles grow. Kafka is correct for analytics pipelines but introduces 5-50ms latency that is unacceptable for job command dispatch on a manufacturing floor.

The existing `IPersistenceAdapter` interface in `PersistentMessageBus` requires only a new adapter implementation — no architectural changes to message routing, intent handling, or A2A protocol logic.

### Migration Plan

1. Implement `NatsJetStreamAdapter implements IPersistenceAdapter` — wraps `nats.js` client, publishes to `pcc.{intent_type}` subjects, subscribes via consumer groups
2. Wire `NatsJetStreamAdapter` behind a feature flag in `MessageBusFactory`; in-memory bus remains default until flag enabled
3. Deploy NATS JetStream via Synadia Cloud or single-node NATS container on Railway; configure streams for each intent category with 7-day retention
4. Configure deduplication window to 2 minutes for `JOB_SUBMIT` and `PAYMENT_TRIGGER` intents (idempotency key = job_id + timestamp)
5. Run E2E test suite with NATS backend: job submit → execute → evidence → verify → settle flow
6. Enable flag in production for a subset of operators (canary)
7. Monitor for missing or duplicate deliveries via NATS JetStream consumer lag metrics
8. Full rollout; deprecate `InMemoryMessageBus` for production use (keep for unit tests)

### Timeline

- Week 1-2: NatsJetStreamAdapter implementation + unit tests
- Week 3: Integration tests with real NATS cluster
- Week 4: Canary production rollout
- Month 2: Full rollout + monitoring dashboards

### Estimated Monthly Cost

| Scale | NATS JetStream (Synadia) | Redis Streams (Upstash) |
|-------|--------------------------|-------------------------|
| Development | $0 (free tier) | $0 (free tier) |
| 10 operators | $25-50/mo | $15-30/mo |
| 100 operators | $75-150/mo | $50-100/mo |
| 500 operators | $200-500/mo (or self-host ~$40/mo infra) | $200-400/mo |

---

## Decision 3: Durable Workflow Engine

### Current State

`packages/scheduler` compiles workflow DAGs and dispatches them, but execution is stateless and fire-and-forget. There is no mechanism to resume a workflow after:

- A `pcc-gateway` process crash
- A network timeout during evidence submission to Storacha
- A Starknet transaction pending for >10 minutes
- An operator going offline mid-job

Manufacturing workflows in PCC are inherently long-running:

- CNC milling cycle: 2-8 hours
- Multi-stage composite layup: 12-24 hours
- Heat treatment + inspection: 3-5 days
- Multi-instrument orchestration (OT-2 → quality sensor → printer → packager): sequenced over minutes with human inspection checkpoints

The risk is clear: if the orchestrating process crashes after escrow funds are locked but before job completion is recorded on-chain, funds are stuck and neither party has a clean resolution path. Currently, manual operator intervention is required.

### Options Evaluated

**Temporal.io Cloud**
- Durable execution model: Workflows are functions that survive process crashes; state is replayed from event history on restart
- Actions-based pricing: $25 per million actions. One manufacturing job lifecycle (submit→negotiate→execute→evidence→verify→settle) generates approximately 30-80 actions.
- Essentials plan: $100/month minimum
- Enterprise plan: Custom pricing, SLA guarantees
- Saga pattern: Native support for compensating transactions — if escrow settlement fails, Temporal can automatically trigger refund workflow
- TypeScript SDK: First-class support; matches PCC's existing TypeScript stack
- Latency: Temporal Cloud benchmarks show lower end-to-end latency than self-hosted due to architecture optimizations
- Known cost trap: Actions scale multiplicatively — heartbeats, signals, and retries all count as actions. A long-running job with 1-minute heartbeats for 8 hours = 480 heartbeat actions alone.

**BullMQ (Redis-backed)**
- Redis-backed job queue with priorities, delays, rate limiting, parent-child flows
- Free/open source; cost is only Redis infrastructure
- TypeScript-native; excellent DX
- Flow jobs: Parent-child hierarchies where parent waits for all children — maps to multi-step workflows
- Weaknesses: Not durable in the Temporal sense. If the Redis instance fails (not AOF/RDB), jobs are lost. No saga/compensation primitives. No time-travel debugging. Long-running jobs (hours) require explicit heartbeat management and are vulnerable to Redis connection failures. Not designed for financial settlement flows where exactly-once execution matters.

**Self-Hosted Temporal**
- Full control; no per-action pricing
- Infrastructure requirement: Temporal server + Cassandra or Postgres backend + Elasticsearch for visibility
- Estimated self-hosted cost: $3,500-5,000/month infrastructure + 1-2 FTE operational overhead ($15,000-30,000/month)
- Only economically justified at 100M+ actions/month
- Temporal Cloud is 12-19x more cost-effective at PCC's current and near-term scale

**Inngest / Trigger.dev (alternatives)**
- Serverless workflow platforms with simpler pricing models
- Lower operational overhead than Temporal
- Weaknesses: Less mature for manufacturing-grade durability requirements; smaller community; fewer saga/compensation examples for financial settlement flows

### Trade-off Matrix

| Dimension                     | Temporal Cloud    | BullMQ            | Self-Hosted Temporal |
|-------------------------------|-------------------|-------------------|----------------------|
| Crash recovery                | Full replay       | Redis-dependent   | Full replay          |
| Saga/compensation             | Native            | Manual            | Native               |
| Escrow-safe execution         | Yes               | No                | Yes                  |
| Long-running (hours/days)     | Native            | Fragile           | Native               |
| TypeScript SDK                | Excellent         | Excellent         | Excellent            |
| Time-travel debugging         | Yes               | No                | Yes                  |
| Operational burden            | Low (managed)     | Low               | Very High            |
| Cost (current PCC scale)      | $100-300/mo       | $0-20/mo Redis    | $3,500+/mo           |
| Cost (100 operators)          | $200-500/mo       | $20-50/mo         | $3,500+/mo           |
| Financial settlement safety   | High              | Low               | High                 |

### Recommendation

**Adopt Temporal Cloud (Essentials plan). Prioritize 3 workflow types for initial implementation.**

Rationale: The combination of escrowed funds, evidence chain integrity requirements, and multi-hour job execution windows makes BullMQ's Redis-backed approach insufficient. A Redis failure (or AOF replay inconsistency) during a job execution that has locked $500 USDC in an escrow contract is a critical incident, not a retry. Temporal's durable execution model makes this class of failure impossible — the workflow either completes or its compensation handler runs.

The $100/month minimum on Temporal Cloud is justified by the risk reduction alone. At 100 jobs/month with ~50 actions each, cost is approximately $100 minimum + ~$125 usage = ~$225/month — well within reason for a production manufacturing platform.

Mitigate the heartbeat action cost: use long heartbeat intervals (5 minutes for CNC jobs, not 1 minute) and batch evidence submission into single activity calls rather than per-photo activities.

**First 3 workflows to implement:**
1. `JobLifecycleWorkflow`: submit → negotiate → escrow_lock → execute → evidence_bundle → verify → settle (saga: if verify fails, trigger refund)
2. `EscrowSettlementWorkflow`: monitors on-chain transaction, retries if gas issues, compensates on timeout
3. `MultiInstrumentOrchestrationWorkflow`: sequences OT-2 → quality sensor → downstream steps with human checkpoint signals

### Migration Plan

1. Add `@temporalio/client`, `@temporalio/worker`, `@temporalio/workflow`, `@temporalio/activity` packages to `packages/scheduler`
2. Create `temporal/workflows/job-lifecycle.ts` — translate existing scheduler DAG into Temporal workflow function
3. Create `temporal/activities/` — wrap existing facade method calls as Temporal activities (existing repository and service calls become activities with automatic retry)
4. Deploy Temporal Worker as separate Railway service; configure with Temporal Cloud namespace credentials
5. Implement saga compensation handlers for escrow refund and evidence rollback scenarios
6. Replace `scheduler` fire-and-forget dispatch with Temporal `client.workflow.start()` calls
7. Wire Temporal UI (included in Cloud) for operator visibility into job lifecycle state

### Timeline

- Month 1: JobLifecycleWorkflow + EscrowSettlementWorkflow implementation
- Month 2: MultiInstrumentOrchestrationWorkflow + compensation testing
- Month 3: Full migration of scheduler dispatch to Temporal; legacy path removed

### Estimated Monthly Cost

| Scale | Actions/Month | Temporal Cloud |
|-------|---------------|----------------|
| 10 jobs/mo | ~2,000 | $100 (minimum) |
| 100 jobs/mo | ~15,000-30,000 | $100-175 |
| 1,000 jobs/mo | ~150,000-300,000 | $175-350 |
| 10,000 jobs/mo | 1.5M-3M | $375-875 |

---

## Decision 4: Workload Identity (SPIFFE/SPIRE)

### Current State

PCC uses API keys and Bearer tokens for service-to-service authentication. mTLS is configured in the gateway but not enforced — it is an opt-in rather than a boundary condition. The IEC 62443 zone architecture (Zone 0: untrusted external → Zone 3: safety-critical kernel) is defined in the compliance documentation but not technically enforced at the network layer.

Current trust model weaknesses:

- A compromised API key grants persistent access until manually rotated
- No workload attestation — a rogue process on the same host can impersonate any service
- Agent types (Verifier, Printer, NanoClaw, OT-2 agent) have different trust requirements but the same credential format (Bearer token)
- ERC-8004 DID identity governs on-chain operator claims but does not address runtime service-to-service authentication

### Options Evaluated

**SPIFFE/SPIRE**
- SPIFFE (Secure Production Identity Framework for Everyone): CNCF graduated standard defining a workload identity format (SPIFFE ID: `spiffe://pcc.capability.network/ns/production/agent/verifier`)
- SPIRE: Production implementation of SPIFFE. Runs as a server (issues SVIDs) and agent (attests workloads, serves SVIDs via Workload API)
- SVIDs: Short-lived X.509 certificates (or JWTs) automatically rotated before expiry. No long-lived secrets.
- Node attestation: SPIRE Agent proves to SPIRE Server that it is running on a legitimate compute node (Railway/cloud attestors, or TPM attestation for physical operator nodes)
- Workload attestation: SPIRE Agent proves to a workload that it has a specific process signature (process name, UID, pod labels)
- Tornjak: Management UI layer for SPIRE — provides org-wide visibility into registration entries and SVID status
- Self-hosted: SPIRE binary is a single Go binary. SPIRE Server runs as one pod/container; SPIRE Agent runs as a DaemonSet per node. No licensing cost.
- Integration with existing DID identity: SPIFFE governs east-west service identity (runtime); DID governs north-south operator identity (on-chain claims). Complementary, not competing.

**Istio Service Mesh**
- Full service mesh: mTLS, traffic management, observability, policy enforcement
- SPIFFE-compatible (uses SPIFFE IDs internally)
- Strengths: Mature, battle-tested, handles mTLS transparently without application changes
- Weaknesses: Significant resource overhead (Envoy sidecar per pod, Istiod control plane); requires Kubernetes; adds significant operational complexity; overkill for PCC's current deployment model on Railway (non-Kubernetes)

**Manual Certificate Management**
- Issue certificates per service from a private CA; rotate manually or via cert-manager (Kubernetes only)
- Viable but fragile: rotation is a manual operational task; compromised service requires manual cert revocation and redistribution; no workload attestation

**Hashicorp Vault + PKI Secrets Engine**
- Vault PKI can issue short-lived certificates to services
- More flexible than manual certs; well-understood by ops teams
- Weaknesses: Vault itself becomes a critical dependency requiring HA deployment; services must call Vault API to obtain certificates; no automatic SVID rotation via Workload API standard; licensing cost for Vault Enterprise features

### Trade-off Matrix

| Dimension                   | SPIFFE/SPIRE    | Istio          | Manual Certs   | Vault PKI      |
|-----------------------------|-----------------|----------------|----------------|----------------|
| SPIFFE standard compliance  | Native          | Compatible     | No             | Partial        |
| Automatic cert rotation     | Native (SVIDs)  | Native         | Manual         | Yes (TTL-based)|
| Workload attestation        | Native          | Partial        | No             | No             |
| Non-Kubernetes support      | Yes             | No             | Yes            | Yes            |
| Operational complexity      | Medium          | High           | Low (until it fails) | Medium |
| IEC 62443 zone enforcement  | Via mTLS policy | Via Istio policy | Manual ACL  | Via Vault policy|
| Cost                        | $0 (OSS)        | $0 (OSS) + infra | $0            | $0-$$$$ (license) |
| DID integration path        | Clear           | Complex        | Manual         | Manual         |
| On-premises operator support| Excellent       | Poor           | Manual         | Good           |

### Recommendation

**Adopt SPIFFE/SPIRE. Self-hosted. Phase rollout over 3 milestones.**

Rationale: PCC's deployment model spans Railway-hosted cloud services and on-premises operator nodes (the pcc-node CLI running on shop-floor hardware). Istio is Kubernetes-only and eliminates the on-premises path. Manual certs fail at scale when operators are onboarded globally and certificates must be issued and rotated per-operator. SPIRE's workload attestation is the only mechanism that can assert "this SVID belongs to a pcc-gateway process running on Railway" rather than "this is an API key that was issued to gateway."

SPIFFE/SPIRE and ERC-8004 DID identity are fully complementary: DID handles "who is this operator and what have they attested on-chain?"; SPIRE handles "is this process the legitimate gateway service right now, with a certificate issued 30 seconds ago that auto-rotates every hour?"

**Phase 1 (Month 1-2): Gateway-to-kernel boundary**
- Deploy SPIRE Server on Railway; SPIRE Agent on gateway and kernel containers
- Issue SVIDs to `pcc-gateway` and `pcc-kernel` workloads
- Enforce mTLS on gateway → kernel channel
- This boundary has the highest consequence: kernel signs HLOS execution logs

**Phase 2 (Month 3-4): Agent-to-gateway boundary**
- Register SVIDs for each agent type (verifier, printer, OT-2, NanoClaw, harvest-agent)
- Each agent authenticates to gateway with short-lived SVID rather than long-lived API key
- Implement per-agent authorization policy based on SPIFFE ID: `spiffe://pcc.capability.network/agent/verifier` can call verify endpoints; `spiffe://pcc.capability.network/agent/printer` cannot

**Phase 3 (Month 5-6): Operator node attestation**
- Deploy SPIRE leaf federation to on-premises pcc-node installations
- Node attestation via TPM (if hardware available) or join-token (software attestation)
- Operator SVIDs federated to cloud SPIRE cluster via SPIFFE federation

### Migration Plan

1. Deploy SPIRE Server as Railway service with PostgreSQL backend (uses same Neon database — separate schema)
2. Configure SPIRE Server with Railway OIDC node attestor (attests Railway containers via their OIDC tokens)
3. Deploy SPIRE Agent as sidecar on `pcc-gateway` and `pcc-kernel` services
4. Register workload entries: `spiffe://pcc.capability.network/gateway` and `spiffe://pcc.capability.network/kernel`
5. Update gateway → kernel HTTP client to fetch X.509 SVID from SPIRE Workload API and use it for mTLS
6. Enforce `require_client_cert: true` on kernel service
7. Test with SPIRE's `spiffe-helper` for zero-application-code certificate rotation
8. Deploy Tornjak for SVID visibility and registration management

### Timeline

- Month 1-2: Phase 1 (gateway/kernel boundary)
- Month 3-4: Phase 2 (agent identities)
- Month 5-6: Phase 3 (operator node federation)

### Estimated Monthly Cost

| Component | Cost |
|-----------|------|
| SPIRE Server (Railway container) | $5-10/mo (compute) |
| SPIRE Agent sidecars | ~$0 (negligible compute overhead) |
| Tornjak UI | $5/mo (Railway container) |
| **Total SPIRE infrastructure** | **$10-15/mo** |

SPIRE is effectively free infrastructure. The cost is engineering time for initial setup (estimated 2-3 engineering days for Phase 1).

---

## Dependency Graph

The four decisions are not independent. Implementing them in the wrong order creates rework.

```
[Decision 1: Neon Postgres]
    │
    ├── Required by: SPIRE Server backend (SPIRE stores its data in Postgres)
    └── Required by: NATS JetStream deduplication table (stores message IDs)
         │
         [Decision 2: NATS JetStream]
              │
              └── Required by: Temporal Workers (Temporal workers use NATS as signal transport in distributed deployments)
                   │
                   [Decision 3: Temporal Cloud]
                        │
                        └── Enhanced by: SPIFFE SVIDs (Temporal Workers authenticate to Cloud namespace via SVID)
                             │
                             [Decision 4: SPIFFE/SPIRE]
```

**Recommended implementation order:**

| Phase | Decision | Dependency |
|-------|----------|------------|
| Phase 1 (Now — Month 1) | SQLite → Neon Postgres | None |
| Phase 2 (Month 1-2) | NATS JetStream | Postgres (for dedup tables) |
| Phase 3 (Month 2-3) | Temporal Cloud | NATS (for signal transport) |
| Phase 4 (Month 3-6) | SPIFFE/SPIRE | Postgres (for SPIRE backend); all above running |

Each phase can go to production independently. There is no need to complete all four before shipping improvements.

---

## Cost Estimates

Monthly cost projections by operator scale:

| Infrastructure Piece | Now (dev) | 10 operators | 100 operators | 1,000 operators |
|----------------------|-----------|--------------|---------------|-----------------|
| Neon Postgres | $5 | $40 | $120 | $500 |
| NATS JetStream (Synadia) | $0 | $35 | $100 | $300 (or self-host $40) |
| Temporal Cloud | $0 | $100 | $250 | $700 |
| SPIFFE/SPIRE infra | $0 | $15 | $15 | $30 |
| **Total addition** | **$5** | **$190** | **$485** | **$1,530** |

Notes:
- Current Railway + existing services costs are not included above (infrastructure delta only)
- NATS self-hosting becomes economical at ~50 operators ($40/month for 3-node cluster vs $150+ managed)
- Temporal self-hosting is not economical until 10M+ actions/month (requires dedicated platform team)
- All figures in USD; Neon pricing post-Databricks acquisition reflects 2026 reduced rates

---

## Risk Assessment

### Decision 1: What happens if we don't migrate from SQLite?

**Immediate risk (within weeks):** SQLite uses file-level write locking. Two operator nodes submitting evidence simultaneously will serialize, causing one to block and potentially timeout. At 10+ concurrent operators, this becomes a production incident.

**Medium-term risk:** Cannot deploy multiple gateway replicas for high availability — all would contend for the same SQLite file (or each maintain divergent state). Railway's horizontal scaling is blocked.

**Long-term risk:** No PITR means a schema corruption or bad migration is unrecoverable without backups. Evidence chains stored in SQLite cannot be audited by external parties or compliance tooling.

**Blast radius of failure:** Full platform unavailability during write contention; potential data loss on container restart if Railway's ephemeral filesystem reclaims the SQLite file.

### Decision 2: What happens if we don't adopt a distributed message bus?

**Immediate risk:** Single process failure loses all in-flight A2A intents. A `pcc-gateway` restart during job execution drops the `JOB_EXECUTE` intent — the operator's equipment never receives the command. Manual intervention required.

**Medium-term risk:** Cannot scale to multiple gateway instances — all message routing state is in-memory in a single process. Horizontal scaling is architecturally blocked.

**Long-term risk:** The PCC A2A protocol is designed for multi-agent, multi-operator communication. Without a shared message bus, the protocol operates only within a single process, which negates the entire distributed agent architecture.

**Blast radius of failure:** Lost job commands; stuck escrow funds; operator equipment sitting idle waiting for commands that will never arrive.

### Decision 3: What happens if we don't adopt durable workflows?

**Immediate risk:** Any process crash during the job lifecycle window (which can span hours) leaves the system in an indeterminate state. Escrow funds are locked but job state is unknown.

**Medium-term risk:** Operators lose trust in the platform after the first incident where funds are stuck and require manual admin intervention to resolve. This is a reputation-destroying event for a manufacturing platform.

**Long-term risk:** Multi-instrument orchestration (OT-2 → CNC → quality gate → packaging) cannot be built reliably without durable workflow primitives. The scheduler DAG approach only works if the orchestrating process stays alive for the entire job duration.

**Blast radius of failure:** Financial: stuck escrow funds requiring admin recovery. Operational: job state divergence between on-chain records and off-chain system state. Trust: operators stop submitting jobs.

### Decision 4: What happens if we don't adopt SPIFFE/SPIRE?

**Immediate risk:** Long-lived API keys are the weakest link in the authentication chain. A single leaked key grants persistent access until manually revoked — which requires knowing it was leaked.

**Medium-term risk:** IEC 62443 compliance certification (relevant for industrial customers) requires zone-boundary enforcement. "mTLS configured but not enforced" does not satisfy auditors.

**Long-term risk:** As PCC scales to global operators, the attack surface for credential theft grows proportionally. A compromised verifier node can falsify evidence without workload attestation detecting it.

**Blast radius of failure:** A compromised gateway API key allows an attacker to submit fraudulent job completions, trigger escrow payments for work never performed, or inject false evidence into the verification chain — all of which are financially consequential and legally liable events.

---

*This document reflects research conducted on 2026-04-03. Pricing figures are current as of that date and subject to vendor changes. All cost estimates should be validated against current vendor pricing pages before budget commitments.*

---

## Sources

- [Neon Serverless Postgres Pricing 2026](https://vela.simplyblock.io/articles/neon-serverless-postgres-pricing-2026/)
- [Neon Plans Documentation](https://neon.com/docs/introduction/plans)
- [Neon vs Supabase: Benchmarks, Pricing & When to Use Each](https://designrevision.com/blog/supabase-vs-neon)
- [Top Managed PostgreSQL Services Compared (2025 Edition)](https://seenode.com/blog/top-managed-postgresql-services-compared)
- [NATS vs Redis vs Kafka: Message Broker Comparison 2026](https://www.index.dev/skill-vs-skill/nats-vs-redis-vs-kafka)
- [NATS and Kafka Compared | Synadia](https://www.synadia.com/blog/nats-and-kafka-compared)
- [NATS vs. Kafka vs. Redis Streams for Java Microservices](https://www.javacodegeeks.com/2026/03/nats-vs-kafka-vs-redis-streams-for-java-microservices-when-simpler-actually-wins.html)
- [Comparing NATS JetStream and Kafka Performance](https://medium.com/@nathanbcrocker/comparing-nats-nats-jetstream-and-kafka-performance-for-varying-payload-sizes-3538c94ac56c)
- [Synadia Cloud](https://www.synadia.com/cloud)
- [Temporal Cloud Pricing Documentation](https://docs.temporal.io/cloud/pricing)
- [Estimating the cost of Temporal Cloud](https://temporal.io/blog/estimating-the-cost-of-temporal-cloud)
- [Cloud Benchmark: Temporal Cloud vs. Self-Hosted](https://temporal.io/blog/benchmarking-latency-temporal-cloud-vs-self-hosted-temporal)
- [Temporal Use Cases and Design Patterns](https://temporal.io/evaluate/use-cases-design-patterns)
- [Node.js Task Queue Solution | Temporal](https://temporal.io/blog/using-temporal-as-a-node-task-queue)
- [BullMQ vs Other Queue Systems](https://oneuptime.com/blog/post/2026-01-21-bullmq-vs-other-queues/view)
- [How to Set Up SPIFFE and SPIRE for Workload Identity in Kubernetes](https://oneuptime.com/blog/post/2026-02-09-spiffe-spire-workload-identity-kubernetes/)
- [Machine Identity: mTLS + SPIFFE Zero Trust Guide 2026](https://petronellatech.com/blog/machine-identity-is-the-new-perimeter-mtls-spiffe-for-zero-trust/)
- [SPIFFE/SPIRE Concepts](https://spiffe.io/docs/latest/spire-about/spire-concepts/)
- [Tornjak: Management Layer for SPIRE](https://github.com/spiffe/tornjak)
- [Railway Postgres Connection Pooling](https://blog.railway.com/p/database-connection-pooling)
- [CockroachDB Serverless Pricing Guide](https://airbyte.com/data-engineering-resources/cockroachdb-pricing)
