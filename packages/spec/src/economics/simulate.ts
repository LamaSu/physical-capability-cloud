/**
 * simulateEconomics — the same compile over what-if variants, then outcomes (docs §7).
 *
 * There is no second arithmetic here. Each scenario edits a copy of the agreement (a different price,
 * a component that did or did not run), compiles it with `compileEconomics`, and then applies the
 * escrow's outcome rules per unit: a released unit pays its legs and its fee; a refunded unit returns
 * its whole gross to the payer; a pending unit keeps its gross reserved. A variant that cannot be
 * funded comes back as the compiler's refusal, which is itself the answer ("below this price the deal
 * does not cover its fixed costs"). Results are predictions (Layer C), never state.
 */

import { z } from "zod";
import { compileEconomics, type CompileOptions } from "./compile.js";
import { cmpStr } from "./hash.js";
import { snapshotJson } from "./input.js";
import { refusal, type Refusal } from "./refusals.js";
import { AmountSchema, EconomicAgreementSchema, IdSchema, LabelSchema, MAX_AGREEMENT_UNITS, type EconomicAgreement } from "./types.js";

export const MAX_SCENARIOS = 64;
export const MAX_USES_OVERRIDES = 1024;

function uniqueBy<T>(key: (x: T) => string) {
  return (xs: readonly T[]) => new Set(xs.map(key)).size === xs.length;
}

export const ScenarioSchema = z
  .object({
    scenarioId: IdSchema,
    label: LabelSchema,
    grossOverrides: z
      .array(z.object({ unitRef: IdSchema, gross: AmountSchema }).strict())
      .max(MAX_AGREEMENT_UNITS)
      .refine(uniqueBy((g) => g.unitRef), "a unit's gross is overridden twice"),
    /** `uses: "0"` means the component did not run in that unit. */
    usesOverrides: z
      .array(z.object({ unitRef: IdSchema, ref: IdSchema, uses: AmountSchema }).strict())
      .max(MAX_USES_OVERRIDES)
      .refine(uniqueBy((o) => `${o.unitRef}\u0000${o.ref}`), "a component's uses in one unit are overridden twice"),
    outcomes: z
      .array(z.object({ unitRef: IdSchema, outcome: z.enum(["released", "refunded", "pending"]) }).strict())
      .max(MAX_AGREEMENT_UNITS)
      .refine(uniqueBy((o) => o.unitRef), "a unit has two outcomes"),
  })
  .strict();
export type Scenario = z.infer<typeof ScenarioSchema>;

export type UnitOutcome = "released" | "refunded" | "pending";

export type ScenarioResult =
  | {
      scenarioId: string;
      label: string;
      ok: true;
      agreementHash: string;
      units: Array<{ unitRef: string; outcome: UnitOutcome; gross: string; fee: string; net: string }>;
      /** What each party is paid by released units, from the compiled legs' attribution. */
      paid: Array<{ partyId: string; amount: string }>;
      payer: { partyId: string; spent: string; refunded: string; reserved: string };
      fee: { paid: string; recipient: string | null };
    }
  | { scenarioId: string; label: string; ok: false; refusals: Refusal[] };

function applyOverrides(base: EconomicAgreement, s: Scenario): EconomicAgreement | Refusal[] {
  const variant: EconomicAgreement = structuredClone(base);
  const errors: Refusal[] = [];
  const unitByRef = new Map(variant.units.map((u) => [u.unitRef, u] as const));
  for (const g of s.grossOverrides) {
    const u = unitByRef.get(g.unitRef);
    if (u === undefined) errors.push(refusal("UNKNOWN_REFERENCE", `scenario overrides unknown unit "${g.unitRef}"`, ["scenario", s.scenarioId, g.unitRef]));
    else u.gross = g.gross;
  }
  for (const o of s.usesOverrides) {
    const u = unitByRef.get(o.unitRef);
    if (u === undefined) {
      errors.push(refusal("UNKNOWN_REFERENCE", `scenario overrides unknown unit "${o.unitRef}"`, ["scenario", s.scenarioId, o.unitRef]));
      continue;
    }
    const rest = u.components.filter((c) => c.ref !== o.ref);
    u.components = o.uses === "0" ? rest : [...rest, { ref: o.ref, uses: o.uses }];
  }
  for (const o of s.outcomes) {
    if (!unitByRef.has(o.unitRef)) {
      errors.push(refusal("UNKNOWN_REFERENCE", `scenario sets an outcome for unknown unit "${o.unitRef}"`, ["scenario", s.scenarioId, o.unitRef]));
    }
  }
  return errors.length > 0 ? errors : variant;
}

/**
 * One result per scenario, in the order given. If `scenarios` is not a list of at most MAX_SCENARIOS
 * entries, the single result `scenarios` says so; nothing throws.
 */
export function simulateEconomics(
  agreement: unknown,
  scenarios: readonly unknown[],
  options: CompileOptions = {},
): ScenarioResult[] {
  const list = snapshotJson(scenarios);
  if (!list.ok || !Array.isArray(list.value) || list.value.length > MAX_SCENARIOS) {
    const why = !list.ok ? list.reason : `scenarios must be a list of at most ${MAX_SCENARIOS}`;
    return [{ scenarioId: "scenarios", label: "invalid scenarios", ok: false, refusals: [refusal("SCHEMA_INVALID", why, ["scenarios"])] }];
  }
  const agreementCopy = snapshotJson(agreement);
  const parsedAgreement = agreementCopy.ok ? EconomicAgreementSchema.safeParse(agreementCopy.value) : null;
  return list.value.map((raw, index): ScenarioResult => {
    const parsed = ScenarioSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        scenarioId: `scenario-${index}`,
        label: "invalid scenario",
        ok: false,
        refusals: [refusal("SCHEMA_INVALID", parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "), ["scenario"])],
      };
    }
    const s = parsed.data;
    if (parsedAgreement === null || !parsedAgreement.success) {
      const r = compileEconomics(agreement, options);
      return { scenarioId: s.scenarioId, label: s.label, ok: false, refusals: r.ok ? [] : r.refusals };
    }
    const variant = applyOverrides(parsedAgreement.data, s);
    if (Array.isArray(variant)) return { scenarioId: s.scenarioId, label: s.label, ok: false, refusals: variant };

    const compiled = compileEconomics(variant, options);
    if (!compiled.ok) return { scenarioId: s.scenarioId, label: s.label, ok: false, refusals: compiled.refusals };

    const outcomeOf = new Map(s.outcomes.map((o) => [o.unitRef, o.outcome] as const));
    const paid = new Map<string, bigint>();
    let spent = 0n;
    let refunded = 0n;
    let reserved = 0n;
    let feePaid = 0n;
    const units = compiled.units.map((u) => {
      const outcome: UnitOutcome = outcomeOf.get(u.unitRef) ?? "released";
      if (outcome === "released") {
        spent += BigInt(u.gross);
        feePaid += BigInt(u.fee);
        for (const leg of u.legs) {
          for (const a of leg.attribution) paid.set(a.partyId, (paid.get(a.partyId) ?? 0n) + BigInt(a.amount));
        }
      } else if (outcome === "refunded") {
        refunded += BigInt(u.gross);
      } else {
        reserved += BigInt(u.gross);
      }
      return { unitRef: u.unitRef, outcome, gross: u.gross, fee: u.fee, net: u.net };
    });
    return {
      scenarioId: s.scenarioId,
      label: s.label,
      ok: true,
      agreementHash: compiled.agreementHash,
      units,
      paid: [...paid.entries()].sort((a, b) => cmpStr(a[0], b[0])).map(([partyId, amount]) => ({ partyId, amount: amount.toString() })),
      payer: {
        partyId: compiled.payer,
        spent: spent.toString(),
        refunded: refunded.toString(),
        reserved: reserved.toString(),
      },
      fee: { paid: feePaid.toString(), recipient: compiled.fee.feeRecipient },
    };
  });
}
