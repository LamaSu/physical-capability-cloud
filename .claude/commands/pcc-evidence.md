Browse and verify evidence bundles from PCC jobs.

## Steps

1. If user provides a bundle ID, fetch with `pcc_get_evidence`
2. If user provides a job ID, get job details with `pcc_get_job` and list all evidence bundles
3. For each evidence bundle, show:
   - Bundle ID and associated job/milestone
   - Encryption status (Lit Protocol AES-256-GCM)
   - IPFS CID (content-addressed, immutable)
   - Evidence events: what data was collected (measurements, sensor readings, photos)
   - ZK proof status: generated? verified?
   - Bittensor verification: miner consensus score, number of miners
   - Evaluator attestation (if any): who verified, score, findings
4. If the user wants to verify, trigger verification via `POST /api/evidence/{bundleId}/verify`
5. Explain the evidence lifecycle:
   - Collect → Encrypt (Lit Protocol) → Store (IPFS) → Verify (Bittensor) → ZK Proof → Escrow Release

## Key MCP tools
- `pcc_get_evidence` — get evidence bundle details
- `pcc_get_job` — get job with evidence timeline
- `pcc_list_jobs` — find jobs to inspect

## Example queries
- "Show evidence for bundle bafkrei..."
- "What evidence was submitted for the HPLC job?"
- "Verify the evidence for milestone 2"
- "Show ZK proof status for all active jobs"
