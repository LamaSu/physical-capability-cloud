# PCC — Bounty Submission Claims

**Project**: Physical Capability Cloud
**Hackathon**: PL Genesis: Frontiers of Collaboration
**Deadline**: March 31, 2026
**Live**: https://capability.network

---

## Main Track Prizes

### Fresh Code — $5,000

**Status**: Submitting

The PCC repository was created on March 2, 2026, after the hackathon opened on February 10. All 25 packages, 3,300+ tests, 154 agent tools, and 347 REST endpoints were written during the hackathon window. The repo history is publicly verifiable — no commits exist before March 2. This is not a rebrand of a prior project; the protocol design, agent architecture, sovereign infrastructure layer, and deployment infrastructure were all built from scratch during this period.

---

### AI & Robotics Track

**Status**: Submitting

PCC is physical AI infrastructure — the foundational layer that lets AI agents discover, negotiate, and orchestrate real machines. The system runs a 6-phase agentic pipeline (Discover → Bid → Escrow → Execute → Verify → Settle) with a multi-agent architecture (User, Broker, Kernel, Evaluator) communicating over 34 typed A2A intents. A real OT-2 liquid handler robot is operating as the first operator node via the `pcc-node` Python package, which auto-detects hardware, generates Ed25519 keys, provisions API credentials, and registers the device on the network in a single command. This is not a simulation of physical AI — it is the protocol layer that makes physical AI agents economically viable.

---

### Infrastructure & Digital Rights Track

**Status**: Submitting

PCC's sovereign evidence chain is a complete digital rights infrastructure stack: W3C DIDs for machine identity (`did:key` and `did:pcc`), Verifiable Credentials for capability attestation, content-addressed IPFS storage via Storacha for permanent evidence archival, AES-256-GCM encryption with programmable on-chain access conditions via Lit Protocol, ZK Merkle proofs for privacy-preserving evidence commitments, and Starknet anchoring for permanent chain-verifiable proof of execution. Operators in 34 emerging market countries can receive payment in local fiat via the Yellowcard integration — removing the barriers that have historically kept small physical manufacturers out of global supply chains.

---

## Sponsor Bounties

### Storacha — Storage Bounty ($300 + credits)

**Status**: Submitting

PCC integrates `@storacha/client` (the w3up SDK) for permanent evidence archival. Every evidence bundle produced during job execution is uploaded to Storacha via `client.uploadFile()`, producing CIDv1 hashes using sha2-256 + raw codec. Two CIDs are generated per bundle: a full bundle CID and a public metadata CID (no sensitive fields). The storage factory (`packages/kernel/src/evidence-storage-factory.ts`) selects Storacha vs. Helia based on the `EVIDENCE_STORAGE` environment variable, making the integration production-ready without coupling the codebase to a single IPFS backend. The `StorachaStorageService` (`packages/kernel/src/storacha-storage.ts`) handles UCAN delegation parsing, space management, and gateway retrieval (`https://w3s.link/ipfs/<cid>`).

**Relevant files**: `packages/kernel/src/storacha-storage.ts`, `packages/kernel/src/evidence-storage-factory.ts`

**Test**: `pnpm --filter @pcc/kernel test`

---

### Lit Protocol — NextGen AI Apps ($500)

**Status**: Submitting

PCC uses Lit Protocol to encrypt manufacturing evidence under programmable on-chain access conditions tied to smart contract state. The `LitEncryptionService` builds `UnifiedAccessControlCondition` arrays that gate decryption on whether the caller is the escrow buyer (`MilestoneEscrow.getBuyer(jobId) == callerAddress`) or a credentialed verifier (reputation >= 100). This is AI-native programmable access control: the AI agents running the pipeline produce encrypted evidence that only the contracting party and authorized verifiers can read. The real implementation (`packages/kernel/src/lit-encryption-real.ts`) uses `@lit-protocol/lit-node-client` v6 on the `datil-test` network with full threshold key splitting. Activate with `LIT_PROTOCOL_REAL=true`.

**Relevant files**: `packages/kernel/src/lit-encryption-service.ts`, `packages/kernel/src/lit-encryption-real.ts`

**Test**: `npx tsx scripts/lit-protocol-demo.ts`

---

### Starknet — Best Use / ZK Proofs

**Status**: Submitting

PCC's `StarknetProofAnchoringService` (`packages/verifier/src/starknet-proof-service.ts`) anchors ZK proof hashes and Merkle commitment roots on Starknet Sepolia via `starknet.js`. After evidence is verified, a canonical SHA-256 hash of the proof is submitted as a felt252 field element to the `ProofRegistry` contract (RPC: `starknet-sepolia.public.blastapi.io`). This creates a permanent, publicly verifiable on-chain record that specific physical work happened and passed verification — without ever committing raw evidence to the chain. The system supports both single-proof anchoring (`anchorProof`) and batch anchoring via Merkle roots (`anchorMerkleRoot`), making it gas-efficient for high-throughput workloads. The integration is activated by setting `STARKNET_ACCOUNT` and `STARKNET_PRIVATE_KEY` environment variables.

**Relevant files**: `packages/verifier/src/starknet-proof-service.ts`, `packages/verifier/src/zk-proof-service.ts`

**Test**: `pnpm --filter @pcc/verifier test`

---

### Physical AI — Solo Tech / Physical AI ($500)

**Status**: Submitting

PCC is, literally, physical AI infrastructure. The entire protocol exists to let AI agents coordinate and control physical machinery — 3D printers, CNC routers, liquid handlers, mass spectrometers, couriers. The `pcc-node` Python package (pip-installable) turns any physical device into a network endpoint: it auto-detects OT-2 robots, OctoPrint servers, and generic HTTP devices, generates Ed25519 identity keys, provisions API credentials, and registers the hardware on the network as a governed operator node. The Execution Scope Protocol (4 security classes: READ/SAFE/SCOPED/PRIVILEGED) ensures AI agents can only issue commands they are explicitly authorized for — a critical safety primitive for physical systems. This is not AI applied to physical data; this is the protocol layer for physical AI.

---

### Impulse AI — AI Agent Integration ($300)

**Status**: Integration pending

PCC's 154-tool agent package (`/agent-package.json`) and 49-tool MCP server are designed to be consumed by any AI agent runtime, including Impulse AI. The agent package exposes the full PCC pipeline as structured tool calls: capability discovery, price quoting, contract building, escrow management, job submission, evidence retrieval, ZK proof generation, and fiat ramp operations. Integration with Impulse AI's agent framework would allow Impulse agents to autonomously source physical manufacturing capabilities. If the integration is completed before the deadline, this claim will be updated with specifics.

---

### Funding the Commons — EIR Residency

**Status**: Submitting

PCC is open infrastructure for the physical economy. The protocol is credibly neutral: operators set their own prices, there is no extractive platform fee beyond the protocol escrow commission, and the codebase is Apache 2.0. The Yellowcard integration enables operators and users in 34 emerging market countries to participate using local fiat currency via mobile money and bank transfer — removing the USD/crypto onramp barrier that excludes most of the world's physical manufacturing capacity from global supply chains. The Sovereign Wealth Fund module allows protocol revenue to be governed collectively and distributed to participants. PCC is applying for EIR residency to continue building this infrastructure toward mainnet deployment.

---

## Qualification Summary

| Bounty | Qualification Basis | Key Evidence |
|--------|--------------------|----|
| Fresh Code ($5K) | Repo created March 2, 2026 | Git history |
| AI & Robotics Track | Physical AI protocol + real OT-2 node | `packages/pcc-node/`, A2A agent layer |
| Infrastructure & Digital Rights | Sovereign data stack (DIDs, IPFS, Lit, ZK) | `packages/spec/src/identity/`, `packages/kernel/`, `packages/verifier/` |
| Storacha ($300) | `@storacha/client` w3up integration | `packages/kernel/src/storacha-storage.ts` |
| Lit Protocol ($500) | `@lit-protocol/lit-node-client` v6, real access conditions | `packages/kernel/src/lit-encryption-real.ts` |
| Starknet (ZK) | `starknet.js` proof anchoring on Sepolia | `packages/verifier/src/starknet-proof-service.ts` |
| Physical AI ($500) | The protocol IS physical AI infrastructure | Entire codebase |
| Impulse AI ($300) | Agent package ready for integration | `/agent-package.json`, `packages/mcp-server/` |
| Funding the Commons (EIR) | Open infrastructure, emerging market access | Yellowcard integration, Apache 2.0 license |
