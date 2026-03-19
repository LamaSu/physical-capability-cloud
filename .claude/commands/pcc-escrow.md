Check escrow status, milestones, and evidence for PCC jobs.

## Steps

1. If the user provides a job ID, fetch it directly with `pcc_get_job`
2. If not, list their active escrows with `pcc_list_escrows`
3. For each escrow, show:
   - Job ID and capability type
   - Total amount locked
   - Milestone progress (e.g., 2/4 completed)
   - Current milestone details: what evidence is needed, deadline
   - Bond amount and challenge window status (if Tier 2+)
   - Evidence submitted: IPFS CIDs, ZK proof status, Bittensor verification scores
4. If a milestone is ready for review, show the evidence bundle with `pcc_get_evidence`
5. Explain escrow states: funded → active → milestone_fulfilled → completed (or disputed)

## Key MCP tools
- `pcc_list_escrows` — list all escrows with status filters
- `pcc_get_job` — get job details including evidence timeline
- `pcc_get_evidence` — get evidence bundle details
- `pcc_list_jobs` — list jobs with filters

## Example queries
- "What's the status of my HPLC job?"
- "Show all active escrows"
- "Check evidence for job J-0047"
- "Is the milestone evidence verified yet?"
