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
import type { RateSchedule } from "@pcc/spec";
import { configuredProtocolFee, namedScheduleHashes, sealedSchedules } from "../services/server-economics-facts.js";

// The preview and the accept-time binding read the fee and the sealed schedules through the same functions.
export { configuredProtocolFee } from "../services/server-economics-facts.js";

const MAX_DEFAULT_FAILURE_SCENARIOS = 4;

interface PreviewBody {
  agreement?: unknown;
  templateId?: string;
  scenarios?: unknown[];
}

function configuredForbiddenRecipients(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.PCC_FORBIDDEN_RECIPIENTS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^0x[0-9a-fA-F]{40}$/.test(s));
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
    let exampleTemplateId: string | undefined;
    const extraSchedules: RateSchedule[] = [];
    if (typeof body.templateId === "string") {
      const t = AGREEMENT_TEMPLATES.find((x) => x.templateId === body.templateId);
      if (!t) return reply.code(404).send({ error: "template_not_found", message: `No template "${body.templateId}".` });
      const built = asOfNow(t.build(), now);
      // A template is a starting point: PCC fills in the fee it actually charges.
      if (fee !== null) built.fee = { feeBps: fee.feeBps, feeRecipient: fee.feeRecipient };
      agreement = built;
      exampleTemplateId = t.templateId;
      extraSchedules.push(...t.compileOptions.schedules); // content-addressed demo bodies, re-verified by hash
    } else if (body.agreement !== undefined) {
      agreement = body.agreement;
    } else {
      return reply.code(400).send({ error: "agreement_required", message: "Send an agreement, or a templateId from GET /api/economics/templates." });
    }

    // Where each schedule body came from, so a verified rate says which (astra EC3 M2): only the registry's
    // bodies are published; a template's bundled bodies are examples, even when they hash correctly.
    // Without a registry there are no registered bodies, and every pin stays unverified.
    const registered = sealedSchedules(namedScheduleHashes(agreement)).schedules;
    const scheduleSources: Record<string, "registry" | "example"> = {};
    for (const x of extraSchedules) scheduleSources[x.scheduleHash.toLowerCase()] = "example";
    for (const x of registered) scheduleSources[x.scheduleHash.toLowerCase()] = "registry";
    const options: CompileOptions = {
      schedules: [...registered, ...extraSchedules],
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
    return {
      preview: buildEconomicPreview(agreement, result, {
        feeVerified: fee !== null,
        scenarios,
        now,
        scheduleSources,
        ...(exampleTemplateId !== undefined ? { exampleTemplateId } : {}),
      }),
    };
  });
}
