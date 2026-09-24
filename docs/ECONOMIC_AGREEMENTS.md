# Economic agreements v1: the spec for the economics compiler

**Status:** v1, normative. **Implementation:** `packages/spec/src/economics/` (`@pcc/spec`).
**What it is for:** an agent or a person writes down who is paid what, and under which rights, in plain economic terms. The compiler turns that into the exact per-unit payouts the V-next settlement escrow funds (`docs/VNEXT_SETTLEMENT_ABI.md`, escrow lane), or it refuses and says why.

**What it is not:** a second settlement system, a royalty ledger or a planner. It produces no money movement and no contract code. Its only money output is the `PayoutEntry[]` of each V-next settlement unit, and the escrow's own V-next compiler turns those into `UnitConfig[]`. Rights (what you may do) and payments (who is owed what) are two separate objects with two separate hashes, linked only by explicit reference.

Everything below is exact. Two implementations that follow this document produce the same bytes, the same hashes and the same refusals for the same input.

---

## 1. Conventions

- **Amount:** a non-negative integer number of base units of the agreement's currency, written as a decimal string of 1 to 78 digits with no sign, no leading zeros (`"0"` is allowed) and no exponent: `^(0|[1-9][0-9]{0,77})$`. Arithmetic is exact integer arithmetic (`bigint`). Amounts never pass through floating point.
- **bps:** an integer basis-point value, `0 <= bps <= 10000`. "Of 10000" means exactly `x * bps / 10000` with the rounding named where it is used.
- **Id:** 1 to 128 printable ASCII characters without spaces, `^[\x21-\x7E]{1,128}$`. This is exactly the accepted-plan compiler's node-id grammar, so a plan's node id is always a valid unit reference. All ids are ASCII, so string order is byte order in every language, and canonical JSON escapes only `"` and `\`. Ids are compared exactly (case-sensitive).
- **Address:** `0x` followed by 40 hex digits, in either case. It is normalized to lowercase before anything else. The zero address is never a valid payee.
- **Hash:** `0x` followed by 64 hex digits, in either case. It is normalized to lowercase before anything else (§6).
- **Integer:** a JSON number with no fractional part (`1.0` parses as `1` and is accepted). Unless a narrower range is stated, integer fields are within `0 .. 2^53 − 1`; `version` fields are `1 .. 10^9`.
- **Label:** human text shown to people. 1 to 200 characters, Unicode NFC, with no control characters (U+0000–U+001F, U+007F–U+009F) and no unpaired surrogates. Labels are hashed, so a relabelled agreement is a different agreement.
- **Time:** an integer count of unix seconds, `0 .. 2^53 − 1`.
- **Unknown fields are rejected.** Every object is closed. A field this document does not define is a schema error, never ignored.
- **Order-free input.** Input arrays are sets. The compiler sorts them canonically (§6), so the order an agent happened to emit never changes a hash or a payout.
- **Bounds and uniqueness** are part of the schema. Every array's length limit is written next to it below. These arrays must not repeat an entry, or the input fails the schema: `appliesTo.units`, `grants.fieldsOfUse`, `grants.regions`, `use.modifies`, the `requirementId`s of one license, and the `party`s of one payee `distribution`. Duplicate ids elsewhere (parties, units, splits, clauses, licenses, and the component refs and measure keys of one unit) are structure refusals (`DUPLICATE_ID`, §3).

## 2. The agreement

```
EconomicAgreementV1 {
  schema:       "pcc.economic-agreement.v1"
  agreementId:  Id
  version:      integer >= 1              // a changed agreement is a new version
  supersedes:   Hash | null               // agreementHash of the version this replaces
  asOf:         Time                      // the moment rights validity and the offer deadline are judged
  currency:     { code: /^[A-Z0-9]{2,12}$/, decimals: integer 0..36 }
  payer:        Id                        // a party; receives refunds
  parties:      Party[]    (1..64)
  units:        Unit[]     (1..256)
  splits:       Split[]    (0..64)
  clauses:      Clause[]   (1..128)
  licenses:     License[]  (0..64)
  use:          IntendedUse
  fee:          { feeBps: integer 0..1000, feeRecipient: Address | null }
  terms:        { acceptBy: Time | null, changePolicy: "new-version-required" }
}
```

`fee` is the protocol fee of the V-next escrow. The server sets it. The agreement carries it because the payer accepts it: it is inside every funded unit. If `feeBps > 0`, `feeRecipient` is required. If `feeBps == 0`, it must be `null`.

### 2.1 Party

```
Party { partyId: Id, label: Label, kind: "person" | "organization" | "guild" | "treasury" | "agent" | "protocol", payTo: Address | null }
```

`payTo: null` means the party's payout address is not known. Compiling any payment to such a party is refused (`UNRESOLVED_PARTY`). It is never paid to a placeholder.

### 2.2 Unit

A unit is one V-next settlement unit: an amount the payer funds that is released on its own evidence, or refunded on its own failure.

```
Unit {
  unitRef:    Id                                       // composition's node/step identity
  label:      Label
  gross:      Amount                                   // G, funded by the payer
  components: { ref: Id, uses: Amount }[] (0..64)      // what the accepted plan runs in this unit; uses >= 1
  measures:   { key: Id, value: Amount }[] (0..64)     // named quantities, e.g. pages
}
```

`5 <= gross <= 2^128 - 1` (the escrow's `MIN_BONDABLE_GROSS` and `uint128` bounds).

### 2.3 Split

A split divides an amount among members by integer weights.

```
Split { splitId: Id, label: Label, members: SplitMember[] (1..32) }
SplitMember { to: { party: Id } | { split: Id }, weight: integer 1..1000000, role: Role | null, subject: Id | null }
```

A member's `role` / `subject`, when not null, replace the ones inherited from the paying clause (for example, dataset contributors inside a model author's share). Within one split, no two members may have the same `to`. Splits must not form a cycle. A split's **depth** is 1 plus the largest depth among the splits it pays into, and no split may be deeper than 8, whether or not any clause pays into it.

### 2.4 Clause

A clause is one payment fact.

```
Clause {
  clauseId:     Id
  label:        Label
  role:         Role
  to:           { party: Id } | { split: Id }
  subject:      Id | null                     // what the payment is for: a component, kit, IP, method
  appliesTo:    { units: Id[] (1..256) } | { usingComponent: Id } | { oncePerJobUsing: Id } | { allUnits: true }
  underLicense: { licenseId: Id, version: integer >= 1 } | null
  rule:         one of the rules below
}
```

`Role` is one of the 11 canonical contributor roles in `@pcc/spec` `CONTRIBUTOR_ROLES`: `operator`, `verifier`, `insurer`, `integrator`, `protocol-author`, `model-author`, `dataset-contributor`, `backend-author`, `curator`, `assembler`, `network-treasury`.

**`appliesTo` selects the units a clause pays in.** `units` names them. `allUnits` is every unit. `usingComponent: R` is every unit whose `components` contains `R`. `oncePerJobUsing: R` is only the first such unit in `unitRef` order, for a fee owed once per agreement. The name predates agreements that span several V-next jobs; "once" means once for the whole agreement. That selector is how **participation** is expressed: a clause that applies only where a component actually runs is owed only in the units that run it, and each such unit pays it only if that unit is released. A declared contributor whose component runs nowhere in the job is owed nothing. The compiler reports it as not eligible, not as a payment of zero.

**Rules.** Each rule is evaluated separately in every unit the clause applies to.

| `rule.kind` | Fields | Amount in one unit |
|---|---|---|
| `fixed` | `amount: Amount` | `amount` |
| `per_use` | `rate: Amount`, `per: { component: Id } \| { measure: Id }`, `cap: Amount \| null` | `rate × q`, where `q` is the unit's `uses` of that component (0 if absent) or the unit's measure (`UNKNOWN_MEASURE` if the unit has no such measure). Then `min(·, cap)` when `cap` is set. |
| `pass_through` | `cost: Amount`, `markupBps: bps`, `costRef: Id \| null` | `cost + floor(cost × markupBps / 10000)`. `costRef` names the quote the cost came from. |
| `percent` | `bps: bps`, `of: "gross" \| "net"`, `min: Amount \| null`, `max: Amount \| null`, `rateSource: RateSource \| null` | Proportional share of the base (§4.3), then clamped to `[min, max]`. |
| `residual` | (none) | Whatever of the unit's net is left after every other clause (§4.4). |
| `metered` | `rate: Amount`, `meter: Id` | **Refused** (`ECONOMICS_UNDECIDED_OD4`). Metering across jobs is an open operator decision. |
| `downstream` | `bps: bps`, `horizon: Id` | **Refused** (`ECONOMICS_UNDECIDED_OD4`). Revenue participation in future deals is an open operator decision. |

If `min` and `max` are both set, `min <= max`. A `percent` rule with `bps = 0` and no `min` is refused as meaningless (`SCHEMA_INVALID`).

`RateSource` records where a royalty rate came from:

```
RateSource { scheduleHash: Hash, evaluatedAt: Time, context: { jobValueCents: integer >= 0, jobsPerDay: integer >= 0, captureClass: "CC0".."CC5" | null } }
```

The clause's `bps` **is** the accepted rate. The schedule is where the offer came from, not a live input. The compiler never looks up a "current" schedule, so a later schedule version cannot change an accepted deal. When the caller supplies the schedule body, the compiler checks it: `computeScheduleHash(body)` must equal `scheduleHash` (`SCHEDULE_HASH_MISMATCH`), and `evaluateRateSchedule(body, {now: evaluatedAt, ...context}).bps` must equal `bps` (`RATE_PIN_MISMATCH`). Without the body, the result marks the rate as unverified.

### 2.5 License

A license is a rights fact. It says what a licensee may do with one component, and which payments the licensor requires in return.

```
License {
  licenseId:  Id
  version:    integer >= 1
  label:      Label
  licensor:   Id                         // a party
  subject:    Id                         // the component (unit.components[].ref) it covers
  class:      "open" | "permissive" | "share-alike" | "noncommercial" | "proprietary"
  shareAlikeTag: Id | null               // required iff class == "share-alike"
  grants:     { commercialUse: bool, compose: bool, resell: bool, modify: bool, fieldsOfUse: Id[] (1..32), regions: Id[] (1..32) }
  requires:   { attribution: bool, payments: PaymentRequirement[] (0..8) }
  validFrom:  Time | null
  validUntil: Time | null
  authority:  "self-asserted" | "counterparty-accepted" | "registry-anchored" | "externally-attested"
}
PaymentRequirement {
  requirementId: Id
  role:          Role
  per:           "using-unit" | "job"          // met by appliesTo {usingComponent: subject} or {oncePerJobUsing: subject}
  payee:         { licensor: true } | { distribution: { party: Id, weight: 1..1000000, role: Role | null, subject: Id | null }[] (1..32) }
  rule:          fixed | per_use | pass_through | percent | percent_by_schedule
}
```

A `distribution` payee is the licensor's own declared division of the payment, for example a model author and the datasets it was trained on. It is flat, so a composer cannot re-route a required royalty through a split of its own invention.

`percent_by_schedule` is `{ kind, scheduleHash: Hash, of: "gross" | "net", min: Amount | null, max: Amount | null }`. A job-dependent royalty cannot be required as a fixed number, so the license names the schedule instead. The requirement is met by a `percent` clause whose `rateSource.scheduleHash` is that schedule and whose `of`, `min` and `max` are equal. The compile must also be given the schedule body so the pinned bps can be checked; otherwise it refuses (`RATE_UNVERIFIED`), because an unchecked pin would let a composer pay less than the schedule asks.

For every other rule kind, "equal" means equal in every field, including a `percent` rule's `rateSource` (normally `null` in a requirement). `requirementId`s are unique within a license, and `party`s are unique within one `distribution` (schema). Every `distribution` party must be a party of the agreement (`UNKNOWN_REFERENCE`).

`fieldsOfUse` and `regions` hold ids or `"*"`, meaning any. `authority` says how the licensor's right to license the subject is established. It is set by the server resolver, not by the licensor: `registry-anchored` means the licensor holds the subject's registered identity (ContributorNFT / IP registration with the published schedule), and `externally-attested` means an off-platform attestation.

### 2.6 Intended use

```
IntendedUse {
  commercial: bool           // the deal is paid work
  composite:  bool           // a composer assembles components into one capability
  resell:     bool           // the composite is sold on as a capability
  fieldOfUse: Id             // e.g. the capability type
  region:     Id
  modifies:   Id[] (0..64)   // components the composition modifies (derivatives)
  outbound:   { class: License.class, shareAlikeTag: Id | null }   // the terms the composite is offered under
}
```

As for a license, `outbound.shareAlikeTag` is required exactly when `outbound.class` is `share-alike` (schema).

## 3. Validation and refusals

A compile returns exactly one of:

- `{ ok: true, ... }` (§5), or
- `{ ok: false, refusals: Refusal[] }` with at least one refusal.

There is no partial result.

**A refusal is identified by `(code, path)`.** `Refusal = { code, message, path: string[] }`. The `message` is informative: implementations may word it differently, and it never makes two refusals distinct. Two refusals with the same code and path are one refusal. The list is sorted by phase, then code (byte order), then path. Paths compare element by element in byte order, and a path sorts before any longer path it is a prefix of.

**Phases** run in order. A phase runs only if every earlier phase produced no refusal. Within a phase, every check runs and every refusal is reported, except where an order is stated below.

1. **Schema** (`SCHEMA_INVALID`): closed objects, field types, ranges, grammar, bounds and uniqueness (§1). Only the code is normative here. An input that fails the schema yields one or more `SCHEMA_INVALID` refusals and no other code. Their paths are JSON paths of failing fields (object keys, and array indices in decimal), but which failing fields are listed is implementation-defined.
2. **Structure** (below).
3. **Rights** (§4.1).
4. **Money** (§4.2–§4.6).

**Path grammar.** In the table below, `L` is a license written `licenseId@version` (for example `lic-kit@2`), and a payee key is `party:<id>` or `split:<id>`.

| Code | Phase | Path(s) |
|---|---|---|
| `DUPLICATE_ID` | structure | `["party"\|"unit"\|"split"\|"clause", id]`, `["license", L]`, `["unit", unitRef, "component", ref]`, `["unit", unitRef, "measure", key]` |
| `DUPLICATE_LICENSE_SUBJECT` | structure | `["license-subject", subject]` |
| `UNKNOWN_REFERENCE` | structure | `["payer", id]`; `["clause", clauseId, "to", payeeKey]`; `["clause", clauseId, "appliesTo", unitRef]`; `["clause", clauseId, "underLicense", L]`; `["license", L, "licensor", partyId]`; `["license", L, "requirement", requirementId, "party", partyId]`; `["split", splitId, "member", payeeKey]`; `["use", "modifies", ref]` |
| `DUPLICATE_SPLIT_MEMBER` | structure | `["split", splitId, payeeKey]` |
| `SPLIT_CYCLE` | structure | `["split", splitId]` for **every** split that can reach itself through its members |
| `SPLIT_TOO_DEEP` | structure | `["split", splitId]` for every split deeper than 8 (§2.3); checked only when no split is in a cycle |
| `FEE_INVALID` | structure | At most one, the first that applies: `feeBps > 0` with no recipient gives `["fee"]`; `feeBps == 0` with a recipient gives `["fee"]`; a recipient that is the zero address or a forbidden recipient gives `["fee", "forbidden-recipient"]` |
| `OFFER_EXPIRED` | structure | `["terms", "acceptBy"]` |
| `ECONOMICS_UNDECIDED_OD4` | structure | `["clause", clauseId]` |
| `INVALID_BOUNDS` | structure | `["clause", clauseId]`, `["license", L, "requirement", requirementId]` |
| `SCHEDULE_HASH_MISMATCH` | structure | `["clause", clauseId, "rateSource"]`: only for a clause whose schedule body was supplied, and it takes precedence over `RATE_PIN_MISMATCH` for that clause |
| `RATE_PIN_MISMATCH` | structure | `["clause", clauseId, "rateSource"]` |
| `RIGHTS_UNKNOWN` | rights | `["component", ref]` |
| `LICENSE_NOT_IN_FORCE`, `AUTHORITY_BELOW_FLOOR` | rights | `["component", ref, L]` |
| `RIGHTS_INCOMPATIBLE` | rights | `["component", ref, L, condition]` |
| `LICENSE_PAYMENT_MISSING`, `RATE_UNVERIFIED` | rights | `["license", L, requirementId]` |
| `LICENSE_PAYMENT_UNMATCHED` | rights | `["clause", clauseId, L]` |
| `GROSS_OUT_OF_RANGE` | money | `["unit", unitRef]` |
| `UNKNOWN_MEASURE` | money | `["unit", unitRef, "clause", clauseId, key]` |
| `OVER_ALLOCATED` | money | `["unit", unitRef, "percent-gross"\|"percent-net"]` (§4.3), `["unit", unitRef]` (§4.4) |
| `MULTIPLE_RESIDUALS`, `UNALLOCATED_REMAINDER`, `TOO_MANY_LEGS` | money | `["unit", unitRef]` |
| `UNRESOLVED_PARTY`, `FORBIDDEN_RECIPIENT` | money | `["unit", unitRef, "party", partyId]` |

**Structure checks** (all run):
- `DUPLICATE_ID`, `DUPLICATE_LICENSE_SUBJECT` (two licenses for one subject).
- `UNKNOWN_REFERENCE` for every id that points at nothing.
- `DUPLICATE_SPLIT_MEMBER`, `SPLIT_CYCLE`, `SPLIT_TOO_DEEP`.
- `FEE_INVALID` (§2 fee rules and the forbidden-recipient list).
- `OFFER_EXPIRED` (`terms.acceptBy` set and `asOf > acceptBy`).
- `ECONOMICS_UNDECIDED_OD4` for every `metered` or `downstream` clause.
- `INVALID_BOUNDS` (`min > max`).
- `SCHEDULE_HASH_MISMATCH` / `RATE_PIN_MISMATCH` (§2.4).

**Money checks, per unit, in this order.** A unit stops at the first stage that refuses. Every unit is checked, and the refusals of all units are reported together.
1. `GROSS_OUT_OF_RANGE`.
2. Clause amounts: `UNKNOWN_MEASURE` for each `per_use` clause whose measure is missing, and `OVER_ALLOCATED` for each percent base over 10000 bps (§4.3).
3. `OVER_ALLOCATED` for the whole unit (§4.4).
4. `MULTIPLE_RESIDUALS`.
5. `UNALLOCATED_REMAINDER`.
6. `UNRESOLVED_PARTY` / `FORBIDDEN_RECIPIENT` for every positive allocation. A party with no `payTo` is `UNRESOLVED_PARTY`; otherwise a forbidden address is `FORBIDDEN_RECIPIENT`.
7. `TOO_MANY_LEGS`.

## 4. The compile

### 4.1 Rights (before any money)

For every distinct component `R` used by any unit, once (not once per unit):

1. The license with `subject == R`. If there is none, the refusal is `RIGHTS_UNKNOWN`. **Unknown rights never mean permission.** A component that really is free to use needs an explicit `open` license.
2. `validFrom <= asOf` (when set) and `asOf < validUntil` (when set), else `LICENSE_NOT_IN_FORCE`.
3. `authority` must be at least the compile's authority floor (default `counterparty-accepted`; the order is the order listed in §2.5), else `AUTHORITY_BELOW_FLOOR`.
4. Compatibility with `use`. Each failed condition is one `RIGHTS_INCOMPATIBLE` refusal whose last path element names the condition:
   - `commercial-use`: `use.commercial` and (`!grants.commercialUse` or `class == "noncommercial"`)
   - `compose`: `use.composite` and `!grants.compose`
   - `resell`: `use.resell` and `!grants.resell`
   - `modify`: `R` is in `use.modifies` and `!grants.modify`
   - `field-of-use`: `fieldsOfUse` contains neither `"*"` nor `use.fieldOfUse`
   - `region`: `regions` contains neither `"*"` nor `use.region`
   - `share-alike`: `class == "share-alike"`, (`R` is in `use.modifies` or `use.resell`), and not (`use.outbound.class == "share-alike"` and `use.outbound.shareAlikeTag == shareAlikeTag`)
5. Required payments. Each `PaymentRequirement` must be met by at least one clause with all of the following:
   - `underLicense == {licenseId, version}`
   - `to == {party: licensor}` when the payee is `licensor`, or `to == {split: S}` where `S`'s members are exactly the declared distribution (every member a party; same parties, weights, roles and subjects)
   - `role` equal
   - `rule` equal field for field, or, for `percent_by_schedule`, the percent match described in §2.5
   - `appliesTo == {usingComponent: subject}` for `per: "using-unit"`, or `{oncePerJobUsing: subject}` for `per: "job"`

   If no clause meets it, the refusal is `LICENSE_PAYMENT_MISSING`. If one does and the rule is `percent_by_schedule` but the schedule body was not supplied, the refusal is `RATE_UNVERIFIED`.

In addition:

- Any clause whose `underLicense` names a license but matches none of that license's requirements is refused (`LICENSE_PAYMENT_UNMATCHED`). A payment is never attributed to a license that did not ask for it.
- Any `usingComponent` or `per.component` reference to a component used by no unit is not a refusal. It is simply owed nowhere.

`use.modifies` entries must be components used by some unit (`UNKNOWN_REFERENCE`).

### 4.2 Per unit: gross, fee, net

For each unit: `G = gross`, `F = floor(G × feeBps / 10000)`, `N = G − F`. This is exactly the escrow's rule. `G` must be within the §2.2 bounds, else `GROSS_OUT_OF_RANGE`. `N` is then always positive (`G >= 5` and `feeBps <= 1000` leave at least 90% of `G`), and it is the amount the unit's payouts must total, exactly.

The clauses that apply to the unit are its **applicable clauses** (§2.4 `appliesTo`).

### 4.3 Proportional clauses

Take every applicable `percent` clause and group them by `of` ("gross" with base `G`, "net" with base `N`). In each group:

1. If `Σ bps > 10000`, the refusal is `OVER_ALLOCATED` with path `["unit", unitRef, "percent-gross"]` or `["unit", unitRef, "percent-net"]`.
2. The claimants are the group's clauses plus one **rest** claimant with weight `10000 − Σ bps`.
3. **Largest remainder, exactly:** every claimant gets `floor(base × w / 10000)`. The leftover `L = base − Σ floors` (always `< number of claimants`) is given one unit at a time to the claimants with the largest `(base × w) mod 10000`. Ties go to clauses in ascending `clauseId` order, and the rest claimant loses every tie.
4. Then each clause is clamped: `max(amount, min)` when `min` is set, then `min(amount, max)` when `max` is set.

The rest claimant is never paid. What it holds simply stays in the unit's net for the residual.

This is the only rounding in the system. Every proportional amount is within one base unit of its exact share. Parties whose shares add up to a whole base (for example, 50/50 of net) receive exactly that base, with no remainder to place.

### 4.4 Everything else, and the residual

In the unit:

- `fixed`, `per_use` and `pass_through` amounts per §2.4.
- `S = Σ` of every non-residual applicable clause's amount (all of §4.3 after clamping, plus this list).
- `rest = N − S`. If `rest < 0`, the refusal is `OVER_ALLOCATED` with path `["unit", unitRef]`.
- At most one `residual` clause may apply to a unit (`MULTIPLE_RESIDUALS`).
- If `rest > 0` and no residual clause applies, the refusal is `UNALLOCATED_REMAINDER`. **Nobody receives money by default.** The agreement must name who gets what is left.
- A residual clause's amount is `rest`, which may be 0.

### 4.5 Paying into splits

A clause amount `a` paid `to: {party: P}` is one allocation to `P`. Paid `to: {split: S}`, it is divided among `S`'s members by largest remainder over their weights. Every member gets `floor(a × w / W)` with `W = Σ weights`, and the leftover goes one unit at a time to the largest `(a × w) mod W`, with ties to members in ascending order of their target written `party:<id>` or `split:<id>`. A member that is a split divides its part the same way, recursively. Each allocation records its **path**: the clause id followed by every split id it passed through.

An allocation's role and subject are the clause's, replaced by the nearest split member on its path that sets them.

### 4.6 Legs

1. Every allocation with a positive amount is a payment. Its party must have a `payTo` (`UNRESOLVED_PARTY`), and that address must be neither the zero address nor in the compile's forbidden-recipient list (the escrow clone, the settlement token and the factory, which the server supplies), else `FORBIDDEN_RECIPIENT`. The same list applies to `fee.feeRecipient` (`FEE_INVALID`).
2. **Leg identity** is `(payTo, role, subject)`. Allocations with the same identity are one leg: their amounts add, and the leg keeps every contributing `(partyId, path, amount)` as its attribution. Two different identities stay two legs, even at the same address. The same wallet paid as operator and as assembler is two legs, so each is separately visible in the escrow's per-leg claims.
3. Zero-amount legs are not payouts (the escrow forbids them). They are listed in the result's `zeroLegs`.
4. If a unit has more than 16 legs, legs with the same `payTo` are merged (**compaction**). The merged leg's identity is `(payTo, roles joined "+", subjects joined "+")`, both sorted and de-duplicated, and it keeps all attribution. If there are still more than 16, the refusal is `TOO_MANY_LEGS`.
5. Legs are ordered by `payTo`, then role, then subject (subject `null` sorts as the empty string). A compacted leg is the only leg at its `payTo`, so it needs no further key.
6. The unit ends with 1 to 16 legs, each `> 0`, summing to exactly `N`. This holds by construction: every clause amount is fully apportioned, and whatever is left goes to the residual or is refused. The compiler asserts it and never emits a unit that breaks it. An agreement may span several V-next jobs (one per operator). Grouping its units into jobs, and the escrow's per-job limits of 16 units and 256 legs, belong to the accepted-plan compiler, which refuses a plan that does not fit.

Refusals from different units are all reported, not only the first unit's.

## 5. The result

```
CompiledEconomicsV1 {
  ok: true
  schema: "pcc.compiled-economics.v1"
  agreementId, version
  agreementHash, economicTermsHash, rightsTermsHash       // §6
  currency, payer, asOf
  fee: { feeBps, feeRecipient }
  units: [{                                  // same order as the canonical units (§6)
    unitRef, gross, fee, net
    payouts: [{ recipient: Address, amount: Amount }]     // the V-next PayoutEntry[], in leg order
    legs: [{ recipient, amount, partyIds: Id[], roles: Role[], subjects: Id[], compacted: bool,
             attribution: [{ clauseId, partyId, path: Id[], amount }] }]
    zeroLegs: [{ partyId, role, subject, path }]
    clauses: [{ clauseId, amount }]           // every applicable clause's amount in this unit, residual included
  }]
  notEligible: [{ clauseId, reason: "component-not-used" }]    // clauses owed in no unit
  rights: [{ licenseId, version, subject, licensor, class, attributionRequired, authority, compatible: true }]
  rates: [{ clauseId, scheduleHash, bps, verified: bool }]
  totals: { gross, fee, net, byParty: [{ partyId, amount }] }
}
```

`payouts` is exactly what the escrow's V-next compiler places in each unit's `UnitConfig.payouts`, with `g = gross`, `feeBps` and `feeRecipient` from `fee`, so `f` and `n` follow. Composition supplies each unit's `milestoneIndex`, `stepId`, tier, `reclaimAt` and composition fields, and fixes the unit order.

**Orders in the result** (all byte order; paths element by element as in §3):
- `units` by `unitRef`, and legs as §4.6.
- A leg's `partyIds`, `roles` and `subjects` sorted and without repeats.
- A leg's `attribution` by `clauseId`, then path, then `partyId`.
- A unit's `zeroLegs` by `partyId`, then role, then subject (`null` as the empty string), then path.
- A unit's `clauses` by `clauseId`.
- `notEligible` and `rates` by `clauseId`.
- `rights` by `(licenseId, version)`.
- `totals.byParty` by `partyId`.

## 6. Canonical form and hashes

**Normalization.** Addresses and hashes (`supersedes`, every `scheduleHash`) are lowercased. Arrays are sorted:

- `parties` by `partyId`
- `units` by `unitRef`
- `splits` by `splitId`
- `clauses` by `clauseId`
- `licenses` by `(licenseId, version)`
- `unit.components` by `ref`
- `unit.measures` by `key`
- `split.members` by their target key
- `license.requires.payments` by `requirementId`
- each requirement's `payee.distribution` by `party`
- `appliesTo.units`, `grants.fieldsOfUse`, `grants.regions` and `use.modifies` as ascending sets (duplicates are a schema error)

**Canonical JSON** is `@pcc/spec` `canonicalize`: object keys sorted, no whitespace, strings as JSON strings, `null` kept. All amounts are strings. All other numbers are small integers.

**Hash** `H(domain, value) = "0x" + hex(sha256(utf8(domain) ‖ 0x0a ‖ utf8(canonicalJSON(value))))`.

- `rightsTermsHash = H("PCC:rights-terms:v1", { licenses, use })`. This covers the rights facts only.
- `economicTermsHash = H("PCC:economic-terms:v1", { currency, payer, parties, units, splits, clauses, fee })`. This covers the payment facts only.
- `agreementHash = H("PCC:economic-agreement:v1", { agreementId, version, supersedes, asOf, terms, economicTermsHash, rightsTermsHash })`.

A change to any rights fact moves `rightsTermsHash` and leaves `economicTermsHash` alone. A change to any payment fact does the reverse. Both move `agreementHash`. Accepting an agreement means binding `agreementHash`, or both terms hashes, into the funded deal (composition's accepted-plan compiler owns where). A version changed after acceptance therefore no longer matches what was accepted: `verifyAcceptedAgreement(accepted, agreement)`, given the three accepted hashes, answers `AGREEMENT_HASH_MISMATCH` with `changed` listing what moved: `rights`, `economics`, or `envelope` when neither terms hash moved but the agreement's own fields did.

## 7. Simulation

`simulateEconomics(agreement, scenarios)` runs the same compile over variants of an agreement, then applies outcomes. It uses no other arithmetic.

```
Scenario { scenarioId: Id, label: Label, grossOverrides: { unitRef: Id, gross: Amount }[], usesOverrides: { unitRef: Id, ref: Id, uses: Amount }[], outcomes: { unitRef: Id, outcome: "released" | "refunded" | "pending" }[] }
```

A unit's default outcome is `released`. A **released** unit pays its legs and its fee. A **refunded** unit returns its `G` to the payer, with no fee and no legs; that is the escrow's refund. A **pending** unit's `G` stays reserved. The per-scenario result is either the compile's refusal (a variant can be unfundable, for example when a lower price no longer covers the fixed costs) or, per party, the amounts `paid`, `refunded` and `reserved`, and the `fee` paid. Simulation results are predictions, never state.

## 8. Adapters (existing PCC primitives in, the same IR out)

- **`CompositionManifest`** (`@pcc/spec`): entries grouped by `(role, ipId, rateScheduleHash)` become one `percent` clause of `net` at the schedule's pinned bps. The clause pays to a split of the group's contributors. Their weights are their `groupBps`, which must then total exactly 10000, or they are equal when every entry omits it; a group that mixes the two is refused. Co-authors therefore share one role allocation and are never each paid the full rate.
- **`TrainingManifest`**: a `model-author` allocation pays to a split of the model author (weight `10000 − passThroughBps`) and the training inputs (weight `passThroughBps`). The training inputs are the datasets by `weightBps` and, when a base model is declared, the base model with an explicit `baseModelWeightBps`, recursively. `passThroughBps` and `baseModelWeightBps` are explicit inputs, and are refused when missing. The expansion subdivides one allocation and never adds to it.
- **`ContributionGraphV1`** (optional, for open ecosystems): each node keeps a `retain` weight and passes shares along **accepted** edges. An edge that is not accepted, or that leads to a node whose component does not run in the unit when participation is required, is dropped and its weight returns to its source node's retain. The graph becomes splits and one clause, and the rest is the same compile. It is a template, never a second engine.

## 9. What is out of scope in v1

Cross-job metering and downstream revenue participation (refused, OD-4), currency conversion, tax, and any rule an agent writes as code. New rule kinds are added to this document and to the compiler together, with golden vectors, under a new domain version.
