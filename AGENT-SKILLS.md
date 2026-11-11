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

## Contract & Pricing Skills

| Skill | Method | Endpoint | What It Does |
|-------|--------|----------|-------------|
| `get_build_options` | POST | `/api/build/options` | Get configuration options for a capability type: parameter groups, each parameter's definition, and a base price hint. It includes no assurance tiers |
| `build_contract` | POST | `/api/build/contract` | Build a contract with selected parameters and pricing |

## Job Execution Skills

| Skill | Method | Endpoint | What It Does |
|-------|--------|----------|-------------|
| `list_jobs` | GET | `/api/jobs` | List active and completed jobs |
| `get_job` | GET | `/api/jobs/:id` | Get job details with progress and evidence |
| `submit_workflow` | POST | `/api/jobs/submit` | Submit a CWM workflow for execution |

## Escrow & Settlement Skills

| Skill | Method | Endpoint | What It Does |
|-------|--------|----------|-------------|
| `list_escrows` | GET | `/api/escrow` | List escrow contracts with their milestone counts. Optionally filter by escrow status |
| `get_escrow` | GET | `/api/escrow/:escrowId` | Get one escrow. By its PCC id: the database record, with milestones and disputes. By its contract address: read from the chain |

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
| `list_batches` | GET | `/api/batches` | List batch manifests (HPLC runs, etc.) of the kernels you operate (admin: all) |
| `get_batch` | GET | `/api/batches/:id` | Get batch details with sample slots (admin or the kernel's operator) |
| `get_batch_by_job` | GET | `/api/batches/by-job/:jobId` | Find batches containing a job's samples (a party to the job; a buyer sees only its job's slots) |

## ZK Proof Skills

| Skill | Method | Endpoint | What It Does |
|-------|--------|----------|-------------|
| `create_commitment` | POST | `/api/zk/commit` | Create a Merkle commitment for evidence |
| `build_tree` | POST | `/api/zk/tree` | Build a commitment Merkle tree |
| `prove_inclusion` | POST | `/api/zk/prove/inclusion` | Generate ZK inclusion proof |
| `prove_tier` | POST | `/api/zk/prove/tier` | Generate tier compliance proof |
| `verify_proof` | POST | `/api/zk/verify` | Verify a ZK proof |

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
| `stream_kernel` | SSE | `/sse/stream/kernel/:kernelId` | All events from a kernel (admin or the kernel's operator) |
| `stream_device` | SSE | `/sse/stream/device/:deviceId` | All events from a device (admin or its kernel's operator) |
| `stream_batch` | SSE | `/sse/stream/batch/:batchId` | Batch lifecycle events (admin or its kernel's operator) |
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
