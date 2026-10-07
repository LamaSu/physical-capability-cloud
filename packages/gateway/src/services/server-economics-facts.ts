/**
 * serverEconomicsFacts: what the server knows when an economic agreement is bound at accept time
 * (R15-core; steward #6691, DECISIONS 10/04 00:42).
 *
 * The economics binding (`netSplitterFor`, @pcc/spec economics/bind.ts) refuses an agreement unless every
 * authority-bearing field equals server state. This module assembles that state, `ServerEconomicsFacts`, from
 * server sources only, so the accept route can hand the seam (external-plan-seam.ts)
 *
 *   economics: { unitGross: () => agreementUnitGross(agreement), splitNet: netSplitterFor({ agreement, accepted, server }) }
 *
 * `economicsBindingFor` builds exactly that object. Wiring it into the accept route stays with the plan and
 * composition lane.
 *
 * The agreement is untrusted. It is read ONCE, into an owned copy, and used only to name which registry rows to
 * read: the rate schedules, licenses and parties it cites. No value in the facts comes from it.
 *
 * Field by field:
 *   feeBps, feeRecipient   configuration: PCC_PROTOCOL_FEE_BPS and PCC_PROTOCOL_FEE_RECIPIENT (`protocolFeePolicy`),
 *                          with the zero address for a zero fee (composition's convention). The accept route's
 *                          SettlementPolicy must price with these same values; if it ever does not, the binding
 *                          refuses (FEE_MISMATCH or FEE_RULE_DIVERGED).
 *   currency               the plan's settlement currency (its reservation's), with its decimals from the compiler's
 *                          SETTLEMENT_TOKEN_DECIMALS, never from a caller.
 *   now                    the request's one clock reading (the accept route reads the clock once per request).
 *   schedules              the contributors registry's sealed bodies for the schedule hashes the agreement names.
 *   forbiddenRecipients    configuration: PCC_FORBIDDEN_RECIPIENTS.
 *   licenses, parties      operator item 27: the license registry's copies and the parties' registered payout
 *                          addresses. Neither table exists yet, so a request that needs one is REFUSED.
 *   intendedUse            no server source derives a plan's intended use yet: REFUSED.
 *   unitFacts              no server record says what runs in a plan node yet (kits R5/K1): REFUSED.
 *   rateFacts              no server source gives a unit's capture class or jobs per day: left out, and REFUSED when a
 *                          named schedule has a segment whose rate depends on one. A capture-class segment would
 *                          otherwise fall back to its `default` rate, which is a default standing in for a fact.
 *   maxAgreementAgeSeconds, authorityFloor   left out, so the binding's and the compiler's reviewed policy values apply.
 *
 * Nothing missing is filled in. No empty list stands in for a registry that does not exist, and no default for a
 * configuration that is unset. A refusal lists every missing fact it can name, in a fixed order. Untrusted input
 * never makes this module throw; a source that throws (a database fault) propagates, as a dependency fault does in
 * the seam. It stores nothing: it adds no ledger, and money moves only through the V-next payouts the binding
 * returns.
 */

import { SETTLEMENT_TOKEN_DECIMALS, assertScheduleIsWellFormed, computeScheduleHash, type RateSchedule } from "@pcc/spec";
import {
  EconomicAgreementSchema,
  IdSchema,
  LicenseSchema,
  MAX_FEE_BPS,
  ServerEconomicsFactsSchema,
  ZERO_ADDRESS,
  agreementUnitGross,
  netSplitterFor,
  snapshotJson,
  type AcceptedAgreementHashes,
  type EconomicAgreement,
  type IntendedUse,
  type License,
  type ServerEconomicsFacts,
  type ServerUnitFacts,
} from "@pcc/spec/economics";
import { z } from "zod";
import { getRepos } from "../db.js";
import type { EconomicsBinding } from "./external-plan-seam.js";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** A plain decimal integer: "2.35", "1e2", "0x64" and "+5" are not read as some number. */
const DECIMAL_BPS = /^(0|[1-9][0-9]{0,3})$/;
const MAX_SCHEDULE_LOOKUPS = 64;
/** ServerEconomicsFactsSchema's own bound on forbiddenRecipients. */
const MAX_FORBIDDEN_RECIPIENTS = 64;
/** The seam's bound on a submission's nodes. */
const MAX_PLAN_NODES = 1024;

// ── Configuration ────────────────────────────────────────────────────────────────────────────────

/**
 * The fee PCC charges, from configuration; null when it is not configured, or configured wrong. The basis points
 * must be a plain decimal integer up to the escrow's MAX_FEE_BPS, and a non-zero fee needs a non-zero recipient.
 */
export function configuredProtocolFee(env: NodeJS.ProcessEnv = process.env): { feeBps: number; feeRecipient: string | null } | null {
  const raw = env.PCC_PROTOCOL_FEE_BPS?.trim() ?? "";
  if (!DECIMAL_BPS.test(raw)) return null;
  const feeBps = Number(raw);
  if (feeBps > MAX_FEE_BPS) return null;
  if (feeBps === 0) return { feeBps, feeRecipient: null };
  const recipient = env.PCC_PROTOCOL_FEE_RECIPIENT?.trim() ?? "";
  return ADDRESS.test(recipient) && recipient.toLowerCase() !== ZERO_ADDRESS ? { feeBps, feeRecipient: recipient } : null;
}

/**
 * The protocol fee as the accept-time compilers price it: composition's convention, with the zero address for a
 * zero fee. The accept route's SettlementPolicy and these facts must both come from here.
 */
export function protocolFeePolicy(env: NodeJS.ProcessEnv = process.env): { feeBps: number; feeRecipient: string } | null {
  const fee = configuredProtocolFee(env);
  return fee === null ? null : { feeBps: fee.feeBps, feeRecipient: fee.feeRecipient ?? ZERO_ADDRESS };
}

type ForbiddenRead =
  | { ok: true; addresses: string[] }
  | { ok: false; refusal: EconomicsFactsRefusal };

/**
 * PCC_FORBIDDEN_RECIPIENTS, read strictly: comma-separated addresses (the escrow clone, the settlement token, the
 * factory). Unset or empty does not mean "nothing is forbidden", and an entry that is not an address is not skipped.
 * Empty entries (a trailing comma) carry nothing and are ignored.
 */
function readForbiddenRecipients(env: NodeJS.ProcessEnv): ForbiddenRead {
  const entries = (env.PCC_FORBIDDEN_RECIPIENTS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  if (entries.length === 0) return { ok: false, refusal: { code: "FORBIDDEN_RECIPIENTS_NOT_CONFIGURED" } };
  const bad = entries.findIndex((s) => !ADDRESS.test(s));
  if (bad >= 0) return { ok: false, refusal: { code: "FORBIDDEN_RECIPIENTS_INVALID", detail: `entry ${bad + 1}` } };
  const addresses = [...new Set(entries.map((s) => s.toLowerCase()))];
  if (addresses.length > MAX_FORBIDDEN_RECIPIENTS) {
    return { ok: false, refusal: { code: "FORBIDDEN_RECIPIENTS_INVALID", detail: `more than ${MAX_FORBIDDEN_RECIPIENTS} entries` } };
  }
  return { ok: true, addresses };
}

// ── The contributors registry's sealed rate schedules ────────────────────────────────────────────

/** Every schedule hash the (untrusted) agreement names, lowercased, for lookup only. */
export function namedScheduleHashes(agreement: unknown): string[] {
  const hashes = new Set<string>();
  const visit = (rule: unknown) => {
    if (typeof rule !== "object" || rule === null) return;
    const r = rule as { kind?: unknown; scheduleHash?: unknown; rateSource?: { scheduleHash?: unknown } | null };
    if (r.kind === "percent_by_schedule" && typeof r.scheduleHash === "string") hashes.add(r.scheduleHash.toLowerCase());
    if (r.kind === "percent" && r.rateSource && typeof r.rateSource.scheduleHash === "string") hashes.add(r.rateSource.scheduleHash.toLowerCase());
  };
  const ag = agreement as { clauses?: unknown; licenses?: unknown } | null;
  if (ag && Array.isArray(ag.clauses)) for (const c of ag.clauses) visit((c as { rule?: unknown })?.rule);
  if (ag && Array.isArray(ag.licenses)) {
    for (const l of ag.licenses) {
      const payments = (l as { requires?: { payments?: unknown } })?.requires?.payments;
      if (Array.isArray(payments)) for (const p of payments) visit((p as { rule?: unknown })?.rule);
    }
  }
  return [...hashes].slice(0, MAX_SCHEDULE_LOOKUPS);
}

/** The registry's sealed bodies; `available` is false only when there was something to look up and no registry. */
export interface SealedSchedules {
  available: boolean;
  schedules: RateSchedule[];
}

/**
 * The sealed bodies the registry holds for those hashes. A body the compiler could not use (one sealed before the
 * registry checked number ranges, or a stored copy that no longer hashes to its label) is left out, so the pin it
 * would verify is refused at its own clause (RATE_UNVERIFIED), instead of the server's bad record refusing the
 * whole agreement as malformed options. The compiler re-checks both.
 */
export function sealedSchedules(hashes: readonly string[]): SealedSchedules {
  const out: RateSchedule[] = [];
  if (hashes.length === 0) return { available: true, schedules: out };
  let repos: ReturnType<typeof getRepos>;
  try {
    repos = getRepos();
  } catch {
    // No registry. The preview leaves the pins unverified; the binding's facts refuse.
    return { available: false, schedules: out };
  }
  for (const h of hashes) {
    const record = repos.contributors.getSchedule(h);
    if (!record) continue;
    try {
      const body = {
        scheduleHash: record.scheduleHash,
        version: record.version,
        segments: JSON.parse(record.segmentsJson),
        ...(record.notes !== null ? { notes: record.notes } : {}),
        publishedAt: record.publishedAt,
      } as RateSchedule;
      assertScheduleIsWellFormed(body);
      if (computeScheduleHash(body).toLowerCase() !== record.scheduleHash.toLowerCase()) continue;
      out.push(body);
    } catch {
      // A corrupt or unusable stored body is skipped; the pin it would verify stays unverified.
    }
  }
  return { available: true, schedules: out };
}

/** Segment kinds whose rate depends on a server fact (`rateFacts`) that no server source supplies yet. */
const RATE_FACT_SEGMENT_KINDS: ReadonlySet<string> = new Set(["capture-class-indexed", "adoption-indexed"]);

// ── The facts ────────────────────────────────────────────────────────────────────────────────────

/** Every reason the facts can be refused, in the order a refusal lists them. */
export const ECONOMICS_FACTS_REFUSAL_CODES = [
  /** The agreement cannot be read as an EconomicAgreementV1, so the registry rows it needs cannot be named. */
  "AGREEMENT_UNREADABLE",
  /** The plan's nodes are not a list of distinct node ids, each with its capability id. */
  "PLAN_INVALID",
  /** The clock reading is not whole unix seconds in the safe range. */
  "CLOCK_INVALID",
  /** The plan's currency has no server-owned decimals (SETTLEMENT_TOKEN_DECIMALS). */
  "CURRENCY_NOT_SUPPORTED",
  /** PCC_PROTOCOL_FEE_BPS or PCC_PROTOCOL_FEE_RECIPIENT is unset or malformed. */
  "FEE_NOT_CONFIGURED",
  /** PCC_FORBIDDEN_RECIPIENTS is unset or empty. */
  "FORBIDDEN_RECIPIENTS_NOT_CONFIGURED",
  /** A PCC_FORBIDDEN_RECIPIENTS entry is not an address, or there are too many. */
  "FORBIDDEN_RECIPIENTS_INVALID",
  /** The agreement names a rate schedule, and the contributors registry cannot be read. */
  "SCHEDULE_REGISTRY_UNAVAILABLE",
  /** A named schedule's rate depends on a unit's capture class or jobs per day, which no server source supplies. */
  "RATE_FACTS_UNAVAILABLE",
  /** The agreement cites a license, and there is no license registry (operator item 27). */
  "LICENSE_REGISTRY_UNAVAILABLE",
  /** There is no registry of parties' payout addresses (operator item 27). Every agreement names a party. */
  "PARTY_REGISTRY_UNAVAILABLE",
  /** No server source states the plan's intended use. */
  "INTENDED_USE_UNAVAILABLE",
  /** No server source states what runs in each plan node (kits R5/K1). */
  "UNIT_FACTS_UNAVAILABLE",
  /** A server source returned data the binding's own schema refuses; the detail names the first failing field. */
  "SERVER_FACTS_INVALID",
] as const;
export type EconomicsFactsRefusalCode = (typeof ECONOMICS_FACTS_REFUSAL_CODES)[number];

export interface EconomicsFactsRefusal {
  code: EconomicsFactsRefusalCode;
  /** Informative only, and never a configured value or a caller's string. */
  detail?: string;
}

/** A plan node as the facts need it: its id (an agreement unit's `unitRef`) and the capability it runs. */
export interface PlanNodeRef {
  nodeId: string;
  capabilityId: string;
}

export interface EconomicsFactsRequest {
  /** The agreement to bind. Untrusted, whether the server loaded it by id or the plan carried it. Read once. */
  agreement: unknown;
  /** The plan's nodes, as the accept route read them from the submission. */
  nodes: readonly PlanNodeRef[];
  /** The plan's settlement currency: its reservation's, which the compiler prices every node in. */
  currency: string;
  /** The request's one clock reading, in whole unix seconds. */
  now: number;
}

/**
 * Where each fact comes from. A source that does not exist yet is null, and every fact it would supply is refused.
 * The four nullable sources' signatures are placeholders until their owners build them.
 */
export interface EconomicsFactsSources {
  /** Configuration: the protocol fee and the forbidden recipients. */
  env: NodeJS.ProcessEnv;
  /** The contributors registry's sealed rate schedules (`sealedSchedules`). */
  sealedSchedules(hashes: readonly string[]): SealedSchedules;
  /** Operator item 27: the registry's copy of licenseId@version, or null when it holds none. */
  licenseRegistry: ((licenseId: string, version: number) => License | null) | null;
  /** Operator item 27: a party's registered payout address, or null when the party is not registered. */
  partyRegistry: ((partyId: string) => string | null) | null;
  /** The plan's intended use as the server records it, or null when it cannot say. */
  intendedUse: ((nodes: readonly PlanNodeRef[]) => IntendedUse | null) | null;
  /** What runs in each plan node, every node listed, or null when it cannot say. */
  unitFacts: ((nodes: readonly PlanNodeRef[]) => Record<string, ServerUnitFacts> | null) | null;
}

/** Today's sources: configuration and the contributors registry. Item 27's registries and the plan sources do not exist yet. */
export function productionEconomicsFactsSources(): EconomicsFactsSources {
  return { env: process.env, sealedSchedules, licenseRegistry: null, partyRegistry: null, intendedUse: null, unitFacts: null };
}

export type ServerEconomicsFactsResult =
  | { ok: true; facts: ServerEconomicsFacts }
  | { ok: false; refusals: EconomicsFactsRefusal[] };

/** One own data property of a server-built request, read once; undefined for an accessor or a missing key. */
function field(from: unknown, key: string): unknown {
  try {
    if (typeof from !== "object" || from === null) return undefined;
    const d = Object.getOwnPropertyDescriptor(from, key);
    return d !== undefined && "value" in d ? d.value : undefined;
  } catch {
    return undefined;
  }
}

const PlanNodesSchema = z
  .array(z.object({ nodeId: IdSchema, capabilityId: IdSchema }).strict())
  .max(MAX_PLAN_NODES)
  .refine((ns) => new Set(ns.map((n) => n.nodeId)).size === ns.length, "a node is listed twice");

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function assemble(agreementCopy: ReturnType<typeof snapshotJson>, request: unknown, sources: EconomicsFactsSources): ServerEconomicsFactsResult {
  const refusals: EconomicsFactsRefusal[] = [];
  const env: NodeJS.ProcessEnv = sources.env ?? {}; // no configuration is unconfigured, never process.env by default

  const parsed = agreementCopy.ok ? EconomicAgreementSchema.safeParse(agreementCopy.value) : null;
  const ag: EconomicAgreement | null = parsed !== null && parsed.success ? parsed.data : null;
  if (ag === null) refusals.push({ code: "AGREEMENT_UNREADABLE" });

  const nodesCopy = snapshotJson(field(request, "nodes"));
  const nodesParsed = nodesCopy.ok ? PlanNodesSchema.safeParse(nodesCopy.value) : null;
  const nodes: PlanNodeRef[] | null = nodesParsed !== null && nodesParsed.success ? nodesParsed.data : null;
  if (nodes === null) refusals.push({ code: "PLAN_INVALID" });

  const now = field(request, "now");
  const clockOk = typeof now === "number" && Number.isSafeInteger(now) && now >= 0;
  if (!clockOk) refusals.push({ code: "CLOCK_INVALID" });

  // Own keys only: "toString" or "__proto__" is not a settlement token.
  const code = field(request, "currency");
  const decimals = typeof code === "string" && Object.prototype.hasOwnProperty.call(SETTLEMENT_TOKEN_DECIMALS, code) ? SETTLEMENT_TOKEN_DECIMALS[code] : undefined;
  if (decimals === undefined) refusals.push({ code: "CURRENCY_NOT_SUPPORTED" });

  const fee = protocolFeePolicy(env);
  if (fee === null) refusals.push({ code: "FEE_NOT_CONFIGURED" });

  const forbidden = readForbiddenRecipients(env);
  if (!forbidden.ok) refusals.push(forbidden.refusal);

  // Rate schedules: the registry's sealed bodies for the hashes the agreement names.
  let schedules: RateSchedule[] = [];
  if (ag !== null) {
    const sealed = sources.sealedSchedules(namedScheduleHashes(ag));
    if (!sealed.available) refusals.push({ code: "SCHEDULE_REGISTRY_UNAVAILABLE" });
    else {
      schedules = sealed.schedules;
      if (schedules.some((s) => s.segments.some((seg) => RATE_FACT_SEGMENT_KINDS.has(seg.kind)))) refusals.push({ code: "RATE_FACTS_UNAVAILABLE" });
    }
  }

  // Licenses (item 27): the registry's copy of each one the agreement cites, verbatim. One it does not hold is left
  // out, and the binding refuses the agreement for it (LICENSE_NOT_REGISTERED).
  const licenses: License[] = [];
  if (ag !== null && ag.licenses.length > 0) {
    const lookup = sources.licenseRegistry;
    if (lookup === null) refusals.push({ code: "LICENSE_REGISTRY_UNAVAILABLE" });
    else {
      const cited = new Map(ag.licenses.map((l) => [`${l.licenseId}@${l.version}`, l] as const));
      for (const key of [...cited.keys()].sort(cmp)) {
        const l = cited.get(key)!;
        const answer: unknown = lookup(l.licenseId, l.version);
        if (answer === null) continue;
        // Checked here, before its parties are read below: a row is the registry's license for exactly this key.
        const copy = snapshotJson(answer);
        const row = copy.ok ? LicenseSchema.safeParse(copy.value) : null;
        if (row === null || !row.success) {
          refusals.push({ code: "SERVER_FACTS_INVALID", detail: "licenses (the registry answered a malformed license)" });
          break;
        }
        if (`${row.data.licenseId}@${row.data.version}` !== key) {
          refusals.push({ code: "SERVER_FACTS_INVALID", detail: "licenses (the registry answered for another license)" });
          break;
        }
        licenses.push(row.data);
      }
    }
  }

  // Parties (item 27): the registered payout address of every party the agreement declares, and of every party the
  // registry's copies of its licenses name. Taking the license-named parties from the registry's copies, never the
  // agreement's, bounds the lookups by server data: the binding refuses any license that differs from its copy.
  // Every agreement declares a party, so without the registry no agreement can bind, readable or not.
  const parties: Array<{ partyId: string; payTo: string }> = [];
  const payToOf = sources.partyRegistry;
  if (payToOf === null) refusals.push({ code: "PARTY_REGISTRY_UNAVAILABLE" });
  else if (ag !== null) {
    const ids = new Set(ag.parties.map((p) => p.partyId));
    for (const l of licenses) {
      ids.add(l.licensor);
      for (const q of l.requires.payments) if ("distribution" in q.payee) for (const d of q.payee.distribution) ids.add(d.party);
    }
    for (const partyId of [...ids].sort(cmp)) {
      const payTo = payToOf(partyId);
      if (payTo !== null) parties.push({ partyId, payTo });
    }
  }

  // The plan's sources. One that does not exist is named whatever the plan; one that exists is asked only about a
  // readable plan, and a null answer means it cannot say.
  const useOf = sources.intendedUse;
  const intendedUse = useOf !== null && nodes !== null ? useOf(nodes) : null;
  if (useOf === null || (nodes !== null && intendedUse === null)) refusals.push({ code: "INTENDED_USE_UNAVAILABLE" });
  const factsOf = sources.unitFacts;
  const unitFacts = factsOf !== null && nodes !== null ? factsOf(nodes) : null;
  if (factsOf === null || (nodes !== null && unitFacts === null)) refusals.push({ code: "UNIT_FACTS_UNAVAILABLE" });

  if (refusals.length > 0) return { ok: false, refusals: ordered(refusals) };

  // Every source answered. The facts must still pass the binding's own schema; the copy it returns is owned data.
  const checked = ServerEconomicsFactsSchema.safeParse({
    feeBps: fee!.feeBps,
    feeRecipient: fee!.feeRecipient,
    currency: { code, decimals },
    now,
    intendedUse,
    licenses,
    parties,
    unitFacts,
    schedules,
    forbiddenRecipients: forbidden.ok ? forbidden.addresses : [],
  });
  if (!checked.success) {
    return { ok: false, refusals: [{ code: "SERVER_FACTS_INVALID", detail: checked.error.issues[0]?.path.join(".") || "(root)" }] };
  }
  return { ok: true, facts: checked.data as ServerEconomicsFacts };
}

/** One refusal per code, in ECONOMICS_FACTS_REFUSAL_CODES order (the first detail kept). */
function ordered(refusals: readonly EconomicsFactsRefusal[]): EconomicsFactsRefusal[] {
  const byCode = new Map<EconomicsFactsRefusalCode, EconomicsFactsRefusal>();
  for (const r of refusals) if (!byCode.has(r.code)) byCode.set(r.code, r);
  return ECONOMICS_FACTS_REFUSAL_CODES.flatMap((c) => (byCode.has(c) ? [byCode.get(c)!] : []));
}

/** The facts the binding checks this request's agreement against, or every missing fact by name. */
export function serverEconomicsFacts(request: EconomicsFactsRequest, sources: EconomicsFactsSources = productionEconomicsFactsSources()): ServerEconomicsFactsResult {
  return assemble(snapshotJson(field(request, "agreement")), request, sources);
}

export type EconomicsBindingResult =
  | { ok: true; binding: EconomicsBinding; facts: ServerEconomicsFacts }
  | { ok: false; refusals: EconomicsFactsRefusal[] };

/**
 * The seam's `economics` dependency for one request. The agreement is read ONCE: its facts are assembled from that
 * copy, and both halves of the binding are bound to the same copy, so the rows looked up, the gross reserved and
 * the split compiled all describe one agreement. `accepted` is what the payer accepted (from the accepted-agreement
 * store, operator item 27), or null when this acceptance is the payer's.
 */
export function economicsBindingFor(
  request: EconomicsFactsRequest & { accepted: AcceptedAgreementHashes | null },
  sources: EconomicsFactsSources = productionEconomicsFactsSources(),
): EconomicsBindingResult {
  const copy = snapshotJson(field(request, "agreement"));
  const assembled = assemble(copy, request, sources);
  if (!assembled.ok) return assembled;
  const agreement = copy.ok ? copy.value : undefined; // facts were assembled, so the copy parsed
  // Passed as read. Only null means "this acceptance is the payer's": an absent or malformed value is checked by the
  // binding and refused (AGREEMENT_HASH_MISMATCH:SCHEMA_INVALID), never taken as null.
  const accepted = field(request, "accepted") as AcceptedAgreementHashes | null;
  return {
    ok: true,
    facts: assembled.facts,
    binding: {
      unitGross: () => agreementUnitGross(agreement),
      splitNet: netSplitterFor({ agreement, accepted, server: assembled.facts }),
    },
  };
}
