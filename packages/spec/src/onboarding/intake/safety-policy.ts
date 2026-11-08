/**
 * Device intake — safety policy that depends on the selected capability.
 *
 * Two rules live here:
 *   1. `safety.limits` entries are bound to the CSD named by `capability.type`
 *      (`checkSafetyLimits`): the quantity must be a NUMBER parameter of that
 *      CSD, the unit must be convertible to the parameter's declared unit
 *      through a small closed table ("count" is the unit of a count
 *      parameter: one that declares unit "count", or a REVIEWED built-in
 *      parameter that declares no unit, REVIEWED_COUNT_PARAMETERS; any other
 *      unitless parameter cannot carry a limit), the limit must lie inside the
 *      parameter's
 *      own [min, max] (a limit only NARROWS the CSD's range), and each
 *      quantity may appear once (duplicates are refused, never intersected).
 *   2. `safety.estop` `{mechanism: "none"}` is an honest observation, but it
 *      does not make a device publishable or runnable unless the capability is
 *      on `ESTOP_NONE_APPROVED_CAPABILITIES`.
 * `validateIntake` (index.ts) applies both; neither is a substitute for the
 * downstream safety-envelope compiler checking the same things independently.
 */

import { loadBuiltinCsds, type CsdRegistry } from "../../csd/registry.js";

// ── e-stop "none" policy ─────────────────────────────────────────────────

/**
 * Capabilities for which `safety.estop = {mechanism: "none"}` does not by
 * itself block publish / accept-jobs: office printers have no e-stop; their
 * hazard is paper handling. A policy decision; extend only by reviewed PR.
 */
export const ESTOP_NONE_APPROVED_CAPABILITIES: readonly string[] = Object.freeze([
  "pcc://capabilities/2d-print/v1",
  "pcc://capabilities/document-print-and-mail/v1",
]);

// ── Units ────────────────────────────────────────────────────────────────

/** `base = value * scale + offset`, within one dimension. */
interface UnitDef {
  dimension: string;
  scale: number;
  offset: number;
}

const unit = (dimension: string, scale: number, offset = 0): UnitDef => ({ dimension, scale, offset });

const DEGREE = String.fromCharCode(0xb0);

/**
 * The closed unit table: only these units are understood, and only within
 * their own dimension. It covers every unit a built-in CSD number parameter
 * declares (%, degrees, km, min, kg, pages) plus the common neighbours of
 * each dimension. Any other unit — on a limit or on the CSD parameter — is
 * refused rather than guessed. Case matters ("mL" is not "ML").
 */
const UNIT_TABLE: ReadonlyMap<string, UnitDef> = new Map<string, UnitDef>([
  // temperature (base: kelvin)
  ["C", unit("temperature", 1, 273.15)],
  ["K", unit("temperature", 1)],
  // length (base: metre); nm for optical wavelengths (sensors #5048)
  ["nm", unit("length", 1e-9)],
  ["um", unit("length", 1e-6)],
  ["mm", unit("length", 1e-3)],
  ["cm", unit("length", 1e-2)],
  ["m", unit("length", 1)],
  ["km", unit("length", 1e3)],
  // volume (base: litre)
  ["uL", unit("volume", 1e-6)],
  ["mL", unit("volume", 1e-3)],
  ["L", unit("volume", 1)],
  // time (base: second)
  ["s", unit("time", 1)],
  ["min", unit("time", 60)],
  ["h", unit("time", 3600)],
  // mass (base: kilogram)
  ["g", unit("mass", 1e-3)],
  ["kg", unit("mass", 1)],
  // ratio (base: percent)
  ["%", unit("percent", 1)],
  // plane angle (base: degree)
  [DEGREE, unit("angle", 1)],
  // count of pages
  ["pages", unit("pages", 1)],
  // a dimensionless count of things (copies, parts, portions, walls)
  ["count", unit("count", 1)],
]);

/** Spellings that normalize to a table unit. Applied after NFKC, trim and
 *  micro folding (the micro sign U+00B5 and Greek mu U+03BC both become "u",
 *  so "uL" has three spellings). */
const UNIT_ALIASES: ReadonlyMap<string, string> = new Map<string, string>([
  [`${DEGREE}C`, "C"],
  ["degC", "C"],
  ["ul", "uL"],
  ["ml", "mL"],
  ["l", "L"],
  ["sec", "s"],
  ["hr", "h"],
  ["deg", DEGREE],
]);

const GREEK_MU = String.fromCharCode(0x3bc);

/** The table unit `raw` names, or undefined when it is outside the closed table. */
function tableUnit(raw: string): UnitDef | undefined {
  const folded = raw.normalize("NFKC").trim().split(GREEK_MU).join("u");
  return UNIT_TABLE.get(UNIT_ALIASES.get(folded) ?? folded);
}

function convert(value: number, from: UnitDef, to: UnitDef): number {
  return ((value * from.scale + from.offset) - to.offset) / to.scale;
}

/** The unit of a count parameter's limit: "count" (in the unit table, dimension "count"). */
export const UNITLESS_LIMIT_UNIT = "count";

/**
 * Built-in CSD number parameters that declare NO unit and are reviewed to be
 * whole-number counts (each has step 1 and a count label), so a limit on them
 * uses the unit "count". A CSD does not say that an unlisted unitless number is a
 * count: a dimensionless ratio, score or coefficient is not, so an unlisted
 * unitless parameter cannot carry a limit (astra pack 120c). A kit or external
 * CSD makes its parameter a count by declaring unit "count". Extend only by
 * reviewed PR; a test pins that every built-in unitless number parameter is
 * listed here.
 */
export const REVIEWED_COUNT_PARAMETERS: ReadonlyMap<string, readonly string[]> = new Map<string, readonly string[]>([
  ["pcc://capabilities/2d-print/v1", Object.freeze(["copies"])],
  ["pcc://capabilities/cnc-3axis/v2", Object.freeze(["quantity"])],
  ["pcc://capabilities/fdm/v2", Object.freeze(["quantity", "wallCount"])],
  ["pcc://capabilities/hot-food-prep/v1", Object.freeze(["portions"])],
  ["pcc://capabilities/laser-cut/v2", Object.freeze(["quantity"])],
  ["pcc://capabilities/make-pizza/v1", Object.freeze(["quantity"])],
  ["pcc://capabilities/sla/v2", Object.freeze(["quantity"])],
]);

// ── CSD binding ──────────────────────────────────────────────────────────

/** The NUMBER parameters of a CSD, as `key -> {unit, min, max}`. */
export type NumberParameters = ReadonlyMap<string, { unit?: string; min: number; max: number }>;

let builtinRegistry: CsdRegistry | undefined;

/** `registry` when given, else the built-in CSDs (loaded once). */
function registryOrBuiltin(registry: CsdRegistry | undefined): CsdRegistry {
  return registry ?? (builtinRegistry ??= loadBuiltinCsds());
}

/**
 * The number parameters of the CSD whose url is `capabilityType`, resolved
 * through `registry` (default: the built-in CSDs) including inherited
 * parameters; undefined when it does not resolve (unknown url, an unresolvable
 * base, or a registry that is not usable) — never throws.
 */
export function numberParametersOf(capabilityType: unknown, registry?: CsdRegistry): NumberParameters | undefined {
  if (typeof capabilityType !== "string") return undefined;
  try {
    const csd = registryOrBuiltin(registry).resolve(capabilityType);
    const params = new Map<string, { unit?: string; min: number; max: number }>();
    const reviewedCounts = REVIEWED_COUNT_PARAMETERS.get(capabilityType) ?? [];
    for (const p of csd.parameters) {
      if (p.type !== "number") continue;
      // A reviewed unitless count takes the unit "count"; any other unitless parameter keeps no unit.
      const unit = p.unit ?? (reviewedCounts.includes(p.key) ? UNITLESS_LIMIT_UNIT : undefined);
      params.set(p.key, { unit, min: p.min, max: p.max });
    }
    return params;
  } catch {
    return undefined;
  }
}

export interface SafetyLimit {
  quantity: string;
  unit: string;
  min: number;
  max: number;
}

/** Floating-point slack when a limit had to be converted into the parameter's
 *  unit (relative to the bound, at least 1e-9 absolute); zero when the units
 *  are the same, so an in-unit comparison is exact. */
const CONVERSION_SLACK = 1e-9;

/**
 * Check `safety.limits` entries against the number parameters of the selected
 * CSD. Returns one message per problem — entry index and reason only, never a
 * value. `parameters` undefined means the CSD is not bound: only the checks
 * that need no CSD (duplicate quantities) run, and the caller decides what an
 * unbound CSD means for its milestone.
 *
 * With a CSD, each entry must: name (exactly) a NUMBER parameter's key; use a
 * unit in the closed table whose dimension matches the parameter's effective
 * unit (its declared unit; "count" for a reviewed unitless count parameter,
 * REVIEWED_COUNT_PARAMETERS; a parameter with no unit otherwise, or with a unit
 * outside the table, cannot carry a limit); and, converted to that unit, lie
 * within the
 * parameter's [min, max]. Every entry for an already-seen quantity (compared
 * after NFKC, trim and lower-casing) is refused — never intersected.
 */
export function checkSafetyLimits(limits: readonly SafetyLimit[], parameters: NumberParameters | undefined): string[] {
  const errors: string[] = [];
  const firstIndexOf = new Map<string, number>();

  limits.forEach((limit, index) => {
    const where = `safety.limits[${index}]`;

    const quantityKey = limit.quantity.normalize("NFKC").trim().toLowerCase();
    const first = firstIndexOf.get(quantityKey);
    if (first === undefined) firstIndexOf.set(quantityKey, index);
    else errors.push(`${where}: duplicate quantity (first at safety.limits[${first}])`);

    if (!parameters) return;

    const parameter = parameters.get(limit.quantity);
    if (!parameter) {
      errors.push(`${where}: quantity is not a number parameter of the selected CSD`);
      return;
    }
    if (parameter.unit === undefined) {
      errors.push(`${where}: the CSD parameter declares no unit and is not a reviewed count parameter`);
      return;
    }
    const limitUnit = tableUnit(limit.unit);
    if (!limitUnit) {
      errors.push(`${where}: unit is not in the closed unit table`);
      return;
    }
    const parameterUnit = tableUnit(parameter.unit);
    if (!parameterUnit) {
      errors.push(`${where}: the CSD parameter's unit is not in the closed unit table`);
      return;
    }
    if (limitUnit.dimension !== parameterUnit.dimension) {
      errors.push(`${where}: unit does not match the CSD parameter's unit`);
      return;
    }

    const converted = limitUnit !== parameterUnit;
    const lo = converted ? convert(limit.min, limitUnit, parameterUnit) : limit.min;
    const hi = converted ? convert(limit.max, limitUnit, parameterUnit) : limit.max;
    const slack = (bound: number): number => (converted ? CONVERSION_SLACK * Math.max(1, Math.abs(bound)) : 0);
    if (!(lo >= parameter.min - slack(parameter.min) && hi <= parameter.max + slack(parameter.max))) {
      errors.push(`${where}: limit lies outside the CSD parameter's range`);
    }
  });

  return errors;
}

/**
 * The limits converted into each CSD parameter's own unit, or null when any of
 * them fails checkSafetyLimits (or the CSD is not bound). Each result names the
 * parameter's unit ("count" for a count parameter) and its bounds converted
 * through the closed table, rounded to 12 significant digits so a conversion
 * such as 1 mL -> 1000 uL reads exactly, then clamped into the parameter's
 * [min, max]: checkSafetyLimits allows a converted bound CONVERSION_SLACK past
 * the range, and a normalized limit never lies outside the CSD's own range. A
 * consumer that does no conversion of its own (sensors' R8) takes these (kits
 * re sensors #4764).
 */
export function limitsInParameterUnits(
  limits: readonly SafetyLimit[],
  parameters: NumberParameters | undefined,
): SafetyLimit[] | null {
  if (!parameters || checkSafetyLimits(limits, parameters).length > 0) return null;
  const round = (n: number): number => Number(n.toPrecision(12));
  return limits.map((limit) => {
    const parameter = parameters.get(limit.quantity)!;
    const from = tableUnit(limit.unit)!;
    const to = tableUnit(parameter.unit!)!;
    const inRange = (n: number): number => Math.min(parameter.max, Math.max(parameter.min, n));
    return {
      quantity: limit.quantity,
      unit: parameter.unit!,
      min: from === to ? limit.min : inRange(round(convert(limit.min, from, to))),
      max: from === to ? limit.max : inRange(round(convert(limit.max, from, to))),
    };
  });
}
