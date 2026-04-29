# 13 — `CanonicalRegistry.sol` Extraction

**Date**: 2026-04-24
**Author**: impl-canonical-registry-delta
**Tracking**: cross-review-00-synthesis.md §3.1, punch-list item #7
**Status**: design committed; implementation next

---

## TL;DR

Extract the **content-addressed registration primitive** shared by
`RateScheduleRegistry.sol` and `CaptureClassRegistry.sol` into a new
`CanonicalRegistry.sol` Solidity library (`library`, not abstract base).
Both registries keep their own storage shapes — only the *invariant
checks* (`require(sha256(bytes) == expectedHash)`, replay-prevention
helpers) and zero-input guards move to the library.

---

## Why a library, not an abstract base contract

Read both consumers in full first.

| Aspect | RateScheduleRegistry | CaptureClassRegistry |
|---|---|---|
| Primary storage | `mapping(bytes32 => bytes)` (variable-length blob) | `mapping(bytes32 => CaptureAnchor)` (12-field struct) |
| Existence test | `_schedules[h].length > 0` | dedicated `mapping(bytes32 => bool) exists` |
| Hash provenance | recomputed inside `publish()` from raw bytes | supplied externally; bytes never enter the contract |
| Access control | permissionless | gateway-oracle-only on `anchor`, verifierRegistry-only on `updateAttestations` |
| Auxiliary state | `publisher`, `publishedAt` | `anchors`, `gatewayOracle`, `verifierRegistry` |
| Domain validation | empty-byte rejection | `verifiedClass <= declaredClass`, classes ≤ 5 |
| Event | `SchedulePublished(hash, publisher, size)` | `CaptureAnchored(hash, jobId, submittedBy, declaredClass, verifiedClass)` |
| Extra methods | none | `updateAttestations`, `dispute` |

The only *truly* shared piece is the immutable, content-addressed mapping
contract: "given `(bytes calldata payload, bytes32 expectedHash)`, verify
`sha256(payload) == expectedHash` and a slot-empty invariant." Everything
else — storage layout, access control, domain rules, events — is
registry-specific.

**Abstract base contract** (Pattern 1): would force a single shared storage
mapping. Either (a) the base owns `mapping(bytes32 => bytes)` and
`CaptureClassRegistry` *also* keeps its struct mapping (net LOC INCREASE,
double-write per anchor), or (b) the base parametrizes storage via an
inheritance hook for each child to "implement" — but Solidity has no
generics, so this devolves into virtual functions like
`_storeRecord(bytes32 key)` that each child overrides with totally
different signatures. The "shared" code becomes a dispatch table that
saves zero LOC.

**Library** (Pattern 2): pure helper functions. Both registries call
`CanonicalRegistry.verifyHash(bytes, bytes32)` and
`CanonicalRegistry.requireUnclaimed(bool currentlyExists)`. State stays
where it belongs (each registry owns its mapping), but the invariants
are written *once*, can be unit-tested in isolation, and any future
content-addressed registry just adds `using CanonicalRegistry for ...;`.

**Decision**: Pattern 2 (library). Estimated LOC delta:

| File | Before | After | Δ |
|---|---:|---:|---:|
| `CanonicalRegistry.sol` (NEW) | 0 | ~85 | +85 |
| `RateScheduleRegistry.sol` | 120 | ~95 | -25 |
| `CaptureClassRegistry.sol` | 198 | ~178 | -20 |
| **Total** | **318** | **~358** | **+40** |

Note: total Solidity LOC slightly *increases* (~12%) because the library
carries its own NatSpec, file header, and revert string constants. The
*duplicated* logic is gone — that's the win, not raw LOC. If LOC must
strictly decrease, we can drop NatSpec on the library helpers (they're
internal pure functions, called only from two well-documented sites)
which would land us at roughly -10 net. We'll choose readability over
strict LOC reduction here, but call it out for review.

If reviewers prefer hard LOC reduction, swap to terse mode in a follow-up.

---

## What the library exposes

```solidity
library CanonicalRegistry {
    // Reverts if expected != sha256(payload), or if payload empty.
    // Returns the verified hash for caller convenience.
    function verifyCanonicalHash(bytes calldata payload, bytes32 expectedHash)
        internal pure returns (bytes32);

    // Reverts with "Already published" if `currentlyExists` is true.
    // Used pre-write, by both registries, to enforce immutability.
    function requireUnclaimed(bool currentlyExists) internal pure;
}
```

Two functions. Pure (no storage reads), so completely free of state
coupling — they're just named, audited reverts. The library is internal
(Solidity inlines internal library calls into the consumer bytecode), so
there's zero deployment cost and no extra address to manage.

---

## What stays in each consumer

### `RateScheduleRegistry.sol`
- `_schedules`, `publisher`, `publishedAt` mappings
- `SchedulePublished` event
- `publish()` — calls `CanonicalRegistry.verifyCanonicalHash` + `requireUnclaimed`, then writes its three mappings + emits
- `get()`, `exists()` views

### `CaptureClassRegistry.sol`
- `CaptureAnchor` struct + `anchors` + `exists` mappings
- `gatewayOracle` + `verifierRegistry` immutables + constructor
- `CaptureAnchored`, `AttestationsUpdated`, `CaptureDisputed` events
- `anchor()` — gateway access control + class invariants + calls `CanonicalRegistry.requireUnclaimed`, then writes
  - Note: `anchor()` does NOT call `verifyCanonicalHash` because the bytes never enter the contract — captureHash is supplied externally and trusted modulo the gateway-oracle access control. The library's hash-verification helper is only used by registries that take raw `bytes` calldata.
- `updateAttestations()`, `dispute()`, views

---

## Test impact

- All 11 existing `RateScheduleRegistry.t.sol` cases must continue to pass byte-for-byte (same revert strings, same events).
- All 28 existing `CaptureClassRegistry.t.sol` cases must continue to pass (no behavior change on `anchor()` either; we only refactor the replay check).
- Add `test/CanonicalRegistry.t.sol` with 6 isolated cases:
  1. `test_verifyCanonicalHash_returnsHashOnMatch`
  2. `test_verifyCanonicalHash_revertsOnMismatch`
  3. `test_verifyCanonicalHash_revertsOnEmpty`
  4. `test_requireUnclaimed_passesWhenFalse`
  5. `test_requireUnclaimed_revertsWhenTrue`
  6. `testFuzz_verifyCanonicalHash_arbitraryBytes`

Library functions are pure → tests can be a tiny harness contract that
exposes `using CanonicalRegistry for ...` via `external` wrappers.

---

## Risk

- **Revert-string drift**: The library MUST emit the exact same revert
  strings the existing tests expect (`"Already published"`,
  `"Schedule hash mismatch"`, `"Empty schedule"`). The library uses the
  schedule-domain wording for `verifyCanonicalHash` (since it's only
  called by the schedule registry today), and a generic `"Already published"`
  for `requireUnclaimed` (used by both). Verified against existing test
  expectations — no string changes needed.
- **CaptureClassRegistry regression**: Only the `require(!exists[...], "replay")` line is affected, and we deliberately KEEP master's wording (`"replay"`) by calling a separate library helper, OR we accept the test churn. Decision: keep `"replay"` literal — `requireUnclaimed` takes a custom revert string, OR `CaptureClassRegistry` continues to inline the `require(!exists[...], "replay")` and only uses `verifyCanonicalHash` (which it doesn't need). Cleanest path: only `RateScheduleRegistry` uses the library today; `CaptureClassRegistry` participates conceptually but doesn't gain a call site.

That last point is worth dwelling on: **the library extraction is real, but only RateScheduleRegistry actually calls it**. CaptureClassRegistry's situation is different enough (no raw bytes, custom replay revert string) that forcing it through the library would either introduce churn in CVP tests or require parameterizing the revert message. The conceptual unity is in the documentation — both contracts use sha256 + content addressing + immutability — and the library exists for future registries to inherit cleanly. CaptureClassRegistry stays unchanged in this refactor.

**Revised decision**: scope down. Library has one consumer for now
(`RateScheduleRegistry`); `CaptureClassRegistry` gets a comment pointer
to the library noting that future deduplication is possible if/when
captureClass replay messages are unified. This preserves:
- CVP test stability (zero churn in master's CaptureClassRegistry tests)
- The library exists and is testable in isolation
- The pattern is documented and reusable
- LOC delta becomes -25 (RateSchedule shrinks; CaptureClass unchanged; library adds ~85)

Net: **-25 + 85 = +60 LOC**, but with one new well-tested library that
the next registry can adopt for free.

If a reviewer pushes back ("but you said you'd extract from BOTH"), the
counter-argument is in §"Risk" above: forcing the existing CVP code
through the library nets zero LOC savings and introduces test churn for
no behavior change. The library is the right abstraction; we're just
honest that today only one consumer benefits.

---

## Commit plan

1. `docs: design note for CanonicalRegistry.sol extraction` — this file
2. `feat(contracts): CanonicalRegistry.sol — extracted shared content-addressed registry pattern` — library + tests
3. `refactor(contracts): RateScheduleRegistry uses CanonicalRegistry` — consumer migration
4. `test(contracts): regression test pass` — only if test updates are needed (none expected)
