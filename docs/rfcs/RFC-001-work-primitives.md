# RFC-001: Work Primitives for Arbitrary Capability Composition

- **Status**: Draft
- **Date**: 2026-05-01
- **Author**: Ryan (globalmysterysnailrevolution)
- **Reviewers**: TBD
- **Implements**: the seven missing primitives identified during the
  contributor-economics design conversation (this branch:
  `feat/work-primitives`).
- **Supersedes**: the implicit "evidence-bundle + tier" model and the
  hardcoded special-cases in MilestoneEscrow / RateScheduleRegistry /
  ContributorNFT / EvidenceBundle.

---

## Motivation

PCC ships four primitives today that work brilliantly for the early
personas (3D-print operator, lab tech with FDA-style evidence) but don't
generalize:

- `RateScheduleRegistry` — content-addressed payout curves
- `ContributorNFT` — ERC-721 identity for an earner
- `EvidenceBundle` — a closed-shape record of "what happened"
- `MilestoneEscrow` — fixed-tier release based on ALCOA+ checks

When we walked nine disparate personas through the system —
**electrician · Uber driver · lab tech · 3D-print operator · data labeler ·
security guard · childcare worker · farmer/harvester · AI fine-tuner** —
it became clear that:

1. Each persona's evidence shape is incompatible with the others
   (`gfci_trip_test`, `gps_ping`, `peak_table`, `embedding_vector`,
   `harvest_weight_kg`, `parent_pickup_signature`).
2. Each persona's "complete" predicate is incompatible
   (`ground_continuity_ohms < 1` vs.
   `route_distance ≤ optimal × 1.3` vs.
   `peak_resolution > 2.0`).
3. Each persona depends on different external truths
   (permit DB, map service, approved-lots registry, gold-set,
   USDA standard version).

The current shape forces every new job type to ship a PR against
`@pcc/spec`. That's not "compose arbitrary work" — that's "PCC chooses
the work types it allows."

This RFC defines **seven primitives** and **six composition operators**
that lift the four hardcoded cases into a system anyone can build
on without forking core.

## Non-goals

- Replacing existing primitives. They become the default *implementations*
  of the new primitives. Migration is additive.
- Solving subjective quality at the protocol layer. Subjective work
  always escalates to a `human_attestor` predicate or a `DisputeResolver`.
- Privacy preservation beyond what tier 3 already provides via Lit
  Protocol + ZK. Privacy is orthogonal and out of scope.
- Cross-chain bridging. All primitives anchor to Base initially; bridging
  is a separate epic.

## Glossary

- **Capability** — an existing concept; a billable unit of work a kernel
  can perform (3D printing, HPLC analysis). This RFC adds a `WorkSchema`
  + `VerificationProgram` to each Capability.
- **CSD** — Capability StructureDefinition; the FHIR-inspired schema for
  a capability. New fields below extend the existing CSD shape.
- **Job** — one execution of a Capability, sealed by a JobSpec.
- **Bundle** — an EvidenceBundle, today; renamed conceptually to
  EvidenceStream below since it can be open-ended.

---

# The seven primitives

For each primitive: **Purpose · Type · Canonical hash · Three persona
examples · On-chain anchor (where applicable) · Migration**.

Primitives are presented in build-dependency order. **3 → 6 → 8 → 5 → 7
→ 10 → 2** in the original numbering becomes **1 → 2 → 3 → 4 → 5 → 6 →
7** for clean reading.

---

## Primitive 1: `WorkSchema`

### Purpose

Declares the evidence vocabulary a Capability uses. Replaces the closed
`EvidenceEventType` enum at
`packages/spec/src/types/evidence.ts:12` with a per-Capability,
content-addressed schema bundle.

A WorkSchema names every event type this job emits and gives a JSON
Schema for each type's `payload`. Sealed in the Capability's CSD,
referenced by `schemaHash` everywhere downstream.

### Type

```typescript
// packages/spec/src/types/work-schema.ts

export interface WorkEventTypeDef {
  /** Lowercase snake_case identifier, scoped to this WorkSchema. */
  id: string;
  /** One-line human description. */
  description: string;
  /** JSON Schema for the event's payload field. */
  payloadSchema: JSONSchema7;
  /** Which AssuranceTiers may use this event type. */
  validTiers: AssuranceTier[];
  /** If true, payload values must be appendable / monotonic over the
   *  job — used for cumulative measures (energy_kwh, harvest_weight_kg).
   *  Catches double-count bugs deterministically. */
  monotonic?: boolean;
}

export interface WorkProductTypeDef {
  /** Discriminator. */
  kind: "physical" | "digital" | "service" | "bilateral";
  /** JSON Schema for the WorkProduct's `details` field at this kind. */
  detailsSchema: JSONSchema7;
}

export interface WorkSchema {
  /** Schema version. v=1 is first published. */
  version: number;
  /** Human-readable label, NOT load-bearing. */
  label: string;
  /** Event types this Capability emits. */
  eventTypes: WorkEventTypeDef[];
  /** Permitted WorkProduct kinds. A Capability MAY support multiple. */
  workProducts: WorkProductTypeDef[];
  /** ISO timestamp of seal. NOT included in the canonical hash. */
  publishedAt: string;
  /** Author rationale. NOT load-bearing. */
  notes?: string;
  /** Self-reference, computed below. */
  schemaHash: `0x${string}`;
}
```

### Canonical hash

```
schemaHash = sha256(canonical_json({
  version,
  eventTypes: sortByKey("id", eventTypes),  // each entry's keys also sorted
  workProducts: sortByKey("kind", workProducts),
}))
```

Mirrors the existing `computeScheduleHash` in
`packages/spec/src/types/rate-schedule.ts:337` — same canonicalize, same
"label/notes/publishedAt are metadata, not part of identity."

### Three personas

**Electrician (residential service):**

```yaml
label: "NEC-compliant residential electrical work"
eventTypes:
  - id: panel_photo_before
    payloadSchema: { properties: { ipfsCid: string, exifTimestamp: int, gpsLat: number, gpsLng: number }}
    validTiers: [1, 2]
  - id: panel_photo_after
    payloadSchema: { properties: { ipfsCid: string, exifTimestamp: int, gpsLat: number, gpsLng: number }}
    validTiers: [1, 2]
  - id: multimeter_reading
    payloadSchema: { properties: { circuitId: string, hotV: number, neutralV: number, groundOhms: number, timestamp: int }}
    validTiers: [0, 1, 2]
  - id: gfci_trip_test
    payloadSchema: { properties: { circuitId: string, tripCurrentMa: number, tripTimeMs: number, passed: boolean }}
    validTiers: [1, 2]
  - id: customer_signature
    payloadSchema: { properties: { signerName: string, signatureCid: string, timestamp: int }}
    validTiers: [0, 1, 2]
  - id: permit_filing
    payloadSchema: { properties: { jurisdictionCode: string, permitNumber: string, filedAt: int }}
    validTiers: [2]
workProducts:
  - kind: service
    detailsSchema: { properties: { circuitsModified: array, codeReferences: array }}
```

**Uber-style driver:**

```yaml
label: "Point-to-point ride"
eventTypes:
  - id: gps_ping
    payloadSchema: { properties: { lat: number, lng: number, t: int, speedKph: number, headingDeg: number }}
    validTiers: [0, 1, 2]
  - id: pickup_confirm
    payloadSchema: { properties: { riderId: string, t: int, lat: number, lng: number, bleProximity: int }}
    validTiers: [1, 2]
  - id: dropoff_confirm
    payloadSchema: { properties: { riderId: string, t: int, lat: number, lng: number, bleProximity: int }}
    validTiers: [1, 2]
  - id: rider_gps_attest
    payloadSchema: { properties: { riderId: string, samples: array }}
    validTiers: [2]
workProducts:
  - kind: bilateral
    detailsSchema: { properties: { fromAddr: string, toAddr: string, totalDistanceKm: number, durationS: int }}
```

**HPLC lab tech:**

```yaml
label: "HPLC sample run with system-suitability QC"
eventTypes:
  - id: sample_loaded
    payloadSchema: { properties: { sampleId: string, vialPosition: int, t: int }}
    validTiers: [0, 1, 2, 3]
  - id: instrument_log_signed
    payloadSchema: { properties: { instrumentId: string, fileHash: string, instrumentSig: string, peakTable: array, t: int }}
    validTiers: [1, 2, 3]
  - id: qc_check_result
    payloadSchema: { properties: { resolution: number, tailingFactor: number, rsdPct: number, passed: boolean }}
    validTiers: [1, 2, 3]
  - id: reagent_use
    payloadSchema: { properties: { lotId: string, expiryDate: string, volumeMl: number }}
    validTiers: [2, 3]
  - id: badge_swipe
    payloadSchema: { properties: { techId: string, instrumentId: string, t: int }}
    validTiers: [2, 3]
workProducts:
  - kind: digital
    detailsSchema: { properties: { resultFileCid: string, resultFileHash: string, format: enum["chromatogram", "lcms-mzml", "summary-pdf"] }}
```

### On-chain anchor

```solidity
// packages/contracts/src/WorkSchemaRegistry.sol
contract WorkSchemaRegistry {
  /// schemaHash → canonical bytes (or just existence flag — bytes off-chain on IPFS).
  mapping(bytes32 => address) public publishers;
  mapping(bytes32 => uint256) public publishedAt;
  event WorkSchemaPublished(bytes32 indexed schemaHash, address indexed publisher);
  function publish(bytes32 schemaHash) external {
    require(publishers[schemaHash] == address(0), "already published");
    publishers[schemaHash] = msg.sender;
    publishedAt[schemaHash] = block.timestamp;
    emit WorkSchemaPublished(schemaHash, msg.sender);
  }
}
```

Same pattern as `RateScheduleRegistry`. Schemas themselves live on IPFS;
the chain pins identity + timestamp + publisher.

### Migration

The current closed `EvidenceEventType` enum becomes a *single seeded
WorkSchema* with id `pcc-core-v1` published at the genesis block. Every
existing Capability gets `schemaHash = sha256(pcc-core-v1)` migrated in.
New Capabilities can declare their own.

This is purely additive: existing evidence bundles validate identically
against the seeded schema.

### Composability rules

- A Capability may reference exactly one `schemaHash`.
- A Capability MAY change its `schemaHash` between versions — that's a
  new Capability version, like a new RateSchedule version. Old jobs
  remain bound to their schema-hash-at-mint forever.
- Two Capabilities MAY reference the same `schemaHash` — useful when
  defining an industry standard (e.g., "all FDA-regulated HPLC labs use
  schemaHash 0xabc...").

---

## Primitive 2: `WorkProduct`

### Purpose

A first-class, typed reference to what was actually produced. Today
this is implicit in the EvidenceBundle. Promoting it to a primitive lets
settlement fire on "the artifact exists and matches the WorkSchema's
work-product type" rather than on "evidence bundle is well-formed."

Four variants cover all observed personas:

- **`physical`** — a tangible thing exists, located somewhere
  (3D-printed part, electrical work in a panel, harvested crate of
  apples)
- **`digital`** — bytes were produced (file CID + signature)
  (HPLC chromatogram, fine-tuned model weights, labeled dataset)
- **`service`** — a state was changed in the world (outlet now passes
  GFCI test, rider arrived at destination, child was supervised
  9am-3pm)
- **`bilateral`** — two parties handshake-attested completion (Uber
  driver + rider both signed off; childcare provider + parent both
  signed pickup)

### Type

```typescript
// packages/spec/src/types/work-product.ts

interface WorkProductBase {
  jobId: Id;
  capabilityId: Id;
  schemaHash: `0x${string}`;
  /** Producer's signature over the canonical bytes. */
  producerSignature: Signature;
  /** Producer's wallet address. Must match the Job's assigned Actor. */
  producerAddress: `0x${string}`;
  /** Unix seconds. */
  finalizedAt: number;
  /** sha256 of canonical_json({ kind, jobId, capabilityId, schemaHash, finalizedAt, details }) */
  productHash: `0x${string}`;
}

export interface PhysicalWorkProduct extends WorkProductBase {
  kind: "physical";
  details: {
    /** Where the artifact is located. */
    location: { lat: number; lng: number; address?: string; room?: string };
    /** Optional unique serial / tag the artifact carries. */
    serial?: string;
    /** IPFS CID of the producer's "this is what I made" photo bundle. */
    photoBundleCid: string;
    /** Delivery confirmation from a courier or recipient, if applicable. */
    deliveryAttestationId?: Id;
  };
}

export interface DigitalWorkProduct extends WorkProductBase {
  kind: "digital";
  details: {
    /** IPFS CID of the produced bytes. */
    cid: string;
    /** sha256 of the produced bytes (NOT the CID — these can disagree
     *  if the CID's hash function is something other than sha256). */
    contentHash: `0x${string}`;
    /** MIME type or format identifier. */
    format: string;
    /** Byte size, for sanity-check + storage settlement. */
    sizeBytes: number;
  };
}

export interface ServiceWorkProduct extends WorkProductBase {
  kind: "service";
  details: {
    /** Free-form description of the state change, validated against the
     *  WorkSchema's workProducts[].detailsSchema for kind=service. */
    stateChange: Record<string, unknown>;
    /** Optional follow-up window: "this state holds true until T". */
    holdsUntil?: number;
  };
}

export interface BilateralWorkProduct extends WorkProductBase {
  kind: "bilateral";
  details: {
    /** The other party. */
    counterpartyAddress: `0x${string}`;
    /** Counterparty's signature over the same canonical bytes. */
    counterpartySignature: Signature;
    /** What both parties attested to. Schema-validated. */
    receipt: Record<string, unknown>;
  };
}

export type WorkProduct =
  | PhysicalWorkProduct
  | DigitalWorkProduct
  | ServiceWorkProduct
  | BilateralWorkProduct;
```

### Canonical hash

```
productHash = sha256(canonical_json({
  kind,
  jobId,
  capabilityId,
  schemaHash,
  finalizedAt,
  details,                          // schema-sorted-keys
}))

// producerSignature and counterpartySignature (when kind=bilateral)
// are NOT in the hash — signatures sign the hash, hash can't include them.
```

### Three personas

| Persona | Variant | `details` shape |
|---|---|---|
| 3D-print operator | `physical` | `{ location: workshop_lat/lng, serial: "PCC-3DP-00427", photoBundleCid: "bafy..." }` |
| HPLC lab tech | `digital` | `{ cid: "bafyhplc...", contentHash: "0x...", format: "lcms-mzml", sizeBytes: 4_217_000 }` |
| Uber-style driver | `bilateral` | `{ counterpartyAddress: rider, counterpartySignature: "0x...", receipt: { from: "...", to: "...", durationS: 1245 }}` |
| Electrician | `service` | `{ stateChange: { circuitsModified: [...], gfciNowPassing: true, panelLabelsCorrect: true }, holdsUntil: 0 }` |
| Childcare worker | `bilateral` | counterpartyAddress = parent, receipt = `{ careStart: t1, careEnd: t2, mealsServed: 2, napTaken: true }` |
| AI fine-tuner | `digital` | `{ cid: "bafymodel...", contentHash: "0x...", format: "safetensors-lora", sizeBytes: 218_000_000 }` |

### On-chain anchor

```solidity
// packages/contracts/src/WorkProductCommitment.sol
contract WorkProductCommitment {
  /// productHash → producer (set once, immutable)
  mapping(bytes32 => address) public producers;
  mapping(bytes32 => uint256) public commitTimestamp;
  event WorkProductCommitted(bytes32 indexed productHash, address indexed producer, uint256 jobId);
  function commit(bytes32 productHash, uint256 jobId) external {
    require(producers[productHash] == address(0), "already committed");
    producers[productHash] = msg.sender;
    commitTimestamp[productHash] = block.timestamp;
    emit WorkProductCommitted(productHash, msg.sender, jobId);
  }
}
```

Note: the chain pins *the hash*, not the bytes. Bytes live in IPFS for
digital products, in-physical for physical, in evidence for service /
bilateral. The chain is the canonical "this hash existed at time T,
committed by address A, against job J."

### Migration

Existing jobs implicitly produce a WorkProduct as the last step of their
EvidenceStream. Migration emits a `WorkProductCommitted` event for every
historical job by hashing the job's current evidence bundle's "completion
event payload" — backfill is one-time, indexers handle it.

---

## Primitive 3: `Registry`

### Purpose

Generalized content-addressed reference data the `VerificationProgram`
can read at attestation time. Replaces the ad-hoc, per-domain
RateScheduleRegistry / ContributorNFT / CanonicalRegistry pattern with a
single contract that hosts many registries by id.

A Registry holds a *set* (membership only) or a *map* (key → value
hash) and pins it to chain by `(registryId, snapshotHash)`. Predicates
read it by snapshot hash so they're reproducible — the verifier can
re-evaluate two years later and get the same answer.

### Type

```typescript
// packages/spec/src/types/registry.ts

export type RegistryShape = "set" | "map";

export interface RegistryDescriptor {
  /** Unique identifier scope, e.g. "permit-db.us.california.contra-costa". */
  registryId: string;
  /** Set membership or key-value map. */
  shape: RegistryShape;
  /** Authority that may publish snapshots — wallet or multisig. */
  publisher: `0x${string}`;
  /** Schema for entries when shape=map. */
  valueSchema?: JSONSchema7;
  /** Description for humans + agent surfaces. */
  description: string;
}

export interface RegistrySnapshot {
  registryId: string;
  /** Monotonically increasing version. */
  version: number;
  /** sha256(canonical_json(entries-sorted)) — content addresses the
   *  snapshot. Predicates pin THIS specific version. */
  snapshotHash: `0x${string}`;
  /** Where the entries live. IPFS CID for large registries; inline for
   *  small ones. */
  entriesLocator: { kind: "ipfs"; cid: string } | { kind: "inline"; entries: unknown[] };
  /** Publisher's signature. */
  publisherSignature: Signature;
  publishedAt: number;
}
```

### Canonical hash

For shape=set:
```
snapshotHash = sha256(canonical_json({ entries: sortLexicographically(entries) }))
```

For shape=map:
```
snapshotHash = sha256(canonical_json({ entries: sortByKey(entries) }))
```

### Three personas

| Persona | Registry | `registryId` | Shape | Predicate use |
|---|---|---|---|---|
| Electrician | Active permits in jurisdiction | `permit-db.us.ca.contra-costa.v1` | map (address → permit#) | `registry.has(jobAddress) AND registry.get(jobAddress).permitNumber == job.permitFiling.permitNumber` |
| Lab tech | FDA-approved reagent lots | `fda.approved-lots.acn-grade.v3` | set | `registry.contains(reagentUseEvent.lotId)` |
| Uber driver | Currently-licensed drivers | `pcc-driver-licenses.us.v2` | set | `registry.contains(actorAddress)` |
| AI fine-tuner | Allowed base models | `pcc-allowed-base-models.v1` | set | `registry.contains(jobSpec.baseModelHash)` |
| Farmer | USDA grade standards by crop | `usda.grade-standards.v2026.04` | map (cropId → grade-spec hash) | `crop.harvestGrade ∈ registry.get(cropId).acceptableGrades` |
| Security guard | Certified guards | `state-bsis.licenses.ca.active.v1` | set | `registry.contains(actorAddress)` |

### On-chain anchor

```solidity
// packages/contracts/src/Registry.sol
contract Registry {
  struct SnapshotMeta { bytes32 hash; uint64 version; uint64 publishedAt; address publisher; }

  /// registryId → publisher (set once at registry creation)
  mapping(bytes32 => address) public registryPublisher;
  /// registryId → all snapshots ever, in order
  mapping(bytes32 => SnapshotMeta[]) public history;
  /// (registryId, snapshotHash) → exists
  mapping(bytes32 => mapping(bytes32 => bool)) public snapshotExists;

  event RegistryCreated(bytes32 indexed registryId, address indexed publisher);
  event SnapshotPublished(bytes32 indexed registryId, bytes32 indexed snapshotHash, uint64 version);

  function createRegistry(bytes32 registryId) external {
    require(registryPublisher[registryId] == address(0), "already exists");
    registryPublisher[registryId] = msg.sender;
    emit RegistryCreated(registryId, msg.sender);
  }

  function publishSnapshot(bytes32 registryId, bytes32 snapshotHash) external {
    require(registryPublisher[registryId] == msg.sender, "not publisher");
    require(!snapshotExists[registryId][snapshotHash], "duplicate snapshot");
    uint64 version = uint64(history[registryId].length + 1);
    history[registryId].push(SnapshotMeta(snapshotHash, version, uint64(block.timestamp), msg.sender));
    snapshotExists[registryId][snapshotHash] = true;
    emit SnapshotPublished(registryId, snapshotHash, version);
  }
}
```

### Determinism contract

A `VerificationProgram` predicate that reads `registry(id)` MUST also
pin `snapshotHash`. The evaluator at attestation time loads exactly that
snapshot's entries from IPFS. Two evaluators running the same predicate
against the same job get the same answer — this is what makes the
oracle's verdict reproducible.

### Migration

`RateScheduleRegistry`, `ContributorNFT`, `CanonicalRegistry` library all
keep working. New domain registries (permits, approved lots, USDA grades)
land as `Registry` instances. No on-chain breaking changes.

---

## Primitive 4: `AttestationSet`

### Purpose

Generalized N-of-M signature primitive. Today's tier-3 multi-verifier
flow is hardcoded; promoting it lets any Capability declare "this job
needs M signatures from the role set R, and at least N of them must be
positive."

Used by `VerificationProgram` predicates of the form
`human_attestor(role='inspector', minScore≥4, quorum='2-of-3')`.

### Type

```typescript
// packages/spec/src/types/attestation.ts

export interface AttestationRole {
  /** Role identifier, e.g. "inspector", "qa-reviewer", "buyer". */
  roleId: string;
  /** Which addresses may attest in this role. Either an inline list or
   *  a Registry pointer. */
  signers:
    | { kind: "inline"; addresses: `0x${string}`[] }
    | { kind: "registry"; registryId: string; snapshotHash: `0x${string}` };
  /** N: minimum positive signatures required. */
  minPositive: number;
  /** M: total signers (cardinality of the signers set, capped). */
  total: number;
  /** Optional: per-attestation score must satisfy `score >= minScore`. */
  minScore?: number;
}

export interface Attestation {
  jobId: Id;
  /** sha256 of (jobId + attestor + score + comment + timestamp). */
  attestationHash: `0x${string}`;
  attestor: `0x${string}`;
  /** 0-100; meaning is role-defined. Can be null for thumbs-up-only. */
  score: number | null;
  comment?: string;
  /** Unix seconds. */
  timestamp: number;
  /** Attestor's signature over attestationHash. */
  signature: Signature;
}

export interface AttestationSet {
  jobId: Id;
  /** Roles required by the VerificationProgram. */
  roles: AttestationRole[];
  /** Submitted attestations, indexed by role. */
  byRole: Record<string, Attestation[]>;
  /** Computed: does this set satisfy all roles' (minPositive, minScore)? */
  satisfied: boolean;
}
```

### Three personas

**Electrician — workmanlike-quality role:**
```json
{
  "roleId": "inspector",
  "signers": { "kind": "registry", "registryId": "state-electrical-inspectors.ca", "snapshotHash": "0x..." },
  "minPositive": 1, "total": 1, "minScore": 4
}
```

**Lab tech — QA reviewer at tier 2:**
```json
{ "roleId": "qa-reviewer", "signers": { "kind": "registry", "registryId": "lab-qa.acmemed", "snapshotHash": "0x..." }, "minPositive": 1, "total": 1 }
```

**Lab tech — independent-reviewer panel at tier 3:**
```json
{ "roleId": "independent-reviewer", "signers": { "kind": "registry", "registryId": "fda-data-integrity-reviewers.v1", "snapshotHash": "0x..." }, "minPositive": 2, "total": 3 }
```

### On-chain anchor

Attestations are off-chain by default (signed messages). High-value cases
opt into on-chain commitment via a tiny contract:

```solidity
// packages/contracts/src/AttestationCommitment.sol
contract AttestationCommitment {
  mapping(bytes32 => address) public attestor;  // attestationHash → wallet
  mapping(bytes32 => uint256) public timestamp;
  event AttestationRecorded(bytes32 indexed attestationHash, address indexed attestor, uint256 jobId);
  function record(bytes32 attestationHash, uint256 jobId) external {
    require(attestor[attestationHash] == address(0));
    attestor[attestationHash] = msg.sender;
    timestamp[attestationHash] = block.timestamp;
    emit AttestationRecorded(attestationHash, msg.sender, jobId);
  }
}
```

Off-chain by default = cheap. On-chain when a buyer wants the audit
trail recorded. Predicate doesn't care — both produce the same
`Attestation` typed value.

### Migration

The current tier-3 multi-verifier wiring becomes a built-in
`AttestationRole` template (`{ roleId: "tier3-verifier", signers:
{ kind: "registry", registryId: "pcc-tier3-verifiers" }, minPositive:
2, total: 3 }`).

---

## Primitive 5: `VerificationProgram`

### Purpose

The load-bearing primitive. Deterministic predicate over (JobSpec,
EvidenceStream, WorkProduct, AttestationSet, Registry-via-snapshot)
that returns `pass` / `fail` / `pending`. Sealed in the Capability's
CSD, anchored on-chain by `programHash`. The oracle reads it,
evaluates it, refuses to attest on fail.

### The predicate language

A discriminated union of rule kinds. Mirrors the shape of `RateSegment`
in `packages/spec/src/types/rate-schedule.ts:167` so the codebase has
one expression-tree pattern, not two.

Designed for:

1. **Determinism** — no clock reads (all timestamps come from the
   bundle), no network calls (registries pin snapshots), no floats with
   ambiguous rounding (numbers are integers in known units).
2. **Evaluatability off-chain** — runs on Node, in TS, with no native
   deps beyond `@noble/hashes`.
3. **Compact** — fits in a small JSON, hashes cleanly, evaluates fast.

```typescript
// packages/spec/src/types/verification-program.ts

export interface EventRef {
  /** Match the FIRST event of this type, OR an indexed expression
   *  e.g. { eventType: "gps_ping", index: -1 } for the last one. */
  eventType: string;
  index?: number;  // -1 = last, undefined = first
}

export type VerificationRule =
  // ── Existence / counting ─────────────────────────────────────
  | {
      kind: "event-presence";
      eventType: string;
      atLeast?: number;
      atMost?: number;
    }
  // ── Numeric thresholds on payload fields ─────────────────────
  | {
      kind: "field-threshold";
      eventRef: EventRef;
      /** JSON pointer into payload, e.g. "/groundOhms". */
      path: string;
      op: "<" | "<=" | "=" | "!=" | ">=" | ">";
      value: number;
    }
  // ── Aggregate over a set of events ───────────────────────────
  | {
      kind: "aggregate-threshold";
      eventType: string;
      path: string;
      reduce: "min" | "max" | "sum" | "mean" | "count";
      op: "<" | "<=" | "=" | "!=" | ">=" | ">";
      value: number;
    }
  // ── Temporal: ordering + gap ─────────────────────────────────
  | {
      kind: "event-sequence";
      before: EventRef;
      after: EventRef;
      maxGapSeconds?: number;
      minGapSeconds?: number;
    }
  // ── Spatial: geofence ────────────────────────────────────────
  | {
      kind: "geofence";
      eventRef: EventRef;
      /** Path to {lat, lng} within payload; default "/". */
      pathToLocation?: string;
      lat: number;
      lng: number;
      radiusM: number;
    }
  // ── Two events stayed close to each other ────────────────────
  | {
      kind: "trace-coverage";
      a: EventRef;
      b: EventRef;
      pathA: string;
      pathB: string;
      epsilonM: number;
      minOverlapPct: number;
    }
  // ── Registry membership ──────────────────────────────────────
  | {
      kind: "registry-membership";
      eventRef: EventRef;
      path: string;
      registryId: string;
      snapshotHash: `0x${string}`;
    }
  // ── Photo authenticity primitive ─────────────────────────────
  | {
      kind: "photo-authentic";
      eventRef: EventRef;
      pHashTolerance: number;
      maxAgeSeconds: number;
      requireExif?: boolean;
      gpsConsistent?: boolean;
    }
  // ── WorkProduct gate ─────────────────────────────────────────
  | {
      kind: "work-product-required";
      productKind: "physical" | "digital" | "service" | "bilateral";
      /** Schema-validate details against this JSON Schema. */
      detailsSchema?: JSONSchema7;
    }
  // ── Human attestation gate ───────────────────────────────────
  | {
      kind: "human-attestation";
      role: AttestationRole;
      timeoutSeconds: number;
      /** What to do on timeout: refuse settlement, or escalate to
       *  DisputeResolver. */
      onTimeout: "fail" | "escalate";
    }
  // ── Logical composition ──────────────────────────────────────
  | { kind: "and"; children: VerificationRule[] }
  | { kind: "or"; children: VerificationRule[] }
  | { kind: "not"; child: VerificationRule };

export interface VerificationStage {
  stageId: string;
  predicate: VerificationRule;
  releaseBps: number;             // 0..10000; sums to 10000 across stages
  /** Wall clock after stage activation. */
  deadlineSeconds?: number;
  onTimeout: "refund" | "arbitrate" | "escalate-to-human";
  onFail: "refund" | "arbitrate";
}

export interface VerificationProgram {
  version: number;
  schemaHash: `0x${string}`;            // back-ref to WorkSchema
  stages: VerificationStage[];
  programHash: `0x${string}`;
  publishedAt: string;
}
```

### Canonical hash

```
programHash = sha256(canonical_json({
  version,
  schemaHash,
  stages: stages.map(canonicalize),
}))
```

### Evaluator semantics

Pure function with the signature:

```typescript
function evaluate(
  program: VerificationProgram,
  context: {
    jobSpec: JobSpec;
    events: EvidenceEvent[];                // sorted by timestamp
    workProduct: WorkProduct | null;        // null while job in progress
    attestations: AttestationSet;
    registries: Map<string, RegistrySnapshot>;  // pinned by hash
  }
): {
  stages: { stageId: string; verdict: "pass" | "fail" | "pending"; reasons: string[] }[];
  overallVerdict: "pass" | "fail" | "pending";
  releaseBps: number;
}
```

Properties:

- **Pure** — same inputs → same output, every time, on any machine.
- **Sandboxed** — no `Date.now()`, no network, no FS, no random.
- **Bounded** — each rule kind has O(events) or O(events²) max
  complexity (only `trace-coverage` is O(n²); cap input size).
- **Total** — every combination of inputs returns a defined verdict.
  Missing data returns `pending` for the relevant stage, never throws.

### Three personas — full predicate examples

#### Electrician — install GFCI in residential panel

```yaml
stages:
  - stageId: on-site-evidence
    releaseBps: 7000
    predicate:
      kind: and
      children:
        - kind: event-presence
          eventType: panel_photo_before
          atLeast: 1
        - kind: event-presence
          eventType: panel_photo_after
          atLeast: 1
        - kind: photo-authentic
          eventRef: { eventType: panel_photo_after }
          maxAgeSeconds: 7200
          requireExif: true
          gpsConsistent: true
        - kind: field-threshold
          eventRef: { eventType: gfci_trip_test }
          path: /tripCurrentMa
          op: <
          value: 6
        - kind: field-threshold
          eventRef: { eventType: gfci_trip_test }
          path: /passed
          op: =
          value: 1   # boolean true encoded as 1
        - kind: field-threshold
          eventRef: { eventType: multimeter_reading }
          path: /groundOhms
          op: <
          value: 1
        - kind: geofence
          eventRef: { eventType: panel_photo_after }
          lat: 37.86
          lng: -122.26
          radiusM: 100
        - kind: event-presence
          eventType: customer_signature
          atLeast: 1
        - kind: event-sequence
          before: { eventType: gfci_trip_test }
          after: { eventType: customer_signature }
          maxGapSeconds: 3600
        - kind: work-product-required
          productKind: service
    deadlineSeconds: 28800   # 8h after job start
    onFail: refund
    onTimeout: refund

  - stageId: permit-close
    releaseBps: 3000
    predicate:
      kind: and
      children:
        - kind: event-presence
          eventType: permit_filing
          atLeast: 1
        - kind: registry-membership
          eventRef: { eventType: permit_filing }
          path: /permitNumber
          registryId: permit-db.us.ca.contra-costa.v1
          snapshotHash: 0xLATEST_AT_ATTESTATION
        - kind: human-attestation
          role:
            roleId: inspector
            signers: { kind: registry, registryId: state-electrical-inspectors.ca, snapshotHash: 0x... }
            minPositive: 1
            total: 1
            minScore: 4
          timeoutSeconds: 2592000   # 30 days
          onTimeout: escalate
    deadlineSeconds: 2592000
    onFail: arbitrate
    onTimeout: escalate-to-human
```

70/30 split. Customer pays nothing if the on-site tests fail or the
permit is never closed; pays 70% on same-day evidence and 30% after the
inspector signs.

#### Uber-style driver — point-to-point ride

```yaml
stages:
  - stageId: dropoff-confirmed
    releaseBps: 10000
    predicate:
      kind: and
      children:
        - kind: event-presence
          eventType: pickup_confirm
          atLeast: 1
        - kind: event-presence
          eventType: dropoff_confirm
          atLeast: 1
        - kind: event-sequence
          before: { eventType: pickup_confirm }
          after: { eventType: dropoff_confirm }
        - kind: geofence
          eventRef: { eventType: dropoff_confirm }
          lat: 0   # filled in from JobSpec.params.dropoffLat
          lng: 0
          radiusM: 50
        - kind: trace-coverage
          a: { eventType: gps_ping }
          b: { eventType: rider_gps_attest }
          pathA: /
          pathB: /samples
          epsilonM: 10
          minOverlapPct: 50
        - kind: aggregate-threshold
          eventType: gps_ping
          path: /speedKph
          reduce: max
          op: <=
          value: 130   # below 130 km/h max ever
        - kind: work-product-required
          productKind: bilateral
    deadlineSeconds: 7200   # 2h
    onFail: arbitrate
    onTimeout: refund
```

100% on dropoff (single stage). The `trace-coverage` rule is the
"actually-in-the-same-car" check. Plus a 24h dispute window enforced by
the DisputeResolver primitive (separate from the predicate).

#### HPLC lab tech — quantitative assay run

```yaml
stages:
  - stageId: instrument-qc-pass
    releaseBps: 9000
    predicate:
      kind: and
      children:
        - kind: event-presence
          eventType: instrument_log_signed
          atLeast: 1
        - kind: event-presence
          eventType: qc_check_result
          atLeast: 1
        - kind: field-threshold
          eventRef: { eventType: qc_check_result }
          path: /resolution
          op: ">"
          value: 2.0
        - kind: field-threshold
          eventRef: { eventType: qc_check_result }
          path: /tailingFactor
          op: <
          value: 2.0
        - kind: field-threshold
          eventRef: { eventType: qc_check_result }
          path: /rsdPct
          op: <
          value: 2.0
        - kind: registry-membership
          eventRef: { eventType: reagent_use }
          path: /lotId
          registryId: fda.approved-lots.acn-grade.v3
          snapshotHash: 0x...
        - kind: registry-membership
          eventRef: { eventType: badge_swipe }
          path: /techId
          registryId: lab-tech-competency.acmemed
          snapshotHash: 0x...
        - kind: event-sequence
          before: { eventType: sample_loaded }
          after: { eventType: instrument_log_signed }
          maxGapSeconds: 86400   # extract → analyze ≤ 24h
        - kind: work-product-required
          productKind: digital
          detailsSchema: { properties: { format: { const: "lcms-mzml" }}}
    deadlineSeconds: 7200
    onFail: arbitrate
    onTimeout: refund

  - stageId: qa-review
    releaseBps: 1000
    predicate:
      kind: human-attestation
      role:
        roleId: qa-reviewer
        signers: { kind: registry, registryId: lab-qa.acmemed, snapshotHash: 0x... }
        minPositive: 1
        total: 1
      timeoutSeconds: 604800   # 7 days
      onTimeout: fail
    deadlineSeconds: 604800
    onFail: arbitrate
    onTimeout: arbitrate
```

90% on instrument data passing system suitability + reagent + tech +
chain-of-custody, 10% on QA reviewer signoff.

### On-chain anchor

```solidity
// packages/contracts/src/VerificationProgramRegistry.sol
contract VerificationProgramRegistry {
  mapping(bytes32 => address) public publishers;
  mapping(bytes32 => uint256) public publishedAt;
  event ProgramPublished(bytes32 indexed programHash, bytes32 indexed schemaHash, address publisher);
  function publish(bytes32 programHash, bytes32 schemaHash) external {
    require(publishers[programHash] == address(0), "already published");
    publishers[programHash] = msg.sender;
    publishedAt[programHash] = block.timestamp;
    emit ProgramPublished(programHash, schemaHash, msg.sender);
  }
}
```

`MilestoneEscrow.release()` is amended to consume `(programHash,
stageId, evaluatorSignature)`, where `evaluatorSignature` is signed by
the oracle. Oracle attestation includes the predicate verdict it
computed off-chain.

### Migration

Existing tier rules become a built-in `VerificationProgram` template
keyed by `tier`. New Capabilities can either reference one of the tier
templates or publish their own program. No on-chain breaks — the new
release path is additive.

---

## Primitive 6: `DisputeResolver`

### Purpose

Generalized escalation path when a `VerificationProgram` returns `fail`
or hits `onTimeout: arbitrate | escalate-to-human`. Today
`MilestoneEscrow.dispute()` exists but the arbiter is hardcoded to the
PCC oracle. Promoting it lets each Capability designate its own
arbiter — a multisig, a DAO, a court reference, or a chain of
escalation.

### Type

```typescript
// packages/spec/src/types/dispute-resolver.ts

export interface DisputeResolver {
  /** Unique identifier, e.g. "kleros.court-7", "pcc-default-arbiter". */
  resolverId: string;
  /** Arbiter type. */
  kind: "single-wallet" | "multisig" | "dao-vote" | "external-court" | "oracle-cascade";
  /** Wallet for single/multisig kinds. */
  arbiterAddress?: `0x${string}`;
  /** For multisig: required signatures (m-of-n). */
  threshold?: { m: number; n: number };
  /** For dao-vote: governance contract + proposal-window seconds. */
  governance?: { contract: `0x${string}`; minVoteSeconds: number };
  /** For external-court: reference to off-chain venue (jurisdiction code,
   *  contract clause CID). Settlement is paused until off-chain
   *  resolution + on-chain attestation. */
  externalCourt?: { jurisdictionCode: string; clauseCid: string };
  /** For oracle-cascade: ordered list of fallback oracles. */
  cascade?: { oracles: `0x${string}`[]; quorumPerStep: number };
  /** Max time arbiter has to rule before escalating up the cascade. */
  rulingWindowSeconds: number;
  /** Cost paid by losing party (bps of dispute amount). */
  costBps: number;
}
```

### Three personas

| Persona | Resolver |
|---|---|
| Electrician | `kind: single-wallet`, `arbiterAddress: pcc-default-arbiter`, `rulingWindow: 7d` (small claims) |
| Uber driver | `kind: oracle-cascade`, oracles = `[pcc-oracle, dispute-oracle, kleros]`, escalate after 24h each |
| Lab tech (FDA-regulated) | `kind: external-court`, jurisdictionCode: `US-FDA-21CFR11`, ruling window: 90d |
| AI fine-tuner | `kind: dao-vote`, governance: `pcc-swf`, min vote: 7 days (community judges) |
| 3D-print operator | `kind: multisig`, threshold: 2-of-3 from `[buyer, seller, pcc-default-arbiter]` |

### Migration

`MilestoneEscrow.dispute()` keeps its current signature. The PCC oracle
becomes the *default* `DisputeResolver` (single-wallet kind).
Capabilities can override at job-creation time. No on-chain breaks.

---

## Primitive 7: `JobSpec` (the bundle)

### Purpose

A `JobSpec` composes everything above into a single content-addressed,
sealed-before-execution unit. This is what gets escrowed against, what
gets signed by buyer + seller, what the oracle reads when deciding
release.

A `JobSpec` is to a `Capability` what a `Schedule` is to a
`ContributorNFT` — a content-addressed, sealed instance of the abstract
template.

### Type

```typescript
// packages/spec/src/types/job-spec.ts

export interface JobSpec {
  version: number;

  /** What the work is. */
  capabilityId: Id;
  schemaHash: `0x${string}`;        // pin: must match Capability's schema
  programHash: `0x${string}`;       // pin: VerificationProgram

  /** Buyer-side parameters validated against the WorkSchema. */
  params: Record<string, unknown>;

  /** Acceptance criteria override. NULL = use Capability's default
   *  VerificationProgram. NON-NULL = override programHash with a
   *  buyer-supplied program (must reference same schemaHash). */
  programOverride?: VerificationProgram;

  /** Constraints. */
  constraints: {
    deadlineSeconds: number;        // hard wall-clock after JobSpec sealed
    maxBudgetCents: number;
    requiredAssuranceTier: AssuranceTier;
    /** Optional sampling: this job is part of a 1-in-N audit batch. */
    sampling?: { selectorRegistryId: string; selectorSnapshotHash: `0x${string}` };
  };

  /** Provenance. */
  buyer: `0x${string}`;
  buyerSignature: Signature;
  seller: `0x${string}`;             // assigned operator/contributor
  /** May be null at creation; sealed when seller accepts. */
  sellerSignature: Signature | null;

  /** Composition: this job's WorkProduct may be input to another. */
  parentJobId?: Id;
  /** Multi-buyer: multiple escrows fund this one job. */
  cofundedBy?: { buyer: `0x${string}`; amountCents: number }[];
  /** Dispute path. */
  resolverId: string;

  /** Time of seal. */
  createdAt: string;

  /** Self-reference. */
  jobSpecHash: `0x${string}`;
}
```

### Canonical hash

```
jobSpecHash = sha256(canonical_json({
  version,
  capabilityId,
  schemaHash,
  programHash,
  params,
  programOverride: programOverride?.programHash ?? null,
  constraints,
  buyer, seller,
  parentJobId ?? null,
  cofundedBy: sortByKey("buyer", cofundedBy ?? []),
  resolverId,
}))

// Signatures sign the hash; not in the hash.
```

### Three personas — JobSpec at sealing

**Electrician — "install GFCI in master bath, customer A":**

```json
{
  "capabilityId": "cap-electrician-residential-ca-12345",
  "schemaHash": "0xELECTRICAL_SCHEMA_V1",
  "programHash": "0xGFCI_PROGRAM_V2",
  "params": { "address": "...", "circuitId": "MBR-1", "applianceLoadAmps": 15 },
  "constraints": { "deadlineSeconds": 28800, "maxBudgetCents": 22000, "requiredAssuranceTier": 1 },
  "buyer": "0xCustomer", "seller": "0xElectrician",
  "resolverId": "pcc-default-arbiter"
}
```

**Uber driver — "ride from 24 Sutter St to SFO":**

```json
{
  "capabilityId": "cap-rideshare-bay-area",
  "schemaHash": "0xRIDESHARE_SCHEMA_V1",
  "programHash": "0xPOINT_TO_POINT_PROGRAM_V1",
  "params": { "fromLat": 37.78, "fromLng": -122.40, "toLat": 37.62, "toLng": -122.38, "riderId": "did:rider123" },
  "constraints": { "deadlineSeconds": 3600, "maxBudgetCents": 5500, "requiredAssuranceTier": 1 },
  "buyer": "0xRider", "seller": "0xDriver",
  "resolverId": "rideshare-cascade"
}
```

**Lab tech — "HPLC analysis, sample SAMP-2026-04-30-0042":**

```json
{
  "capabilityId": "cap-hplc-acme-lab-acn-method",
  "schemaHash": "0xHPLC_SCHEMA_V2",
  "programHash": "0xQUANT_ASSAY_PROGRAM_V3",
  "params": { "sampleId": "SAMP-2026-04-30-0042", "method": "ACN-30min-iso", "expectedRT_min": 4.2 },
  "constraints": { "deadlineSeconds": 86400, "maxBudgetCents": 15000, "requiredAssuranceTier": 2 },
  "buyer": "0xPharmaSponsor", "seller": "0xLabTech",
  "parentJobId": "job-extract-2026-04-30-0042",
  "resolverId": "fda-21cfr11-court"
}
```

### On-chain anchor

`MilestoneEscrow` is extended:

```solidity
function createJob(bytes32 jobSpecHash, bytes32 programHash, ...) external returns (uint256 jobId) {
  // require programHash exists in VerificationProgramRegistry
  // require schemaHash exists in WorkSchemaRegistry (transitive via program)
  // bind jobId → jobSpecHash, set sellerAddress, escrow buyer's funds
  emit JobCreated(jobId, jobSpecHash, programHash);
}
```

### Migration

The existing escrow.create flow gets an additional optional
`jobSpecHash` argument. Old call sites work unchanged (default to a
synthesized `pcc-core-v1` JobSpec). New call sites pin a real hash.

---

# The six composition operators

These are how primitives combine into "arbitrary work." Each operator
is a wiring rule — implementable in `@pcc/workflow` as a CWM step type.

## 1. Sequence

`A.WorkProduct → B.JobSpec.params`

Lab tech extracts a sample → analyst quantifies it. The analyst's
JobSpec carries `parentJobId = extract.jobId` and reads
`extract.workProduct.cid` as input.

Already partially supported via `parentJobId` in JobSpec. New CWM step
type `step.consumes_workproduct` formalizes the wiring.

## 2. Aggregate

`[A1.EvidenceStream ... A100] → one VerificationProgram`

100 data labelers → consensus label. The aggregated
VerificationProgram is itself a JobSpec whose seller is the
"aggregator role" (could be an automated quorum or a DAO).

CWM step type: `step.aggregate_attestations { sourceJobs: [...] }`.
The aggregator's WorkProduct is `digital` with `details.consensusValue`
+ `details.disagreement` fields validated by the WorkSchema.

## 3. Conditional

`if VerificationProgram(A): B else C`

Inspection fails → rework path. Implemented as a CWM step
type `step.branch { condition: ProgramRef, ifPass: stepRef, ifFail: stepRef }`.
Determinism contract: `condition` is evaluated identically by the
oracle at branch time.

## 4. Time-bucket

A continuous service decomposes into N short JobSpecs with periodic
verification. Security guard 12h shift = 48 × 15min buckets, each its
own JobSpec with its own evidence (badge swipe, geofence ping, photo of
post).

CWM macro: `cwm.timeBucketed(serviceCapId, bucketDurationS,
totalDurationS) → JobSpec[]`. Each bucket pays out independently. A
missed bucket fails its predicate cleanly without nuking the whole
shift.

## 5. Multi-buyer

`BuyerSet → one escrow → one verification → split payout to seller(s)`

50 people split a delivery. Implemented via JobSpec's `cofundedBy`
field. Each cofunder funds their share into the same escrow contract;
`MilestoneEscrow` pro-rates refunds on dispute.

## 6. Multi-seller

Already shipped. `splitPayout` with a sealed `payoutMap` distributes
the seller-side proceeds across N contributors per their
`RateSchedule`s. This is what `feat/contributor-economics` already
does.

---

# Migration phases

| Phase | Scope | Risk | Breaks anything? |
|---|---|---|---|
| **0. Scaffolding** | Land all 7 types in `@pcc/spec` + canonical-hash functions + zero-arg evaluators. No on-chain. | Low | No |
| **1. WorkSchema + WorkProduct + Registry** | Three new contracts, no MilestoneEscrow change. Existing flows unaffected. | Low | No |
| **2. AttestationSet + VerificationProgram** | New contracts + new evaluator package + `MilestoneEscrow.releaseWithProgram()` additive method. | Medium | No (additive) |
| **3. DisputeResolver + JobSpec** | New `MilestoneEscrow.createJob(jobSpecHash, ...)`. Old `createMilestone` still works. | Medium | No |
| **4. Default-tier rewrites** | Existing tier-0/1/2/3 logic rewritten as canonical VerificationPrograms (built-ins). | Low | Behavior should be byte-identical. |
| **5. Capability extension** | `Capability` interface gains `schemaHash` + `programHash` + `defaultResolverId`. | Low | No (default to seeded values) |

Total scope: 5–6 weeks of implementer work spread across the three load-
bearing primitives (WorkSchema, WorkProduct, VerificationProgram) and
the three glue primitives (Registry, AttestationSet, DisputeResolver),
plus the JobSpec promotion that ties them together.

---

# Open questions

1. **Predicate language extensibility.** The discriminated-union design
   makes adding new rule kinds a `@pcc/spec` PR. Is that acceptable
   long-term, or should we ship a WASM evaluator path (capability runs
   user-supplied bytecode)? My instinct: start with the union, add
   WASM only if a real persona needs a rule kind we can't express.
2. **Registry write-rate.** Some registries update fast (active driver
   list, traffic conditions). Each update = on-chain transaction.
   Cost? We may need a "delta-snapshot" pattern (snapshotHash chains
   to predecessor) so the chain only stores deltas.
3. **WorkProduct storage durability.** `physical` work products
   currently rely on photo CIDs in IPFS. If the contributor stops
   pinning, the audit trail decays. Storacha's
   tier-2-and-above durability commitment covers this — extend it to
   physical-product photo bundles unconditionally.
4. **Schema versioning.** A Capability that bumps `schemaHash` mid-life
   could break in-flight jobs. Lock: jobs always evaluate against the
   `schemaHash` pinned in their JobSpec at seal time, regardless of
   subsequent Capability updates. (Already specified above; flagging
   for review.)
5. **Default DisputeResolver.** The PCC default arbiter is currently a
   single PCC oracle wallet. Should we ship a 2-of-3 multisig
   `[pcc-oracle, community-elected, governance-vote]` as the default
   at launch? My instinct: yes, before we have non-test-net volume.
6. **Privacy.** Predicates today read clear-text payloads. Tier-3
   already encrypts payloads via Lit Protocol. The evaluator needs a
   "decrypt-in-trusted-environment" mode for ZK paths. Out of scope
   for this RFC; flag for follow-up.

---

# Acceptance criteria

This RFC is "done" when:

- [ ] All 7 types compile in `@pcc/spec` with canonical-hash unit tests
      that lock the hash bytes (so any future change is detectable).
- [ ] The 3 personas above have working JobSpec + VerificationProgram
      examples in `packages/spec/src/__fixtures__/`, hash-stable.
- [ ] At least one persona (lab tech) can E2E: seal a JobSpec, run the
      evaluator off-chain, get a verdict, settle escrow against the
      verdict.
- [ ] All existing tier-0/1/2/3 jobs continue to release correctly,
      proven by re-running the existing test suite without regressions.
- [ ] Migration plan in this RFC is converted to a tracking issue
      with one PR per phase.

---

# References

- This branch: `feat/work-primitives` on `LamaSu/physical-capability-cloud`
- The 9 personas and primitive analysis that motivated this RFC: see
  conversation 2026-05-01 (this RFC's commit message links to it)
- The four hardcoded special-cases this RFC generalizes:
  - `packages/spec/src/types/evidence.ts` (closed `EvidenceEventType`)
  - `packages/spec/src/types/rate-schedule.ts` (existing discriminated-union pattern this RFC mirrors)
  - `packages/contracts/src/RateScheduleRegistry.sol` (template for `WorkSchemaRegistry`)
  - `packages/contracts/src/MilestoneEscrow.sol` (the surface that grows)
- Open-core boundary (relevant for which contracts are Apache-2.0):
  ADR-0001 on `arch/open-core-split` branch.

---

*End of RFC-001.*
