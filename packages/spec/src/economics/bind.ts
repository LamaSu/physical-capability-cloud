/**
 * netSplitterFor — the economics half of the accepted-plan seam (composition #351, `CompileDeps.splitNet`).
 *
 * The accepted-plan compiler owns unit order, node ↔ unit identity and the fee rule; economics owns how
 * each unit's net is split. At accept time the agreement must not be taken on the caller's word, whether
 * the server loaded it by id or the plan carried it. This binding REFUSES, and never repairs, unless:
 *
 *   1. the agreement is still exactly what the payer accepted (when accepted hashes are given), with
 *      the refusal naming which half moved (rights, economics, envelope);
 *   2. every authority-bearing field equals server state: the fee and currency the plan was priced with,
 *      the unit set and each unit's gross (the server quote), and every license, which must equal the
 *      server's registry copy at licenseId@version, INCLUDING its authority level (the caller's copy
 *      never sets its own authority);
 *   3. `compileEconomics` accepts it, given the server's sealed rate-schedule bodies and forbidden
 *      recipients.
 *
 * Only then does it return each unit's payouts in the shape `splitNet` expects. The seam re-checks that
 * output independently (Σ == n, 1–16 legs, non-zero recipients), so neither side trusts the other.
 */

import { canonicalize } from "../util/canonical.js";
import type { RateSchedule } from "../types/rate-schedule.js";
import { compileEconomics } from "./compile.js";
import { EconomicAgreementSchema, ZERO_ADDRESS, type Authority, type License } from "./types.js";
import { verifyAcceptedAgreement, type AcceptedAgreementHashes } from "./verify.js";

/** One unit as the accepted-plan compiler hands it over, in canonical plan order. */
export interface PlanSplitUnit {
  nodeId: string;
  operator: string;
  payoutAddress: string;
  g: bigint;
  f: bigint;
  n: bigint;
}

/** Structurally identical to composition's `NetSplitResult` (#351). Amounts are base-unit strings. */
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
      economicTermsHash: string;
      rightsTermsHash: string;
    }
  | { ok: false; code: string };

export type PlanSplitter = (units: readonly PlanSplitUnit[]) => PlanSplitResult;

/** What the server knows, independently of anything the caller sent. */
export interface ServerEconomicsFacts {
  /** The plan's server-resolved fee: the same values the accepted-plan compiler prices with. */
  feeBps: number;
  /** Composition's convention: the zero address when feeBps is 0. */
  feeRecipient: string;
  /** Settlement currency and its server-owned decimals. */
  currency: { code: string; decimals: number };
  /** The server's registry copies of licenses. An agreement may cite only these, and only verbatim. */
  licenses: readonly License[];
  /** Sealed rate-schedule bodies (the `rate_schedules` table), so pinned royalty rates are verified. */
  schedules: readonly RateSchedule[];
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
  "SCHEMA_INVALID",
  "AGREEMENT_HASH_MISMATCH",
  "FEE_MISMATCH",
  "CURRENCY_MISMATCH",
  "LICENSE_NOT_REGISTERED",
  "LICENSE_MISMATCH",
  "UNIT_SET_MISMATCH",
  "GROSS_MISMATCH",
  "COMPILE_REFUSED",
  "FEE_RULE_DIVERGED",
] as const;
export type BindRefusalCode = (typeof BIND_REFUSAL_CODES)[number];

/** Refusal codes read `economics:<CODE>[:<detail>]`, bounded, so the seam can record them verbatim. */
function refuse(code: BindRefusalCode, detail?: string): PlanSplitResult {
  const text = detail === undefined ? `economics:${code}` : `economics:${code}:${detail}`;
  return { ok: false, code: text.length > 256 ? `${text.slice(0, 253)}...` : text };
}

const lower = (s: string) => s.toLowerCase();

export function netSplitterFor(input: NetSplitterInput): PlanSplitter {
  // Snapshot the server facts now, so a caller mutating them later cannot change a decision.
  const server = structuredClone(input.server);
  const accepted = input.accepted === null ? null : { ...input.accepted };
  let agreementSnapshot: unknown;
  try {
    agreementSnapshot = structuredClone(input.agreement);
  } catch {
    agreementSnapshot = undefined; // uncloneable (functions, proxies): refused below as a schema failure
  }

  return (units) => {
    const parsed = EconomicAgreementSchema.safeParse(agreementSnapshot);
    if (!parsed.success) return refuse("SCHEMA_INVALID");
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

    // Licenses: only the server's registry copies, verbatim (authority level included).
    const registry = new Map<string, string>(server.licenses.map((l) => [`${l.licenseId}@${l.version}`, canonicalize(l)]));
    for (const l of ag.licenses) {
      const key = `${l.licenseId}@${l.version}`;
      const registered = registry.get(key);
      if (registered === undefined) return refuse("LICENSE_NOT_REGISTERED", key);
      if (registered !== canonicalize(l)) return refuse("LICENSE_MISMATCH", key);
    }

    // Units: exactly the plan's nodes, each at the server-quoted gross.
    const byRef = new Map(ag.units.map((u) => [u.unitRef, u] as const));
    const nodeIds = new Set(units.map((u) => u.nodeId));
    if (nodeIds.size !== units.length || byRef.size !== units.length || units.some((u) => !byRef.has(u.nodeId))) {
      return refuse("UNIT_SET_MISMATCH");
    }
    for (const u of units) {
      if (BigInt(byRef.get(u.nodeId)!.gross) !== u.g) return refuse("GROSS_MISMATCH", u.nodeId);
    }

    const compiled = compileEconomics(ag, {
      forbiddenRecipients: server.forbiddenRecipients,
      schedules: server.schedules,
      ...(server.authorityFloor !== undefined ? { authorityFloor: server.authorityFloor } : {}),
    });
    if (!compiled.ok) {
      const codes = [...new Set(compiled.refusals.map((r) => r.code))].sort();
      return refuse("COMPILE_REFUSED", codes.join(","));
    }

    const compiledByRef = new Map(compiled.units.map((u) => [u.unitRef, u] as const));
    const out: Extract<PlanSplitResult, { ok: true }>["units"] = [];
    for (const u of units) {
      const c = compiledByRef.get(u.nodeId)!;
      // One fee rule, the escrow's. Both sides compute it; if they ever disagree, nothing is funded.
      if (BigInt(c.fee) !== u.f || BigInt(c.net) !== u.n) return refuse("FEE_RULE_DIVERGED", u.nodeId);
      out.push({ unitRef: c.unitRef, gross: c.gross, fee: c.fee, net: c.net, payouts: c.payouts.map((p) => ({ ...p })) });
    }
    return { ok: true, units: out, economicTermsHash: compiled.economicTermsHash, rightsTermsHash: compiled.rightsTermsHash };
  };
}
