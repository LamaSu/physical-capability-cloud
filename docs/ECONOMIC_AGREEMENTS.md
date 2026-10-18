# Economic agreements v1: the spec for the economics compiler

**Status:** v1, normative. **Implementation:** `packages/spec/src/economics/` (`@pcc/spec`).
**What it is for:** an agent or a person writes down who is paid what, and under which rights, in plain economic terms. The compiler turns that into the exact per-unit payouts the V-next settlement escrow funds (`docs/VNEXT_SETTLEMENT_ABI.md`, escrow lane), or it refuses and says why.

**What it is not:** a second settlement system, a royalty ledger or a planner. It produces no money movement and no contract code. Its only money output is the `PayoutEntry[]` of each V-next settlement unit, and the escrow's own V-next compiler turns those into `UnitConfig[]`. Rights (what you may do) and payments (who is owed what) are two separate objects with two separate hashes, linked only by explicit reference.

Everything below is exact. Two implementations that follow this document produce the same bytes, the same hashes and the same refusals for the same input and options.

The reference implementation runs on the server (Node). Product surfaces show results the server computed; they do not import the compiler.

---

## 1. Conventions

- **Amount:** a non-negative integer number of base units of the agreement's currency, written as a decimal string of 1 to 78 digits with no sign, no leading zeros (`"0"` is allowed) and no exponent: `^(0|[1-9][0-9]{0,77})$`. Arithmetic is exact integer arithmetic (`bigint`). Amounts never pass through floating point.
- **bps:** an integer basis-point value, `0 <= bps <= 10000`. "Of 10000" means exactly `x * bps / 10000` with the rounding named where it is used.
- **Id:** 1 to 128 printable ASCII characters without spaces, `^[\x21-\x7E]{1,128}$`. This is exactly the accepted-plan compiler's node-id grammar, so a plan's node id is always a valid unit reference. All ids are ASCII, so string order is byte order in every language, and canonical JSON escapes only `"` and `\`. Ids are compared exactly (case-sensitive).
- **Address:** `0x` followed by 40 hex digits, in either case. It is normalized to lowercase before anything else. The zero address is never a valid payee.
- **Hash:** `0x` followed by 64 hex digits, in either case. It is normalized to lowercase before anything else (§6).
- **Integer:** a JSON number with no fractional part (`1.0` parses as `1` and is accepted). Unless a narrower range is stated, integer fields are within `0 .. 2^53 − 1`; `version` fields are `1 .. 10^9`.
- **Label:** human text shown to people. 1 to 200 Unicode code points, in NFC, with no control characters (U+0000–U+001F, U+007F–U+009F) and no unpaired surrogates. Labels are hashed, so a relabelled agreement is a different agreement.
- **Time:** an integer count of unix seconds, `0 .. 2^53 − 1`.
- **Unknown fields are rejected.** Every object is closed. A field this document does not define is a schema error, never ignored.
- **Every field is required.** A field whose type includes `null` must be present, with the value `null`. Only the options (§3) have fields that may be left out.
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

`fee` is the protocol fee of the V-next escrow. The server sets it. The agreement carries it because the payer accepts it: it is inside every funded unit. If `feeBps > 0`, `feeRecipient` is required. If `feeBps == 0`, it must be `null`. A compile given the server's fee (option `fee`, §3) refuses an agreement that states any other fee (`FEE_INVALID`), so an author cannot set a larger "fee" that shrinks every percentage of net.

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
  appliesTo:    { units: Id[] (1..256) } | { usingComponent: Id } | { oncePerAgreementUsing: Id } | { allUnits: true }
  underLicense: { licenseId: Id, version: integer >= 1 } | null
  rule:         one of the rules below
}
```

`Role` is one of the 11 canonical contributor roles in `@pcc/spec` `CONTRIBUTOR_ROLES`: `operator`, `verifier`, `insurer`, `integrator`, `protocol-author`, `model-author`, `dataset-contributor`, `backend-author`, `curator`, `assembler`, `network-treasury`.

**`appliesTo` selects the units a clause pays in.** `units` names them. A name that is not a unit of the agreement is refused (`UNKNOWN_REFERENCE`) and selects nothing, so a clause that names only unknown units pays in no unit. `allUnits` is every unit. `usingComponent: R` is every unit whose `components` contains `R`. `oncePerAgreementUsing: R` is also every unit that uses `R`, but the clause's amount is owed once for the whole agreement, not once per unit. It is **spread** over those units in proportion to their gross: largest remainder (§4.3) of the amount over the units' `gross` as weights, with ties to the lower `unitRef`. The weights are each `gross` as written, including one that is refused as `GROSS_OUT_OF_RANGE`; if every weight is 0, every share is 0. Only a `fixed` or `pass_through` rule has an agreement-level amount, so only those rules may be used with it (schema). Each unit pays its share only if that unit is released. The licensor is therefore paid for exactly the part of the deal that ran, and naming a cheap unit first cannot concentrate the fee on it.

These selectors are how **participation** is expressed. A clause that applies only where a component actually runs is owed only in the units that run it, and each such unit pays it only if that unit is released. A declared contributor whose component runs nowhere in the agreement is owed nothing. The compiler reports it as not eligible, not as a payment of zero.

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

The clause's `bps` **is** the accepted rate. The schedule is where the offer came from, not a live input. The compiler never looks up a "current" schedule, so a later schedule version cannot change an accepted deal.

**Pinned rates are checked at the deal's own facts, never at facts the composer recorded.** `evaluatedAt` and `context` are the quoting side's record: they are hashed, but they are not trusted. When the server supplies the schedule body (option `schedules`, §3), the compiler evaluates it for every unit `u` the clause applies to, at:

- `now` = the agreement's `asOf`;
- the unit's value in cents, `floor(gross(u) × 100 / 10^decimals)`;
- `jobsPerDay` and `captureClass` from the server's option `rateFacts` (each `null` when not supplied).

The pinned `bps` must equal every such evaluation, or the refusal is `RATE_PIN_MISMATCH`. One clause can therefore pin one rate only for units that share it.

**v1 limitation.** A license's `percent_by_schedule` requirement is met only by a clause that applies to every unit using the subject (§4.1 step 5). So when those units fall in different bands of a value-dependent schedule, no clause can meet it, and the agreement is refused rather than underpaid. The refusal is `RATE_PIN_MISMATCH` for one clause, or `LICENSE_PAYMENT_MISSING` and `LICENSE_PAYMENT_UNMATCHED` for per-band clauses. Such deals need one agreement per band.

**Exact evaluation.** Evaluation picks the first segment whose `[startTime, endTime)` contains `now` (`endTime: null` runs forever). With no such segment the rate is 0 bps. Rounding is round-half-up, as `Math.round` does for non-negative values, computed exactly in integers:

| Segment | Rate |
|---|---|
| `constant`, `step` | `bps` |
| `linear-decay` | `floor((2·num + span) / (2·span))`, with `span = endTime − startTime`, `elapsed = now − startTime`, `num = startBps·span + (endBps − startBps)·elapsed` |
| `piecewise-value` | `bpsLow` if the unit's value in cents `< thresholdCents`, else `bpsHigh` |
| `capture-class-indexed` | `byClass[captureClass]` if the server supplied a class the segment lists, else `default` |
| `adoption-indexed` | `capBps` if `jobsPerDay <= 0`. Otherwise `max(floorBps, min(capBps, r))`, where `r = floor((m + 1) / 2)`, `m = isqrt(floor(4p² / (q²·jobsPerDay)))`, and `p / q` is `scale` as an exact binary fraction. **Unverifiable** if the server supplied no `jobsPerDay`. |
| `exponential-decay` | `endBps` if `startBps <= endBps`. Otherwise **unverifiable**: e^x has no exact value to round. |

Every rate is then clamped to `0..10000`.

Whether an evaluation is exact depends only on the segment in force at `asOf` and on `rateFacts`, and both are the same for every unit of a clause. A clause's rate is therefore exact in all its units or in none, so `RATE_PIN_MISMATCH` and `RATE_UNVERIFIED` never both apply to one clause.

A pin is **verified** when the clause pays in at least one unit, the body was supplied, and every evaluation was exact and equal. A clause that pays in no unit is never evaluated. Its pin is not verified, even when the body was supplied, because nothing was compared. It is not refused either: it pays nothing. **A clause that names a rate source and pays in at least one unit must be verified**, whether or not a license requires it. If the body is missing, or any unit's segment is unverifiable, the refusal is `RATE_UNVERIFIED` at `["clause", clauseId, "rateSource"]`. An unverifiable rate never produces a payout; a composer who does not claim a schedule's rate simply omits `rateSource`.

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
  per:           "using-unit" | "agreement"    // met by appliesTo {usingComponent: subject} or {oncePerAgreementUsing: subject}
  payee:         { licensor: true } | { distribution: { party: Id, weight: 1..1000000, role: Role | null, subject: Id | null }[] (1..32) }
  rule:          fixed | per_use | pass_through | percent | percent_by_schedule
}
```

A `distribution` payee is the licensor's own declared division of the payment, for example a model author and the datasets it was trained on. It is flat, so a composer cannot re-route a required royalty through a split of its own invention.

`percent_by_schedule` is `{ kind, scheduleHash: Hash, of: "gross" | "net", min: Amount | null, max: Amount | null }`. A job-dependent royalty cannot be required as a fixed number, so the license names the schedule instead. The requirement is met by a `percent` clause whose `rateSource.scheduleHash` is that schedule and whose `of`, `min` and `max` are equal. The compile must also be given the schedule body so the pinned bps can be checked; otherwise it refuses (`RATE_UNVERIFIED`), because an unchecked pin would let a composer pay less than the schedule asks.

For every other rule kind, "equal" means equal in every field. A license states its percent directly, so a required `percent` rule's `rateSource` must be `null` (schema). A `per: "agreement"` requirement needs a `fixed` or `pass_through` rule (schema), as its clause does (§2.4). `requirementId`s are unique within a license, and `party`s are unique within one `distribution` (schema). Every `distribution` party must be a party of the agreement (`UNKNOWN_REFERENCE`).

`fieldsOfUse` and `regions` hold ids or `"*"`, meaning any. `authority` says how the licensor's right to license the subject is established. It is set by the server resolver, not by the licensor: `registry-anchored` means the licensor holds the subject's registered identity (ContributorNFT / IP registration with the published schedule), and `externally-attested` means an off-platform attestation.

### 2.6 Intended use

```
IntendedUse {
  commercial: true           // every compiled deal is paid work
  composite:  bool           // a composer assembles components into one capability
  resell:     bool           // the composite is sold on as a capability
  fieldOfUse: Id             // e.g. the capability type
  region:     Id
  modifies:   Id[] (0..64)   // components the composition modifies (derivatives)
  outbound:   { class: License.class, shareAlikeTag: Id | null }   // the terms the composite is offered under
}
```

As for a license, `outbound.shareAlikeTag` is required exactly when `outbound.class` is `share-alike` (schema). `commercial` is always `true` (schema): every unit the compiler accepts pays out a gross of at least 5, so every deal it compiles is paid work. A `false` could only exist to dodge a noncommercial license.

## 3. Validation and refusals

**Reading the input.** The input and the options are untrusted. Before any check, each is copied into plain JSON data, and every property is read exactly once. All later work uses the copy, so nothing the caller does can make the compiler see two different values of one field. The copy is refused (`SCHEMA_INVALID`) if the value:
- is anything other than null, a boolean, a number, a string, an array or a plain object (for example a function, a bigint, a Date or a class instance);
- has an accessor property (an enumerable member, or any array element), a symbol key or a hole in an array;
- contains itself;
- nests too deep. The input itself is at depth 0, and a value inside an object or array at depth `d` is at depth `d + 1`. An object or array at depth 64 or more is refused; a null, boolean, number or string at depth 64 is not;
- has an array with more than 65,536 entries;
- has more than 1,000,000 values in all. Each null, boolean, number, string, array and object counts as one value, including the input itself. Object keys are not values.

Only an object's own enumerable properties are read, as `JSON.stringify` does. A `toJSON` method is never called, and a `__proto__` key is an ordinary key, which the closed schema then refuses. No input and no options make the compiler throw.

**Options.** Everything that is the server's to say comes in the options, never in the agreement. All fields are optional:

| Option | Meaning |
|---|---|
| `forbiddenRecipients: Address[] (0..64)` | The escrow clone, the settlement token and the factory. The zero address is always forbidden. |
| `authorityFloor: Authority` | The weakest license authority accepted; the default is `counterparty-accepted`. |
| `schedules: RateSchedule[] (0..64)` | Sealed rate-schedule bodies. Each must hash to its own `scheduleHash`. A body is trusted only for the hash it actually has, so listing order never matters. Only `version` and `segments` enter the hash. Unknown fields are dropped before hashing, at every depth: in the body and inside each segment. The registry does the same when it publishes, so an unknown field changes neither the hash nor the rate. The one closed object is a `capture-class-indexed` segment's `byClass`; a key there other than `CC0`..`CC5` is refused. The known fields outside the hash are still checked: `scheduleHash` and `publishedAt` (a string) are required, and `notes`, when present, is a string. Each body must also be **well formed**:<br>1. No segment follows an open-ended one (`endTime: null`).<br>2. Each segment starts at or after the previous segment's `endTime`.<br>3. A set `endTime` is not before its `startTime`.<br>4. A `linear-decay` segment's `endTime` is after its `startTime`.<br>5. Its numbers are in §1's ranges: `version` is `1 .. 10^9`; every integer field (times, bps, `thresholdCents`) is `0 .. 2^53 − 1`; `scale` and `decayPerSecond` are numbers greater than 0 and at most `2^53 − 1`, and need not be integers. A larger integer does not mean the same number to every JSON reader (JavaScript rounds it), and `1e400` reads as infinity. Every double from `2^53` up is such an integer, so the canonical form has no form for it (evidence profile v1 §1, D5) and such a body has no hash. The compiler refuses a body it cannot hash (`SCHEMA_INVALID`, path `["options"]`) and never throws. The registry refuses to seal such a body, with the same rules. |
| `fee: { feeBps: integer 0..1000, feeRecipient: Address \| null }` | The fee the server charges. It obeys §2's own rule: a recipient exactly when `feeBps > 0`. |
| `rateFacts: { jobsPerDay?: integer >= 0 \| null, captureClass?: "CC0".."CC5" \| null }` | Facts some schedules depend on (§2.4). Each field may be omitted, which means `null`. |

The options are one object, and `null` is not an object. Options that break these rules, including an unknown field or a misspelled authority, are refused as `SCHEMA_INVALID` with path `["options"]`. They are never ignored. `forbiddenRecipients` is a set: a repeat changes nothing.

A compile returns exactly one of:

- `{ ok: true, ... }` (§5), or
- `{ ok: false, refusals: Refusal[] }` with at least one refusal.

There is no partial result.

**A refusal is identified by `(code, path)`.** `Refusal = { code, message, path: string[] }`. The `message` is informative: implementations may word it differently, and it never makes two refusals distinct. Two refusals with the same code and path are one refusal. The list is sorted by phase, then code (byte order), then path. Paths compare element by element in byte order, and a path sorts before any longer path it is a prefix of.

**Phases** run in order. A phase runs only if every earlier phase produced no refusal. Within a phase, every check runs and every refusal is reported, except where an order is stated below.

1. **Schema** (`SCHEMA_INVALID`): the input copy, closed objects, field types, ranges, grammar, bounds and uniqueness (§1), and the options. An input that fails yields exactly one refusal, `SCHEMA_INVALID` with path `[]`. Options that fail yield exactly one, `SCHEMA_INVALID` with path `["options"]`. Both can occur together. The message lists the failing fields, and is informative.
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
| `SPLIT_CYCLE` | structure | `["split", splitId]` for **every** split that can reach itself through its members; checked only when no id is duplicated |
| `SPLIT_TOO_DEEP` | structure | `["split", splitId]` for every split deeper than 8 (§2.3); checked only when no id is duplicated and no split is in a cycle |
| `FEE_INVALID` | structure | At most one, the first that applies:<br>1. `feeBps > 0` with no recipient gives `["fee"]`.<br>2. `feeBps == 0` with a recipient gives `["fee"]`.<br>3. A recipient that is the zero address or a forbidden recipient gives `["fee", "forbidden-recipient"]`.<br>4. A fee other than the server's (option `fee`) gives `["fee", "server-fee"]`. |
| `OFFER_EXPIRED` | structure | `["terms", "acceptBy"]` |
| `ECONOMICS_UNDECIDED_OD4` | structure | `["clause", clauseId]` |
| `INVALID_BOUNDS` | structure | `["clause", clauseId]`, `["license", L, "requirement", requirementId]` |
| `RATE_PIN_MISMATCH` | structure | `["clause", clauseId, "rateSource"]`: one per clause, whichever units disagree; checked only when no id is duplicated |
| `RATE_UNVERIFIED` | structure | `["clause", clauseId, "rateSource"]`: a clause that names a rate source and pays in some unit, whose body is missing or whose segment cannot be evaluated exactly (§2.4). It never applies to a clause that has `RATE_PIN_MISMATCH` (§2.4), and it is checked only when no id is duplicated. |
| `TOO_MANY_ALLOCATIONS` | structure | `[]` (the agreement as a whole); checked only when no id is duplicated and no split is in a cycle |
| `RIGHTS_UNKNOWN` | rights | `["component", ref]` |
| `LICENSE_NOT_IN_FORCE`, `AUTHORITY_BELOW_FLOOR` | rights | `["component", ref, L]` |
| `RIGHTS_INCOMPATIBLE` | rights | `["component", ref, L, condition]` |
| `LICENSE_PAYMENT_MISSING` | rights | `["license", L, requirementId]` |
| `LICENSE_PAYMENT_UNMATCHED` | rights | `["clause", clauseId, L]` |
| `GROSS_OUT_OF_RANGE` | money | `["unit", unitRef]` |
| `UNKNOWN_MEASURE` | money | `["unit", unitRef, "clause", clauseId, key]` |
| `OVER_ALLOCATED` | money | `["unit", unitRef, "percent-gross"\|"percent-net"]` (§4.3), `["unit", unitRef]` (§4.4) |
| `MULTIPLE_RESIDUALS`, `UNALLOCATED_REMAINDER`, `TOO_MANY_LEGS` | money | `["unit", unitRef]` |
| `UNRESOLVED_PARTY`, `FORBIDDEN_RECIPIENT` | money | `["unit", unitRef, "party", partyId]` |

**Structure checks** (all run, except as follows). When any `DUPLICATE_ID` is reported, the checks that resolve ids are skipped: `SPLIT_CYCLE`, `SPLIT_TOO_DEEP`, `TOO_MANY_ALLOCATIONS`, `RATE_PIN_MISMATCH` and `RATE_UNVERIFIED`. Which object a duplicated id means is undefined, and their result would otherwise depend on the input's order.
- `DUPLICATE_ID`, `DUPLICATE_LICENSE_SUBJECT` (two licenses for one subject).
- `UNKNOWN_REFERENCE` for every id that points at nothing.
- `DUPLICATE_SPLIT_MEMBER`, `SPLIT_CYCLE`, `SPLIT_TOO_DEEP`.
- `TOO_MANY_ALLOCATIONS`, counted before anything is expanded. An **allocation** is one clause amount reaching one party along one path through splits (§4.5).
  - Where `paths(P)` counts the paths from a payee: a party, or a split id that names no split, counts as 1; a split counts as the sum of `paths` over its members.
  - The count is `Σ` over units of `Σ` over the unit's applicable clauses of `paths(clause.to)`.
  - The refusal is when the count exceeds **65,536**.
  - Shared splits make the count multiply per level. That is why it is bounded: without the bound, a 30 KB agreement could demand billions of allocations.
- `FEE_INVALID` (§2 fee rules, the forbidden-recipient list, and the server's fee).
- `OFFER_EXPIRED` (`terms.acceptBy` set and `asOf > acceptBy`).
- `ECONOMICS_UNDECIDED_OD4` for every `metered` or `downstream` clause.
- `INVALID_BOUNDS` (`min > max`).
- `RATE_PIN_MISMATCH` and `RATE_UNVERIFIED` (§2.4).

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
5. Required payments. **Requirements and the clauses attributed to the license are paired one to one.** Two identical requirements need two clauses, and one clause never meets two requirements.

   Each requirement has a **key**:
   - the payee: `{party: licensor}`, or the declared `distribution` (sorted by party);
   - `role` and `per`;
   - the rule: for `percent_by_schedule`, its `scheduleHash`, `of`, `min` and `max`; otherwise the rule itself.

   A clause with `underLicense == {licenseId, version}` has a key built the same way, from:
   - the payee: `to: {party: P}` gives `{party: P}`; `to: {split: S}` gives `S`'s members as a distribution, when every member is a party;
   - `role`;
   - `per`: `"using-unit"` when `appliesTo` is `{usingComponent: subject}`, and `"agreement"` when it is `{oncePerAgreementUsing: subject}`;
   - the rule: a `percent` rule with a `rateSource` gives that source's `scheduleHash` with its `of`, `min` and `max`; otherwise the rule itself.

   The clause has no key when:
   - its `subject` is not the license's `subject` (a required payment is about the licensed component);
   - its `appliesTo` is neither of the two forms above;
   - or its split has a member that is a split.

   Within each requirement key, sort the requirements by `requirementId` and the clauses by `clauseId`, and pair the i-th requirement with the i-th clause. A requirement left without a clause is `LICENSE_PAYMENT_MISSING`. (A `percent_by_schedule` requirement's clause names a rate source, so an unverified pin has already been refused in the structure phase, §2.4.)

In addition, for every license, used or not:

- A clause attributed to it that has no key, has a key no requirement has, or is left over after pairing is refused (`LICENSE_PAYMENT_UNMATCHED`). A payment is never attributed to a license that did not ask for it, and a requirement is never paid twice under its name.
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

- `fixed`, `per_use` and `pass_through` amounts per §2.4. For a `oncePerAgreementUsing` clause, the amount in this unit is the unit's share of the spread (§2.4).
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
  rates: [{ clauseId, scheduleHash, bps, verified: bool }]           // verified: §2.4
  totals: { gross, fee, net, byParty: [{ partyId, amount }] }
}
```

`payouts` is exactly what the escrow's V-next compiler places in each unit's `UnitConfig.payouts`, with `g = gross`, `feeBps` and `feeRecipient` from `fee`, so `f` and `n` follow. Composition supplies each unit's `milestoneIndex`, `stepId`, tier, `reclaimAt` and composition fields, and fixes the unit order.

**Orders in the result.** Strings compare in byte order and version numbers numerically; paths compare element by element as in §3:
- `units` by `unitRef`, and legs as §4.6.
- A leg's `partyIds`, `roles` and `subjects` sorted and without repeats.
- A leg's `attribution` by `clauseId`, then path, then `partyId`.
- A unit's `zeroLegs` by `partyId`, then role, then subject (`null` as the empty string), then path.
- A unit's `clauses` by `clauseId`.
- `notEligible` and `rates` by `clauseId`.
- `rights` by `(licenseId, version)`.
- `totals.byParty` by `partyId`.

**Membership:**
- A leg's `attribution` lists its positive allocations. Zero allocations appear only in `zeroLegs`.
- `rights` lists the licenses of the components some unit uses.
- `totals.byParty` lists the parties paid a positive total.
- In a successful result, a rate shows `verified: true` exactly when its clause pays in some unit. Such a pin was checked, since anything else was refused. The pin of a clause that pays in no unit was never compared with its schedule (§2.4).

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

**Canonical JSON** is `@pcc/spec` `canonicalize`: object keys sorted, no whitespace, strings as JSON strings, `null` kept. All amounts are strings. All other numbers in an agreement are integers below 2^53, written in decimal with no exponent (`-0` is written `0`).

A rate-schedule body (§3) is hashed in the same canonical form, and it has two fields that are not integers, `scale` and `decayPerSecond`. Every number in a schedule body is written as ECMAScript's `Number.prototype.toString` writes it. That is the shortest decimal that reads back as the same double. A number of magnitude `10^−6` to `2^53 − 1` is written with no exponent (`0.000001`, `100.5`, `9007199254740991`). A number of smaller magnitude, other than 0, is written in exponent form (`1e-7`, `1.5e-9`). `0` and `-0` are written `0`. A number of magnitude `2^53` or more has no canonical form (§3, rule 5). So `1e-9` is written `1e-9`, never `1e-09`.

A string is written exactly as ECMAScript `JSON.stringify` writes it:
- `"` is written `\"` and `\` is written `\\`;
- U+0008, U+0009, U+000A, U+000C and U+000D are written `\b`, `\t`, `\n`, `\f` and `\r`, and every other character below U+0020 is written `\u00xx` in lowercase hex;
- an unpaired surrogate is written `\udxxx` in lowercase hex;
- every other character is written as itself, and the whole text is encoded as UTF-8.

A valid agreement's ids are printable ASCII, and its labels exclude control characters and unpaired surrogates. So in practice only `"` and `\` are ever escaped, and non-ASCII label text appears as its raw UTF-8 bytes.

**Hash** `H(domain, value) = "0x" + hex(sha256(utf8(domain) ‖ 0x0a ‖ utf8(canonicalJSON(value))))`.

- `rightsTermsHash = H("PCC:rights-terms:v1", { licenses, use })`. This covers the rights facts only.
- `economicTermsHash = H("PCC:economic-terms:v1", { currency, payer, parties, units, splits, clauses, fee })`. This covers the payment facts only.
- `agreementHash = H("PCC:economic-agreement:v1", { agreementId, version, supersedes, asOf, terms, economicTermsHash, rightsTermsHash })`.

A change to any rights fact moves `rightsTermsHash` and leaves `economicTermsHash` alone. A change to any payment fact does the reverse. Both move `agreementHash`. **Accepting an agreement means binding `agreementHash`** into the funded deal (composition's accepted-plan compiler owns where). The two terms hashes do not cover the envelope (`asOf`, `version`, `supersedes`, `terms`), and `asOf` decides which licenses are in force and which rate a schedule gives. They are carried beside `agreementHash` only so that a mismatch can say which half moved. A version changed after acceptance therefore no longer matches what was accepted: `verifyAcceptedAgreement(accepted, agreement)`, given the three accepted hashes, answers `AGREEMENT_HASH_MISMATCH` with `changed` listing what moved: `rights`, `economics`, or `envelope` when neither terms hash moved but the agreement's own fields did.

## 7. Simulation

`simulateEconomics(agreement, scenarios)` runs the same compile over variants of an agreement, then applies outcomes. It uses no other arithmetic.

```
Scenario { scenarioId: Id, label: Label, grossOverrides: { unitRef: Id, gross: Amount }[], usesOverrides: { unitRef: Id, ref: Id, uses: Amount }[], outcomes: { unitRef: Id, outcome: "released" | "refunded" | "pending" }[] }
```

Limits (schema):
- at most 64 scenarios;
- per scenario, at most 256 `grossOverrides`, 1024 `usesOverrides` and 256 `outcomes`;
- no unit is overridden or given an outcome twice, and no `(unitRef, ref)` pair is overridden twice. A repeat is refused rather than resolved by order.

A malformed scenario is refused on its own (`SCHEMA_INVALID`, path `["scenario"]`). A `scenarios` value that is not such a list yields the single result `scenarios`.

A unit's default outcome is `released`. A **released** unit pays its legs and its fee. A **refunded** unit returns its `G` to the payer, with no fee and no legs; that is the escrow's refund. A **pending** unit's `G` stays reserved. The per-scenario result is either the compile's refusal (a variant can be unfundable, for example when a lower price no longer covers the fixed costs) or, per party, the amounts `paid`, `refunded` and `reserved`, and the `fee` paid. Simulation results are predictions, never state.

## 8. Adapters (existing PCC primitives in, the same IR out)

- **`CompositionManifest`** (`@pcc/spec`): entries grouped by `(role, ipId, rateScheduleHash)` become one `percent` clause of `net` at the schedule's pinned bps.
  - The clause pays to a split of the group's contributors. Their weights are their `groupBps`, which must then total exactly 10000, or they are equal when every entry omits it. A group that mixes the two is refused.
  - A co-author whose `groupBps` is 0 holds no share and is not a member. A group left with one member pays that member directly.
  - Co-authors therefore share one role allocation and are never each paid the full rate.
  - The `ipId` becomes the clause's subject, so it must be an Id (`INVALID_ID`).
  - Contributor addresses are looked up among the table's own keys only (`UNKNOWN_CONTRIBUTOR`).
- **`TrainingManifest`**: a `model-author` allocation pays to a split of the model author (weight `10000 − passThroughBps`) and the training inputs (weight `passThroughBps`).
  - The training inputs are the datasets by `weightBps` and, when a base model is declared, the base model with an explicit `baseModel.weightBps`, recursively.
  - `passThroughBps` and `baseModel.weightBps` are explicit inputs, and are refused when missing.
  - The manifest must pass its own schema, so its dataset weights total exactly 10000 (`MANIFEST_INVALID`). Its model and dataset ids must be Ids (`INVALID_ID`).
  - The expansion subdivides one allocation and never adds to it.
- **The calls.** The adapters are exported from `@pcc/spec/economics` (economics/adapters.ts). A result is `{ ok: true, ... }` or `{ ok: false, refusals }`, and a refusal is `{ code, message, path }`.
  - `clausesFromCompositionManifest(input)` returns `{ ok: true, clauses, splits }` on success. `input` is a `ManifestAdapterInput`: `{ manifest, pinnedRates, partyByAddress, appliesTo, idPrefix }`, and every member is required. `manifest` is a `CompositionManifest` (`CompositionManifestSchema`, from `@pcc/spec`). `pinnedRates` lists `{ bps, rateSource }`: the rate each schedule gave when the deal was quoted, with its `RateSource` (§2.4). A group whose schedule has no pinned rate is `RATE_NOT_PINNED`. `partyByAddress` maps a lowercase contributor address to a party id. `appliesTo` is a clause's `appliesTo` (§2.4).
  - `splitsFromTrainingManifest(input, idPrefix)` returns `{ ok: true, splits, rootSplitId }` on success. `input` is a `LineageInput`, one level of the lineage: `{ manifest, modelAuthorParty, passThroughBps, datasetParty, baseModel }`. Every member but `baseModel` is required. `manifest` is a `TrainingManifest` (`TrainingManifestSchema`, from `@pcc/spec`). `modelAuthorParty` is the model author's party id, and `datasetParty` maps a dataset id to a party id. `baseModel` is `{ weightBps, lineage }`, where `lineage` is the base model's own level. It is present exactly when the manifest declares a base model.
  - `splitsFromContributionGraph(graphInput, usedComponents, idPrefix)` returns `{ ok: true, splits, rootPayee }` on success, where `rootPayee` is `{ split }`. `graphInput` is a contribution graph (`ContributionGraph`, checked by `ContributionGraphSchema`, both from `@pcc/spec/economics`; its `schema` is `"pcc.contribution-graph.v1"`). `usedComponents` is the `Set` of component refs that run in the unit: a real `Set` that is `instanceof Set`, not a proxy of one and not one from another realm. A member that is not a string is ignored.
  - `idPrefix` is a string. Every clause and split id an adapter makes is `<idPrefix>/<suffix>`: `c0`, `s0` and so on for a composition, `m0`, `m0i`, `m0d` and so on for a training lineage, and the `nodeId` for a graph. One that is not an Id is refused (`ID_TOO_LONG`).
- **Every adapter reads its input once**, into a plain copy (`snapshotJson` with `canonical`, economics/input.ts). Everything after that, the schema, the hash and the payout, uses that one copy, so the hash and the payout always see the same manifest.
  - The copy is §3's (Reading the input), with two changes: an undefined object member is dropped, as `canonicalize` drops it, and a number the canonical form cannot write is refused (one that is not finite, or of magnitude `2^53` or more). A refused copy is `INPUT_INVALID`, or `GRAPH_INVALID` for a contribution graph. It is the same with or without D5 in `canonicalize`.
  - It reads object members and array elements from their own descriptors, so it never calls their getters. On a proxy it calls only `getPrototypeOf`, `ownKeys` and `getOwnPropertyDescriptor` for an object, and `get` (for `length`) and `getOwnPropertyDescriptor` for an array. It copies what those traps report, so a proxy is refused when what they report would be refused.
  - Composition: after the copy, `input` is checked against one schema, and only its first issue is reported. An `input` that is not a plain object is `INPUT_INVALID`. Otherwise a `manifest` that is missing or fails `CompositionManifestSchema` comes first, and is `MANIFEST_INVALID`. Then a member that is missing or not of its kind is `INPUT_INVALID`: `pinnedRates` must list `{ bps, rateSource }` with a bps (§1) and a `RateSource`, `partyByAddress` must be a plain object, `appliesTo` one of §2.4's forms, and `idPrefix` a string.
  - Training: `idPrefix` is checked before the copy, and one that is not a string is `INPUT_INVALID`. After the copy, a level that is not a plain object, or whose `manifest` or `datasetParty` is not one, is `INPUT_INVALID`. A `manifest` that fails `TrainingManifestSchema` is `MANIFEST_INVALID`. Then a `modelAuthorParty` that is missing or not an Id is `INVALID_ID`, and a `passThroughBps` that is missing or not an integer from 0 to 10000 is `EXPANSION_SHARE_UNDECLARED`. So is a `baseModel` given without a declared base model, missing with one, not a plain object, or whose `weightBps` is not an integer from 0 to 10000. Its `lineage` is checked as a level.
  - Graph: `idPrefix` is checked first, then the copy, then `usedComponents`, then the graph's schema. An `idPrefix` that is not a string, or a `usedComponents` that is not such a `Set`, is `INPUT_INVALID`. A graph that fails its schema is `GRAPH_INVALID`, and so is one with a repeated `nodeId`, two edges with the same `from` and `to`, or an edge or root that names an unknown node.
  - A `partyByAddress` or `datasetParty` entry that is missing, or is not an Id, is `UNKNOWN_CONTRIBUTOR`.
  - A manifest whose hash cannot be computed is `MANIFEST_INVALID`. Each manifest is then checked against its `manifestHash` (`MANIFEST_HASH_MISMATCH`).
  - On any input, an adapter returns a result. It does not throw.
- **`ContributionGraphV1`** (optional, for open ecosystems): each node keeps a `retain` weight and passes shares along **accepted** edges. An edge is dropped when:
  - it is not accepted;
  - it leads to a node that requires participation and whose component does not run in the unit;
  - or it leads to a node left with nothing to pay.

  A dropped edge's weight returns to its source node's retain when the source has a party. A **routing node** (no party) retains nothing: it is a pool. Its remaining edges share its whole inflow in proportion to their weights, and a routing node left with no edge is itself dropped.

  The root obeys the same participation rule. A graph with nothing payable is refused (`GRAPH_EMPTY`).

  The graph becomes splits and one clause, and the rest is the same compile. It is a template, never a second engine.

## 9. Binding to server state (`netSplitterFor`)

At accept time the accepted-plan compiler asks economics to split each unit's net. The agreement is untrusted there, whether the server loaded it or the plan carried it. The binding refuses (`economics:<CODE>[:<detail>]`), and never repairs, unless every authority-bearing field equals what the server knows, checked in this order:

| Code | Refused when |
|---|---|
| `SERVER_FACTS_INVALID` | The server facts are missing a field, malformed, or unreadable. They are validated at runtime, never assumed from their type: for example, a missing or `NaN` clock would otherwise disable every time check. The detail names the first failing field. |
| `PLAN_UNITS_INVALID` | The plan's units are not well formed. |
| `SCHEMA_INVALID` | The agreement fails §3's input rules. |
| `AGREEMENT_HASH_MISMATCH` | The agreement is not what the payer accepted; the detail names `rights`, `economics` or `envelope`. |
| `FEE_MISMATCH`, `CURRENCY_MISMATCH` | The fee or currency is not the plan's. |
| `AS_OF_OUT_OF_WINDOW` | `asOf` is not in `[now − maxAge, now]` on the server clock (default maximum age: one day). `asOf` decides license validity and pinned rates, so only a server moment is accepted. |
| `OFFER_EXPIRED` | `terms.acceptBy` is set and the server's `now` is after it. The deadline is judged at the server's actual time, never at the agreement's own `asOf`. |
| `USE_MISMATCH` | `use` is not the intended use the server derives from the plan. |
| `LICENSE_NOT_REGISTERED`, `LICENSE_MISMATCH` | A license is not the registry's copy at `licenseId@version`, verbatim, including its authority. |
| `PARTY_NOT_REGISTERED`, `PARTY_MISMATCH` | A party is missing from the registry, or its payout address differs from the registry's. Two groups are checked:<br>1. Before compiling, every party a license names (the licensor, or a declared distribution's party).<br>2. After compiling, **every party the compile pays**, directly, through splits or as the residual. |
| `UNIT_SET_MISMATCH`, `GROSS_MISMATCH` | The units are not the plan's nodes, or a gross is not the server's quote. |
| `UNIT_FACTS_MISMATCH` | A unit's components (with their uses) or measures are not what the server says runs in it. A licensed component therefore cannot be left out or under-counted. |
| `QUOTE_NOT_COVERED` | A unit's gross is less than its operator's live quote. |
| `COMPILE_REFUSED` | The compile, given the server's fee, schedules, rate facts, authority floor and forbidden recipients, refuses. The detail lists the codes. |
| `FEE_RULE_DIVERGED` | The compile's per-unit fee differs from the plan's. |
| `OPERATOR_BELOW_QUOTE` | The unit pays the operator's payout address less than `quote − floor(quote × feeBps / 10000)`. |

**The operator's quote is its price for its own work.** What an agreement adds (licenses, modules, methods, the composer's margin) is on top of the quote, paid by the buyer. It is never taken out of the operator's price.
- Each plan unit carries the operator's live `quote`. `g`, what the buyer funds, is the agreement's unit gross.
- The accepted-plan compiler reads each unit's gross before compiling (`agreementUnitGross`) so it can reserve it.
- The binding then re-checks that gross against the plan and the quote (`GROSS_MISMATCH`, `QUOTE_NOT_COVERED`).
- After compiling it checks the operator's floor (`OPERATOR_BELOW_QUOTE`).
- A royalty the operator itself owes (for example for a kit on its own printer) is part of its quote, and it prices that in.

On success it returns each unit's payouts in plan order, with `agreementHash` and both terms hashes.

## 10. What is out of scope in v1

- Cross-job metering and downstream revenue participation (refused, OD-4).
- Currency conversion and tax.
- Any rule an agent writes as code.
- An exact rate for an `exponential-decay` segment below its starting rate (unverifiable, §2.4).
- A required scheduled royalty over units in different value bands (§2.4). New rule kinds are added to this document and to the compiler together, with golden vectors, under a new domain version.

## 11. Templates

An agreement template has an immutable, versioned economic identity and an explicit list of the values an agent may fill. It does not add a payment rule or a second compiler. The five current examples from `AGREEMENT_TEMPLATES` remain the source of the bodies, in their original order, and their ordinary `EconomicAgreementV1` hashes do not change.

### 11.1 Shape, catalog and hash

`AgreementTemplateV1` is a strict object with exactly `{ schema: "pcc.agreement-template.v1", templateId: Id, version: integer >= 1, title: string, summary: string, slots: SlotV1[], body: EconomicAgreementV1 }`. `title` and `summary` are nonempty presentation strings. The body must satisfy the entire strict economic-agreement schema, including its rule refinements. All five catalog versions start at 1. A slot is exactly `{ name, kind, default, paths }`, with name matching `^[a-z][A-Za-z0-9]{0,63}$`, and kind `party`, `unit`, `amount`, `bps` or the reserved `license`. `default` is the body's present value: an Id for party/unit, an Amount string for amount, or an integer 0..10000 for bps. License slots are always refused in v1, even if no value is supplied. `paths` is a nonempty list of RFC 6901 JSON pointers into `body`, in strictly ascending byte order without repeats; pointer escapes are `~0` for `~` and `~1` for `/`. A malformed template, including an unsorted or repeated pointer within a slot, is `TEMPLATE_SCHEMA_INVALID`.

`AGREEMENT_TEMPLATES_V1` is the deep-frozen, readonly catalog `{ template, templateHash, compileOptions }[]`, in the exact order of the existing five examples. Each `template` copies its entry's `templateId`, `title`, `summary`, and unchanged `build()` body and declares the edit slots below. Its compilation options have the same values as the corresponding existing example; the printer carries its published-schedule example. Nothing here modifies `AGREEMENT_TEMPLATES`, its callers or the preview route's template-building behavior.

The hash is exactly `templateHash(t) = H("PCC:agreement-template:v1", { templateId: t.templateId, version: t.version, slots: t.slots, body: t.body })`, with §6's `H` and `canonicalize`. The domain is exported as `AGREEMENT_TEMPLATE_DOMAIN`. The lowercase result is `0x` plus 64 hex digits. The `schema`, `title` and `summary` fields are **excluded**. Hash the body's actual array orders and fields, not a separately normalized compiler agreement: `canonicalize` sorts object keys, but never sorts arrays. Any change to a hashed field makes a different template hash. The new `agreement-templates-v1.json` fixture records every slot and pointer, plus hashes and compiled examples; the original economics goldens remain authoritative for the default bodies.

### 11.2 Edit surfaces and fixed positions

A slot may name only these positions, where `i`, `j` and `k` are decimal array indices (without leading zeros):

- `party`: `/payer`, `/parties/i/partyId`, `/clauses/i/to/party`, `/splits/i/members/j/to/party`.
- `unit`: `/units/i/unitRef`, `/clauses/i/appliesTo/units/k`.
- `amount`: `/units/i/gross`, or `/clauses/i/rule/amount`, `/clauses/i/rule/rate`, `/clauses/i/rule/cost`, `/clauses/i/rule/min`, `/clauses/i/rule/max`, `/clauses/i/rule/cap`.
- `bps`: `/clauses/i/rule/bps` or `/clauses/i/rule/markupBps`.

A path not in those forms is `SLOT_PATH_FORBIDDEN`. A path in one form but declared with another kind is `SLOT_KIND_MISMATCH`. A form whose concrete position does not exist, or whose current value does not equal its declared default, is `SLOT_DEFAULT_MISMATCH`. In particular, null optional rule limits are not editable amount slots. A pointer may appear in only one slot (`SLOT_PATH_DUPLICATE`), and a name may appear only once (`SLOT_NAME_DUPLICATE`).

Some otherwise well-typed leaves are **always fixed**: the whole `/fee` subtree, any `payTo`, the entire `/licenses` subtree, every rule leaf in a clause with non-null `underLicense`, and every rule leaf in a percent clause with non-null `rateSource`. Slots may not change an address, a license's licensor, distribution, required payment, authority, or a published schedule's accepted rate. A license's reference is reserved too: merely changing that reference in a pure function would leave its embedded server-registry license object out of sync, so a `license` slot is `SLOT_KIND_RESERVED`. A party whose id is named inside any embedded license as licensor or distribution member cannot be made a party slot, because that fixed license reference could not follow the changed id.

For each `party` slot, its paths must be **exactly** the editable party reference positions whose value equals its default, including `/payer` where relevant. For each `unit` slot, its paths must be exactly the unit reference positions whose value equals its default, including every `appliesTo.units` occurrence. Missing any is `SLOT_PATHS_INCOMPLETE`; extra paths are checked by the path rules above. Match positions, not equal-looking strings elsewhere: `role`, `subject`, `clauseId`, `costRef`, a component ref, or arbitrary text is not a party/unit reference. In the deck example, `contractor` and `lumber` also occur as clause ids, `lumber` as a subject and `insurer` as a role; in the lab example `model-author` also occurs as a role. None of those other occurrences is slotted.

Every catalog example declares the payer, every other party eligible under these fixed-license rules, each unit reference and unit gross, and every free rule amount or bps (including each non-null `min`, `max`, `cap`). These rules, plus the exact slot declarations in `agreement-templates-v1.json`, determine the catalog; no rule, split weight, license content, fee, address or protocol term can be introduced through a slot.

### 11.3 Validation and instantiation

`validateTemplate(input: unknown)` first makes one defensive plain-JSON copy with `snapshotJson`, then parses the strict shape and checks every position, kind, default and coverage rule above. It returns `{ ok: true, template }` (the parsed copy), or `{ ok: false, refusals }`; it never throws. A malformed copy, extra field, invalid rule or malformed pointer list is `TEMPLATE_SCHEMA_INVALID`. Validation does not compile, and no catalog validation assertion runs at module load.

`instantiateTemplate(template, params)` validates the template first and propagates its refusals unchanged. `params` must be a plain JSON object whose only relevant keys are own enumerable string keys; its input is defensively copied once before use. Null, arrays, unsupported prototypes, non-JSON data and throwing accessors are `PARAMS_INVALID`, not exceptions. An unknown key, including an own `__proto__` or `payTo`, is `SLOT_UNKNOWN`. A missing slot key uses the declared default. A party or unit value must match §1's `Id` grammar, an amount must match §1's `Amount` grammar, and bps must be an integer from 0 through 10000. Any wrong type (including an object with `{ partyId, payTo }`, any array or a number given for an amount) is `SLOT_VALUE_INVALID`. A bare `0x` plus 40 hex digits in a party or unit slot is instead `SLOT_VALUE_ADDRESS`. A `wallet:0x...` prefixed string is an Id, not an address to use for payment.

Apply each valid value to all and only the slot's declared pointers in a fresh body copy, without changing any authority-bearing position. Two parties or units ending with the same ID/ref, whether both slots were filled or one was already present, are `SLOT_ID_COLLISION`. When a party value **differs** from the default, set that party row's `payTo` to `null` and its `label` to the new party id. The pure function never reads an address registry and never infers an address from a `wallet:` id. If the value equals the default, preserve the original party's `payTo` and label exactly. The server's registry supplies the new address at binding time; meanwhile a paid party without one compiles to `UNRESOLVED_PARTY`. The final filled body must parse as `EconomicAgreementV1`, including all refinements, or is `INSTANCE_SCHEMA_INVALID`. On success return `{ ok: true, agreement }` with no provenance fields added to the agreement IR.

Therefore `instantiateTemplate(t, {})` is deep-equal to `t.body` and has its identical canonical bytes and default compiled `agreementHash`. `agreementId`, `asOf`, `terms.acceptBy`, `fee`, license terms and all un-slotted fields remain unchanged. The preview route may re-time a built example and apply the configured server fee **after** building it; that is separate from template instantiation and its identity check.

### 11.4 Origin proof and refusal identity

`verifyTemplateOrigin(agreement, { templateKey, templateHash, params }, catalog = AGREEMENT_TEMPLATES_V1)` is pure and never throws. First find the catalog entry whose key is the literal `templateId@version`, else `TEMPLATE_UNKNOWN`. Compare the supplied template hash exactly to that entry's hash, else `TEMPLATE_HASH_MISMATCH`. Re-instantiate the entry with those parameters, propagating any validation/instantiation refusals, then compare `canonicalize` of the resulting agreement to the **one canonical JSON snapshot** of the supplied agreement, before any server retiming, license rebinding or fee application. Any difference or unreadable agreement is `TEMPLATE_ORIGIN_MISMATCH`; identical bytes return `{ ok: true }`. A title or summary change does not alter the template hash. Origin is provenance, not a new payment term or an accepted-agreement hash: v1 adds no database column, migration, store write, or IR field.

The complete separate closed `TEMPLATE_REFUSAL_CODES` list is: `TEMPLATE_SCHEMA_INVALID`, `SLOT_KIND_RESERVED`, `SLOT_NAME_DUPLICATE`, `SLOT_PATH_DUPLICATE`, `SLOT_PATH_FORBIDDEN`, `SLOT_KIND_MISMATCH`, `SLOT_DEFAULT_MISMATCH`, `SLOT_PATHS_INCOMPLETE`, `PARAMS_INVALID`, `SLOT_UNKNOWN`, `SLOT_VALUE_INVALID`, `SLOT_VALUE_ADDRESS`, `SLOT_ID_COLLISION`, `INSTANCE_SCHEMA_INVALID`, `TEMPLATE_UNKNOWN`, `TEMPLATE_HASH_MISMATCH`, `TEMPLATE_ORIGIN_MISMATCH`.

Each template refusal is `{ code, message, path: string[] }`. Its identity is `(code, path)`; keep the first message for a duplicate identity and sort by code, then by the elementwise byte-order path comparison of §3 (a prefix sorts first). The path is `[]` for the template as a whole, `["slots", name]` or `["slots", name, jsonPointer]` for a slot, `["params"]` or `["params", key]` for an instantiation parameter, or `["origin"]` for an origin failure. Compiler `REFUSAL_CODES`, compiler refusal sorting/phases and human wording remain separate and unchanged; template refusals never enter `CompileResult`.

`GET /api/economics/templates` lists the five catalog entries in order, giving `templateId`, `title`, `summary`, `version`, `templateHash`, and `slots` projected as `{ name, kind, default }` with no pointer paths. This is discovery only; adding `{ templateId, params }` to the preview POST and persisting verified origin belong to later work.

## 12. Kit licenses and the lineage split

A Kit version (a capability or terms template) carries an ordinary License (§2.5). Its only payment requirement, when it has one, is a percent of the gross of every unit that runs the kit, paid to the kit's fork lineage. The compile pays it as payout legs in the unit's release, like any other required payment. There is no second ledger and no claim step. The functions below are in `economics/kits.ts`, and each is pure.

### 12.1 A License's content address (`licenseHash`)

`licenseHash(license) = H("PCC:license:v1", license)`, with §6's `H`: `"0x"` followed by 64 lowercase hex digits.

- **Read, then checked.** The License is read once, as §3's "Reading the input" reads an agreement. The copy then goes through §3's schema phase on its own: §2.5's License shape, §1's conventions, and every rule marked as a schema rule (for example, `shareAlikeTag` exactly when the class is `share-alike`, and unique `requirementId`s). A License that fails either step is refused, never hashed.
- **No later phase.** Nothing after the schema phase applies. A requirement whose `min` is above its `max` still hashes (the compile refuses it later, `INVALID_BOUNDS`), and so does a License whose `validFrom` is after its `validUntil`. Its licensor and distribution parties need not be parties of any agreement.
- **As published.** None of §6's normalization applies:
  - No array is sorted. `grants.fieldsOfUse`, `grants.regions`, `requires.payments` and every `distribution` are hashed in the order they are written.
  - No hash is lowercased. A `percent_by_schedule` requirement's `scheduleHash` is hashed in the case it is written.
  - So reordering one of those arrays, or changing a hash's case, gives a different `licenseHash`. Key order does not matter, because canonical JSON sorts keys.
- **Where kits use it.** A Kit manifest (`pcc.capability-kit/v1`) pins its License by this hash, in `economics.economicTermsHash` (kits #4102). The field shares its name with an agreement's `economicTermsHash` (§6), but it holds a different value, under a different domain.
- **Result:** `{ ok: true, hash }`, or `{ ok: false, reason }`. The reason is free text, not a code.

Example: this License's canonical JSON is 788 bytes. Its one requirement is `kitRoyaltyRequirement({ bps: 50, lineage: ["carol", "bob", "ann"] })` (§12.2).

```
{"authority":"registry-anchored","class":"permissive","grants":{"commercialUse":true,"compose":true,"fieldsOfUse":["*"],"modify":true,"regions":["*"],"resell":true},"label":"Kit license","licenseId":"kit-license","licensor":"carol","requires":{"attribution":true,"payments":[{"payee":{"distribution":[{"party":"ann","role":null,"subject":null,"weight":1},{"party":"bob","role":null,"subject":null,"weight":2},{"party":"carol","role":null,"subject":null,"weight":4}]},"per":"using-unit","requirementId":"kit-royalty","role":"protocol-author","rule":{"bps":50,"kind":"percent","max":null,"min":null,"of":"gross","rateSource":null}}]},"shareAlikeTag":null,"subject":"kit:sha256:abababababababababababababababababababababababababababababababab","validFrom":null,"validUntil":null,"version":1}
```

Its `licenseHash` is `0x1112bfa7d0da2195b118df02734b16a1d7ba93848157ec7eacd5922974b83686`.

### 12.2 The lineage and its distribution

A kit version's **lineage** lists publishers, nearest first: the kit's own publisher (the forker), then its parent's publisher, then its grandparent's, and so on. It is an array of 1 to 1,024 entries. Every entry must be an Id (§1), although only the first three are paid. Anything else is refused.

`kitLineageDistribution(lineage)` is the distribution the royalty is paid to:

1. Take the first three entries, or all of them if there are fewer. Nearest first, their weights are 1 for one entry, 2 : 1 for two, and 4 : 2 : 1 for three (`KIT_LINEAGE_WEIGHTS = [4, 2, 1]`). Nothing past the grandparent is paid.
2. A party that appears more than once among them (a self-fork) is one member, with the summed weight.
3. Divide every weight by the greatest common divisor of all of them.
4. Sort the members by party id (byte order). Each member is `{ party, weight, role: null, subject: null }`.

A refused lineage throws a `RangeError`.

| Lineage | Distribution (party: weight) |
|---|---|
| `["ann"]` | ann: 1 |
| `["bob", "ann"]` | ann: 1, bob: 2 |
| `["carol", "bob", "ann"]` | ann: 1, bob: 2, carol: 4 |
| `["dave", "carol", "bob", "ann"]` | bob: 1, carol: 2, dave: 4 |
| `["ann", "ann"]` | ann: 1 |
| `["ann", "bob", "ann"]` | ann: 5, bob: 2 |
| `["ann", "ann", "bob"]` | ann: 6, bob: 1 |
| `["ann", "bob", "bob"]` | ann: 4, bob: 3 |

`kitRoyaltyRequirement({ bps, lineage })` is the payment requirement of a kit version's License. `bps` must be an integer from 0 to 10000. The lineage is then checked as above, even at 0 bps. Either failure throws a `RangeError`. A free kit (0 bps) asks for no payment, so the result is `null`. Otherwise it is:

```
{ requirementId: "kit-royalty", role: "protocol-author", per: "using-unit",
  payee: { distribution: kitLineageDistribution(lineage) },
  rule: { kind: "percent", bps, of: "gross", min: null, max: null, rateSource: null } }
```

### 12.3 What a buyer funds (`computeKitSplit`)

`computeKitSplit({ quoteMinor, currency, feeBps, licenseBps, lineage })` prices one unit that runs one kit: the operator's quote, with the kit's royalty on top. It runs the compile (§4) for every amount, so the amounts are exactly what settlement pays at that gross.

**Input.** Each field is read once, as an own data property, and so are `currency`'s two fields and the lineage's entries. A field's getter is never called, so a field given by an accessor counts as missing, and so does an inherited one. Every field is required, so such an input is refused.
- `quoteMinor`: an Amount (§1), or a non-negative bigint. It is at least 5.
- `currency`: `{ code, decimals }`, a string and an integer. The compile then checks them as §2 does.
- `feeBps`: PCC's fee, an integer from 0 to 1000.
- `licenseBps`: the royalty, an integer from 1 to 1000. A free kit pays nobody, so it has no split.
- `lineage`: as in §12.2. The ids `kit-split:buyer` and `kit-split:operator` are reserved, and a lineage that names one is refused.

A refused input answers `{ ok: false, reason }`, with a free-text reason.

**The one-unit agreement** is `kitSplitAgreement(gross, input)`:
- One unit, `job`, at the given gross. It uses the kit component `kit:kit-split` once.
- The kit's License, `kit-license` version 1, whose licensor is `lineage[0]`. It is `permissive` and `registry-anchored`. It grants commercial use, composing, reselling and modifying in any field of use and region, requires attribution, and has one payment requirement: `kitRoyaltyRequirement({ bps: licenseBps, lineage })`.
- A split, `lineage`, whose members are the distribution's parties at their weights.
- The clause `kit-royalty`: a `percent` of `gross` at `licenseBps`, paid to the split `lineage` in every unit that uses the kit, under `kit-license` version 1.
- The clause `operator`: the `residual`, paid to `kit-split:operator`.
- PCC's fee at `feeBps`. The intended use is plain commercial use: not composite, not resold, in any field of use and region.

Its other fields (labels, placeholder payout addresses and `asOf`) are fixed in the code and mean nothing. This section specifies only the amounts the agreement compiles to. `kitSplitAgreement` takes no quote, and it throws a `RangeError` for any other input that the **Input** rules above refuse. It does not compile, so an input that only the compile refuses, such as a negative `decimals`, still gives an agreement.

**The gross.** Let `floor = quote − floor(quote × feeBps / 10000)`, the least the operator may receive under §9 (`OPERATOR_BELOW_QUOTE`). The gross `G` is the smallest amount, at least `quote`, at which the one-unit agreement pays the operator at least `floor`. At gross `G`, §4 gives:
- the fee, `F = floor(G × feeBps / 10000)` (§4.2);
- the royalty, `R`: `G × licenseBps / 10000` rounded to the nearest base unit, with a half rounding up. This is §4.3's largest remainder, for one clause against the rest claimant;
- each member's share of `R`, by weight, by §4.5's largest remainder (a tie goes to the party whose id sorts first);
- the operator's amount, `G − F − R`.

One more base unit of gross can raise `F` and `R` together, so the operator's amount does not rise steadily with `G`. `G` is therefore the first amount from `quote` upward that passes, not the solution of an equation. If the compile refuses (a currency that §2 refuses, or a `G` above §2.2's bound), `computeKitSplit` refuses, and its reason lists the compiler's codes.

**Result.**

```
{ ok: true, grossMinor: G, feeMinor: F, royaltyMinor: R, operatorMinor: G − F − R,
  shares: { party, weight, amountMinor }[],
  rounding: <the text below> }
```

Every amount is an Amount string. `shares` lists the distribution's members in the order they first appear in the lineage. A member whose share rounds to 0 is listed with `"0"`: it is a zero leg (§4.6), so it is not paid. `rounding` is always this text:

> Exact base units. PCC's fee is the gross times its rate, rounded down. The royalty is the license's rate of the gross, rounded to the nearest base unit (a half rounds up). The royalty divides by lineage weight, by largest remainder; a tie goes to the party whose id sorts first. The operator receives the rest.

**Examples** (USDC, 6 decimals):

| Quote | feeBps | licenseBps | Lineage | G | F | R | Operator | Shares |
|---|---|---|---|---|---|---|---|---|
| 25000000 | 235 | 50 | carol, bob, ann | 25128666 | 590523 | 125643 | 24412500 | carol 71796, bob 35898, ann 17949 |
| 2500000000 | 235 | 100 | bob, ann | 2525866528 | 59357863 | 25258665 | 2441250000 | bob 16839110, ann 8419555 |
| 5 | 0 | 1000 | ann | 6 | 0 | 1 | 5 | ann 1 |
| 1000 | 1000 | 1000 | ann, bob, ann | 1124 | 112 | 112 | 900 | ann 80, bob 32 |

In the first row, `floor = 25000000 − 587500 = 24412500`, and at `G − 1` the operator would receive 24412499. In the third row, at `G = 5` the royalty of 0.5 rounds up to 1, which would leave the operator 4.

**It assumes the operator is not one of the lineage's payees.** When the operator is also a contributor, §9's check counts the operator's share toward its minimum as well, so a smaller gross can pass. `computeKitSplit` does not look for that smaller gross.

**Not in v1:** folding a share below the smallest leg into the forker's share, and a cap per unit over all kits. Both need a compiler rule, after the operator rules on the rates (operator item 99).
