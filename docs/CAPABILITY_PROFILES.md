# Capability StructureDefinitions (CSD) — Design Specification

> **The goal**: Anyone plugs in a machine, an agent discovers what it can do,
> the machine joins the network with a wallet, and other agents can actuate it
> by following the protocol. No human configuration. No manual parameter entry.
> The machine describes itself. The network validates and prices it. Settlement is automatic.

---

## The Problem Today

PCC has 4 hardcoded capability templates (FDM, SLA, CNC, Laser Cut) written in TypeScript.
Adding a new capability type requires a developer to:

1. Write a template file in `packages/contract-builder/src/templates/`
2. Define all parameters, constraints, and pricing impacts in code
3. Register it in the template registry
4. Update the spec types
5. Rebuild and redeploy

This doesn't scale. A person in Florida with a Canon inkjet should be able to say
"I have a printer" and have the network understand what it can do — without anyone
writing TypeScript.

---

## The Vision: Self-Describing Machines

```
┌─────────────────────────────────────────────────────────────┐
│                    THE ONBOARDING FLOW                       │
│                                                             │
│  1. Plug in machine                                         │
│  2. Agent auto-discovers it (mDNS, IPP, USB, manual URL)   │
│  3. Machine reports its capabilities (IPP attrs, OctoPrint  │
│     API, Modbus registers, or human describes it)           │
│  4. Agent generates a CSD (Capability StructureDefinition)  │
│  5. Agent registers the CSD + device on the network         │
│  6. Agent creates/connects wallet                           │
│  7. Machine is LIVE — other agents can discover and book it │
│  8. Jobs arrive → adapter actuates machine → evidence flows │
│  9. Settlement is automatic                                 │
└─────────────────────────────────────────────────────────────┘
```

---

## Part 1: Capability StructureDefinition (CSD)

A CSD is a JSON document that completely describes what a machine can do,
what parameters are configurable, what constraints apply, and how to price it.

Think of it as a FHIR StructureDefinition but for physical capabilities:
- FHIR Profile says "a US Core Patient MUST have a race extension"
- CSD says "a Canon PIXMA MUST support color printing, paper sizes A4/Letter/Legal,
  resolution 300-4800 DPI, and borderless mode for photo paper"

### 1.1 Schema

```json
{
  "$schema": "https://pcc.network/schemas/csd/v1",
  "url": "pcc://capabilities/2d-print/v1",
  "version": "1.0.0",
  "status": "active",
  "name": "2D Print",
  "description": "Standard 2D document and image printing via inkjet or laser",

  "kind": "base",
  "baseDefinition": null,

  "discovery": {
    "protocols": ["ipp", "usb", "mdns", "manual"],
    "detect": {
      "ipp": {
        "attributes": ["printer-make-and-model", "media-supported", "print-color-mode-supported"]
      },
      "mdns": {
        "serviceType": "_ipp._tcp"
      }
    }
  },

  "adapter": {
    "type": "ipp",
    "configSchema": {
      "type": "object",
      "properties": {
        "uri": { "type": "string", "description": "IPP printer URI (e.g., ipp://192.168.1.50/ipp/print)" },
        "name": { "type": "string", "description": "Human-readable printer name" }
      },
      "required": ["uri"]
    },
    "commands": {
      "print": { "description": "Send a document to the printer", "input": "file", "output": "jobId" },
      "status": { "description": "Get printer status", "output": "printerState" },
      "cancel": { "description": "Cancel a print job", "input": "jobId" }
    }
  },

  "parameters": [
    {
      "key": "mediaSize",
      "type": "enum",
      "label": "Paper Size",
      "required": true,
      "options": [
        { "value": "na_letter_8.5x11in", "label": "Letter (8.5×11\")" },
        { "value": "iso_a4_210x297mm", "label": "A4 (210×297mm)" },
        { "value": "iso_a3_297x420mm", "label": "A3 (297×420mm)" },
        { "value": "na_legal_8.5x14in", "label": "Legal (8.5×14\")" },
        { "value": "na_number-10_4.125x9.5in", "label": "Envelope #10" },
        { "value": "custom", "label": "Custom Size" }
      ],
      "group": "media",
      "pricingImpact": null
    },
    {
      "key": "mediaType",
      "type": "enum",
      "label": "Paper Type",
      "required": true,
      "options": [
        { "value": "stationery", "label": "Plain Paper" },
        { "value": "photographic-high-gloss", "label": "Photo Paper (Glossy)" },
        { "value": "photographic-matte", "label": "Photo Paper (Matte)" },
        { "value": "cardstock", "label": "Cardstock" },
        { "value": "transparency", "label": "Transparency" },
        { "value": "labels", "label": "Labels" },
        { "value": "envelope", "label": "Envelope" }
      ],
      "group": "media",
      "pricingImpact": null
    },
    {
      "key": "colorMode",
      "type": "enum",
      "label": "Color Mode",
      "required": true,
      "options": [
        { "value": "color", "label": "Full Color" },
        { "value": "monochrome", "label": "Black & White" },
        { "value": "auto", "label": "Auto-detect" }
      ],
      "group": "quality",
      "pricingImpact": { "mode": "multiplier", "perOption": { "color": 2.0, "monochrome": 1.0, "auto": 1.5 } }
    },
    {
      "key": "resolution",
      "type": "enum",
      "label": "Print Resolution",
      "required": false,
      "options": [
        { "value": "300", "label": "300 DPI (Draft)" },
        { "value": "600", "label": "600 DPI (Normal)" },
        { "value": "1200", "label": "1200 DPI (High)" },
        { "value": "2400", "label": "2400 DPI (Photo)" },
        { "value": "4800", "label": "4800 DPI (Ultra)" }
      ],
      "group": "quality",
      "pricingImpact": { "mode": "multiplier", "perOption": { "300": 0.5, "600": 1.0, "1200": 1.5, "2400": 2.5, "4800": 4.0 } }
    },
    {
      "key": "duplex",
      "type": "enum",
      "label": "Sides",
      "required": false,
      "options": [
        { "value": "one-sided", "label": "Single-sided" },
        { "value": "two-sided-long-edge", "label": "Double-sided (Long Edge)" },
        { "value": "two-sided-short-edge", "label": "Double-sided (Short Edge)" }
      ],
      "group": "layout",
      "pricingImpact": { "mode": "percent", "perOption": { "two-sided-long-edge": 40, "two-sided-short-edge": 40 } }
    },
    {
      "key": "copies",
      "type": "number",
      "label": "Number of Copies",
      "required": true,
      "min": 1,
      "max": 9999,
      "step": 1,
      "defaultValue": 1,
      "group": "job",
      "pricingImpact": { "mode": "per_unit", "value": 1.0 }
    },
    {
      "key": "borderless",
      "type": "boolean",
      "label": "Borderless Printing",
      "required": false,
      "defaultValue": false,
      "group": "layout",
      "pricingImpact": { "mode": "percent", "value": 15 }
    },
    {
      "key": "staple",
      "type": "boolean",
      "label": "Staple Output",
      "required": false,
      "defaultValue": false,
      "group": "finishing",
      "pricingImpact": { "mode": "flat", "value": 0.50 }
    }
  ],

  "constraints": [
    {
      "key": "2d-print-1",
      "human": "Borderless printing only available on photo paper",
      "severity": "error",
      "when": [
        { "param": "borderless", "operator": "equals", "value": true },
        { "param": "mediaType", "operator": "notIn", "value": ["photographic-high-gloss", "photographic-matte"] }
      ],
      "then": [{ "action": "reject", "message": "Borderless printing requires photo paper" }]
    },
    {
      "key": "2d-print-2",
      "human": "Envelopes cannot be printed double-sided",
      "severity": "error",
      "when": [
        { "param": "mediaType", "operator": "in", "value": ["envelope"] },
        { "param": "duplex", "operator": "notEquals", "value": "one-sided" }
      ],
      "then": [{ "action": "restrictTo", "param": "duplex", "values": ["one-sided"] }]
    },
    {
      "key": "2d-print-3",
      "human": "Ultra-high resolution only available for photo paper",
      "severity": "warning",
      "when": [
        { "param": "resolution", "operator": "in", "value": ["2400", "4800"] },
        { "param": "mediaType", "operator": "notIn", "value": ["photographic-high-gloss", "photographic-matte"] }
      ],
      "then": [{ "action": "warn", "message": "2400+ DPI is optimized for photo paper. Results on plain paper may not show improvement." }]
    },
    {
      "key": "2d-print-4",
      "human": "Stapling requires multiple pages or copies",
      "severity": "error",
      "when": [
        { "param": "staple", "operator": "equals", "value": true },
        { "param": "copies", "operator": "lt", "value": 1 }
      ],
      "then": [{ "action": "warn", "message": "Stapling requires a multi-page document" }]
    }
  ],

  "invariants": [
    {
      "key": "2d-print-inv-1",
      "human": "Custom paper size requires A3-capable printer",
      "severity": "error",
      "expression": "mediaSize != 'custom' or device.capabilities.includes('iso_a3_297x420mm')"
    }
  ],

  "evidence": {
    "tier0": {
      "description": "Job completion receipt",
      "required": ["jobId", "timestamp", "pageCount", "printerModel"]
    },
    "tier1": {
      "description": "Job completion + print queue confirmation",
      "required": ["jobId", "timestamp", "pageCount", "printerModel", "ippJobState", "ippJobId"]
    },
    "tier2": {
      "description": "Job completion + scanned output sample",
      "required": ["jobId", "timestamp", "pageCount", "printerModel", "ippJobState", "ippJobId", "outputScanCid"]
    }
  },

  "pricing": {
    "basePrice": "0.10",
    "currency": "USDC",
    "unit": "per page",
    "minimumCharge": "1.00"
  }
}
```

### 1.2 Key Design Principles

**Self-describing**: The CSD contains everything needed to discover, configure, actuate,
validate, and price the capability. No external code required.

**Machine-generated**: When an agent discovers a printer via IPP, it reads the printer's
`printer-make-and-model`, `media-supported`, `print-color-mode-supported`, `sides-supported`,
`finishings-supported` attributes and generates a CSD automatically. The agent doesn't need
to know what a printer is — it maps IPP attributes to CSD parameters.

**Composable**: A CSD can inherit from a base definition. `pcc://capabilities/canon-pixma-tr8620/v1`
inherits from `pcc://capabilities/2d-print/v1` and narrows: removes A3 (not supported),
adds "CD/DVD printing" as an extension, restricts resolution to 300-4800 DPI.

**Versionable**: CSDs use semver. Breaking changes (removed parameters, narrowed ranges)
require a major version bump. Additive changes (new parameters, wider ranges) are minor.

**Protocol-agnostic**: The `adapter` section defines how to talk to the machine.
IPP for printers, OctoPrint for 3D printers, Modbus for industrial, OPC-UA for CNC,
SiLA for lab instruments, HTTP for generic APIs. The rest of the CSD (parameters,
constraints, pricing) is the same regardless of adapter protocol.

---

## Part 2: The Discovery → Registration Pipeline

### 2.1 Auto-Discovery

When a device connects to the network, the agent discovers it through:

```
1. mDNS/Bonjour scan → find _ipp._tcp, _octoprint._tcp, _sila2._tcp services
2. For each discovered service:
   a. Query the device for its capabilities
   b. Match to a known CSD base type (or generate a new one)
   c. Create a device-specific CSD (profile) that narrows the base
3. If no auto-discovery: human tells agent what they have
   a. "I have a Canon PIXMA TR8620"
   b. Agent looks up or generates CSD from known device database
   c. Or: agent asks what it can do and builds CSD from answers
```

### 2.2 IPP Discovery Example (2D Printer)

IPP (Internet Printing Protocol) is spoken by every modern printer. The agent:

```
1. Send Get-Printer-Attributes to ipp://192.168.1.50/ipp/print
2. Read attributes:
   - printer-make-and-model: "Canon PIXMA TR8620a"
   - media-supported: ["na_letter_8.5x11in", "iso_a4_210x297mm", "na_legal_8.5x14in", ...]
   - print-color-mode-supported: ["color", "monochrome", "auto"]
   - printer-resolution-supported: ["300dpi", "600dpi", "1200dpi", "4800dpi"]
   - sides-supported: ["one-sided", "two-sided-long-edge", "two-sided-short-edge"]
   - finishings-supported: [3, 4]  (3=none, 4=staple)
   - media-type-supported: ["stationery", "photographic-high-gloss", "envelope", ...]
3. Map to CSD:
   - Each IPP attribute → CSD parameter options (intersection with base CSD)
   - Remove options the printer doesn't support
   - Add printer-specific extensions (CD printing, borderless sizes, etc.)
4. Result: device-specific CSD profile of pcc://capabilities/2d-print/v1
```

### 2.3 OctoPrint Discovery Example (3D Printer)

```
1. GET /api/printer → { "state": "Operational", "temperature": {...} }
2. GET /api/printerprofiles → {
     "profiles": {
       "_default": {
         "name": "Prusa MK4",
         "model": "MK4",
         "volume": { "width": 250, "depth": 210, "height": 210 },
         "heatedBed": true,
         "extruder": { "count": 1, "nozzleDiameter": 0.4 }
       }
     }
   }
3. Map to CSD:
   - Build volume → parameter constraints (max part size)
   - Heated bed → enables ABS/PETG/Nylon materials
   - Nozzle diameter → constrains layer height options
   - Extruder count → enables/disables multi-material
4. Result: device-specific CSD profile of pcc://capabilities/fdm/v1
```

### 2.4 Human-Described Discovery (Fallback)

```
Agent: "What kind of machine do you have?"
Human: "It's a printer"
Agent: "What make and model?"
Human: "Canon something, it's the big one in my office"
Agent: "I'll scan your network for Canon printers..."
       [mDNS finds _ipp._tcp on 192.168.1.50]
       "Found Canon PIXMA TR8620a at 192.168.1.50. It supports:
        - Color and B&W printing
        - Letter, A4, Legal, Envelope paper sizes
        - Up to 4800 DPI
        - Double-sided printing
        - Borderless photo printing
        Is this the one?"
Human: "Yes"
Agent: "Registering on PCC network..."
```

---

## Part 3: The Adapter Layer

### 3.1 Adapter Protocol Registry

Each CSD declares which adapter protocol it uses. The adapter registry maps protocols
to implementations:

| Protocol | Transport | Discovery | Adapter Class | Use Case |
|----------|-----------|-----------|---------------|----------|
| `ipp` | HTTP/HTTPS | mDNS `_ipp._tcp` | `IppAdapter` | 2D printers (Canon, HP, Brother, Epson) |
| `octoprint` | HTTP REST | mDNS `_octoprint._tcp` | `OctoPrintAdapter` | 3D printers via OctoPrint |
| `modbus` | TCP/RTU | Manual config | `ModbusSensorAdapter` | Industrial sensors, PLCs |
| `opcua` | TCP (OPC UA) | Discovery endpoint | `OPCUAAdapter` | CNC machines, industrial automation |
| `sila` | HTTP (SiLA 2) | SiLA Discovery | `SiLAAdapter` | Lab instruments (Hamilton, Tecan, Beckman) |
| `usb` | USB/Serial | OS device enumeration | `UsbAdapter` | Direct-connected devices |
| `http` | HTTP REST | Manual URL | `GenericHttpAdapter` | Any device with a REST API |
| `mqtt` | MQTT | Broker subscription | `MqttAdapter` | IoT devices, smart home |

### 3.2 New: IppAdapter

The IPP adapter is the simplest possible adapter — it prints documents.

```typescript
interface IppAdapterConfig {
  uri: string;           // ipp://192.168.1.50/ipp/print
  name?: string;         // "Dad's Canon"
}

class IppAdapter implements MachineAdapter {
  // Discovery
  static async discover(): Promise<IppPrinter[]>
  // Uses mDNS to find _ipp._tcp services on the local network

  // Get printer capabilities (IPP Get-Printer-Attributes)
  async getCapabilities(): Promise<IppCapabilities>

  // Print a document
  async execute(job: JobConfig): Promise<void>
  // Sends a Print-Job request with the document data

  // Get job status
  async getStatus(): Promise<MachineStatus>
  // Queries IPP job-state attribute

  // Get progress
  async getProgress(): Promise<number>
  // Maps IPP job-impressions-completed / job-impressions to 0-100
}
```

### 3.3 Adapter Auto-Generation from CSD

The `adapter` section of a CSD defines the commands the adapter must implement.
For known protocols (IPP, OctoPrint, Modbus, etc.), the adapter factory knows how to
map CSD commands to protocol-specific calls. For custom protocols, the CSD provides
enough information to generate a scaffold.

---

## Part 4: The Registration Protocol

Once a device is discovered and its CSD is generated:

### 4.1 Steps

```
1. GENERATE CSD
   - Auto from device attributes OR human-assisted
   - Result: JSON document with canonical URI

2. VALIDATE CSD
   - Schema validation (all required fields present)
   - Constraint consistency (no contradictions)
   - Pricing sanity (non-negative, reasonable ranges)

3. REGISTER DEVICE
   - POST /api/setup/register-device
   - Creates DB record with CSD reference
   - Assigns device ID

4. CONNECT WALLET
   - Generate or import wallet (UnifiedKeychain)
   - Fund with gas (testnet: faucet; mainnet: deposit)
   - Register ERC-8004 identity on-chain

5. PUBLISH CSD
   - Store CSD on IPFS/Storacha (content-addressed)
   - Register CSD URI in the network's capability index
   - Other agents can now discover this capability

6. GO LIVE
   - Start adapter (begin accepting jobs)
   - Health check (verify device responds)
   - Submit test job (end-to-end verification)
```

### 4.2 The "Dad in Florida" Flow

```
Dad installs PCC agent (npm package or standalone binary)

Agent: "Let me scan your network for devices..."
       [finds Canon PIXMA TR8620a via mDNS]
       "Found your Canon PIXMA TR8620a. It can print:
        - Color and B&W
        - Letter, Legal, A4 paper
        - Up to 4800 DPI
        - Double-sided
        Want to put it on the PCC network?"

Dad: "Sure"

Agent: "I'll set up a wallet for you. This is like a bank account
        for your printer — when someone prints something on it,
        the payment goes here automatically."
       [generates wallet, requests testnet ETH from faucet]
       "Wallet created. You have $100 test dollars."

Agent: "Now let me register your printer..."
       [registers device, publishes CSD, starts adapter]
       "Your printer is LIVE on PCC. Here's what happens next:
        - When someone needs something printed, they'll find your printer
        - You set the price per page (currently $0.10)
        - The payment is held in escrow until printing is confirmed
        - After printing, the money is released to your wallet
        Want me to print a test page to make sure everything works?"

Dad: "Yes"

Agent: [submits test job → IPP Print-Job → evidence collected → settlement]
       "Test page printed successfully. Your printer is ready."
```

---

## Part 5: CSD Registry

### 5.1 Structure

```
pcc://capabilities/                          ← root namespace
├── 2d-print/v1                              ← base: 2D printing
│   ├── inkjet/v1                            ← profile: inkjet-specific
│   │   ├── canon-pixma-tr8620/v1            ← device profile
│   │   └── hp-officejet-pro-9015/v1         ← device profile
│   └── laser/v1                             ← profile: laser-specific
│       ├── hp-laserjet-pro-m404/v1
│       └── brother-hl-l2350dw/v1
├── fdm/v2                                   ← base: FDM 3D printing
│   ├── prusa-mk4/v1                         ← device profile
│   ├── ender-3-v3/v1
│   └── bambulab-x1c/v1
├── cnc-3axis/v1                             ← base: CNC milling
│   ├── haas-vf2/v1
│   └── tormach-pcnc440/v1
├── sla/v1                                   ← base: SLA resin
├── laser-cut/v1                             ← base: laser cutting
├── hplc/v1                                  ← base: HPLC analysis
├── pcr/v1                                   ← base: PCR amplification
└── ...
```

### 5.2 Resolution Order

When a job request comes in for "2D printing":

```
1. Find all device profiles that inherit from pcc://capabilities/2d-print/v1
2. Filter by:
   - Kernel location / network proximity
   - Device health status
   - Queue depth
   - Assurance tier support
   - Parameter compatibility (can this printer do borderless A3?)
3. Price using device-specific CSD pricing + operator overrides
4. Route to best match
```

### 5.3 Storage

CSDs are stored in three places:
1. **IPFS** — canonical, content-addressed, immutable (the source of truth)
2. **SQLite** — local cache for fast queries (the working copy)
3. **On-chain** — hash commitment for integrity (the proof it hasn't been tampered with)

---

## Part 6: Cross-Capability Workflows

A multi-step workflow (e.g., CNC mill a part → anodize it → print a label → ship it)
needs cross-capability constraints.

### 6.1 Workflow CSD (Composite)

```json
{
  "url": "pcc://workflows/cnc-anodize-label-ship/v1",
  "kind": "workflow",
  "steps": [
    {
      "id": "mill",
      "capability": "pcc://capabilities/cnc-3axis/v1",
      "outputBindings": { "partMaterial": "material" }
    },
    {
      "id": "anodize",
      "capability": "pcc://capabilities/anodize/v1",
      "dependsOn": ["mill"],
      "inputBindings": { "material": "mill.partMaterial" },
      "constraints": [
        {
          "key": "anodize-material-compat",
          "human": "Only aluminum parts can be anodized",
          "when": [{ "param": "mill.material", "operator": "notIn", "value": ["aluminum-6061", "aluminum-7075"] }],
          "then": [{ "action": "reject", "message": "Anodizing requires aluminum" }]
        }
      ]
    },
    {
      "id": "label",
      "capability": "pcc://capabilities/2d-print/v1",
      "dependsOn": ["anodize"]
    },
    {
      "id": "ship",
      "capability": "pcc://capabilities/courier-delivery/v1",
      "dependsOn": ["label"]
    }
  ]
}
```

### 6.2 Cross-Step Constraint Propagation

When step 1 selects `material: "aluminum-6061"`, that value propagates forward:
- Step 2 (anodize) passes the material compatibility check
- Step 2's pricing adjusts based on the specific aluminum alloy
- Step 3 (label) is unaffected (no material dependency)
- Step 4 (ship) adjusts package weight based on material density

This is the equivalent of FHIR's cross-resource references — but for physical processes.

---

## Part 7: The Compiler (BabelPCC)

Like BabelFHIR-TS compiles FHIR StructureDefinitions to TypeScript, BabelPCC compiles
CSDs to:

1. **TypeScript interfaces** — compile-time type safety for job parameters
2. **Runtime validators** — constraint checking without code generation
3. **Pricing calculators** — from CSD pricing rules
4. **Adapter scaffolds** — from CSD adapter definitions
5. **Test data generators** — random valid parameter sets for testing

```bash
# Compile a CSD to TypeScript
babelpcc compile pcc://capabilities/2d-print/v1 --output ./generated/

# Output:
# generated/2d-print.ts         — interfaces (Print2DParams, Print2DConfig)
# generated/2d-print.validator.ts — runtime validation
# generated/2d-print.pricing.ts  — price calculator
# generated/2d-print.adapter.ts  — adapter scaffold
# generated/2d-print.test.ts     — test data generators
```

This is a future project. The immediate priority is the CSD format + registry +
auto-discovery pipeline.

---

## Part 8: Implementation Roadmap

### Phase 1: CSD Format + Validation (now)
- Define CSD JSON Schema
- Build CSD validator (Zod schema)
- Convert existing 4 templates to CSD format
- Store in `packages/spec/src/csds/`

### Phase 2: IPP Adapter + 2D Print CSD
- Build `IppAdapter` using `ipp` npm package
- Implement mDNS discovery for `_ipp._tcp`
- Auto-generate device CSDs from IPP attributes
- "Hello World" print test

### Phase 3: CSD Registry
- IPFS storage for published CSDs
- SQLite cache for fast queries
- URI resolution (`pcc://capabilities/...`)
- Discovery API: `GET /api/capabilities/csd/:uri`

### Phase 4: Auto-Discovery Pipeline
- mDNS scanner for all known protocols
- Device → CSD generation engine
- Agent-assisted discovery (human fallback)
- One-command onboarding: `pcc-onboard discover`

### Phase 5: Upgraded Constraint Engine
- Compound conditions (AND/OR)
- Bidirectional invariants
- Cross-capability constraints for workflows
- Expression language (simple, not FHIRPath)

### Phase 6: BabelPCC Compiler
- CSD → TypeScript interfaces
- CSD → runtime validators
- CSD → pricing calculators
- CSD → adapter scaffolds
- npm package: `babelpcc`

---

## Appendix A: IPP Attribute → CSD Parameter Mapping

| IPP Attribute | CSD Parameter | Mapping |
|---|---|---|
| `media-supported` | `mediaSize` | Direct: IPP media keywords → enum options |
| `media-type-supported` | `mediaType` | Direct: IPP media-type keywords → enum options |
| `print-color-mode-supported` | `colorMode` | Direct: color/monochrome/auto |
| `printer-resolution-supported` | `resolution` | Extract DPI values → enum options |
| `sides-supported` | `duplex` | Direct: one-sided/two-sided-long-edge/two-sided-short-edge |
| `finishings-supported` | `staple` | Map finishing codes: 4=staple, 5=punch, etc. |
| `output-bin-supported` | (extension) | Map to output tray selection |
| `print-quality-supported` | (maps to resolution) | 3=draft, 4=normal, 5=high |
| `copies-supported` | `copies.max` | IPP range → number param max |
| `page-ranges-supported` | (extension) | Boolean: can print specific pages |

## Appendix B: Existing Template → CSD Migration

The 4 existing TypeScript templates map directly:

| Current Template | CSD URI | Changes |
|---|---|---|
| `templates/fdm.ts` | `pcc://capabilities/fdm/v2` | Add discovery (OctoPrint), adapter config, evidence tiers |
| `templates/sla.ts` | `pcc://capabilities/sla/v2` | Same |
| `templates/cnc-3axis.ts` | `pcc://capabilities/cnc-3axis/v2` | Add discovery (OPC-UA), adapter config |
| `templates/laser-cut.ts` | `pcc://capabilities/laser-cut/v2` | Add discovery (generic-http), adapter config |
| (new) | `pcc://capabilities/2d-print/v1` | The hello-world capability |

## Appendix C: Why Not Just Use AASX/AAS?

The Asset Administration Shell (AASX) is the closest industry standard. PCC's CSD
differs in three critical ways:

1. **Interactive constraint propagation** — AASX has no constraint engine. CSDs define
   how selecting parameter A restricts parameter B, enabling real-time UI and agent
   decision-making. AASX is static description only.

2. **Economic primitives built in** — CSDs include pricing, evidence requirements,
   and settlement rules. AASX is an engineering data model with no concept of
   per-job pricing or trustless settlement.

3. **Agent-first design** — CSDs are designed to be consumed by LLM agents through
   MCP tools and A2A intents. AASX is designed for OPC UA servers and engineering
   software. PCC bridges both: a CSD can be translated to an AASX Submodel Template
   for Industry 4.0 interop, but the native format is optimized for agents.

We should map CSD ↔ AASX for interop, but CSD is the primary format.
