/**
 * netSplitterFor — the economics half of the accepted-plan seam (composition #351, `CompileDeps.splitNet`).
 *
 * The accepted-plan compiler owns unit order, node ↔ unit identity and the fee rule; economics owns how
 * each unit's net is split. At accept time the agreement must not be taken on the caller's word, whether
 * the server loaded it by id or the plan carried it. This binding REFUSES, and never repairs, unless:
 *
 *   1. the agreement is still exactly what the payer accepted (when accepted hashes are given), with
 *      the refusal naming which half moved (rights, economics, envelope);
 *   2. every authority-bearing field equals server state (docs §3a):
 *        - the fee and currency the plan was priced with;
 *        - `asOf`, which must be a recent server moment (it decides license validity and pinned rates);
 *        - the intended use, which the server states from the plan, not the composer;
 *        - every license, which must equal the server's registry copy at licenseId@version, INCLUDING its
 *          authority level (the caller's copy never sets its own authority);
 *        - every party a license names (the licensor and a declared distribution), whose payout address
 *          must be the registry's, so a composer cannot re-point a required royalty at another wallet;
 *        - the unit set, each unit's gross (the server quote), and what runs in each unit (components
 *          with their uses, and measures), so a licensed component cannot be left out or under-counted;
 *   3. `compileEconomics` accepts it, given the server's fee, sealed rate-schedule bodies, rate facts
 *      and forbidden recipients.
 *
 * Only then does it return each unit's payouts in the shape `splitNet` expects. The seam re-checks that
 * output independently (Σ == n, 1–16 legs, non-zero recipients), so neither side trusts the other.
 */

import { canonicalize } from "../util/canonical.js";
import type { RateSchedule } from "../types/rate-schedule.js";
import { compileEconomics } from "./compile.js";
import { cmpStr } from "./hash.js";
import { snapshotJson } from "./input.js";
import type { CaptureClassId } from "./rates.js";
import { z } from "zod";
import { RateScheduleSchema } from "../types/rate-schedule.js";
import { CAPTURE_CLASS_IDS } from "./rates.js";
import {
  AddressSchema,
  AmountSchema,
  AuthoritySchema,
  EconomicAgreementSchema,
  IdSchema,
  IntendedUseSchema,
  LicenseSchema,
  MAX_FEE_BPS,
  ZERO_ADDRESS,
  type Authority,
  type IntendedUse,
  type License,
} from "./types.js";
import { verifyAcceptedAgreement, type AcceptedAgreementHashes } from "./verify.js";

/**
 * One unit as the accepted-plan compiler hands it over, in canonical plan order.
 *
 * `quote` is the operator's live price for its own work. `g` is what the buyer funds for the unit: the
 * agreement's unit gross, which may exceed the quote by what the agreement adds ON TOP (licenses,
 * modules, the composer's margin). The operator is never paid less than its quote net of the fee on it.
 */
export interface PlanSplitUnit {
  nodeId: string;
  operator: string;
  payoutAddress: string;
  quote: bigint;
  g: bigint;
  f: bigint;
  n: bigint;
}

/** Structurally identical to composition's `NetSplitResult` (#351), plus `agreementHash`. Amounts are base-unit strings. */
export type PlanSplitResult =
  | {
      ok: true;
      units: Array<{
        unitRef: string;
        gross: string;
        fee: string;
        net: string;
        payouts: Array<{ recipient: string; amount: string }>;
      }>;
      /** What acceptance binds: it covers both terms hashes and the envelope (asOf, version, deadline). */
      agreementHash: string;
      economicTermsHash: string;
      rightsTermsHash: string;
    }
  | { ok: false; code: string };

export type PlanSplitter = (units: readonly PlanSplitUnit[]) => PlanSplitResult;

/** What the server knows about one unit of the plan: what runs in it, and how much. */
export interface ServerUnitFacts {
  components: ReadonlyArray<{ ref: string; uses: string }>;
  measures: ReadonlyArray<{ key: string; value: string }>;
}

/** What the server knows, independently of anything the caller sent. */
export interface ServerEconomicsFacts {
  /** The plan's server-resolved fee: the same values the accepted-plan compiler prices with. */
  feeBps: number;
  /** Composition's convention: the zero address when feeBps is 0. */
  feeRecipient: string;
  /** Settlement currency and its server-owned decimals. */
  currency: { code: string; decimals: number };
  /** The server clock, unix seconds. `asOf` must lie in [now − maxAgreementAgeSeconds, now]. */
  now: number;
  /** Default 86400 (one day). */
  maxAgreementAgeSeconds?: number;
  /** The intended use the server derives from the plan. The agreement's `use` must equal it. */
  intendedUse: IntendedUse;
  /** The server's registry copies of licenses. An agreement may cite only these, and only verbatim. */
  licenses: readonly License[];
  /** Registry payout addresses of the parties licenses name (licensors and distribution parties). */
  parties: ReadonlyArray<{ partyId: string; payTo: string }>;
  /** Per plan node: what runs in it. Every unit must be listed, an empty list included. */
  unitFacts: Readonly<Record<string, ServerUnitFacts>>;
  /** Sealed rate-schedule bodies (the `rate_schedules` table), so pinned royalty rates are verified. */
  schedules: readonly RateSchedule[];
  /** Facts some rate schedules depend on (adoption, capture class). */
  rateFacts?: { jobsPerDay?: number | null; captureClass?: CaptureClassId | null };
  /** The escrow clone, the settlement token and the factory. */
  forbiddenRecipients: readonly string[];
  authorityFloor?: Authority;
}

export interface NetSplitterInput {
  /** Untrusted: loaded by id by the server, or carried by the plan. Checked either way. */
  agreement: unknown;
  /** The hashes the payer accepted when shown the preview, or null when acceptance happens now. */
  accepted: AcceptedAgreementHashes | null;
  server: ServerEconomicsFacts;
}

export const BIND_REFUSAL_CODES = [
  "SERVER_FACTS_INVALID",
  "PLAN_UNITS_INVALID",
  "SCHEMA_INVALID",
  "AGREEMENT_HASH_MISMATCH",
  "FEE_MISMATCH",
  "CURRENCY_MISMATCH",
  "AS_OF_OUT_OF_WINDOW",
  "OFFER_EXPIRED",
  "USE_MISMATCH",
  "LICENSE_NOT_REGISTERED",
  "LICENSE_MISMATCH",
  "PARTY_NOT_REGISTERED",
  "PARTY_MISMATCH",
  "UNIT_SET_MISMATCH",
  "GROSS_MISMATCH",
  "UNIT_FACTS_MISMATCH",
  "QUOTE_NOT_COVERED",
  "COMPILE_REFUSED",
  "FEE_RULE_DIVERGED",
  "OPERATOR_BELOW_QUOTE",
] as const;
export type BindRefusalCode = (typeof BIND_REFUSAL_CODES)[number];

export const DEFAULT_MAX_AGREEMENT_AGE_SECONDS = 86_400;

const SafeTimeSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/**
 * The server facts, checked at runtime. TypeScript types do not survive to runtime: a missing or NaN
 * clock would otherwise make every time comparison false and skip the check (coord-watch #360 P1).
 * Malformed facts refuse every split (SERVER_FACTS_INVALID); they never throw and are never skipped.
 */
export const ServerEconomicsFactsSchema = z
  .object({
    feeBps: z.number().int().min(0).max(MAX_FEE_BPS),
    feeRecipient: AddressSchema,
    currency: z.object({ code: z.string().regex(/^[A-Z0-9]{2,12}$/), decimals: z.number().int().min(0).max(36) }).strict(),
    now: SafeTimeSchema,
    maxAgreementAgeSeconds: SafeTimeSchema.optional(),
    intendedUse: IntendedUseSchema,
    licenses: z.array(LicenseSchema).max(1024),
    parties: z
      .array(z.object({ partyId: IdSchema, payTo: AddressSchema }).strict())
      .max(4096)
      .refine((ps) => new Set(ps.map((p) => p.partyId)).size === ps.length, "a party is registered twice"),
    unitFacts: z.record(
      z
        .object({
          components: z.array(z.object({ ref: IdSchema, uses: AmountSchema }).strict()).max(64),
          measures: z.array(z.object({ key: IdSchema, value: AmountSchema }).strict()).max(64),
        })
        .strict(),
    ),
    schedules: z.array(RateScheduleSchema).max(64),
    rateFacts: z
      .object({
        jobsPerDay: SafeTimeSchema.nullable().optional(),
        captureClass: z.enum(CAPTURE_CLASS_IDS).nullable().optional(),
      })
      .strict()
      .optional(),
    forbiddenRecipients: z.array(AddressSchema).max(64),
    authorityFloor: AuthoritySchema.optional(),
  })
  .strict();

function validPlanUnits(units: unknown): units is readonly PlanSplitUnit[] {
  if (!Array.isArray(units)) return false;
  return units.every(
    (u: unknown) =>
      typeof u === "object" &&
      u !== null &&
      typeof (u as PlanSplitUnit).nodeId === "string" &&
      typeof (u as PlanSplitUnit).payoutAddress === "string" &&
      /^0x[0-9a-fA-F]{40}$/.test((u as PlanSplitUnit).payoutAddress) &&
      (["quote", "g", "f", "n"] as const).every((k) => typeof (u as PlanSplitUnit)[k] === "bigint" && (u as PlanSplitUnit)[k] >= 0n),
  );
}

/** Refusal codes read `economics:<CODE>[:<detail>]`, bounded, so the seam can record them verbatim. */
function refuse(code: BindRefusalCode, detail?: string): PlanSplitResult {
  const text = detail === undefined ? `economics:${code}` : `economics:${code}:${detail}`;
  return { ok: false, code: text.length > 256 ? `${text.slice(0, 253)}...` : text };
}

const lower = (s: string) => s.toLowerCase();

function sameMultiset<T>(a: readonly T[], b: readonly T[], key: (x: T) => string): boolean {
  if (a.length !== b.length) return false;
  const ka = a.map(key).sort(cmpStr);
  const kb = b.map(key).sort(cmpStr);
  return ka.every((k, i) => k === kb[i]);
}

/**
 * The gross each unit of an (untrusted) agreement asks the buyer to fund, for the accepted-plan compiler
 * to reserve BEFORE it compiles. The splitter re-checks every one of these against the plan
 * (GROSS_MISMATCH, QUOTE_NOT_COVERED), so reading them early grants nothing.
 */
export function agreementUnitGross(agreement: unknown): { ok: true; gross: Record<string, bigint> } | { ok: false; code: string } {
  const copy = snapshotJson(agreement);
  const parsed = copy.ok ? EconomicAgreementSchema.safeParse(copy.value) : null;
  if (parsed === null || !parsed.success) return { ok: false, code: "economics:SCHEMA_INVALID" };
  const gross: Record<string, bigint> = {};
  for (const u of parsed.data.units) {
    if (Object.prototype.hasOwnProperty.call(gross, u.unitRef)) return { ok: false, code: `economics:UNIT_SET_MISMATCH:${u.unitRef}` };
    gross[u.unitRef] = BigInt(u.gross);
  }
  return { ok: true, gross };
}

export function netSplitterFor(input: NetSplitterInput): PlanSplitter {
  // Snapshot everything now, so a caller mutating its objects later cannot change a decision. Reading
  // never throws; malformed facts refuse every call below.
  const serverCopy = snapshotJson((input as { server?: unknown } | null)?.server);
  const serverParsed = serverCopy.ok ? ServerEconomicsFactsSchema.safeParse(serverCopy.value) : null;
  const acceptedRaw = (input as { accepted?: unknown } | null)?.accepted;
  const acceptedCopy = acceptedRaw === null ? null : snapshotJson(acceptedRaw);
  const agreementCopy = snapshotJson((input as { agreement?: unknown } | null)?.agreement);

  return (units) => {
    if (serverParsed === null || !serverParsed.success) {
      const why = serverParsed?.success === false ? serverParsed.error.issues[0]?.path.join(".") : "unreadable";
      return refuse("SERVER_FACTS_INVALID", why || "(root)");
    }
    const server = serverParsed.data;
    if (!validPlanUnits(units)) return refuse("PLAN_UNITS_INVALID");
    const accepted = acceptedCopy === null ? null : acceptedCopy.ok ? (acceptedCopy.value as AcceptedAgreementHashes) : ({} as AcceptedAgreementHashes);
    const parsed = agreementCopy.ok ? EconomicAgreementSchema.safeParse(agreementCopy.value) : null;
    if (parsed === null || !parsed.success) return refuse("SCHEMA_INVALID");
    const ag = parsed.data;

    if (accepted !== null) {
      const v = verifyAcceptedAgreement(accepted, ag);
      if (!v.ok) return refuse("AGREEMENT_HASH_MISMATCH", v.code === "AGREEMENT_HASH_MISMATCH" ? v.changed.join("+") : v.code);
    }

    // Fee and currency are the plan's, which the server priced; the agreement must say the same.
    const agreedFeeRecipient = ag.fee.feeRecipient === null ? ZERO_ADDRESS : lower(ag.fee.feeRecipient);
    if (ag.fee.feeBps !== server.feeBps || agreedFeeRecipient !== lower(server.feeRecipient)) return refuse("FEE_MISMATCH");
    if (ag.currency.code !== server.currency.code || ag.currency.decimals !== server.currency.decimals) {
      return refuse("CURRENCY_MISMATCH");
    }

    // asOf decides which licenses are in force and which rate a schedule gives: a server moment only.
    const maxAge = server.maxAgreementAgeSeconds ?? DEFAULT_MAX_AGREEMENT_AGE_SECONDS;
    if (ag.asOf > server.now || ag.asOf < server.now - maxAge) return refuse("AS_OF_OUT_OF_WINDOW", String(ag.asOf));
    // The offer deadline is judged at the server's actual time, never at the agreement's own asOf.
    if (ag.terms.acceptBy !== null && server.now > ag.terms.acceptBy) return refuse("OFFER_EXPIRED", String(ag.terms.acceptBy));

    // The composer does not get to describe its own use to the licenses it is checked against.
    const serverUse = { ...server.intendedUse, modifies: [...server.intendedUse.modifies].sort(cmpStr) };
    const agreedUse = { ...ag.use, modifies: [...ag.use.modifies].sort(cmpStr) };
    if (canonicalize(agreedUse) !== canonicalize(serverUse)) return refuse("USE_MISMATCH");

    // Licenses: only the server's registry copies, verbatim (authority level included).
    const registry = new Map<string, string>(server.licenses.map((l) => [`${l.licenseId}@${l.version}`, canonicalize(l)]));
    for (const l of ag.licenses) {
      const key = `${l.licenseId}@${l.version}`;
      const registered = registry.get(key);
      if (registered === undefined) return refuse("LICENSE_NOT_REGISTERED", key);
      if (registered !== canonicalize(l)) return refuse("LICENSE_MISMATCH", key);
    }

    // Parties a license names are paid at their registry address, never at one the composer wrote.
    const registeredPayTo = new Map(server.parties.map((p) => [p.partyId, lower(p.payTo)] as const));
    const agreedPayTo = new Map(ag.parties.map((p) => [p.partyId, p.payTo === null ? null : lower(p.payTo)] as const));
    const named = new Set<string>();
    for (const l of ag.licenses) {
      named.add(l.licensor);
      for (const q of l.requires.payments) if ("distribution" in q.payee) for (const d of q.payee.distribution) named.add(d.party);
    }
    for (const partyId of [...named].sort(cmpStr)) {
      const registered = registeredPayTo.get(partyId);
      if (registered === undefined) return refuse("PARTY_NOT_REGISTERED", partyId);
      if (agreedPayTo.has(partyId) && agreedPayTo.get(partyId) !== registered) return refuse("PARTY_MISMATCH", partyId);
    }

    // Units: exactly the plan's nodes, each at the server-quoted gross, running what the server says.
    const byRef = new Map(ag.units.map((u) => [u.unitRef, u] as const));
    const nodeIds = new Set(units.map((u) => u.nodeId));
    if (nodeIds.size !== units.length || byRef.size !== units.length || units.some((u) => !byRef.has(u.nodeId))) {
      return refuse("UNIT_SET_MISMATCH");
    }
    const facts = new Map(Object.entries(server.unitFacts));
    for (const u of units) {
      const unit = byRef.get(u.nodeId)!;
      if (BigInt(unit.gross) !== u.g) return refuse("GROSS_MISMATCH", u.nodeId);
      if (u.g < u.quote) return refuse("QUOTE_NOT_COVERED", u.nodeId);
      const f = facts.get(u.nodeId);
      if (
        f === undefined ||
        !sameMultiset(unit.components, f.components, (c) => `${c.ref}\u0000${c.uses}`) ||
        !sameMultiset(unit.measures, f.measures, (m) => `${m.key}\u0000${m.value}`)
      ) {
        return refuse("UNIT_FACTS_MISMATCH", u.nodeId);
      }
    }

    const compiled = compileEconomics(ag, {
      forbiddenRecipients: server.forbiddenRecipients,
      schedules: server.schedules,
      fee: { feeBps: server.feeBps, feeRecipient: server.feeBps === 0 ? null : server.feeRecipient },
      ...(server.rateFacts !== undefined ? { rateFacts: server.rateFacts } : {}),
      ...(server.authorityFloor !== undefined ? { authorityFloor: server.authorityFloor } : {}),
    });
    if (!compiled.ok) {
      const codes = [...new Set(compiled.refusals.map((r) => r.code))].sort();
      return refuse("COMPILE_REFUSED", codes.join(","));
    }

    // Every party the compile pays, not only those a license names, is paid at its registry address
    // (coord-watch #360 P1): a residual, fixed or split recipient the registry does not know, or knows at
    // another address, is refused.
    const paid = new Set(compiled.units.flatMap((u) => u.legs.flatMap((l) => l.partyIds)));
    for (const partyId of [...paid].sort(cmpStr)) {
      const registered = registeredPayTo.get(partyId);
      if (registered === undefined) return refuse("PARTY_NOT_REGISTERED", partyId);
      if (agreedPayTo.get(partyId) !== registered) return refuse("PARTY_MISMATCH", partyId);
    }

    const compiledByRef = new Map(compiled.units.map((u) => [u.unitRef, u] as const));
    const out: Extract<PlanSplitResult, { ok: true }>["units"] = [];
    for (const u of units) {
      const c = compiledByRef.get(u.nodeId)!;
      // One fee rule, the escrow's. Both sides compute it; if they ever disagree, nothing is funded.
      if (BigInt(c.fee) !== u.f || BigInt(c.net) !== u.n) return refuse("FEE_RULE_DIVERGED", u.nodeId);
      // The operator's quote is its price for its own work: whatever the agreement adds is on top, so
      // the operator's own legs cover at least its quote net of the fee on that quote.
      const floor = u.quote - (u.quote * BigInt(server.feeBps)) / 10_000n;
      const toOperator = c.payouts.filter((p) => p.recipient === lower(u.payoutAddress)).reduce((s, p) => s + BigInt(p.amount), 0n);
      if (toOperator < floor) return refuse("OPERATOR_BELOW_QUOTE", u.nodeId);
      out.push({ unitRef: c.unitRef, gross: c.gross, fee: c.fee, net: c.net, payouts: c.payouts.map((p) => ({ ...p })) });
    }
    return {
      ok: true,
      units: out,
      agreementHash: compiled.agreementHash,
      economicTermsHash: compiled.economicTermsHash,
      rightsTermsHash: compiled.rightsTermsHash,
    };
  };
}
