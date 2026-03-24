# PCC Build — CLI

Capability discovery, contract construction, and pricing — from "what can PCC do?" to a signed contract ready for escrow.

## When to use
- "Build a contract for CNC machining"
- "Price a 3D print job"
- "What capabilities are available?"
- "How much does HPLC analysis cost?"
- "Search for flow chemistry capabilities"
- "Build a contract for Tier 2 assurance"
- "Compile a multi-step workflow"
- "What parameters do I need for mass spectrometry?"

## Prerequisites
- Build the CLI first: `cd packages/mcp-server && npx tsc`
- Gateway reachable at `PCC_URL` (default: https://pcc-gateway-production.up.railway.app)

## Commands

### Capabilities List — List All Capability Types
```bash
node packages/mcp-server/dist/cli.js capabilities list
```
Lists all registered capability types in the PCC taxonomy. Returns type identifiers (e.g., `hplc`, `cnc-3axis`, `cnc-5axis`, `fdm-printer`, `mass-spec`, `flow-reactor`, `sla-printer`, `injection-molding`). Use these type IDs in subsequent `build` commands.

### Capabilities Search — Search Templates with Details
```bash
node packages/mcp-server/dist/cli.js capabilities search
```
Searches capability templates with full details: operator name, location, assurance tier, pricing, key specifications, and availability. Supports free-text search — describe what you need and it returns matching templates. Equivalent to browsing the PCC marketplace.

### Build Options — Get Parameters for a Capability Type
```bash
node packages/mcp-server/dist/cli.js build options <type>
```
Returns the full parameter schema for a given capability type. Shows all configurable parameters, valid values, and interdependencies. Parameters are grouped (e.g., material, tolerance, quantity, assurance tier). Use the output to understand what values you'll need to provide.

Example:
```bash
node packages/mcp-server/dist/cli.js build options cnc-3axis
```

You can also pass partial selections to get context-dependent options:
```bash
node packages/mcp-server/dist/cli.js build options cnc-3axis --params '{"material":"aluminum"}'
```
This returns the options that depend on the already-selected material (e.g., achievable tolerances for aluminum).

### Build Price — Calculate Price for Selections
```bash
node packages/mcp-server/dist/cli.js build price <type>
```
Calculates the price for a set of selections. Returns base price, tier add-ons (bonds, ZK proof overhead), estimated turnaround, and a per-milestone payment schedule. Pass parameters as JSON:

```bash
node packages/mcp-server/dist/cli.js build price hplc --params '{"sample_count":5,"method":"reverse_phase","assurance_tier":2}'
```

### Build Contract — Build Full Contract
```bash
node packages/mcp-server/dist/cli.js build contract <type>
```
Generates the complete capability contract: capability spec, milestone schedule, evidence requirements per milestone, payment amounts per milestone, assurance tier rules, and escrow terms. The output is the contract payload ready to be submitted to escrow.

```bash
node packages/mcp-server/dist/cli.js build contract fdm-printer --params '{"material":"PLA","layer_height":0.2,"infill":20,"assurance_tier":1}'
```

Assurance tiers and what they mean:
- **Tier 0**: Self-attested, no evidence required — cheapest, highest trust risk
- **Tier 1**: Basic peer review — one evaluator sign-off
- **Tier 2**: Standard — evidence chain + operator bond (slashed on dispute loss)
- **Tier 3**: Full — ZK proofs + Bittensor verifier consensus + challenge window

### Workflows Compile — Compile a Multi-Step Workflow
```bash
node packages/mcp-server/dist/cli.js workflows compile
```
Compiles a multi-step workflow (DAG) from a list of steps with dependencies. Each step references a capability type and parameters. The compiler validates the dependency graph, checks capability availability, calculates total price, and outputs an execution plan.

Provide the workflow definition as JSON:
```bash
node packages/mcp-server/dist/cli.js workflows compile --workflow '[
  {"id":"step1","type":"hplc","params":{"sample_count":1,"method":"reverse_phase"}},
  {"id":"step2","type":"mass-spec","params":{"ionization":"ESI"},"depends_on":["step1"]}
]'
```

## Workflow: Build a Contract from Scratch

1. Browse available capability types to find what you need:
   ```bash
   node packages/mcp-server/dist/cli.js capabilities list
   ```

2. Search for templates matching your requirement:
   ```bash
   node packages/mcp-server/dist/cli.js capabilities search
   ```

3. Explore available parameters for your chosen capability type:
   ```bash
   node packages/mcp-server/dist/cli.js build options cnc-5axis
   ```

4. Get a price estimate for your selections:
   ```bash
   node packages/mcp-server/dist/cli.js build price cnc-5axis --params '{"material":"titanium","tolerance":0.01,"quantity":10,"assurance_tier":2}'
   ```

5. Build the full contract:
   ```bash
   node packages/mcp-server/dist/cli.js build contract cnc-5axis --params '{"material":"titanium","tolerance":0.01,"quantity":10,"assurance_tier":2}'
   ```

6. Review the milestone schedule and evidence requirements in the contract output.
7. Proceed to job submission — take the contract payload to `/pcc-jobs` or the escrow flow.

## Workflow: Multi-Step Lab Analysis Pipeline

For workflows that chain multiple capabilities (e.g., synthesize → purify → verify):

1. Identify the capability types needed:
   ```bash
   node packages/mcp-server/dist/cli.js capabilities list
   ```

2. Get options for each step separately to understand parameters:
   ```bash
   node packages/mcp-server/dist/cli.js build options flow-reactor
   node packages/mcp-server/dist/cli.js build options hplc
   node packages/mcp-server/dist/cli.js build options mass-spec
   ```

3. Compile the multi-step workflow:
   ```bash
   node packages/mcp-server/dist/cli.js workflows compile --workflow '[
     {"id":"synthesis","type":"flow-reactor","params":{"reagent_volume_ml":50}},
     {"id":"purification","type":"hplc","params":{"method":"reverse_phase"},"depends_on":["synthesis"]},
     {"id":"verification","type":"mass-spec","params":{"ionization":"ESI"},"depends_on":["purification"]}
   ]'
   ```

4. Review the compiled DAG: total price, critical path duration, per-step evidence requirements.

## Tips
- `build options` is cheap — call it repeatedly as you refine your parameter selections. It returns context-dependent options, so providing partial selections gives you a filtered view of valid next choices.
- Assurance tier has the biggest impact on price. Start with Tier 1 for prototyping and upgrade to Tier 2/3 for production or regulated work.
- `build price` shows the full milestone payment schedule — useful for understanding cash flow before committing.
- When building contracts for novel capability types not in the taxonomy, register a CSD first (`/pcc-csd`) and then reference it in `build contract`.
- `workflows compile` validates dependency cycles automatically. If you get a cycle error, review your `depends_on` chains.
