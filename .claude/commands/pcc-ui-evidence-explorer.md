Generate or enhance the PCC Evidence Explorer with evaluator attestation support.

Pattern source: PCC existing /evidence + Virtuals evaluator pattern + 8004scan transaction feed

## Enhancements to existing EvidenceExplorerPage

- **Evidence cards**: Each bundle as a GlassPanel card with:
  - Encryption status indicator (locked/unlocked icon + GlowBadge)
  - IPFS CID (IPFSLink component)
  - Evidence event count
  - ZK proof status badge (verified/pending/none)
  - Bittensor consensus score (0-1 with color coding)
  - NEW: Evaluator attestation badge (who verified, score, verdict)
- **Click to decrypt**: Lit Protocol access control check → show decrypted evidence
- **Evaluator section**: When evaluator has signed off:
  - Evaluator identity (ERC-8004 agent ID)
  - Verdict: pass/conditional/fail with color
  - Score: 0-100
  - Findings: Expandable list with severity badges (critical=red, major=gold, minor=gray)
  - Signed attestation VC hash
- **Transaction feed**: Chronological view of all evidence submissions with from/to tracking
- **Filters**: By job, capability type, verification status, evaluator

## Design
- Cards: GlassPanel with encryption lock icon top-right
- Decrypt button: Glowing green border, "Decrypt" label
- Evaluator badge: GlowBadge with verdict color, evaluator name truncated
- Findings: Collapsible list, severity-colored left border
- Feed: Vertical timeline with timestamps and action types
