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
 * Admission accepts primitive JSON text of at most 1 MiB (1,048,576 UTF-8 bytes), parsed inside this service with
 * no reviver. Non-strings, including String objects, are refused unread and without coercion; invalid or oversized
 * text is refused before any request field is read. The text carries agreement, nodes, currency and now, plus
 * accepted for `economicsBindingFor`. The agreement is read ONCE from the parsed tree into an owned copy, used only
 * to name which registry rows to read: the rate schedules, licenses and parties it cites. No value in the facts
 * comes from it. Only literal JSON null for accepted means this acceptance is the payer's; absence stays undefined.
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
 * configuration that is unset. A refusal lists every missing fact it can name, in a fixed order. The untrusted
 * boundary is JSON text: parsing gives ordinary data of this realm, so reading agreement, nodes and acceptance
 * cannot run caller code. Untrusted input never makes this module throw.
 *
 * The seam's 1 MiB precondition (external-plan-seam.ts, its header; gateway bodyLimit) is enforced here before
 * parsing. `ownedJson` retains its depth, array-length, value and work bounds. Its work budget bounds the copy's
 * walk, but not one object's width before enumeration: JavaScript must materialize its own keys to count them.
 * Its no-code and work guarantees hold for ordinary objects of this realm. It is NOT an admission boundary against
 * exotic host objects such as VM globals, whose reflection can invoke Proxy traps despite util.types.isProxy false.
 *
 * `ownedJson` has parity with `snapshotJson` for ordinary data of this realm containing no Proxy, within the work
 * budget, and with every diagnostic path representable by the engine. Three standalone copier exceptions remain:
 * explicit Proxies are refused unread here; skipped non-enumerable keys can exhaust its additional work budget;
 * and snapshotJson can refuse an unrepresentable diagnostic path that this path-free copier accepts. JSON text
 * cannot encode Proxies or non-enumerable keys, and the service's byte cap applies before any of these comparisons.
 *
 * Sources are trusted server code, never caller input: schedule and license bodies are copied through `ownedJson`
 * as defence in depth, and all facts are schema-checked. A malformed answer is refused (SERVER_FACTS_INVALID);
 * a source that throws (a database fault) propagates, as a
 * dependency fault does in the seam. It stores nothing: it adds no ledger, and money moves only through the V-next
 * payouts the binding returns.
 */

import { Buffer } from "node:buffer";
import { types as utilTypes } from "node:util";
import { RateScheduleSchema, SETTLEMENT_TOKEN_DECIMALS, assertScheduleIsWellFormed, computeScheduleHash, type RateSchedule } from "@pcc/spec";
import {
  EconomicAgreementSchema,
  IdSchema,
  LicenseSchema,
  MAX_FEE_BPS,
  ServerEconomicsFactsSchema,
  ZERO_ADDRESS,
  agreementUnitGross,
  netSplitterFor,
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
/** The seam's admission precondition, measured in UTF-8 bytes before JSON parsing. */
const MAX_REQUEST_JSON_BYTES = 1_048_576;

// ── Configuration ────────────────────────────────────────────────────────────────────────────────

/** A configuration value as set. One that is not a string (only an injected env can hold one) reads as unset. */
const setting = (value: unknown): string => (typeof value === "string" ? value : "");

/**
 * The fee PCC charges, from configuration; null when it is not configured, or configured wrong. The basis points
 * must be a plain decimal integer up to the escrow's MAX_FEE_BPS, and a non-zero fee needs a non-zero recipient.
 */
export function configuredProtocolFee(env: NodeJS.ProcessEnv = process.env): { feeBps: number; feeRecipient: string | null } | null {
  const raw = setting(env.PCC_PROTOCOL_FEE_BPS).trim();
  if (!DECIMAL_BPS.test(raw)) return null;
  const feeBps = Number(raw);
  if (feeBps > MAX_FEE_BPS) return null;
  if (feeBps === 0) return { feeBps, feeRecipient: null };
  const recipient = setting(env.PCC_PROTOCOL_FEE_RECIPIENT).trim();
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
  const entries = setting(env.PCC_FORBIDDEN_RECIPIENTS)
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

/**
 * Every schedule hash the agreement names, lowercased, for lookup only. Callers must supply ordinary parsed or
 * server-owned data; this helper reads properties directly and is not an arbitrary-object admission boundary.
 */
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
  /**
   * Informative only: an entry number, or the path of the first field the binding's schema refused (a path can hold
   * a plan node id). Never a configured value.
   */
  detail?: string;
}

/** A plan node as the facts need it: its id (an agreement unit's `unitRef`) and the capability it runs. */
export interface PlanNodeRef {
  nodeId: string;
  capabilityId: string;
}

/**
 * Fields carried by the public entry points' JSON text, at most 1 MiB in UTF-8 bytes and parsed inside the service
 * without a reviver. This interface describes the parsed data, not an admitted object argument: non-string
 * arguments are refused unread. `economicsBindingFor` also reads accepted; only literal JSON null accepts now,
 * and an absent accepted stays undefined for the binding to refuse. Copier parity applies to ordinary data of
 * this realm without Proxies, within the work budget and representable diagnostic paths. Its three exceptions
 * are explicit Proxy refusal, an additional budget for skipped keys, and accepting paths snapshotJson cannot build.
 */
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
 * Trusted server functions, never caller input. A source that does not exist yet is null, and every fact it would
 * supply is refused.
 * The four nullable sources' signatures are placeholders until their owners build them. An answer that is not what
 * its signature says is refused (SERVER_FACTS_INVALID), never read as if it were.
 */
export interface EconomicsFactsSources {
  /** Configuration: the protocol fee and the forbidden recipients. */
  env: NodeJS.ProcessEnv;
  /** The contributors registry's sealed rate schedules (`sealedSchedules`). The answer is checked before it is read. */
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

// ── JSON text admission and owned ordinary data ──────────────────────────────────────────────────

/** Refused admission becomes absent data, using the existing unreadable-request refusal path. */
function readRequestJson(requestJson: string): unknown {
  if (typeof requestJson !== "string") return undefined; // identity-only: never inspect or coerce a rejected argument
  try {
    if (Buffer.byteLength(requestJson, "utf8") > MAX_REQUEST_JSON_BYTES) return undefined;
    return JSON.parse(requestJson); // no reviver; the tree stays private and originates in this realm
  } catch {
    // Invalid JSON or an engine error. Convert to refusals without inspecting what was thrown.
    return undefined;
  }
}

/**
 * One own data property of the internally parsed request, read once; undefined for an accessor, a
 * missing key or a Proxy (`util.types.isProxy` invokes no trap).
 */
function field(from: unknown, key: string): unknown {
  try {
    if (typeof from !== "object" || from === null || utilTypes.isProxy(from)) return undefined;
    const d = Object.getOwnPropertyDescriptor(from, key);
    return d !== undefined && "value" in d ? d.value : undefined;
  } catch {
    return undefined;
  }
}

/** snapshotJson's bounds (@pcc/spec economics/input.ts), so the copy refuses at the same sizes. */
const MAX_COPY_DEPTH = 64;
const MAX_COPY_ARRAY_LENGTH = 65_536;
const MAX_COPY_VALUES = 1_000_000;
/**
 * The copy's work budget, which snapshotJson does not have (EC6 r2, finding 1): the own keys it examines. An object
 * costs every own key, including a non-enumerable one it skips, and a list costs its length and each entry. Each is
 * charged before any of them is read, and a shared object is charged again on every visit. Every value but the root
 * is reached through one key or entry, and each list adds its length, so data whose keys are all enumerable examines
 * at most 2 × values − 1 keys. Within MAX_COPY_VALUES this budget refuses none of it: only keys the copy skips can
 * exhaust the budget first.
 */
const MAX_COPY_WORK = 2 * MAX_COPY_VALUES;
/** Thrown only inside `ownedJson`, whose catch never reads what was thrown. */
const NOT_DATA: unique symbol = Symbol("not-data");

export type OwnedJson = { ok: true; value: unknown } | { ok: false };

/**
 * An owned copy of ordinary data of this realm, read without running code it carries (EC6 M1; the seam's `plainCopy`
 * is the model). This guarantee excludes exotic host objects such as VM globals: reflection on them can invoke
 * caller code despite util.types.isProxy false. This is NOT an untrusted-object boundary; the public entry points
 * admit JSON text and parse it internally. Trusted server answers are copied here as defence in depth.
 * `util.types.isProxy`, which invokes no trap, is asked of every object before anything else touches
 * it, so a Proxy anywhere, revoked or not, refuses the whole value and none of its traps runs. Only own data
 * properties are read, through their descriptors, so no getter and no `toJSON` runs either.
 *
 * Its data rules are `snapshotJson`'s. It refuses accessors, symbol keys, holes, cycles, functions, bigint, undefined,
 * and objects with a prototype other than Object.prototype or null; it skips non-enumerable keys, and it has the same
 * depth, length and size bounds. Nothing thrown inside escapes, and the catch inspects nothing.
 *
 * It also has a work budget (MAX_COPY_WORK). It reads at most one descriptor past the budget: the length of a list
 * whose charge then crosses it. It lists the keys of at most one object past the budget, the one whose keys cross it,
 * so enumeration itself requires a width bound. Parsed requests have the enforced byte cap; trusted server sources
 * supply their own ordinary objects. These work guarantees do not apply to exotic host wrappers.
 *
 * Parity with `snapshotJson` (EC6 r2, finding 2): for ordinary data of this realm that holds no Proxy, stays within
 * the work budget, and whose every diagnostic path `snapshotJson` can build, the two readers accept and refuse the
 * same values and copy them equally. For ordinary data, three documented exceptions have tests pinning each one:
 *   - an explicit Proxy: refused here, by design (EC6 R2-D2); JSON text cannot encode one;
 *   - more keys than MAX_COPY_WORK: refused here, by design. Only keys the copy skips can cause this; parsed JSON
 *     has enumerable keys;
 *   - a path longer than the engine's longest string: `snapshotJson` names each value by its path (`input.a[0]`), so it
 *     refuses such a value. This copy builds no path, so it reads the value. The service's byte cap applies first.
 */
export function ownedJson(root: unknown): OwnedJson {
  let values = 0;
  let work = 0;
  /** Charges keys about to be examined, before any of them is read. */
  const examine = (keys: number): void => {
    work += keys;
    if (work > MAX_COPY_WORK) throw NOT_DATA;
  };
  const onPath = new Set<object>();
  const copy = (v: unknown, depth: number): unknown => {
    if (++values > MAX_COPY_VALUES) throw NOT_DATA;
    if (v === null || typeof v === "string" || typeof v === "boolean" || typeof v === "number") return v;
    // A function, bigint, symbol or undefined is not JSON data, and a Proxy is refused before it is touched.
    if (typeof v !== "object" || utilTypes.isProxy(v)) throw NOT_DATA;
    if (depth >= MAX_COPY_DEPTH || onPath.has(v)) throw NOT_DATA;
    onPath.add(v);
    try {
      if (Array.isArray(v)) {
        const length: unknown = Object.getOwnPropertyDescriptor(v, "length")?.value;
        if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 || length > MAX_COPY_ARRAY_LENGTH) throw NOT_DATA;
        examine(1 + length); // its length, and each entry
        const out: unknown[] = [];
        for (let i = 0; i < length; i++) {
          const d = Object.getOwnPropertyDescriptor(v, i);
          if (d === undefined || !("value" in d)) throw NOT_DATA; // a hole, or an accessor
          out.push(copy(d.value, depth + 1));
        }
        return out;
      }
      const proto: unknown = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) throw NOT_DATA;
      const keys = Reflect.ownKeys(v);
      examine(keys.length); // every own key, the non-enumerable ones it skips included
      const out: Record<string, unknown> = {};
      for (const key of keys) {
        if (typeof key === "symbol") throw NOT_DATA;
        const d = Object.getOwnPropertyDescriptor(v, key);
        if (d === undefined || !d.enumerable) continue; // own enumerable keys only, as snapshotJson and JSON.stringify
        if (!("value" in d)) throw NOT_DATA;
        // defineProperty, not assignment: a "__proto__" key stays an own key, for the closed schemas to refuse.
        Object.defineProperty(out, key, { value: copy(d.value, depth + 1), enumerable: true, writable: true, configurable: true });
      }
      return out;
    } finally {
      onPath.delete(v);
    }
  };
  try {
    return { ok: true, value: copy(root, 0) };
  } catch {
    // NOT_DATA, or an engine error (a module namespace's uninitialized binding). What was thrown is never read.
    return { ok: false };
  }
}

/** The schedules source's answer, as `SealedSchedules` says it is, bounded by the lookups it was asked for. */
const SealedSchedulesSchema = z.object({ available: z.boolean(), schedules: z.array(RateScheduleSchema).max(MAX_SCHEDULE_LOOKUPS) }).strict();

const PlanNodesSchema = z
  .array(z.object({ nodeId: IdSchema, capabilityId: IdSchema }).strict())
  .max(MAX_PLAN_NODES)
  .refine((ns) => new Set(ns.map((n) => n.nodeId)).size === ns.length, "a node is listed twice");

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function assemble(agreementCopy: OwnedJson, request: unknown, sources: EconomicsFactsSources): ServerEconomicsFactsResult {
  const refusals: EconomicsFactsRefusal[] = [];
  const env: NodeJS.ProcessEnv = sources.env ?? {}; // no configuration is unconfigured, never process.env by default

  const parsed = agreementCopy.ok ? EconomicAgreementSchema.safeParse(agreementCopy.value) : null;
  const ag: EconomicAgreement | null = parsed !== null && parsed.success ? parsed.data : null;
  if (ag === null) refusals.push({ code: "AGREEMENT_UNREADABLE" });

  const nodesCopy = ownedJson(field(request, "nodes"));
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

  // Rate schedules: the registry's sealed bodies for the hashes the agreement names. The answer is copied and checked
  // before anything reads it (EC6 M2); the call itself stays outside, so a source that throws still propagates.
  let schedules: RateSchedule[] = [];
  if (ag !== null) {
    const answer: unknown = sources.sealedSchedules(namedScheduleHashes(ag));
    const copy = ownedJson(answer);
    const sealed = copy.ok ? SealedSchedulesSchema.safeParse(copy.value) : null;
    if (sealed === null || !sealed.success) refusals.push({ code: "SERVER_FACTS_INVALID", detail: "schedules (the registry answered malformed schedules)" });
    else if (!sealed.data.available) refusals.push({ code: "SCHEDULE_REGISTRY_UNAVAILABLE" });
    else {
      schedules = sealed.data.schedules;
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
        const copy = ownedJson(answer);
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

/**
 * The facts the binding checks the request's agreement against, or every missing fact by name. Admit primitive JSON
 * text of at most 1 MiB in UTF-8 bytes, parsed here without a reviver; refuse non-strings unread, and invalid or
 * oversized text through the existing unreadable-request codes. Sources are trusted server functions.
 * Copier parity is for ordinary data of this realm without Proxies, within the work budget and representable paths;
 * exceptions are explicit Proxy refusal, extra work for skipped keys, and accepting paths snapshotJson cannot build.
 */
export function serverEconomicsFacts(requestJson: string, sources: EconomicsFactsSources = productionEconomicsFactsSources()): ServerEconomicsFactsResult {
  const request = readRequestJson(requestJson);
  return assemble(ownedJson(field(request, "agreement")), request, sources);
}

export type EconomicsBindingResult =
  | { ok: true; binding: EconomicsBinding; facts: ServerEconomicsFacts }
  | { ok: false; refusals: EconomicsFactsRefusal[] };

/**
 * The seam's `economics` dependency for one request. Admit primitive JSON text of at most 1 MiB in UTF-8 bytes,
 * parsed here without a reviver; refuse non-strings unread and invalid or oversized text through the existing
 * unreadable-request codes. Sources are trusted server functions. Copier parity is for ordinary data of this realm
 * without Proxies, within the work budget and representable paths; exceptions are explicit Proxy refusal, extra
 * work for skipped keys, and accepting paths snapshotJson cannot build.
 * The agreement is read ONCE: its facts are assembled from that
 * copy, and both halves of the binding are bound to the same copy, so the rows looked up, the gross reserved and
 * the split compiled all describe one agreement. `accepted` is what the payer accepted (from the accepted-agreement
 * store, operator item 27), or literal JSON null when this acceptance is the payer's. Absence stays undefined and
 * the binding refuses it; it is never taken as null.
 */
export function economicsBindingFor(
  requestJson: string,
  sources: EconomicsFactsSources = productionEconomicsFactsSources(),
): EconomicsBindingResult {
  const request = readRequestJson(requestJson);
  const copy = ownedJson(field(request, "agreement"));
  const assembled = assemble(copy, request, sources);
  if (!assembled.ok) return assembled;
  const agreement = copy.ok ? copy.value : undefined; // facts were assembled, so the copy parsed
  // Only null means "this acceptance is the payer's". Anything else reaches the binding as an owned copy; a value the
  // copy refuses reaches it as undefined, as an absent one does. The binding checks both and
  // refuses them (AGREEMENT_HASH_MISMATCH:SCHEMA_INVALID); neither is ever taken as null.
  const acceptedRaw = field(request, "accepted");
  const acceptedCopy = acceptedRaw === null ? null : ownedJson(acceptedRaw);
  const accepted = (acceptedCopy === null ? null : acceptedCopy.ok ? acceptedCopy.value : undefined) as AcceptedAgreementHashes | null;
  return {
    ok: true,
    facts: assembled.facts,
    binding: {
      unitGross: () => agreementUnitGross(agreement),
      splitNet: netSplitterFor({ agreement, accepted, server: assembled.facts }),
    },
  };
}
