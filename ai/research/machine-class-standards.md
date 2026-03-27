# Machine Class Standards & Device Catalogs — Research Report

**Date**: 2026-03-26
**Purpose**: Identify structured data sources that can auto-generate CapabilityTemplates for PCC's contract-builder registry.
**Current state**: 5 templates built manually (fdm, sla, cnc-3axis, laser-cut, liquid-handler). 36 BuiltinCapabilityTypes declared in `@pcc/spec`. Gap: 31 types have no template.

---

## Executive Summary

**Answer to key question**: Yes, we can auto-generate CapabilityTemplates for 50+ device types by importing existing structured data. The combination of Opentrons shared-data (lab equipment JSON), Cura/PrusaSlicer (3D printing JSON/INI), MTConnect (manufacturing XML), and Allotropy/ASM (analytical instruments JSON) provides production-ready structured parameter schemas covering approximately 80% of PCC's declared capability types. The remaining 20% (specialized biotech like electrophysiology, compound-synthesis) will need manual template authoring, but can be seeded from SiLA 2 feature definitions and FHIR DeviceDefinition patterns.

**Recommended strategy**: Build an `auto-template-generator` that reads these external schemas and emits `CapabilityTemplate` objects. Priority order:

1. **Cura fdmprinter.def.json** — immediate, JSON, 800+ FDM params, already covers our richest template
2. **Opentrons shared-data** — immediate, JSON, pipettes/modules/labware/deck, covers liquid-handler + PCR + centrifuge + plate-reader
3. **Allotropy/Benchling parsers** — immediate, JSON schemas, 60 instrument parsers across 13 technique categories
4. **MTConnect Devices XML** — high value, XML/XSD, covers CNC/lathe/waterjet + all manufacturing monitoring
5. **OPC-UA Companion Specs** — medium value, covers injection molding + additive manufacturing
6. **SiLA 2 features** — medium value, protobuf, covers generic lab instrument commands
7. **FHIR DeviceDefinition** — structural pattern only, not device-specific data

---

## 1. Lab Equipment Standards

### 1.1 Opentrons shared-data (HIGHEST VALUE for lab equipment)

- **URL**: https://github.com/Opentrons/opentrons/tree/edge/shared-data
- **Covers**: Liquid handlers (OT-2, Flex), pipettes, labware (well plates, tip racks, reservoirs, tubes), hardware modules (thermocycler, temperature module, magnetic module, heater-shaker, absorbance plate reader), deck layouts, grippers
- **Format**: JSON with formal JSON Schema (v2 for labware)
- **Open/Free**: Yes, Apache 2.0
- **Quality**: 5/5 — Production-grade structured data with formal schemas, used by thousands of labs

**Directory structure** (16 subdirectories of shared-data):
| Directory | Content | PCC Mapping |
|-----------|---------|-------------|
| `labware/` | 300+ labware definitions (plates, racks, tubes) | Plate format params for liquid-handler, PCR, assay templates |
| `pipette/` | Pipette specs (P20/P300/P1000, single/multi, Flex 96-ch) | Pipette type enum options |
| `module/` | Thermocycler, temp module, magnetic module, heater-shaker, absorbance reader | Separate CapabilityTemplates for pcr, centrifuge, spectroscopy |
| `deck/` | Deck slot definitions, OT-2 vs Flex layouts | Work envelope constraints |
| `gripper/` | Gripper specs (Flex only) | Gripper force params |
| `liquid-class/` | Liquid handling parameters by liquid type | Reagent type options (viscous, volatile, etc.) |
| `robot/` | Robot hardware specs | Machine profile base data |
| `command/` | Protocol command definitions | Available operations/steps |
| `protocol/` | Protocol schema v4 | Workflow template structure |

**Labware schema v2 key fields** (directly mappable to ParamDef):
- `dimensions`: xDimension, yDimension, zDimension -> WorkEnvelope
- `parameters`: format, isTiprack, loadName, tipLength, tipOverlap
- `wells`: per-well depth, totalLiquidVolume, shape, diameter/xDimension/yDimension
- `groups`: well groupings with metadata
- `brand`: manufacturer name, brandId, links
- `allowedRoles`: labware, adapter, fixture, maintenance, lid
- `gripForce`, `gripHeightFromLabwareBottom`, `stackLimit`

**Module definitions** (heaterShakerModuleV1.json, etc.):
- Temperature ranges, RPM ranges, slot compatibility
- Direct mapping to NumberParamDef with min/max/step/unit

**How to map**: Each module definition -> one CapabilityTemplate. Labware definitions -> EnumParamDef options for plate/labware selection parameters. Pipette definitions -> EnumParamDef options for pipette selection.

### 1.2 SiLA 2 Standard

- **URL**: https://sila-standard.com/standards/ | GitLab: https://gitlab.com/SiLA2/sila_base
- **Covers**: Generic lab instrument interfaces — any device that implements SiLA 2 (liquid handlers, plate readers, centrifuges, incubators, etc.)
- **Format**: Protocol Buffers (gRPC) + XML feature definitions
- **Open/Free**: Yes, MIT license
- **Quality**: 3/5 — Well-designed standard but abstract; feature definitions describe interface patterns, not device-specific parameter ranges

**Core features defined**:
- `SiLAService` — mandatory discovery (name, type, vendor, features)
- `LockController` — device locking for exclusive access
- `CancelController` — cancel running operations
- `ParameterConstraintsProvider` — runtime constraint discovery
- Instrument-specific features under `org/silastandard/instruments/`

**Feature definition structure**:
```
Feature
  ├── Commands (with Parameters + Responses)
  ├── Properties (readable/observable values)
  └── Data types (compound structures)
```

**How to map**: SiLA features map to the *operations* a device can perform, not the *parameters* for ordering a job. Useful as a **secondary source** to discover what commands a device class supports, which informs which ParamDefs are needed. Not directly importable as CapabilityTemplate params.

### 1.3 SLAS/ANSI Microplate Standards

- **URL**: https://www.slas.org/education/ansi-slas-microplate-standards/
- **Covers**: Microplate physical dimensions only (ANSI/SLAS 1-4: footprint, height, flange, well positions)
- **Format**: PDF specifications with exact dimensions
- **Open/Free**: Standards are free to read on SLAS website
- **Quality**: 4/5 for what it covers — but very narrow scope

**Standards**:
- ANSI/SLAS 1-2004: Footprint (127.76mm x 85.48mm)
- ANSI/SLAS 2-2004: Height dimensions
- ANSI/SLAS 3-2004: Bottom outside flange
- ANSI/SLAS 4-2004: Well positions

**How to map**: These define the physical constraints for plate-based parameters (96-well, 384-well, etc.). Already captured in our liquid-handler template's plateFormat enum. Low incremental value — Opentrons labware definitions include all this data in structured JSON form.

### 1.4 PyLabRobot

- **URL**: https://github.com/PyLabRobot/pylabrobot
- **Covers**: Hardware-agnostic SDK for liquid handlers (Hamilton STAR/Vantage, Tecan EVO, Opentrons OT-2), plate readers (CLARIOstar, Cytation5), centrifuges (VSpin), pumps (Masterflex), scales (Mettler Toledo), heater-shakers (Inheco), fans, thermocyclers
- **Format**: Python classes with device resource definitions + translated labware from Hamilton/Tecan/Opentrons
- **Open/Free**: Yes, MIT license
- **Quality**: 4/5 — Excellent multi-vendor coverage, but definitions are in Python code rather than standalone data files

**Supported backends**:
| Category | Devices | PCC Template |
|----------|---------|--------------|
| Liquid handlers | Hamilton STAR, Tecan EVO, Opentrons OT-2 | liquid-handler |
| Plate readers | CLARIOstar, Cytation5 | spectroscopy / assay |
| Centrifuges | VSpin | centrifuge |
| Pumps | Masterflex (Cole-Parmer) | sample-prep |
| Scales | Mettler Toledo WXS205SDU | inspection |
| Heater-shakers | Inheco ThermoShake | sample-prep / pcr |
| Thermocyclers | Various | pcr |

**How to map**: Extract device capability parameters from Python backend classes. Each backend defines supported operations, volume ranges, speed limits, etc. Cross-reference with Opentrons shared-data for full parameter ranges.

---

## 2. Manufacturing Equipment Standards

### 2.1 MTConnect Standard (HIGHEST VALUE for manufacturing)

- **URL**: https://www.mtconnect.org | Schema: https://github.com/mtconnect/schema | Examples: https://github.com/usnistgov/smstestbed
- **Covers**: CNC machines (mills, lathes, multitask), 3D printers, robot arms, coordinate measurement machines, controls, sensors, smart tools
- **Format**: XML/XSD schemas (versions 1.0 through 2.5), REST API over HTTP
- **Open/Free**: Yes, Apache 2.0
- **Quality**: 5/5 — ANSI standard (ANSI/MTC1.4-2018), used by major manufacturers (Mazak, Hurco, Haas, Fanuc), comprehensive device model

**Schema structure** (4 parts):
| Part | Schema | Content |
|------|--------|---------|
| MTConnectDevices | Devices XSD | Device definitions, components, data items |
| MTConnectStreams | Streams XSD | Real-time data streaming |
| MTConnectAssets | Assets XSD | Tool/fixture/part definitions |
| MTConnectError | Error XSD | Error responses |

**DataItem categories** (map to sensor/monitoring params):
| Category | Examples | PCC Use |
|----------|---------|---------|
| SAMPLE (continuous) | Position (X/Y/Z), Speed, Temperature, Load, Angle, Pressure, Feedrate | Sensor channel definitions |
| EVENT (state changes) | Execution state, Tool ID, Program name, Part count, Emergency stop | Job status tracking |
| CONDITION (health) | Temperature warnings, Pressure alerts, Communication status | Device health monitoring |

**NIST testbed example devices**:
- Agie Charmilles HPM600U (5-axis machining center)
- Mazak Integrex 100-IV (multitask turning/milling)
- Mazak QuickTurn Nexus 300 (turning center)
- Hurco VMX 24/64 (vertical milling)
- Each device: ~30-50 DataItems tracking position, temp, speed, load, coolant, overrides

**Component types** (map to device sub-systems):
- Controller, Axes (Linear/Rotary), Spindle, Path, Door, Coolant, Electric, Hydraulic, Pneumatic, EndEffector, PartOccurrence

**How to map**: Each MTConnect device type -> one CapabilityTemplate. DataItems define the available sensor/monitoring parameters. Component hierarchy defines the machine's physical structure. Device XML can auto-generate:
- Material enums from Part/Stock definitions
- Tolerance params from Position DataItem precision
- Speed/feed params from Feedrate/SpindleSpeed DataItems
- Work envelope from axis travel limits
- Sensor channels from all SAMPLE DataItems

### 2.2 OPC-UA Companion Specifications

- **URL**: https://reference.opcfoundation.org/ | AM spec: https://reference.opcfoundation.org/AdditiveManufacturing/v100/docs/
- **Covers**: Additive manufacturing (OPC 40540), injection molding (EUROMAP 77/OPC 40079), plastics/rubber machinery, CNC/machine tools, robotics
- **Format**: XML NodeSet2 files, OPC UA information models
- **Open/Free**: Specifications are freely accessible online; implementation requires OPC UA SDK
- **Quality**: 4/5 — Industry standard, well-structured, but complex information model

**Key companion specs for PCC**:
| Spec | OPC Number | Covers | PCC Template |
|------|-----------|--------|--------------|
| Additive Manufacturing | OPC 40540 | AM systems, build cycles, feedstock | fdm, sla, sls, mjf |
| Plastics/Rubber (EUROMAP 77) | OPC 40079 | Injection molding machines | injection-mold |
| Machine Tools | OPC 40501 | CNC monitoring | cnc-3axis, cnc-5axis, lathe |
| Robotics | OPC 40010 | Robot systems | assembly |

**OPC 40540 (Additive Manufacturing) object types**:
- `AdditiveManufacturingType` — Core AM system
- `MachineIdentificationAMType` — Machine ID properties
- `EquipmentAMType` — Equipment attributes
- `ProcessValueAMType` — Process parameters
- `FeedstockListType` / `FeedstockType` — Material tracking
- `RunInfoDataType` — Build cycle information

**How to map**: OPC UA types map to CapabilityTemplate structure. Each ObjectType's properties -> ParamDefs. Feedstock types -> material enum options. ProcessValues -> numeric parameters with units. More complex mapping than MTConnect but covers injection molding (which MTConnect does not).

### 2.3 ISO 14649 (STEP-NC)

- **URL**: https://en.wikipedia.org/wiki/STEP-NC | Standards: ISO 14649-1 through 14649-111
- **Covers**: CNC milling (ISO 14649-10/11), CNC turning (ISO 14649-12), EDM, contour cutting
- **Format**: STEP/EXPRESS data model (ISO 10303)
- **Open/Free**: No — ISO standards are paywalled (~$200 each)
- **Quality**: 4/5 — Extremely detailed feature-based machining model, but complex and paywall-gated

**Model components**:
- Task description (what to make)
- Technology description (how to make it — feeds, speeds, depths)
- Cutting tool description (tool geometry, material)
- Geometric description (workpiece features)

**How to map**: STEP-NC's technology descriptions contain exactly the kind of parameters we need for CNC templates (feeds, speeds, depths of cut, tool selections). However, the EXPRESS data model is complex and paywalled. **Recommendation**: Use MTConnect for CNC parameter discovery instead — it's free, XML-based, and has the same data items in a more accessible format.

### 2.4 ISO/ASTM 52900 (Additive Manufacturing)

- **URL**: https://www.iso.org/standard/74514.html
- **Covers**: Additive manufacturing terminology and process classification
- **Format**: PDF standard document
- **Open/Free**: No — paywalled (preview available)
- **Quality**: 3/5 — Defines standard terminology but not structured data schemas

**Process categories defined** (7 total):
1. Binder Jetting
2. Directed Energy Deposition
3. Material Extrusion (FDM)
4. Material Jetting
5. Powder Bed Fusion (SLS, SLM, MJF)
6. Sheet Lamination
7. Vat Photopolymerization (SLA, DLP)

**How to map**: Use as the canonical taxonomy for AM capability types. Already reflected in our BuiltinCapabilityType (fdm = material extrusion, sla = vat photopolymerization, sls/mjf = powder bed fusion). No structured parameter data to import directly.

### 2.5 3MF File Format

- **URL**: https://3mf.io/spec/ | GitHub: https://github.com/3MFConsortium/spec_core
- **Covers**: 3D printing build files with materials, colors, settings metadata
- **Format**: XML (Open Packaging Convention / ZIP archive)
- **Open/Free**: Yes, BSD license. Now ISO/IEC 25422:2025
- **Quality**: 3/5 — Primarily a file format, not a machine capability description

**Extensions with capability relevance**:
- Materials and Properties Extension — material compositions
- Production Extension — production workflows
- Beam Lattice Extension — lattice structures
- Slice Extension — pre-sliced data

**How to map**: Limited direct value. 3MF describes *what to print*, not *what a printer can do*. Material definitions could supplement material enum options. Not a primary data source.

---

## 3. Slicer Software / CAM — Machine Profiles

### 3.1 Cura fdmprinter.def.json (HIGHEST VALUE for FDM)

- **URL**: https://github.com/Ultimaker/Cura/blob/main/resources/definitions/fdmprinter.def.json
- **Covers**: ALL FDM printer parameters — 800+ settings across machine capabilities, print quality, material handling, support structures, cooling, speed, travel, mesh fixes, special modes, experimental features
- **Format**: JSON definition files with inheritance
- **Open/Free**: Yes, LGPL-3.0
- **Quality**: 5/5 — The most comprehensive structured FDM parameter schema in existence

**Setting categories in fdmprinter.def.json**:
| Category | Example Settings | Count (approx) |
|----------|-----------------|--------|
| Machine | machine_width, machine_depth, machine_height, machine_heated_bed, machine_nozzle_size, machine_gcode_flavor | 50+ |
| Quality | layer_height, layer_height_0, line_width | 20+ |
| Shell | wall_thickness, wall_line_count, top_layers, bottom_layers | 30+ |
| Infill | infill_sparse_density, infill_pattern, infill_line_distance | 40+ |
| Material | material_print_temperature, material_bed_temperature, material_flow | 30+ |
| Speed | speed_print, speed_infill, speed_wall, speed_travel | 40+ |
| Travel | retraction_amount, retraction_speed, retraction_hop | 20+ |
| Cooling | cool_fan_speed, cool_min_layer_time | 15+ |
| Support | support_enable, support_type, support_angle, support_pattern | 40+ |
| Platform Adhesion | adhesion_type, brim_width, raft_margin | 20+ |
| Dual Extrusion | prime_tower_enable, ooze_shield_angle | 20+ |
| Mesh Fixes | meshfix_union_all, meshfix_extensive_stitching | 15+ |
| Special Modes | magic_spiralize, mold_enabled | 15+ |
| Experimental | support_tree_enable, adaptive_layer_height_enabled | 30+ |

**Setting schema per parameter**:
```json
{
  "label": "Layer Height",
  "description": "The height of each layer in mm...",
  "unit": "mm",
  "type": "float",
  "default_value": 0.2,
  "minimum_value": 0.001,
  "minimum_value_warning": 0.04,
  "maximum_value_warning": 0.8,
  "settable_per_mesh": false,
  "settable_per_extruder": false
}
```

**100+ printer definitions** in `resources/definitions/`:
Each inherits from fdmprinter.def.json and overrides machine-specific values (build volume, nozzle sizes, heated bed, etc.)

**How to map**: Direct 1:1 mapping possible.
- Cura `type: "float"` with min/max -> PCC `NumberParamDef` with min/max/step/unit
- Cura `type: "enum"` with options -> PCC `EnumParamDef` with options
- Cura `type: "bool"` -> PCC `BooleanParamDef`
- Cura categories -> PCC groups
- Machine definition overrides -> PCC `MachineProfile.paramOverrides`
- A script can parse fdmprinter.def.json and emit a CapabilityTemplate with 50+ curated params (filtering out the 750+ expert settings that aren't user-facing for PCC's "car configurator" UX)

### 3.2 PrusaSlicer Vendor Bundles

- **URL**: https://github.com/prusa3d/PrusaSlicer/tree/master/resources/profiles
- **Covers**: Printer definitions for Prusa, Creality, Lulzbot, and 30+ other manufacturers
- **Format**: INI files with inheritance
- **Open/Free**: Yes, AGPL-3.0
- **Quality**: 4/5 — Comprehensive vendor profiles but INI format is less machine-readable than JSON

**Key parameters per printer profile**:
- `nozzle_diameter`, `max_layer_height`, `min_layer_height`
- `retract_length`, `retract_speed`, `retract_lift`
- `variable_layer_height`
- `compatible_printers_condition` (regex-based)

**How to map**: Extract machine capability bounds (nozzle sizes, layer height ranges, build volumes) from vendor INI profiles. Use as supplementary data to populate MachineProfile overrides for specific printer models (e.g., "Prusa MK4 restricts nozzle to 0.25/0.4/0.6/0.8mm").

### 3.3 Fusion 360 / Autodesk Post Processors

- **URL**: https://cam.autodesk.com/hsmposts
- **Covers**: CNC post processors for specific machines/controllers (Haas, Fanuc, Siemens, Mazak, etc.)
- **Format**: JavaScript files with machine capability metadata
- **Open/Free**: Post library is free to access
- **Quality**: 3/5 — Contains machine capability hints in post processor metadata but not structured as standalone data

**How to map**: Extract machine capability metadata (number of axes, spindle type, tool changer capacity) from post processor headers. Supplementary source for CNC MachineProfiles, not primary.

---

## 4. Device Catalogs / Databases

### 4.1 Senvol AM Machine Database

- **URL**: https://senvol.com/database/
- **Covers**: Additive manufacturing machines and materials from all major manufacturers
- **Format**: Web database (searchable, no public API)
- **Open/Free**: Free to search
- **Quality**: 3/5 — Comprehensive catalog but no structured API or bulk export

**How to map**: Manual reference for populating AM machine profiles. Could scrape for build volume, material compatibility, and resolution specs across manufacturers. Not automatable without scraping.

### 4.2 FabLabs.io / Fab Inventory

- **URL**: https://www.fablabs.io/machines | http://inventory.fabcloud.io/
- **Covers**: FabLab standard equipment (laser cutters, CNC routers, 3D printers, vinyl cutters, electronics)
- **Format**: Web platform, no public API
- **Open/Free**: Free to browse
- **Quality**: 2/5 — Equipment lists exist but no structured parameter data

### 4.3 OpenBuilds / Open Source Machine Tools

- **URL**: https://www.appropedia.org/Tolocar/Open_Source_Machine_Tools
- **Covers**: Open-source CNC routers, laser cutters, 3D printers
- **Format**: Wiki pages with specifications
- **Open/Free**: Yes
- **Quality**: 2/5 — Lists exist but specs are in prose, not structured data

---

## 5. Biotech/Pharma Specific

### 5.1 Allotrope Foundation / Benchling Allotropy (HIGH VALUE)

- **URL**: https://www.allotrope.org/ | https://github.com/Benchling-Open-Source/allotropy
- **Covers**: 60 instrument software parsers across 13 analytical technique categories
- **Format**: JSON schemas (Allotrope Simple Model / ASM) + Python parsers
- **Open/Free**: ASM schemas and Benchling allotropy library are open source (MIT)
- **Quality**: 5/5 — Production-grade JSON schemas with formal validation, used by pharma companies

**Supported instrument parsers (60 total, by technique)**:

| Technique Category | # Instruments | Key Vendors | PCC Template |
|-------------------|---------------|-------------|--------------|
| Binding Affinity | 3 | Cytiva (Biacore) | assay |
| Cell Counting | 6 | Beckman Coulter, ChemoMetec, Revvity, Roche | cell-culture |
| Electrophoresis | 1 | Agilent (TapeStation) | sample-prep |
| Flow Cytometry | 2 | BD Biosciences, FlowJo | flow-cytometry |
| Liquid Chromatography | 4 | Agilent, Waters, Cytiva, Thermo Fisher | hplc / chromatography |
| Liquid Handler | 2 | Beckman Coulter (Biomek, Echo) | liquid-handler |
| Multi Analyte Profiling | 3 | Bio-Rad, Luminex | assay |
| Plate Reader | 14 | Agilent, BMG, CTL, Mabtech, MSD, Molecular Devices, PerkinElmer, Revvity, Tecan, Thermo Fisher, Unchained Labs | spectroscopy / assay |
| Solution Analyzer | 3 | Beckman Coulter, NovaBio, Roche | sample-prep |
| Spectrophotometry | 8 | Thermo Fisher (Genesys, NanoDrop, Qubit, VISIONlite) | spectroscopy |
| dPCR | 2 | AppBio (AbsoluteQ), Qiacuity | pcr |
| qPCR | 3 | AppBio (QuantStudio), Bio-Rad (CFX Maestro) | pcr |

**ASM JSON schema structure** (per technique):
- Instance data: experimental parameters, instrument settings, results
- Manifest: ontology references, schema links
- JSON Schema: formal structure definition with required/optional fields

**How to map**: Each ASM technique schema defines the parameters that instrument generates/accepts. Parse the JSON schema to extract:
- Instrument setting fields -> NumberParamDef / EnumParamDef
- Result fields -> defines what evidence the capability produces
- Technique category -> maps to PCC BuiltinCapabilityType
- Vendor/instrument names -> MachineProfile entries

**Example**: The liquid-chromatography ASM schema at `src/allotropy/allotrope/schemas/adm/liquid-chromatography/REC/2023/09/liquid-chromatography.schema.json` defines HPLC parameters (column type, mobile phase, flow rate, wavelength, injection volume, etc.) that directly map to an HPLC CapabilityTemplate.

### 5.2 AnIML (Analytical Information Markup Language)

- **URL**: https://www.animl.org/ | https://github.com/AnIML/schemas
- **Covers**: Spectroscopy and chromatography data (core), extensible to any analytical technique
- **Format**: XML Schema (XSD)
- **Open/Free**: Yes (ASTM standard, schemas on GitHub)
- **Quality**: 3/5 — Well-designed but draft status (v0.90), XML-based (harder to parse than JSON), technique definitions are limited

**Schema files**:
- `animl-core.xsd` — Core document structure (SampleSet, ExperimentStepSet, AuditTrail, Signatures)
- `animl-technique.xsd` — Technique extensions (MethodBlueprint, ResultBlueprint, SampleRoleBlueprint)

**How to map**: AnIML's MethodBlueprint defines technique parameters, ResultBlueprint defines output structure. However, the schema is more about *data recording* than *device capabilities*. Lower priority than Allotropy, which provides the same coverage in JSON with 60 concrete instrument parsers.

### 5.3 HL7 FHIR DeviceDefinition (R5)

- **URL**: https://hl7.org/fhir/R5/devicedefinition.html
- **Covers**: Medical device type definitions — any medical device (implants, diagnostics, wearables, lab instruments)
- **Format**: JSON/XML (FHIR resources)
- **Open/Free**: Yes, Creative Commons
- **Quality**: 4/5 — Excellent structural pattern but focuses on medical devices, not lab/manufacturing equipment

**Key elements for PCC**:
| Element | Cardinality | PCC Mapping |
|---------|-------------|-------------|
| `property` (type + value[x]) | 0..* | ParamDef (static device characteristics) |
| `conformsTo` (specification + version) | 0..* | Template compliance/standards |
| `classification` (type + justification) | 0..* | CapabilityType classification |
| `guideline` (indication, contraindication, intendedUse) | 0..1 | Template description + constraints |
| `deviceName`, `manufacturer`, `modelNumber` | various | MachineProfile identity |

**Property value types**: Quantity, CodeableConcept, string, boolean, integer, Range, Attachment — closely mirrors our ParamDef union (number, enum, string, boolean).

**How to map**: FHIR DeviceDefinition is a **structural pattern** that validates PCC's CapabilityTemplate design. Our ParamDef discriminated union (enum/number/boolean/string) mirrors FHIR's value[x] choice type. Use as a design reference, not a data source.

### 5.4 ASTM Chromatography Standards

- **Standards**: ASTM E1947 (HPLC), ASTM E2077 (chromatography data)
- **Covers**: Chromatographic data interchange
- **Format**: Paywalled PDF standards
- **Open/Free**: No
- **Quality**: 3/5 — Relevant but paywalled and superseded by Allotropy for our purposes

---

## 6. Mapping Matrix: Sources -> PCC CapabilityTypes

| PCC CapabilityType | Primary Source | Secondary Source | Auto-Generate? | Status |
|--------------------|---------------|------------------|----------------|--------|
| fdm | Cura fdmprinter.def.json | PrusaSlicer profiles | YES — parse JSON | Template exists (manual) |
| sla | Cura (via extension) | OPC 40540 | PARTIAL | Template exists (manual) |
| sls | OPC 40540, ISO/ASTM 52900 | Senvol database | PARTIAL | No template |
| mjf | OPC 40540 | Senvol database | PARTIAL | No template |
| cnc-3axis | MTConnect Devices XSD | Fusion 360 posts | YES — parse XML | Template exists (manual) |
| cnc-5axis | MTConnect Devices XSD | Fusion 360 posts | YES — parse XML | No template |
| lathe | MTConnect Devices XSD | Fusion 360 posts | YES — parse XML | No template |
| laser-cut | MTConnect (sensor items) | Cura (laser module) | PARTIAL | Template exists (manual) |
| waterjet | MTConnect Devices XSD | Manual | YES — parse XML | No template |
| sheet-metal | MTConnect + OPC UA | Manual | PARTIAL | No template |
| injection-mold | EUROMAP 77 / OPC 40079 | Manual | YES — parse OPC UA | No template |
| liquid-handler | Opentrons shared-data | PyLabRobot | YES — parse JSON | Template exists (manual) |
| hplc | Allotropy ASM (LC schema) | AnIML | YES — parse JSON | No template |
| mass-spec | Allotropy ASM | AnIML | PARTIAL | No template |
| pcr | Opentrons modules + Allotropy | OpenPCR, NinjaPCR | YES — parse JSON | No template |
| sequencing | Allotropy (future) | Manual | NO | No template |
| cell-culture | Allotropy (cell counting) | PyLabRobot | PARTIAL | No template |
| microscopy | Manual | FHIR DeviceDefinition | NO | No template |
| spectroscopy | Allotropy ASM (spectrophotometry) | Opentrons (absorbance reader) | YES — parse JSON | No template |
| centrifuge | Opentrons modules (heater-shaker) | PyLabRobot (VSpin) | YES — parse JSON | No template |
| lyophilizer | Manual | SiLA 2 features | NO | No template |
| bioreactor | Manual | SiLA 2 features | NO | No template |
| flow-cytometry | Allotropy ASM | Manual | PARTIAL | No template |
| electrophysiology | Manual | — | NO | No template |
| imaging | Manual | FHIR DeviceDefinition | NO | No template |
| sample-prep | Allotropy ASM (electrophoresis) | PyLabRobot | PARTIAL | No template |
| compound-synthesis | Manual | — | NO | No template |
| assay | Allotropy ASM (plate reader, MAP) | Opentrons labware | YES — parse JSON | No template |
| chromatography | Allotropy ASM (LC) | AnIML | YES — parse JSON | No template |
| 2d-print | Manual | — | NO | No template |
| inspection | MTConnect (CMM devices) | FHIR | PARTIAL | No template |
| assembly | OPC UA Robotics | Manual | PARTIAL | No template |
| courier-pickup | Manual | — | NO (logistics, not equipment) | No template |
| courier-delivery | Manual | — | NO (logistics, not equipment) | No template |
| custom | N/A | N/A | N/A | N/A |

**Summary**:
- **YES (auto-generate)**: 12 types — fdm, cnc-3axis, cnc-5axis, lathe, waterjet, injection-mold, liquid-handler, hplc, pcr, spectroscopy, centrifuge, assay, chromatography
- **PARTIAL (auto-generate + manual enrichment)**: 10 types — sla, sls, mjf, laser-cut, sheet-metal, mass-spec, cell-culture, flow-cytometry, sample-prep, inspection, assembly
- **NO (manual only)**: 9 types — sequencing, microscopy, lyophilizer, bioreactor, electrophysiology, imaging, compound-synthesis, 2d-print, courier-*

---

## 7. Recommended Implementation Plan

### Phase 1: Immediate (auto-generate 12 templates in a day)

**Tool: `scripts/generate-templates.ts`**

1. **Parse Cura fdmprinter.def.json** -> Enhanced FDM template (upgrade from 9 to 20+ user-facing params)
   - Source: `https://raw.githubusercontent.com/Ultimaker/Cura/main/resources/definitions/fdmprinter.def.json`
   - Strategy: Curate ~20 params from 800+ (filter by `settable_per_mesh` and `enabled` defaults)
   - Also generate SLA, SLS, MJF templates from Cura extensions + machine defs

2. **Parse Opentrons shared-data** -> Lab equipment templates
   - Source: Clone `shared-data/module/`, `shared-data/pipette/`, `shared-data/labware/`
   - Generate: Enhanced liquid-handler, PCR (thermocycler module), centrifuge, spectroscopy (absorbance reader)
   - Each module JSON -> one CapabilityTemplate with param ranges from module definitions

3. **Parse Allotropy ASM schemas** -> Analytical instrument templates
   - Source: Clone `Benchling-Open-Source/allotropy`, read `src/allotropy/allotrope/schemas/adm/*/`
   - Generate: HPLC, chromatography, assay (plate reader), spectroscopy (supplement Opentrons data)
   - Each ASM schema directory -> one CapabilityTemplate

4. **Parse MTConnect example Devices.xml** -> CNC/manufacturing templates
   - Source: `https://raw.githubusercontent.com/usnistgov/smstestbed/master/mtconnect/agent/Devices.xml`
   - Generate: CNC-5axis, lathe, waterjet from DataItem categories
   - Component types + DataItems -> param groups + numeric params

### Phase 2: Medium-term (10 more templates with manual enrichment)

5. **Parse OPC-UA AM companion spec** -> Injection molding template
6. **Enrich SLA/SLS/MJF** with OPC 40540 feedstock definitions
7. **Generate MachineProfiles** from:
   - Cura's 100+ printer definition JSONs (FDM machines)
   - PrusaSlicer's vendor bundles (more FDM machines)
   - MTConnect device examples (CNC machines)
   - PyLabRobot backends (lab robots)
8. **Generate remaining lab templates** (cell-culture, flow-cytometry, mass-spec) using Allotropy parsers + SiLA 2 feature patterns

### Phase 3: Long-tail (9 manual templates)

9. Author remaining templates manually using domain expertise:
   - sequencing, microscopy, lyophilizer, bioreactor, electrophysiology, imaging, compound-synthesis, 2d-print
   - Use FHIR DeviceDefinition pattern as structural guide
   - Use SiLA 2 feature definitions as command/parameter reference

---

## 8. Source Quality Summary

| Source | Format | Open | Quality | Device Types | Auto-Import | Priority |
|--------|--------|------|---------|-------------|-------------|----------|
| Cura fdmprinter.def.json | JSON | Yes | 5/5 | FDM printers (800+ params) | Direct parse | 1 |
| Opentrons shared-data | JSON | Yes | 5/5 | Liquid handlers, modules (6+ types) | Direct parse | 1 |
| Allotropy/ASM schemas | JSON | Yes | 5/5 | 60 analytical instruments (13 categories) | Direct parse | 1 |
| MTConnect schemas + examples | XML/XSD | Yes | 5/5 | CNC, lathes, 3D printers, CMMs | Parse XML | 2 |
| PyLabRobot | Python | Yes | 4/5 | 8+ lab device categories | Extract from code | 3 |
| PrusaSlicer vendor bundles | INI | Yes | 4/5 | 30+ printer manufacturers | Parse INI | 3 |
| OPC-UA Companion Specs | XML | Yes* | 4/5 | AM, injection molding, CNC | Parse NodeSet2 | 3 |
| FHIR DeviceDefinition | JSON | Yes | 4/5 | Medical devices (structural pattern) | Pattern only | 4 |
| SiLA 2 features | Protobuf | Yes | 3/5 | Generic lab instruments | Interface only | 4 |
| AnIML schemas | XML | Yes | 3/5 | Spectroscopy, chromatography | Parse XSD | 4 |
| 3MF format | XML | Yes | 3/5 | AM file format (materials) | Supplement only | 5 |
| ISO/ASTM 52900 | PDF | No | 3/5 | AM taxonomy | Reference only | 5 |
| ISO 14649 STEP-NC | EXPRESS | No | 4/5 | CNC machining | Paywalled, skip | 5 |
| Senvol database | Web | Free* | 3/5 | AM machines catalog | Manual/scrape | 5 |
| SLAS/ANSI standards | PDF | Free* | 4/5 | Microplate dimensions only | Already in Opentrons | 5 |
| FabLabs.io | Web | Free | 2/5 | Makerspace equipment lists | No structured data | Skip |

---

## 9. Key File Paths in External Repos

These are the exact files/directories to clone or fetch for the auto-generator:

```
# Cura (FDM params + machine profiles)
https://github.com/Ultimaker/Cura/blob/main/resources/definitions/fdmprinter.def.json
https://github.com/Ultimaker/Cura/tree/main/resources/definitions/  (100+ .def.json files)

# Opentrons (lab equipment)
https://github.com/Opentrons/opentrons/tree/edge/shared-data/labware/schemas/2.json
https://github.com/Opentrons/opentrons/tree/edge/shared-data/labware/definitions/2/
https://github.com/Opentrons/opentrons/tree/edge/shared-data/pipette/definitions/2/
https://github.com/Opentrons/opentrons/tree/edge/shared-data/module/definitions/3/
https://github.com/Opentrons/opentrons/tree/edge/shared-data/liquid-class/
https://github.com/Opentrons/opentrons/tree/edge/shared-data/deck/

# Allotropy (analytical instruments)
https://github.com/Benchling-Open-Source/allotropy/tree/main/src/allotropy/allotrope/schemas/adm/
https://github.com/Benchling-Open-Source/allotropy/blob/main/SUPPORTED_INSTRUMENT_SOFTWARE.adoc

# MTConnect (manufacturing)
https://github.com/mtconnect/schema/  (all XSD versions)
https://github.com/usnistgov/smstestbed/blob/master/mtconnect/agent/Devices.xml  (example devices)
https://schemas.mtconnect.org/  (latest schemas)

# PrusaSlicer (machine profiles)
https://github.com/prusa3d/PrusaSlicer/tree/master/resources/profiles/

# SiLA 2 (lab instrument features)
https://gitlab.com/SiLA2/sila_base/-/tree/master/feature_definitions/

# AnIML (analytical data)
https://github.com/AnIML/schemas/

# OPC-UA AM
https://reference.opcfoundation.org/AdditiveManufacturing/v100/docs/
```

---

## 10. Architecture for Auto-Generator

```
scripts/generate-templates.ts
  |
  ├── parsers/
  |     ├── cura-parser.ts          # JSON -> CapabilityTemplate (FDM/SLA/SLS)
  |     ├── opentrons-parser.ts     # JSON -> CapabilityTemplate (lab modules)
  |     ├── allotropy-parser.ts     # JSON Schema -> CapabilityTemplate (analytical)
  |     ├── mtconnect-parser.ts     # XML/XSD -> CapabilityTemplate (CNC/manufacturing)
  |     └── machine-profile-gen.ts  # Cura defs + PrusaSlicer INI -> MachineProfile[]
  |
  ├── curators/
  |     ├── param-filter.ts         # Select user-facing params from 800+ available
  |     ├── pricing-estimator.ts    # Estimate pricing impacts from param metadata
  |     └── constraint-inferrer.ts  # Infer cross-param constraints from data
  |
  └── output/
        ├── packages/contract-builder/src/templates/  # Generated CapabilityTemplate files
        └── packages/contract-builder/src/profiles/   # Generated MachineProfile files
```

**Data flow**:
1. Fetch/clone external data sources (cached locally)
2. Parse each source into normalized intermediate format
3. Curate: filter to user-facing params, add pricing hints, infer constraints
4. Emit TypeScript CapabilityTemplate + MachineProfile files
5. Register in template registry (index.ts)

**Estimated output**:
- ~25 auto-generated CapabilityTemplates (from 5 current manual ones)
- ~100+ MachineProfiles (from Cura + PrusaSlicer printer definitions)
- Total coverage: ~80% of PCC's 36 BuiltinCapabilityTypes
