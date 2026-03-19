Submit a manufacturing job to PCC with milestone escrow.

Walk the user through the full job submission flow using the contract builder.

## Steps

1. **Select capability type**: Use `pcc_build_options` with the capability type to get available parameters
2. **Configure parameters**: Show parameter groups, let user select values. Call `pcc_build_options` with partial selections to get dependent options
3. **Calculate price**: Use `pcc_calculate_price` with complete selections
4. **Set assurance tier**: Explain the tiers:
   - Tier 0: Self-attested (cheapest, no evidence required)
   - Tier 1: Basic verification (peer review)
   - Tier 2: Standard (evidence chain + bonds)
   - Tier 3: Full (ZK proofs + Bittensor + challenge window)
5. **Build contract**: Use `pcc_build_contract` to generate the full contract
6. **Review**: Show the user the complete contract with milestones, pricing, evidence requirements
7. **Submit**: Confirm and submit the job via `POST /api/jobs`

## Key MCP tools
- `pcc_build_options` — get available parameter choices
- `pcc_calculate_price` — calculate price for selections
- `pcc_build_contract` — generate complete contract
- `pcc_list_capabilities` — find capability types
- `pcc_search_capabilities` — search with details

## Example flows
- "I need HPLC purity analysis for a peptide sample"
- "Build a contract for 5-axis CNC machining, aluminum, ±0.01mm tolerance"
- "Submit a flow chemistry job at Tier 2 assurance"
