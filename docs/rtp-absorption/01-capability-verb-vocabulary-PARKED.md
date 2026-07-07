# RTP Absorption #1 — Canonical Physical-Action Verb Vocabulary

**Status:** PARKED (2026-06-22) — note only, no build this cycle.
**Origin:** RTP (Robot Task Protocol) conceptual analysis, github.com/plagtech/rtp-spec §4.
**Decision owner:** Ryan. **Author of note:** Claude (from the RTP teardown).

> Companion docs (built separately as `/go` research passes): `02-connection-transport-abstraction.md` and `03-task-lifecycle-timeout-freshness.md`. Those two are being absorbed now; **this one is deliberately deferred** — reasoning below.

---

## The idea (what RTP does)

RTP §4 defines a **fixed vocabulary of 15 standard action verbs** that every robot declares at registration:

`move, pick, place, scan, sort, inspect, deliver, patrol, charge, capture, transmit, weld, assemble, dispense, print`

Plus:
- **Reverse-domain custom verbs** for anything outside the core set (`com.acmerobotics.palletize`), which MUST NOT collide with core names.
- **Suggested standard parameters per verb** (RTP Appendix B), so agents send a predictable shape (`pick` → `{item, from_location, to_location}`).

The point of a *fixed* vocabulary: two operators offering "the same" action describe it the **same way**, so agents can compare and substitute them.

## Why it's attractive for PCC

- PCC capabilities today are **operator-defined CSDs** — maximally flexible, but two operators' "same" action are **not comparable** by construction. A standard verb layer makes them comparable.
- This maps directly onto PCC's own grand-vision goals (`pcc_grand_vision_agentic_composition`): **"identical products"** for the perfect-competition mechanics, and the **top-100 capability-type catalog seeding** (vision item #7). RTP's pattern is a worked example of exactly that.
- It aids **composition** (the composition engine can match/substitute by verb) and **agent intent-matching** (the model maps "deliver X" → a verb without learning each operator's bespoke API).

## Reservations (Ryan, 2026-06-22) — why we park it

**R1 — Significant additional wiring for the physical provenance we provide.**
RTP's verb schema is a *flat task descriptor*; PCC capabilities additionally carry **verified, signed evidence/provenance** (oracle + 4-tier assurance + capture protocol). A canonical verb+param layer has to be **bound to** that provenance model — i.e., each standard verb needs a defined evidence/verification contract ("what proves a `weld` actually happened"), not just a parameter shape. That binding is the hard part and is where most of the work lives. RTP skips it entirely (its `COMPLETED` is self-reported), so RTP's vocabulary is *cheap precisely because it carries no provenance*. For PCC it is not cheap.

**R2 — The 15-verb list is not exhaustive.**
RTP's set is robotics/warehouse-flavored. PCC targets **every good and service** — physical, digital, human-node skills, and **subjective/novel categories** (cf. `feedback_decomposer_at_user_agent_layer`: "30 min of horn practice as an ambient piece"). A fixed 15-verb list cannot span that universe. Reverse-domain custom verbs patch the gap — but the moment most real capabilities are custom verbs, **comparability (the entire benefit) erodes**, and you're back to operator-defined CSDs with extra ceremony.

## Design options (for when we revisit)

- **(A) Optional verb-tag overlay on CSD** *(lean / cheapest)* — keep CSD canonical; let a capability *optionally self-tag* with a standard verb where one cleanly fits, used only for **discovery/filtering/substitution**. No forced taxonomy, provenance model untouched, comparability where it naturally exists, no pretense that 15 verbs cover everything.
- **(B) Canonical verb layer with provenance binding** *(heavy)* — promote a standard verb set to a first-class layer, each verb carrying a defined evidence/verification contract. Maximum comparability; maximum wiring (R1). Only worth it for a small set of genuinely high-volume physical verbs.
- **(C) PCC-native extensible action ontology** — instead of RTP's flat 15, seed a **hierarchical, extensible** ontology from the top-100 CSD catalog (vision item #7), with provenance contracts attached. The "do it properly for PCC" option; largest scope.

## Recommendation

**PARK.** Revisit when a concrete trigger arrives, not speculatively:
- top-100 CSD catalog seeding (grand-vision item #7) actually starts, **or**
- the composition engine needs a discovery/substitution vocabulary, **or**
- the connection-transport work (#2) starts onboarding real robots whose capabilities want standard verbs.

When triggered, **lean toward Option (A)** first — an optional overlay buys comparability where it's real, keeps CSD + provenance intact, costs little, and avoids the false promise that a fixed verb list spans "every good and service." Escalate to (C) only if/when the catalog work proves the demand.

## Open questions

- Per-verb evidence/verification contracts — who authors them, and how do they compose with the oracle's assurance tiers?
- Does an optional verb tag actually improve agent intent-matching enough to matter, or does the user-agent LLM already bridge CSD → intent well? (Measure before building.)
- Relationship to MCP tool naming and any megaplatform commerce-protocol product taxonomies (ACP/AP2) — a standard vocabulary that *those* speak would carry far more leverage than one that only RTP speaks.

## References

- RTP 1.0 spec §4 (Capability Vocabulary) + Appendix B — github.com/plagtech/rtp-spec
- `pcc_grand_vision_agentic_composition` (identical products, top-100 catalog, perfect competition)
- PCC `docs/CAPABILITY_PROFILES.md` (current CSD model) — audit before any build
- `feedback_decomposer_at_user_agent_layer` (subjective/novel verticals defeat fixed taxonomies)
- Sibling absorption docs: `02-connection-transport-abstraction.md`, `03-task-lifecycle-timeout-freshness.md`
