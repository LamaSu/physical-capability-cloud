# Landscape: Schema/Profile Systems for Physical Manufacturing Capabilities

**Research date**: 2026-03-20
**Goal**: Understand what exists before designing PCC's equivalent of FHIR StructureDefinitions for physical capabilities.
**Question framing**: How do existing standards handle (a) typed parameter definitions, (b) constraint propagation when selections restrict other options, (c) machine-level profiles, (d) versioning, and (e) composability — the same problems FHIR solved for healthcare?

---

## Summary Table

| Standard | Domain | Format | Constraint Propagation | Composable Profiles | Versioning | FHIR Proximity |
|----------|--------|--------|------------------------|---------------------|------------|----------------|
| **STEP-NC / AP238** | CNC machining | EXPRESS/P21 | Implicit in feature library | No formal profiles | ISO revision cycles | Low — task-level, not capability-level |
| **MTConnect** | Shop floor telemetry | XML (read-only) | None | Device components | Versioned spec (2.0 SysML) | Low — observation, not constraint |
| **OPC UA + Companion Specs** | Industrial comms | Binary/XML/JSON | Subtype inheritance, additive only | Submodel templates | Strict backward compat rules | Medium — type hierarchy mirrors FHIR resources |
| **ISA-95 / B2MML** | MES-ERP integration | XML (XSD) | None | Hierarchical object model | V7, breaking changes acknowledged | Medium — data exchange, no constraint engine |
| **QIF** | Dimensional metrology | XML (XSD) | No | Shared component libraries | ISO 23952:2020 | Low — quality data, not process config |
| **ASTM F42** | Additive manufacturing | Various (F3605-23) | No | No | ASTM revision cycles | Very low — materials testing focus |
| **SiLA 2** | Lab instrument automation | Protobuf/gRPC (FDL in XML) | Server-side validation only | Feature composition | Semver on features | High — closest analog to FHIR for instruments |
| **AASX / AAS** | Industry 4.0 digital twin | JSON + XML + RDF | Submodel inheritance | Submodel templates (IDTA) | V3.0, April 2023 | High — explicit FHIR-like intent |
| **MaRCO** | Manufacturing resource capabilities | OWL 2 + SPIN rules | SPARQL inference rules | OWL class composition | Academic (2018) | Medium — reasoning-heavy, no web tooling |
| **IOF / MSDL** | Manufacturing services ontology | OWL 2 | Description Logic inference | Modular ontology stacking | NIST/IOF beta | Medium — matchmaking, not human-configured |
| **W3C WoT Thing Description** | IoT devices | JSON-LD + JSON Schema | JSON Schema constraints on affordances | TD Profiles (WoT Profiles spec) | W3C REC 1.1 (2023) | High — explicit JSON, constraints, profiles |
| **AWS IoT Managed Integrations** | IoT device capabilities | JSON Schema (custom) | JSON Schema (maxLength, enum, oneOf/anyOf) | Type definitions | Cloud API versioning | Medium — JSON-native but cloud-locked |
| **PCC contract-builder (current)** | Physical manufacturing | TypeScript types + JSON-serializable | Template constraints + Profile overrides | MachineProfile over CapabilityTemplate | Manual semver | Very High — PCC-native |

---

## 1. STEP-NC / ISO 10303-AP238

### What it defines
STEP-NC is a replacement for G-code. It defines manufacturing programs as **"working steps"** — named operations (boss, pocket, drill, turn) that carry both the geometric design intent and the process requirements. The AP238 second edition (2020) and third edition (2022) added GD&T tolerances, kinematics, and model-based integration.

The key idea: instead of "G01 X50 Y30 F500", you say "mill-pocket, feature=pocket-1, required-tolerance=±0.05mm, preferred-tool=endmill-10mm." A STEP-NC compiler translates that to machine-specific motion. **The capability matching is the compiler's job** — the standard does not define it.

### Constraint propagation
None in the standard itself. Constraints are embedded in part programs as feature requirements. Whether a specific machine *can* meet those requirements is resolved outside the standard by process planners or CAM software. STEP-NC AP238 is the description of what to make; capability matching is out of scope.

### Format
EXPRESS language (ISO 10303-11) for the schema; files are plain-text P21 (STEP Physical File) format. Not JSON. Not directly consumable by web services without translation. The SysML XMI export in v2.0 helps tooling but is still complex.

### Composability
Working steps form a tree (sequence, parallel, conditional). No profile inheritance or constraint propagation across working steps. Each step is self-contained.

### Versioning
ISO revision cycles (2007, 2020, 2022). Not backward compatible across editions. No delta/differential mechanism.

### FHIR proximity
Low. STEP-NC operates at the part-program level (what to make), not at the capability-advertisement level (what this machine can do). PCC needs the latter. The working-steps concept is interesting for encoding job instructions, but it does not address capability schema design.

**Relevance to PCC**: The "working steps as named operations with requirements" model is analogous to PCC's `CapabilityType + params` model. AP238 is the most sophisticated prior art for encoding machining intent, but PCC needs the inverse: advertising what a machine *can* do, not what a job *needs*.

---

## 2. MTConnect

### What it defines
MTConnect is a **read-only telemetry standard** for CNC machine tools. It defines a semantic vocabulary (DataItems: `execution`, `path_feedrate`, `spindle_speed`, `tool_number`, etc.) and an XML schema for streaming current machine state and history over HTTP GET endpoints.

MTConnect v2.0 (2022) moved from text-based specification to SysML/XMI model. The OPC UA Companion Specification maps MTConnect concepts onto OPC UA nodes, enabling OPC UA clients to consume MTConnect data.

### Constraint propagation
None. MTConnect is a passive observation protocol. It does not constrain what values are allowed; it just describes what values a device reports.

### Format
XML, delivered over HTTP. REST-like but not REST (no POST, no resources). The information model is in SysML XMI for v2.0, but wire format remains XML.

### Composability
Device components are composable (a machine is composed of heads, axes, controllers) but there is no profile system — all machines speak the same vocabulary, differentiated only by which DataItems they report.

### Versioning
Strict versioned spec; the XML namespace carries the version. Tooling relies on specific versions.

### FHIR proximity
Low. MTConnect answers "what is this machine doing right now?" PCC needs "what can this machine do?" They are different questions.

**Relevance to PCC**: MTConnect is useful for the `SensorPipeline` and evidence emission layers (`@pcc/kernel`), not for capability schema design. The semantic DataItem vocabulary could inform PCC's sensor type taxonomy.

---

## 3. OPC UA + Companion Specifications

### What it defines
OPC UA (IEC 62541) is a platform-independent, service-oriented industrial communication standard. It defines:
- An **information model** using object-oriented type hierarchies (ObjectType, VariableType, DataType, ReferenceType)
- A **binary/XML/JSON wire protocol** for reading, writing, subscribing to nodes
- A **Companion Specification** program where industry groups publish domain-specific information models layered on top of OPC UA core

Key companion specs:
- **OPC UA for ISA-95** (OPC 10030): maps B2MML object model into OPC UA nodes
- **OPC UA for PackML** (OPC 30050): standardizes packaging machine state machines
- **OPC UA for MTConnect**: bridges MTConnect data items into OPC UA
- **OPC UA for Machinery** (OPC 40001): generic machinery component model
- **OPC UA for Machine Tools** (OPC 40501): CNC machine tool capabilities

### Constraint propagation
OPC UA uses **subtype inheritance** for type constraints. Rules (from the best-practices spec):
- Subtypes may *add* mandatory nodes (additive)
- Subtypes may *not* add constraints that would retroactively invalidate existing subtypes
- DataType refinement is disallowed on Variable nodes when changing TypeDefinitions
- There is no cross-field constraint mechanism analogous to FHIR's FHIRPath constraints or PCC's `ParamConstraint` system

Companion specs extend base types but cannot *narrow* what the base type allows — they can only specialize further. This is the open-world assumption problem: if a client understands the base type, it must still function with any subtype.

### Format
The information model is described in NodeSet2.xml files (OWL-like but not OWL). Wire protocol is binary (default), XML, or JSON. Tool SDKs exist for most languages. No JSON Schema representation; the schema lives in the NodeSet.

### Composability
High within the OPC UA ecosystem. A server can host multiple companion spec namespaces simultaneously. Nodes from different namespaces can reference each other. This is the closest analog to FHIR's capability composition across ImplementationGuides.

### Versioning
Strict backward compatibility rules. New type versions must not invalidate old subtypes. The OPC Foundation publishes version-numbered NodeSet files. Migration is manual (no delta mechanism).

### FHIR proximity
Medium-High. OPC UA's companion spec system is structurally similar to FHIR Implementation Guides. The type hierarchy, inheritance, and versioning rules are well-thought-out. The major gap: no cross-field constraint propagation (no equivalent of FHIR's FHIRPath invariants), and the format (NodeSet2.xml) is not directly consumed by TypeScript tooling.

**Relevance to PCC**: The OPC UA companion spec model (base type + domain extension + device instance) is the most direct prior art for PCC's `CapabilityTemplate` → `MachineProfile` → `Capability` stack. The backward-compat versioning rules are worth adopting. The gap PCC already fills better: PCC has explicit cross-parameter constraint rules (the `ParamConstraint` mechanism); OPC UA does not.

---

## 4. ISA-95 / B2MML

### What it defines
ISA-95 (ANSI/ISA-95, IEC 62264) is the dominant standard for integrating enterprise (ERP) and manufacturing (MES) systems. It defines a hierarchical object model for:
- Production requests and schedules
- Work definitions (capability requirements)
- Physical assets (equipment, materials, personnel)
- Operations definitions

B2MML (Business-to-Manufacturing Markup Language) is an open-source XML/XSD implementation of ISA-95. It is the de facto interface format between MES systems. The OPC UA/ISA-95 Companion Specification (OPC 10030) maps B2MML onto OPC UA nodes.

ISA-95 Part 4 defines **CapabilityTest** objects — formal assertions about what an asset can produce — but they are expressed as free-form property bags, not typed constraint systems.

### Constraint propagation
None. B2MML XSD schemas define the structure of data messages but have no cross-field constraint logic. Validation is structural (well-formed XML), not semantic (value X means Y must be restricted).

### Format
XML with XSD schemas. B2MML V0700 is the latest. The GitHub repo (MESAInternational/B2MML-BatchML) is the canonical source. Not JSON-native; no JSON Schema equivalent exists.

### Composability
The ISA-95 object model is hierarchical but not compositional in the FHIR sense. There is no profile mechanism — you use the full schema or you don't.

### Versioning
V7 introduced breaking changes from V6. Versioning is coarse (full schema version, not per-type). No delta/differential mechanism.

### FHIR proximity
Medium. ISA-95 shares FHIR's intent (standardize data exchange in a complex domain) but not its mechanisms. The CapabilityTest concept is the closest ISA-95 analog to FHIR CapabilityStatement, but it lacks the type system depth.

**Relevance to PCC**: B2MML's OperationsDefinition and CapabilityTest objects are worth studying for what fields enterprises expect in a manufacturing capability advertisement. However, PCC's typed parameter system and constraint resolver already surpass ISA-95 in expressiveness for per-job configuration.

---

## 5. QIF (Quality Information Framework)

### What it defines
QIF (ISO 23952:2020) is a unified XML framework for quality measurement data exchange — from CAD model-based definitions through inspection plans, measurement results, and statistics. It is the "FHIR of metrology."

QIF's founding principle: all quality data models share common libraries, making the entire quality measurement process inherently interoperable.

QIF consists of 9+ XML schema libraries:
- QIFDocument (top-level envelope)
- PreDefinedCharacteristicStatsEvaluation
- MeasurementResources
- Product (geometric definitions)
- Plan (what to measure and how)
- Results (actual measurements)
- Statistics (Cp, Cpk, SPC data)

### Constraint propagation
None in the sense of interactive UI constraints. QIF defines what measurement data looks like; it does not constrain the process of configuring a measurement plan based on prior selections.

### Format
XML exclusively (no JSON schema equivalent as of 2025). Very large schemas — the full QIF 3.0 package is hundreds of XSD files. Parsers and editors exist but are specialized tools.

### Composability
High within QIF: the shared library approach means measurement data from different stages (plan, execution, results) uses the same primitive types. This is analogous to FHIR's common datatypes. However, there is no profile/extension mechanism.

### Versioning
ISO 23952:2020 is the current version. DMSC maintains updates. The schema is versioned but migration tooling is manual.

### FHIR proximity
Medium. QIF shares FHIR's "common library" approach to composability and is the most FHIR-like of the traditional manufacturing standards in its information model design. The gap: no constraint propagation, no profile inheritance, XML-only.

**Relevance to PCC**: QIF's quality result schemas are relevant to the `@pcc/verifier` evidence layer — what does a "passing inspection result" look like as structured data? The QIF Results and Statistics schemas are more relevant to PCC's evidence bundles than to capability schema design.

---

## 6. ASTM F42 (Additive Manufacturing)

### What it defines
ASTM Committee F42 on Additive Manufacturing Technologies develops standards for:
- Terminology (ISO/ASTM 52900)
- Process categories and material classifications
- Test methods for mechanical properties
- Data standards: F3605-23 (in-process monitoring data structure for PBF), ISO/ASTM 52953-25 (dataset registration/metadata)

F42 Subcommittee F42.08 focuses specifically on data standards.

### Constraint propagation
None. ASTM F42 data standards define file structures for in-process monitoring data and dataset metadata — not interactive configuration or cross-parameter constraints.

### Format
The in-process monitoring standard (F3605-23) defines a file structure for time-series sensor data. The focus is on archival/traceability format, not on capability advertisement or job configuration.

### Composability
No profile or composition system. Standards are standalone documents.

### Versioning
ASTM revision cycles (typically 5-year reviews). No delta mechanism.

### FHIR proximity
Very low. F42 is concerned with test methods, material classifications, and data archival — not with describing what a machine can do or constraining job configurations.

**Relevance to PCC**: F42's material classification vocabulary (powder, filament, resin, binder-jetting feedstocks) is useful for standardizing PCC's `materials` field values in `Capability`. The in-process monitoring data structure may inform how PCC structures evidence bundles for additive manufacturing jobs.

---

## 7. SiLA 2 (Lab Instrument Standardization)

### What it defines
SiLA 2 is the dominant connectivity standard for laboratory automation instruments (pipettors, centrifuges, incubators, liquid handlers, chromatography systems, etc.). It is the closest existing analog to "FHIR for physical instruments."

Core concepts:
- **Feature**: a unit of instrument capability (e.g., `PumpFluidDosingService`, `TemperatureController`)
- **Feature Definition Language (FDL)**: an XML schema that formally describes a Feature's Commands, Parameters, Properties, and Errors
- **SiLA Server**: an instrument exposing one or more Features
- **SiLA Client**: any controller that drives instruments via Features

Wire protocol: gRPC (HTTP/2 + Protocol Buffers). The FDL is compiled to `.proto` files by codegen tools, which then generate typed stubs in Python, C#, Java, etc.

### Constraint propagation
Constraints are defined in the FDL and validated **server-side** at call time. There is no client-side constraint-propagation mechanism (no equivalent of PCC's `TemplateResolver` or FHIR's FHIRPath invariants). If you call `SetTemperature(200)` on an instrument that supports only 4–37°C, the server returns an error; the client has no schema-derived knowledge that it would fail.

This is a key gap: SiLA 2 has no interactive constraint propagation — the client cannot pre-compute that selecting material X restricts post-processing to options Y and Z.

### Format
FDL is XML. Code generation produces Protobuf schemas and language-specific stubs. No JSON Schema equivalent. The FDL+Protobuf stack is strongly typed but requires codegen tooling — not directly consumable as data.

### Composability
High. A single SiLA Server can implement multiple Features. Features can be mixed and matched. The standard defines a **SiLA Discovery** protocol so clients can enumerate available Features at runtime. This is the closest existing analog to PCC's capability advertisement.

### Versioning
Semantic versioning (major.minor) on individual Features. A client specifies the minimum Feature version it requires. Breaking changes require a major version bump. This is more granular than most manufacturing standards.

### FHIR proximity
High. SiLA 2 is architecturally the closest standard to FHIR in the physical instrument domain:
- Features = FHIR Resources (named, typed units of functionality)
- FDL = FHIR StructureDefinition (formal schema for a Feature)
- SiLA Server = FHIR Server
- Feature Discovery = FHIR CapabilityStatement
- Versioning = FHIR version semantics (though coarser)

The gap: no constraint propagation across parameters, no profile specialization (there is no "SiLA Profile" mechanism — either you implement a Feature fully or you don't), and the wire format (gRPC/Protobuf) makes it harder to integrate with web tooling.

**Relevance to PCC**: SiLA 2's Feature concept is directly applicable to PCC's biotech/lab capability types (`hplc`, `mass-spec`, `pcr`, `cell-culture`, etc. in `CapabilityType`). PCC could define FDL-inspired Feature Definitions for lab capabilities, where each Feature maps to a `CapabilityTemplate`. The SiLA 2 versioning model (semver per Feature) is worth adopting for PCC templates.

---

## 8. AASX / Asset Administration Shell (AAS)

### What it defines
The Asset Administration Shell (AAS), published by the Industrial Digital Twin Association (IDTA) and standardized in IEC 63278, is Germany's Industry 4.0 digital twin standard. It is the most explicitly "FHIR-like" of all manufacturing standards.

Core concepts:
- **Asset**: any physical or logical entity (machine, product, component, material)
- **AAS**: the digital twin shell wrapping an asset — structured metadata, history, capabilities
- **Submodel**: a module within an AAS encoding one aspect of the asset (e.g., TechnicalData, Documentation, DigitalNameplate, ProductionCapabilities)
- **Submodel Template**: a standardized schema for a Submodel, published by IDTA — the direct equivalent of FHIR StructureDefinitions

AAS v3.0 (April 2023) supports JSON, XML, and RDF serialization. A REST API spec (IDTA-01002) defines standard CRUD operations on AAS shells and Submodels.

The IDTA publishes Submodel Templates for specific domains (Nameplate, TechnicalData, ProductionCapabilities, ConditionMonitoring, etc.). These are analogous to FHIR Implementation Guides.

### Constraint propagation
Submodel Templates define the structure and cardinality of Submodel elements (SubmodelElementCollection, Property, Operation, Blob, etc.) but **do not define cross-field constraints**. There is no AAS equivalent of "if Property A has value X, then Property B must be restricted to values {Y, Z}." Constraints in AAS are structural (cardinality, data type), not semantic (value-dependent restrictions).

### Format
JSON (primary for API), XML (AASX package format — a ZIP of AAS + documents), RDF (for semantic web). JSON Schema is available for the AAS metamodel. The IDTA GitHub (admin-shell-io/aas-specs-metamodel) provides normative JSON and XML schemas.

### Composability
High. A single AAS can aggregate multiple Submodels. Submodel Templates can reference other templates. The IDTA publishes a growing library of standardized Submodel Templates. This is the most composable of all manufacturing standards.

### Versioning
AAS Submodel Templates carry explicit version numbers. AAS metamodel versioning follows the IDTA publication process (v3.0.6 is current). The metamodel has a stable core; Submodel Templates evolve independently.

### FHIR proximity
High — explicitly designed with FHIR-like intent:
- AAS Submodel = FHIR Resource
- Submodel Template = FHIR StructureDefinition
- IDTA Template Library = FHIR Implementation Guide registry
- AAS REST API = FHIR RESTful API (same CRUD operations)
- AssetId = FHIR logical identifier

The gap: no cross-field constraint propagation (no FHIRPath equivalent), JSON Schema for structure only, no interactive constraint resolution.

**Relevance to PCC**: AAS is the strongest prior art for PCC's overall architecture. PCC's `CapabilityTemplate` corresponds to an IDTA Submodel Template for Production Capabilities. PCC's `MachineProfile` corresponds to an AAS instance with that Submodel. The gap PCC fills is the constraint propagation engine (`TemplateResolver`) — AAS has no equivalent.

---

## 9. MaRCO (Manufacturing Resource Capability Ontology)

### What it defines
MaRCO is an OWL 2 ontology for describing manufacturing resource capabilities. Published in *Journal of Intelligent Manufacturing* (2018/2019) by Semere et al. Its main contribution: automatic inference of **combined capabilities** from simpler constituent capabilities.

Example: Robot has capability "Moving" + Gripper has capability "Grasping" → the combined resource has inferred capability "Transporting." This inference is computed by SPARQL Inferencing Notation (SPIN) rules layered on top of OWL.

MaRCO defines:
- `SimpleCapability`: a single resource's ability (type, parameter ranges)
- `CombinedCapability`: inferred from a combination of resources
- `CapabilityParameter`: numeric/categorical parameters with min/max/enumerated values
- `ProcessRequirement`: what a job needs (matched against capabilities by the reasoner)

### Constraint propagation
MaRCO's SPIN rules compute **capability inference** (combining simpler capabilities into complex ones) rather than **interactive constraint propagation** (selecting parameter A restricts choices for parameter B). It answers "can this set of machines do this job?" not "given that the user picked aluminum, what surface finishes are valid?"

### Format
OWL 2 ontology (Turtle/RDF format). Requires an OWL reasoner (e.g., HermiT, Pellet) + SPARQL engine for SPIN rules. Not directly usable from TypeScript without a SPARQL bridge.

### Composability
High in the OWL sense (classes, subclasses, restrictions compose). Fragile in practice (OWL DL reasoning is computationally expensive and brittle for web-scale systems).

### Versioning
Academic publication — no formal versioning scheme.

### FHIR proximity
Medium. MaRCO addresses a similar problem space (what can this machine do?) but uses OWL reasoning rather than profile inheritance + constraint rules. The conceptual model is valuable; the implementation approach is not directly adoptable.

**Relevance to PCC**: MaRCO's `SimpleCapability + CombinedCapability` model is directly relevant to PCC's multi-machine workflows (the `@pcc/orchestrator` TransferGraph and `@pcc/scheduler` CapabilityRouter). When a job requires CNC + heat treatment + inspection, PCC needs to reason about combined capability availability — MaRCO's inference model is the right conceptual frame for this.

---

## 10. IOF / MSDL (Industrial Ontologies Foundry / Manufacturing Service Description Language)

### What it defines
The **Industrial Ontologies Foundry (IOF)** is an open consortium (NIST, academic, industry) building a suite of OWL 2 ontologies for manufacturing, supply chain, and maintenance. The IOF Core sits on the Basic Formal Ontology (BFO) upper ontology and provides terms common across all manufacturing domains (57 OWL classes, 38 OWL properties in the beta).

**MSDL** (Manufacturing Service Description Language) is an OWL-based ontology for describing machining services — originally focused on mechanical machining, extended to metal casting. It was designed for agent-based matchmaking between buyers and sellers of manufacturing services.

### Constraint propagation
OWL Description Logic inference provides some constraint propagation (class membership implies range restrictions on properties). But this is static reasoning, not interactive UI constraint propagation. No dynamic "selecting value X restricts field Y" mechanism.

### Format
OWL 2 (Turtle, Manchester Syntax). Not JSON. Requires a Description Logic reasoner. IOF ontologies are available on GitHub (iofoundry/ontology).

### Composability
High in theory (OWL imports and class hierarchies). In practice, OWL reasoner integration is complex for web applications.

### Versioning
IOF is in beta. No formal versioning mechanism yet.

### FHIR proximity
Medium. IOF/MSDL addresses the same domain (describing what manufacturing services can do and matching them to requirements) but through OWL reasoning rather than profile-based configuration. The vocabulary is valuable; the implementation approach is heavyweight.

**Relevance to PCC**: IOF's vocabulary for manufacturing processes, equipment types, materials, and operations is worth consulting as a reference taxonomy for PCC's `CapabilityType` enum and `materials` field standardization. The MSDL matchmaking model is conceptually aligned with PCC's `CapabilityRouter`.

---

## 11. W3C WoT Thing Description (TD)

### What it defines
W3C WoT Thing Description 1.1 (2023) is the closest existing standard to "FHIR for IoT devices." A Thing Description is a JSON-LD document that formally describes a device's:
- **Properties** (readable/writable state)
- **Actions** (invocable operations)
- **Events** (emitted notifications)
- **Data schemas** (embedded JSON Schema for every interaction's input/output)
- **Protocol bindings** (how to interact: HTTP, MQTT, CoAP, WebSocket)
- **Security definitions** (API key, OAuth, etc.)

W3C WoT Profiles (separate spec) define constrained subsets of the TD for specific use cases — the direct equivalent of FHIR profiles.

### Constraint propagation
JSON Schema constraints on individual property/action inputs/outputs (type, minimum, maximum, enum, pattern, etc.). No cross-affordance constraint propagation — there is no way to express "if property X has value A, then action Y's parameter is restricted to range [0, 10]."

### Format
JSON-LD (primary), with a full JSON Schema for the TD model. TypeScript types are community-maintained. Excellent web tooling compatibility.

### Composability
A Thing can implement multiple "semantic types" (via @type in JSON-LD). WoT Profiles layer semantic constraints on base TDs. JSON-LD context extension allows domain-specific vocabularies.

### Versioning
W3C REC versioning (1.0, 1.1, 2.0 in progress). Thing Descriptions carry a `@context` URL that encodes the version. The 2.0 spec is under development as of 2025.

### FHIR proximity
High. WoT TD was explicitly designed with FHIR inspiration:
- Thing Description = FHIR resource instance
- WoT Profile = FHIR StructureDefinition
- WoT Thing Directory = FHIR Server
- Affordances (Properties/Actions/Events) = FHIR operations + search params
- JSON-LD + JSON Schema = FHIR JSON + FHIRPath

Gap: no cross-affordance constraint propagation.

**Relevance to PCC**: WoT TDs are the right format for PCC's capability advertisements exposed via the gateway API. A `Capability` record in PCC could be augmented with a WoT-compatible TD, enabling standard WoT clients to discover and interact with PCC kernels. The WoT JSON-LD context extension mechanism is valuable for adding PCC-specific vocabulary to standard TDs.

---

## 12. PCC Contract-Builder (Current State)

### What it defines
PCC already has a three-layer schema system in `packages/contract-builder` and `packages/spec`:

**Layer 0 — ParamDef types** (`spec/types/contract-builder.ts`):
- `EnumParamDef`, `NumberParamDef`, `BooleanParamDef`, `StringParamDef` (discriminated union)
- `PricingImpact`: flat | percent | per_unit | multiplier
- `ParamConstraint`: `when: ConstraintCondition` → `then: ConstraintAction[]`
- `ConstraintCondition`: `param + (equals | in | gt | lt)`
- `ConstraintAction`: `param + (restrictTo | exclude | setMin | setMax)`

**Layer 1 — CapabilityTemplate** (one per capability type, e.g., `cnc-3axis.ts`, `fdm.ts`):
- Canonical parameter definitions for a capability type
- Cross-parameter constraints (e.g., anodizing only valid for aluminum)

**Layer 2 — MachineProfile** (one per physical machine, e.g., `haas-vf2.ts`, `prusa-mk4.ts`):
- `paramOverrides`: restrict/exclude enum options, override numeric min/max/default
- `additionalParams`: machine-specific params not in the base template
- `pricingOverrides`: machine-specific base price

**Layer 3 — TemplateResolver** (runtime constraint engine):
- Step 1: clone template params
- Step 2: apply profile overrides
- Step 3: apply constraint rules against current selections
- Step 4: resolve visibility (`visibleWhen`)
- Step 5: group params for UI rendering
- Step 6: resolve pricing

**Layer 4 — ResolvedBuildOptions** (view model output):
- Fully resolved, grouped, priced parameter list ready for the UI

**Layer 5 — BuilderContract** (validated output):
- User selections + total price + price breakdown + CWM step

### What is already well-designed
1. **Discriminated union ParamDef**: type-safe, JSON-serializable, aligns with JSON Schema patterns
2. **Constraint rules as data**: `ParamConstraint[]` is declarative — constraints are data, not code
3. **Three-layer separation**: Template (canonical) → Profile (machine-specific) → Resolution (runtime)
4. **Pricing-in-schema**: `PricingImpact` embedded per-option is novel vs. all surveyed standards
5. **visibleWhen**: conditional visibility is not present in any surveyed standard

### What is missing vs. full FHIR parity
1. **No versioning mechanism**: `CapabilityTemplate.version = "1.0"` is a string with no enforcement
2. **No differential/snapshot mechanism**: there is no way to express "this profile extends template X with only these differences" — profiles replace or append, never express a minimal diff
3. **No compound conditions**: `ConstraintCondition` is single-param; there is no `AND(material=aluminum, thickness>5mm) → exclude(anodize)` — multi-condition constraints require multiple `ParamConstraint` entries
4. **No constraint chaining**: applying constraint A may make a previously valid value invalid for constraint B, but the resolver does not re-evaluate constraints iteratively
5. **No machine-readable capability advertisement**: `Capability` (in `spec/types/capability.ts`) and `CapabilityTemplate` are not linked — a discoverable capability does not carry its template reference
6. **No inherited constraints**: profile overrides can restrict options but cannot add new constraint rules (only the template's `constraints[]` are evaluated)
7. **No formal schema registry**: templates and profiles are TypeScript files, not JSON documents in a registry with URIs and versioned references
8. **No cross-capability constraints**: when a workflow combines CNC + anodizing + inspection, there are no inter-capability constraints (e.g., "if CNC material=stainless-316, then inspection must use coordinate metrology, not visual")

---

## Key Gaps Across All Standards

Looking across all surveyed standards, the following capabilities are **absent in every standard** and are only partially present in PCC:

| Gap | Standards that address it | PCC current state |
|-----|--------------------------|-------------------|
| Typed parameter definitions with enum/number/boolean | OPC UA (types), WoT (JSON Schema), SiLA 2 (FDL) | Done — ParamDef union |
| Cross-field constraint propagation (interactive) | **None** | Done — ParamConstraint + TemplateResolver |
| Machine-level profile overrides | OPC UA (subtypes), AAS (submodels) | Done — MachineProfile |
| Embedded pricing impact per option | **None** | Done — PricingImpact |
| Conditional visibility | **None** | Done — visibleWhen |
| Versioned templates with delta/differential | FHIR (differential/snapshot), OPC UA (subtype versioning) | Missing |
| Formal schema registry with URIs | FHIR (R4/R5 canonical URLs), AAS (IDTA template registry) | Missing |
| Compound multi-param conditions | FHIR (FHIRPath expressions) | Missing |
| Iterative constraint evaluation | FHIR (validation pipeline) | Missing |
| Cross-capability constraints (workflow-level) | MaRCO (SPARQL inference) | Missing |
| Machine-readable capability advertisement linking to schema | WoT (TD with affordances), AAS (Submodel reference) | Partially — Capability.type links to template by string |

---

## Recommendations for PCC StructureDefinition Design

### 1. Adopt AAS Submodel Template as the conceptual model for CapabilityTemplate
The AASX/AAS model is the strongest prior art. PCC's `CapabilityTemplate` is a Submodel Template. Future work should:
- Add canonical URIs to templates (e.g., `pcc://templates/cnc-3axis@1.0`)
- Publish templates as JSON documents (not just TypeScript files) with a URI-based registry
- Add an IDTA-compatible serialization for interoperability

### 2. Adopt SiLA 2's Feature versioning model
Each `CapabilityTemplate` should carry `{ version: semver, minCompatibleVersion: semver }`. Profiles should specify the minimum template version they were written for. Breaking changes bump the major version.

### 3. Adopt OPC UA's subtype inheritance rules for profiles
A `MachineProfile` should only be able to *tighten* constraints from the base template, never loosen them. This is the OPC UA subtype rule: subtypes may add but not remove restrictions. Currently PCC profiles can override defaults in ways that are not type-checked against the template's constraints.

### 4. Add FHIR-style differential/snapshot to CapabilityTemplate
When a profile overrides 2 of 9 params, it should be possible to express "this profile inherits template X and changes only these fields" (differential). The resolver should compute the full merged view (snapshot). This enables template evolution without breaking profiles.

### 5. Extend ParamConstraint to compound conditions
```typescript
interface CompoundConstraintCondition {
  and?: ConstraintCondition[];  // all must match
  or?: ConstraintCondition[];   // any must match
  not?: ConstraintCondition;    // negation
}
```
This unlocks constraints like "if material=stainless AND thickness>10mm, then restrict finishing to {electropolish, passivation}."

### 6. Add iterative constraint resolution to TemplateResolver
Currently constraints are applied in a single pass. Constraint A may invalidate the current value of a parameter, which should trigger re-evaluation of constraints that depend on that parameter. The resolver should iterate until stable (max 10 iterations to prevent cycles).

### 7. Consider W3C WoT Thing Description for the capability advertisement layer
PCC's `Capability` record (in `spec/types/capability.ts`) should optionally carry a WoT-compatible Thing Description, enabling standard WoT discovery. The TD's Actions would map to PCC job submission; TD's Properties would map to live sensor readings from MTConnect/OPC UA adapters.

### 8. Use IOF/MSDL vocabulary for material and process type standardization
Rather than ad-hoc string values for `materials` (e.g., `"aluminum-6061"`, `"stainless-316"`), PCC should adopt or cross-reference standardized material identifiers from IOF or ASTM F42 taxonomies. This enables semantic matchmaking between buyer job requirements and seller capability advertisements.

---

## Architecture Comparison: FHIR vs PCC (Current) vs PCC (Target)

```
FHIR                          PCC Current                    PCC Target
────────────────────────────  ─────────────────────────────  ─────────────────────────────
StructureDefinition           CapabilityTemplate             CapabilitySchema (URI-registered)
  (canonical resource def)      (TypeScript object)            (JSON doc + TS types)

Implementation Guide          (none)                         CapabilityProfile
  (named collection of SDs)                                   (named template bundle)

Profile (constrained SD)      MachineProfile                 MachineProfile (differential)
  (tighter constraints)         (paramOverrides[])             (diff + inherited constraints)

FHIRPath invariant            ParamConstraint                ParamConstraint (compound)
  (cross-field rule)            (single-condition)             (and/or/not conditions)

Snapshot                      ResolvedBuildOptions           ResolvedBuildOptions (iterated)
  (fully computed view)         (single-pass resolution)       (convergent multi-pass)

CapabilityStatement           (Capability.type string)       CapabilityAdvertisement
  (what this server does)       (weak link)                    (TD-compatible, URI-referenced)

Value Set                     EnumOption[]                   CapabilityValueSet
  (bound terminology)           (inline in template)           (shared, URI-referenced sets)

Version (R4, R5)              version: "1.0" (string)        semver + minCompatibleVersion
```

---

## Sources

- [STEP-NC Wikipedia](https://en.wikipedia.org/wiki/STEP-NC)
- [STEP-NC AP238 Standard (steptools.com)](https://www.steptools.com/stds/stepnc/)
- [STEP-NC in additive manufacturing review (Springer, 2025)](https://link.springer.com/article/10.1007/s00170-025-15290-8)
- [MTConnect Wikipedia](https://en.wikipedia.org/wiki/MTConnect)
- [MTConnect Getting Started](https://www.mtconnect.org/getting-started)
- [MTConnect v2.0 Standard Download](https://www.mtconnect.org/standard-download20181)
- [OPC UA Companion Specifications (opcconnect.com)](https://www.opcconnect.com/opc-ua-companion-specifications.php)
- [ISA-95 Common Object Model (OPC Foundation)](https://opcfoundation.org/markets-collaboration/isa-95/)
- [B2MML GitHub (MESAInternational)](https://github.com/MESAInternational/B2MML-BatchML)
- [QIF Standards (qifstandards.org)](https://qifstandards.org/)
- [ISO 23952:2020 QIF Standard](https://www.iso.org/standard/77461.html)
- [QIF Definitive Guide 2024 (capvidia.com)](https://www.capvidia.com/blog/qif-quality-information-framework-definitive-guide)
- [ASTM F42 Committee Overview](https://www.astm.org/membership-participation/technical-committees/committee-f42)
- [ASTM F42.08 Data Subcommittee](https://www.astm.org/membership-participation/technical-committees/committee-f42/subcommittee-f42/jurisdiction-f4208)
- [SiLA 2 Standard (sila-standard.com)](https://sila-standard.com/)
- [SiLA 2: Next Generation Lab Automation Standard (PubMed, 2022)](https://pubmed.ncbi.nlm.nih.gov/35639108/)
- [Tecan SiLA2 SDK paper (SLAS Technology)](https://www.slas-technology.org/article/S2472-6303(23)00044-4/fulltext)
- [AASX Asset Administration Shell (aimen-shell-toolkit.com)](https://www.aimen-shell-toolkit.com/blog/post/what-is-asset-administration-shell)
- [AAS Specs Metamodel GitHub (admin-shell-io)](https://github.com/admin-shell-io/aas-specs-metamodel)
- [Details of the AAS Part 1 (IDTA, 2022)](https://industrialdigitaltwin.org/wp-content/uploads/2022/06/DetailsOfTheAssetAdministrationShell_Part1_V3.0RC02_Final1.pdf)
- [MaRCO Ontology Paper (Journal of Intelligent Manufacturing, 2018)](https://link.springer.com/article/10.1007/s10845-018-1427-6)
- [IOF Core Ontology (NIST)](https://www.nist.gov/publications/industrial-ontologies-foundry-iof-core-ontology)
- [IOF GitHub (iofoundry)](https://github.com/iofoundry/ontology)
- [MSDL Ontology (ASU Semantics Lab)](https://labs.engineering.asu.edu/semantics/ontology-download/msdl-ontology/)
- [W3C WoT Thing Description 1.1](https://www.w3.org/TR/wot-thing-description11/)
- [W3C WoT and JSON Schema case study](https://json-schema.org/blog/posts/w3c-wot-case-study)
- [W3C WoT Profiles Spec](https://w3c.github.io/wot-profile/)
- [AWS IoT Managed Integrations capability schema](https://docs.aws.amazon.com/iot-mi/latest/devguide/schema-for-capability-definitions.html)
- [ISA-95 explained (rhize.com)](https://rhize.com/blog/what-is-isa95/)
- [Manufacturing Resource Capability Ontology process level (ResearchGate)](https://www.researchgate.net/publication/339495714_Ontology_Model_for_Process_Level_Capabilities_of_Manufacturing_Resources)
- [FHIR Profiling (HL7, v5.0.0)](https://hl7.org/fhir/profiling.html)
- [OPC UA Backward Compatibility Rules](https://reference.opcfoundation.org/Model-Best/v102/docs/3)
- [ISO/DIS 23726-3 Industrial Data Ontology](https://www.iso.org/standard/87560.html)
