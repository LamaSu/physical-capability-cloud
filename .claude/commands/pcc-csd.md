# PCC CSD — CLI

Manage Capability StructureDefinitions — the FHIR-inspired schema layer that defines what capabilities can do, their parameters, and their lifecycle.

## When to use
- "List capability definitions"
- "Register a new CSD"
- "Get the CSD for HPLC reverse phase"
- "What CSDs are available for flow chemistry?"
- "Create a CSD for my custom milling operation"
- "Show me the active base CSDs"
- "What parameters does the CNC-5axis CSD define?"

## Prerequisites
- Build the CLI first: `cd packages/mcp-server && npx tsc`
- Gateway reachable at `PCC_URL` (default: https://pcc-gateway-production.up.railway.app)

## What is a CSD?

A Capability StructureDefinition (CSD) is a versioned schema document that formally defines a PCC capability. It specifies:
- **Parameters**: What inputs the capability accepts (materials, tolerances, methods)
- **Evidence requirements**: What data must be collected per assurance tier
- **Acceptance criteria**: What constitutes a successful outcome
- **Lifecycle status**: `draft`, `active`, `retired`
- **Kind**: `base` (canonical type), `profile` (specialization), `extension` (adds fields), `workflow` (multi-step)

CSDs are the authoritative source of truth for what a capability contract can contain. The contract builder (`/pcc-build`) is backed by CSDs.

## Commands

### CSD List — List All CSDs
```bash
node packages/mcp-server/dist/cli.js csd list
```
Lists all registered CSD documents. Returns: canonical URI, name, kind, status, version, and registration date.

Filter by kind:
```bash
node packages/mcp-server/dist/cli.js csd list --kind base
node packages/mcp-server/dist/cli.js csd list --kind profile
node packages/mcp-server/dist/cli.js csd list --kind workflow
```

Filter by status:
```bash
node packages/mcp-server/dist/cli.js csd list --status active
node packages/mcp-server/dist/cli.js csd list --status draft
```

### CSD Get — Get a Specific CSD
```bash
node packages/mcp-server/dist/cli.js csd get <uri>
```
Retrieves the full CSD document by its canonical URI. Output is the complete JSON schema including all parameter definitions, evidence requirements, and acceptance criteria.

Example:
```bash
node packages/mcp-server/dist/cli.js csd get "https://pcc.example.com/csd/hplc-reverse-phase-v1"
```

The canonical URI is shown in `csd list` output. It's the permanent identifier for the CSD — it never changes even if the CSD is retired.

### CSD Register — Register a New CSD
```bash
node packages/mcp-server/dist/cli.js csd register <json>
```
Registers a new CSD document. The JSON argument is the CSD document (either inline or as a file path). Returns the assigned canonical URI.

Inline JSON:
```bash
node packages/mcp-server/dist/cli.js csd register '{
  "name": "Custom 4-Axis Milling",
  "kind": "profile",
  "base": "https://pcc.example.com/csd/cnc-base-v1",
  "status": "draft",
  "parameters": [
    {"id": "material", "type": "enum", "values": ["aluminum", "brass", "delrin"]},
    {"id": "tolerance_mm", "type": "number", "min": 0.005, "max": 0.5},
    {"id": "quantity", "type": "integer", "min": 1, "max": 1000}
  ],
  "evidence": {
    "tier1": ["dimensional_report"],
    "tier2": ["dimensional_report", "surface_finish_report", "operator_sign_off"],
    "tier3": ["dimensional_report", "surface_finish_report", "operator_sign_off", "cmm_data"]
  }
}'
```

From a file:
```bash
node packages/mcp-server/dist/cli.js csd register --file ./my-csd.json
```

## CSD Kinds Reference

| Kind | Purpose | Example |
|------|---------|---------|
| `base` | Canonical capability type definition | `cnc-base`, `hplc-base` |
| `profile` | Specialization of a base CSD with narrower parameters | `cnc-5axis-titanium` |
| `extension` | Adds optional fields to an existing CSD without narrowing it | `hplc-with-uv-vis-detector` |
| `workflow` | Multi-step capability combining base/profile CSDs | `synthesize-purify-verify` |

## Workflow: Create and Register a Custom CSD

1. Browse existing base CSDs to find if yours is a profile of an existing type:
   ```bash
   node packages/mcp-server/dist/cli.js csd list --kind base --status active
   ```

2. If extending an existing base, retrieve it to understand its parameter schema:
   ```bash
   node packages/mcp-server/dist/cli.js csd get <baseUri>
   ```

3. Draft your CSD JSON. Start from the base and narrow/extend the parameters.

4. Register as a draft first to get a canonical URI:
   ```bash
   node packages/mcp-server/dist/cli.js csd register --file ./my-csd-draft.json
   ```

5. Review the registered CSD to verify it looks right:
   ```bash
   node packages/mcp-server/dist/cli.js csd get <returned-uri>
   ```

6. When ready for use in contracts, update the status to `active` (re-register with same URI and updated status field).

7. Optionally register as an IP Asset to earn royalties when others use this CSD (`/pcc-ip`).

## Workflow: Audit CSDs Before Building a Contract

When building a contract for a capability type you haven't used before:

1. List active CSDs of that kind:
   ```bash
   node packages/mcp-server/dist/cli.js csd list --status active --kind base
   ```

2. Retrieve the relevant CSD to understand exactly what evidence each tier requires:
   ```bash
   node packages/mcp-server/dist/cli.js csd get <uri>
   ```

3. Use this information to set realistic expectations about evidence collection before building the contract (`/pcc-build`).

## Tips
- CSD URIs are permanent identifiers. Never delete or reuse a URI — retire old CSDs and create new ones with new URIs.
- Status `draft` means the CSD is work-in-progress and cannot be used in contracts. Flip to `active` when you are ready.
- `profile` CSDs must reference a valid `base` CSD in their `base` field. The gateway validates this on registration.
- If you are creating a genuinely novel capability type (not a profile of anything existing), register a `base` CSD first, then optionally create profiles of it.
- CSDs registered as IP Assets (`/pcc-ip`) earn royalties each time a contract is built referencing them. High-value novel protocols are worth registering as IP.
- The canonical URI format is typically `https://pcc-gateway-production.up.railway.app/csd/<slug>-v<version>` — the gateway assigns this, but you can suggest a slug during registration.
