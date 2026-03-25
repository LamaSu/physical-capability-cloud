# PCC Submit Job — CLI

Submit a manufacturing job to PCC with milestone escrow using the contract builder CLI.

## When to use
- "Submit a job" / "I need CNC machining" / "Build a contract for 3D printing"
- "Price a job" / "What parameters are available for HPLC?"

## Prerequisites
- PCC gateway reachable at PCC_URL (default: https://pcc-gateway-production.up.railway.app)
- Build CLI: `cd packages/mcp-server && npx tsc`

## Commands

### List capability types
```bash
node packages/mcp-server/dist/cli.js capabilities list [--pretty]
```
Shows all registered PCC capability types (fdm-printer, cnc-3axis, hplc, etc.).

### Search capabilities with details
```bash
node packages/mcp-server/dist/cli.js capabilities search [--pretty]
```
Full details: type, name, version, parameter count, groups, base pricing.

### Get build options (parameter discovery)
```bash
node packages/mcp-server/dist/cli.js build options <type> [--selections='{}'] [--profileId=x] [--pretty]
```
Interactive parameter discovery. Pass partial selections to get next available choices.

### Calculate price
```bash
node packages/mcp-server/dist/cli.js build price <type> --selections='{"material":"pla","infill":20}' [--profileId=x] [--pretty]
```

### Build complete contract
```bash
node packages/mcp-server/dist/cli.js build contract <type> --selections='{"material":"pla","infill":20}' --tier=2 [--profileId=x] [--pretty]
```
Full contract with pricing, milestones, and assurance tier. Ready for escrow.

### Compile multi-step workflow
```bash
node packages/mcp-server/dist/cli.js workflows compile --steps='[{"id":"print","capabilityType":"fdm-printer"},{"id":"verify","capabilityType":"cmm","dependsOn":["print"]}]' [--pretty]
```
Compiles into execution DAG with topologically sorted waves.

## Workflow: Submit a job
1. `pcc capabilities list --pretty` — find capability type
2. `pcc build options fdm-printer --pretty` — see available parameters
3. `pcc build options fdm-printer --selections='{"material":"pla"}' --pretty` — progressive refinement
4. `pcc build price fdm-printer --selections='{"material":"pla","infill":20,"layer_height":0.2}' --pretty` — check price
5. `pcc build contract fdm-printer --selections='{"material":"pla","infill":20,"layer_height":0.2}' --tier=2 --pretty` — build contract

## Assurance tiers
- **Tier 0**: Self-attested (cheapest, no evidence required)
- **Tier 1**: Basic verification (peer review)
- **Tier 2**: Standard (evidence chain + bonds)
- **Tier 3**: Full (ZK proofs + Bittensor subnet + challenge window)

## Tips
- Call build options iteratively with growing selections to discover dependent parameters
- Higher assurance tiers cost more but provide stronger guarantees
- Workflows with dependencies compile into parallel execution waves
