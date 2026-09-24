/**
 * Economic agreements: listable templates and the approval preview (PX-12).
 *
 *   GET  /api/economics/templates  — example agreements an agent or a person can start from
 *   POST /api/economics/preview    — { agreement | templateId, scenarios? } → { preview }
 *
 * The preview answers "who gets paid what, when, and why" before anyone accepts. It is computed here,
 * on the server, by the one economics compiler, from server-owned facts. The browser only renders it:
 *   - the protocol fee PCC charges: PCC_PROTOCOL_FEE_BPS and PCC_PROTOCOL_FEE_RECIPIENT. When they
 *     are not configured, the preview says the fee is unchecked rather than presenting the author's
 *     number as PCC's;
 *   - the sealed rate schedules the agreement names, from the contributors registry, so a pinned
 *     royalty rate is verified, not taken on the author's word;
 *   - the addresses no payout may go to: PCC_FORBIDDEN_RECIPIENTS (the settlement token, the factory).
 *
 * It is a prediction (Layer C): it creates no deal, reserves nothing and pays nothing.
 */

import type { FastifyInstance } from "fastify";
import {
  AGREEMENT_TEMPLATES,
  buildEconomicPreview,
  compileEconomics,
  simulateEconomics,
  type CompileOptions,
  type EconomicAgreement,
} from "@pcc/spec/economics";
import { assertScheduleIsWellFormed, computeScheduleHash, type RateSchedule } from "@pcc/spec";
import { getRepos } from "../db.js";

const MAX_SCHEDULE_LOOKUPS = 64;
const MAX_DEFAULT_FAILURE_SCENARIOS = 4;

interface PreviewBody {
  agreement?: unknown;
  templateId?: string;
  scenarios?: unknown[];
}

/** The fee PCC charges, from configuration; null when it is not configured (or configured wrong). */
export function configuredProtocolFee(env: NodeJS.ProcessEnv = process.env): { feeBps: number; feeRecipient: string | null } | null {
  const raw = env.PCC_PROTOCOL_FEE_BPS;
  if (raw === undefined || raw.trim() === "") return null;
  const feeBps = Number(raw);
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 1000) return null;
  const recipient = env.PCC_PROTOCOL_FEE_RECIPIENT?.trim() ?? "";
  if (feeBps === 0) return { feeBps, feeRecipient: null };
  return /^0x[0-9a-fA-F]{40}$/.test(recipient) ? { feeBps, feeRecipient: recipient } : null;
}

function configuredForbiddenRecipients(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.PCC_FORBIDDEN_RECIPIENTS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^0x[0-9a-fA-F]{40}$/.test(s));
}

/** Every schedule hash the (untrusted) agreement names, for lookup only. */
function namedScheduleHashes(agreement: unknown): string[] {
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

/**
 * The sealed bodies the registry holds for those hashes. A body the compiler could not use (one sealed
 * before the registry checked number ranges, or a stored copy that no longer hashes to its label) is
 * left out, so the pin it would verify is refused at its own clause (RATE_UNVERIFIED), instead of the
 * server's bad record refusing the whole agreement as malformed options. The compiler re-checks both.
 */
function sealedSchedules(hashes: readonly string[]): RateSchedule[] {
  const out: RateSchedule[] = [];
  let repos: ReturnType<typeof getRepos>;
  try {
    repos = getRepos();
  } catch {
    return out; // no registry: pins stay unverified, and a license that needs one is refused
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
  return out;
}

/**
 * A template is a starting point, so it is shown as a deal priced now. Its offer window, its licenses'
 * validity and its pins' recorded moment all move by the same amount, and the seam's timing rules then
 * hold. Its schedules are constant in time, so every pinned rate still holds (a test checks this a year on).
 */
function asOfNow(ag: EconomicAgreement, now: number): EconomicAgreement {
  const delta = now - ag.asOf;
  const shift = (t: number | null) => (t === null ? null : t + delta);
  return {
    ...ag,
    asOf: now,
    terms: { ...ag.terms, acceptBy: shift(ag.terms.acceptBy) },
    clauses: ag.clauses.map((c) =>
      c.rule.kind === "percent" && c.rule.rateSource !== null
        ? { ...c, rule: { ...c.rule, rateSource: { ...c.rule.rateSource, evaluatedAt: c.rule.rateSource.evaluatedAt + delta } } }
        : c,
    ),
    licenses: ag.licenses.map((l) => ({ ...l, validFrom: shift(l.validFrom), validUntil: shift(l.validUntil) })),
  };
}

/** Default what-ifs: everything delivered, each step failing on its own, and a 20% lower price. */
function defaultScenarios(ag: EconomicAgreement): unknown[] {
  const units = [...ag.units].sort((a, b) => (a.unitRef < b.unitRef ? -1 : a.unitRef > b.unitRef ? 1 : 0));
  const scenarios: unknown[] = [{ scenarioId: "all-released", label: "Every step is delivered", grossOverrides: [], usesOverrides: [], outcomes: [] }];
  units.slice(0, MAX_DEFAULT_FAILURE_SCENARIOS).forEach((u, i) => {
    scenarios.push({
      scenarioId: `step-${i + 1}-fails`,
      label: Array.from(`"${u.label}" fails`).slice(0, 200).join(""), // by code point: never split a pair
      grossOverrides: [],
      usesOverrides: [],
      outcomes: [{ unitRef: u.unitRef, outcome: "refunded" }],
    });
  });
  scenarios.push({
    scenarioId: "price-20-lower",
    label: "The price is 20% lower",
    grossOverrides: units.map((u) => ({ unitRef: u.unitRef, gross: ((BigInt(u.gross) * 8n) / 10n).toString() })),
    usesOverrides: [],
    outcomes: [],
  });
  return scenarios;
}

export async function economicsRoutes(app: FastifyInstance) {
  app.get("/api/economics/templates", async () => ({
    templates: AGREEMENT_TEMPLATES.map((t) => ({ templateId: t.templateId, title: t.title, summary: t.summary })),
  }));

  app.post<{ Body: PreviewBody }>("/api/economics/preview", async (req, reply) => {
    const body = req.body ?? {};
    const fee = configuredProtocolFee();
    const now = Math.floor(Date.now() / 1000);
    let agreement: unknown;
    const extraSchedules: RateSchedule[] = [];
    if (typeof body.templateId === "string") {
      const t = AGREEMENT_TEMPLATES.find((x) => x.templateId === body.templateId);
      if (!t) return reply.code(404).send({ error: "template_not_found", message: `No template "${body.templateId}".` });
      const built = asOfNow(t.build(), now);
      // A template is a starting point: PCC fills in the fee it actually charges.
      if (fee !== null) built.fee = { feeBps: fee.feeBps, feeRecipient: fee.feeRecipient };
      agreement = built;
      extraSchedules.push(...t.compileOptions.schedules); // content-addressed demo bodies, re-verified by hash
    } else if (body.agreement !== undefined) {
      agreement = body.agreement;
    } else {
      return reply.code(400).send({ error: "agreement_required", message: "Send an agreement, or a templateId from GET /api/economics/templates." });
    }

    const options: CompileOptions = {
      schedules: [...sealedSchedules(namedScheduleHashes(agreement)), ...extraSchedules],
      forbiddenRecipients: configuredForbiddenRecipients(),
      ...(fee !== null ? { fee } : {}),
    };
    const result = compileEconomics(agreement, options);
    const scenarios =
      body.scenarios !== undefined
        ? simulateEconomics(agreement, body.scenarios, options)
        : result.ok
          ? simulateEconomics(agreement, defaultScenarios(agreement as EconomicAgreement), options)
          : [];
    return { preview: buildEconomicPreview(agreement, result, { feeVerified: fee !== null, scenarios, now }) };
  });
}
