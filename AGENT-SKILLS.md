# PCCP Agent Skills & API Reference

Every PCCP capability is exposed as a REST API endpoint that any AI agent can call. Agents interact with the protocol through these skills.

## Base URL
- **Local**: `http://localhost:3200`
- **Production**: `https://pcc-gateway-production.up.railway.app`

---

## Discovery Skills

| Skill | Method | Endpoint | What It Does |
|-------|--------|----------|-------------|
| `discover_capabilities` | GET | `/api/capabilities` | Search and filter available capabilities (HPLC, PCR, microscopy, etc.) |
| `get_capability` | GET | `/api/capabilities/:id` | Get details of a specific capability |
| `list_kernels` | GET | `/api/kernels` | List all shop kernels (labs, print shops, couriers) |
| `get_kernel` | GET | `/api/kernels/:id` | Get kernel details including devices and queue depth |
| `search_spaces` | GET | `/api/spaces` | Find hosting spaces for equipment |

## Contract & Pricing Skills

| Skill | Method | Endpoint | What It Does |
|-------|--------|----------|-------------|
| `get_build_options` | GET | `/api/build/options/:type` | Get configurable parameters for a capability type |
| `build_contract` | POST | `/api/build/contract` | Build a contract with selected parameters and pricing |
| `validate_contract` | POST | `/api/build/validate` | Validate contract parameters before submission |
| `get_profiles` | GET | `/api/build/profiles` | Get machine profiles with constraints |

## Job Execution Skills

| Skill | Method | Endpoint | What It Does |
|-------|--------|----------|-------------|
| `list_jobs` | GET | `/api/jobs` | List active and completed jobs |
| `get_job` | GET | `/api/jobs/:id` | Get job details with progress and evidence |
| `submit_workflow` | POST | `/api/jobs/submit` | Submit a CWM workflow for execution |

## Escrow & Settlement Skills

| Skill | Method | Endpoint | What It Does |
|-------|--------|----------|-------------|
| `list_escrows` | GET | `/api/escrows` | List all escrow contracts |
| `get_escrow` | GET | `/api/escrows/:id` | Get escrow details with milestones |
| `fund_milestone` | POST | `/api/escrows/:id/fund` | Fund an escrow milestone |
| `release_milestone` | POST | `/api/escrows/:id/milestones/:stepId/release` | Release funds after verification |
| `file_dispute` | POST | `/api/escrows/:id/dispute` | File a dispute on a milestone |

## Evidence Skills

| Skill | Method | Endpoint | What It Does |
|-------|--------|----------|-------------|
| `get_encrypted_evidence` | GET | `/api/evidence/encrypted/:bundleId` | Get an encrypted evidence bundle |
| `get_key_capsule` | GET | `/api/evidence/encrypted/:bundleId/capsule` | Get decryption key capsule |
| `grant_access` | POST | `/api/evidence/encrypted/:bundleId/grant` | Grant evidence access to another party |
| `list_grants` | GET | `/api/evidence/grants/:address` | List access grants for a wallet address |
| `archive_to_ipfs` | POST | `/api/evidence/archive` | Archive evidence bundle to IPFS |
| `get_from_ipfs` | GET | `/api/evidence/ipfs/:cid` | Retrieve data from IPFS by CID |

## Sensor & Monitoring Skills

| Skill | Method | Endpoint | What It Does |
|-------|--------|----------|-------------|
| `list_channels` | GET | `/api/sensors/channels` | List all sensor channels |
| `get_readings` | GET | `/api/sensors/readings/:channel` | Get recent sensor readings |
| `get_aggregates` | GET | `/api/sensors/aggregates/:channel` | Get aggregated sensor data |
| `get_anomalies` | GET | `/api/sensors/anomalies` | Get detected sensor anomalies |

## Batch Tracking Skills

| Skill | Method | Endpoint | What It Does |
|-------|--------|----------|-------------|
| `list_batches` | GET | `/api/batches` | List batch manifests (HPLC runs, etc.) |
| `get_batch` | GET | `/api/batches/:id` | Get batch details with sample slots |
| `get_batch_by_job` | GET | `/api/batches/by-job/:jobId` | Find batches containing a job's samples |

## ZK Proof Skills

| Skill | Method | Endpoint | What It Does |
|-------|--------|----------|-------------|
| `create_commitment` | POST | `/api/zk/commit` | Create a Merkle commitment for evidence |
| `build_tree` | POST | `/api/zk/tree` | Build a commitment Merkle tree |
| `prove_inclusion` | POST | `/api/zk/prove/inclusion` | Generate ZK inclusion proof |
| `prove_tier` | POST | `/api/zk/prove/tier` | Generate tier compliance proof |
| `verify_proof` | POST | `/api/zk/verify` | Verify a ZK proof |

## DePIN & Rewards Skills

| Skill | Method | Endpoint | What It Does |
|-------|--------|----------|-------------|
| `list_epochs` | GET | `/api/rewards/epochs` | List DePIN reward epochs |
| `get_epoch` | GET | `/api/rewards/epochs/:id` | Get epoch details with kernel scores |
| `list_certificates` | GET | `/api/rewards/certificates` | List soulbound capability certificates |
| `list_claims` | GET | `/api/rewards/claims` | List reward claims |
| `get_treasury` | GET | `/api/rewards/treasury` | Get DePIN treasury status |

## Protocol Skills

| Skill | Method | Endpoint | What It Does |
|-------|--------|----------|-------------|
| `list_protocols` | GET | `/api/protocols` | Browse protocol templates |
| `get_protocol` | GET | `/api/protocols/:id` | Get protocol DAG and parameters |
| `create_protocol` | POST | `/api/protocols` | Create a new protocol template |
| `fork_protocol` | POST | `/api/protocols/:id/fork` | Fork an existing protocol |
| `run_protocol` | POST | `/api/protocols/:id/run` | Start a protocol run |

## Orchestrator Skills

| Skill | Method | Endpoint | What It Does |
|-------|--------|----------|-------------|
| `get_transfer_graph` | GET | `/api/orchestrator/graph/:kernelId` | Get instrument transfer graph |
| `list_samples` | GET | `/api/orchestrator/samples` | Track sample movements |
| `list_workflows` | GET | `/api/orchestrator/workflows` | List instrument workflows |

## Logistics Skills

| Skill | Method | Endpoint | What It Does |
|-------|--------|----------|-------------|
| `list_shipments` | GET | `/api/logistics/shipments` | List active shipments |
| `get_shipment` | GET | `/api/logistics/shipments/:id` | Get shipment tracking details |
| `list_bookings` | GET | `/api/logistics/bookings` | List space bookings |
| `list_installations` | GET | `/api/logistics/installations` | List installation orders |
| `list_providers` | GET | `/api/logistics/providers` | List logistics providers |

## Authentication Skills

| Skill | Method | Endpoint | What It Does |
|-------|--------|----------|-------------|
| `get_nonce` | GET | `/api/auth/nonce` | Get SIWE nonce for signing |
| `verify_signature` | POST | `/api/auth/verify` | Verify SIWE signature, create session |
| `get_session` | GET | `/api/auth/me` | Get current session |
| `logout` | POST | `/api/auth/logout` | Destroy session |

## Real-Time Streaming (SSE)

| Skill | Protocol | Endpoint | What It Does |
|-------|----------|----------|-------------|
| `stream_job` | SSE | `/sse/stream/job/:jobId` | Real-time job events |
| `stream_kernel` | SSE | `/sse/stream/kernel/:kernelId` | All events from a kernel |
| `stream_device` | SSE | `/sse/stream/device/:deviceId` | All events from a device |
| `stream_batch` | SSE | `/sse/stream/batch/:batchId` | Batch lifecycle events |
| `stream_notifications` | SSE | `/sse/notifications` | Global notification stream |

## Agent-to-Agent Protocol (A2A)

Beyond REST, PCCP agents communicate via typed intents on the MessageBus:

| Intent | Direction | What It Does |
|--------|-----------|-------------|
| `discover_capabilities` | User → Broker | Search for matching capabilities |
| `request_quote` | User → Broker | Get pricing for a capability |
| `negotiate` | User → Broker | Counter-offer on price |
| `submit_workflow` | User → Broker | Submit a CWM for execution |
| `dispatch_job` | Broker → Kernel | Assign job to a kernel |
| `job_status_update` | Kernel → Broker | Report job progress |
| `evidence_submitted` | Kernel → Broker | Evidence bundle ready |
| `request_verification` | Broker → Verifier | Submit evidence for verification |
| `verification_result` | Verifier → Broker | Verification outcome |
| `escrow_funded` | Settlement → Broker | Escrow milestone funded |
| `payment_released` | Settlement → User | Funds released to operator |
| `request_funding` | Kernel → Broker | Request DePIN funding |
| `claim_rewards` | Kernel → Broker | Claim DePIN epoch rewards |

**Total: 65+ skills across 20 API route files + 13 A2A intents + 5 SSE streams.**
