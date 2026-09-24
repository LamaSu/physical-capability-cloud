/**
 * PX-12: the approval preview is computed on the server, from server-owned facts. These tests pin
 * where each fact comes from: the protocol fee from configuration (and says so when it is missing),
 * rate schedules from the contributors registry (a pin verifies only against a sealed body), and the
 * forbidden recipients from configuration. The agreement itself is only ever the author's proposal.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { canonicalize, computeScheduleHash, economics, type RateSchedule } from "@pcc/spec";
import { configuredProtocolFee, economicsRoutes } from "../routes/economics.js";
import { closeStore, getRepos, initStore } from "../db.js";

const TREASURY = "0xfee0000000000000000000000000000000000fee";
const ENV_KEYS = ["PCC_PROTOCOL_FEE_BPS", "PCC_PROTOCOL_FEE_RECIPIENT", "PCC_FORBIDDEN_RECIPIENTS"] as const;

async function buildApp(): Promise<FastifyInstance> {
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: false });
  const app = Fastify({ logger: false });
  await app.register(economicsRoutes);
  await app.ready();
  return app;
}

type Preview = economics.EconomicPreviewDTO;

describe("PX-12 economics routes", () => {
  let app: FastifyInstance;
  const saved: Record<string, string | undefined> = {};

  beforeEach(async () => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    process.env.PCC_PROTOCOL_FEE_BPS = "235";
    process.env.PCC_PROTOCOL_FEE_RECIPIENT = TREASURY;
    delete process.env.PCC_FORBIDDEN_RECIPIENTS;
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
    closeStore();
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  const preview = async (payload: object) => {
    const res = await app.inject({ method: "POST", url: "/api/economics/preview", payload });
    return { status: res.statusCode, preview: res.json<{ preview: Preview }>().preview };
  };

  it("lists the templates an agent or a person can start from", async () => {
    const res = await app.inject({ method: "GET", url: "/api/economics/templates" });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ templates: Array<{ templateId: string }> }>().templates.map((t) => t.templateId)).toEqual([
      "spare-printer",
      "print-and-mail",
      "guild-repair",
      "lab-assay",
      "deck-milestones",
    ]);
  });

  it("previews a template with the server's fee checked, and default what-if scenarios", async () => {
    const { status, preview: p } = await preview({ templateId: "deck-milestones" });
    expect(status).toBe(200);
    expect(p.status).toBe("fundable");
    expect(p.protocolFee!.verified).toBe(true);
    expect(p.totals!.maxSpend.display).toBe("8000.00 USDC");
    expect(p.scenarios.map((s) => s.scenarioId)).toEqual(["all-released", "step-1-fails", "step-2-fails", "step-3-fails", "price-20-lower"]);
    const buildFails = p.scenarios.find((s) => s.scenarioId === "step-2-fails")!;
    if (!buildFails.fundable) throw new Error("fixture");
    expect(buildFails.payer.refunded.display).toBe("6500.00 USDC");
    // 20% lower still covers the deck's fixed costs: the homeowner would spend 6,400.
    const cheaper = p.scenarios.find((s) => s.scenarioId === "price-20-lower")!;
    if (!cheaper.fundable) throw new Error("fixture");
    expect(cheaper.payer.spent.display).toBe("6400.00 USDC");
  });

  it("a price that no longer covers a fixed upstream cost is shown as unfundable, with the reason", async () => {
    const { preview: p } = await preview({ templateId: "print-and-mail" });
    const cheaper = p.scenarios.find((s) => s.scenarioId === "price-20-lower")!;
    if (cheaper.fundable) throw new Error("expected the print step to be under water");
    expect(cheaper.reasons[0]).toContain("The payments add up to more than the price");
  });

  it("a template takes the fee PCC actually charges", async () => {
    process.env.PCC_PROTOCOL_FEE_BPS = "100";
    const { preview: p } = await preview({ templateId: "print-and-mail" });
    expect(p.protocolFee!.percent).toBe("1.00%");
    expect(p.totals!.protocolFee.display).toBe("0.22 USDC");
  });

  it("an author's agreement is held to the server's fee, not the other way round", async () => {
    const ag = economics.exampleLabAssay();
    ag.fee = { feeBps: 1000, feeRecipient: ag.parties.find((x) => x.partyId === "lab")!.payTo };
    const { preview: p } = await preview({ agreement: ag });
    expect(p.status).toBe("refused");
    expect(p.refusals.map((r) => [r.code, r.path])).toEqual([["FEE_INVALID", ["fee", "server-fee"]]]);
  });

  it("without a configured fee, the preview says the fee is unchecked instead of vouching for it", async () => {
    delete process.env.PCC_PROTOCOL_FEE_BPS;
    const { preview: p } = await preview({ agreement: economics.examplePrintAndMail() });
    expect(p.status).toBe("fundable");
    expect(p.protocolFee!.verified).toBe(false);
    expect(p.headline).toContain("not yet checked");
  });

  it("a pinned royalty verifies only against the sealed schedule in the registry", async () => {
    const ag = economics.exampleSparePrinter();
    // Not in the registry: the license needs the rate checked, so the preview is a refusal.
    const before = await preview({ agreement: ag });
    expect(before.preview.refusals.map((r) => r.code)).toEqual(["RATE_UNVERIFIED"]);
    // Published to the registry: the same agreement now previews, with the rate marked verified.
    const s = economics.PRINTER_KIT_SCHEDULE;
    getRepos().contributors.publishSchedule({
      scheduleHash: s.scheduleHash,
      version: s.version,
      segmentsJson: canonicalize(s.segments),
      notes: s.notes ?? null,
      publishedBy: "0x00000000000000000000000000000000009a1a03",
      publishedAt: s.publishedAt,
    });
    const after = await preview({ agreement: ag });
    expect(after.preview.status).toBe("fundable");
    expect(after.preview.rates[0]!.verified).toBe(true);
  });

  it("a registry body the compiler cannot use is left out, so the refusal names the clause, not the agreement", async () => {
    // Sealed before the registry checked number ranges: 2^53 hashes fine, but it is not one number to every reader.
    const segments = [{ kind: "piecewise-value", startTime: 0, endTime: null, thresholdCents: 2 ** 53, bpsLow: 40, bpsHigh: 40 }];
    const scheduleHash = computeScheduleHash({ version: 1, segments } as unknown as RateSchedule);
    getRepos().contributors.publishSchedule({
      scheduleHash,
      version: 1,
      segmentsJson: canonicalize(segments),
      notes: null,
      publishedBy: "0x00000000000000000000000000000000009a1a03",
      publishedAt: "2026-06-01T00:00:00Z",
    });
    const ag = economics.exampleSparePrinter();
    ag.licenses[0]!.requires.payments[0]!.rule = { kind: "percent_by_schedule", scheduleHash, of: "gross", min: null, max: null };
    const royalty = ag.clauses.find((c) => c.clauseId === "kit-royalty")!;
    if (royalty.rule.kind !== "percent" || royalty.rule.rateSource === null) throw new Error("fixture");
    royalty.rule.rateSource.scheduleHash = scheduleHash;
    const { preview: p } = await preview({ agreement: ag });
    expect(p.refusals.map((r) => [r.code, r.path])).toEqual([["RATE_UNVERIFIED", ["clause", "kit-royalty", "rateSource"]]]);
  });

  it("configured forbidden recipients are enforced", async () => {
    const ag = economics.examplePrintAndMail();
    process.env.PCC_FORBIDDEN_RECIPIENTS = ag.parties.find((x) => x.partyId === "courier")!.payTo!;
    const { preview: p } = await preview({ agreement: ag });
    expect(p.refusals.map((r) => r.code)).toContain("FORBIDDEN_RECIPIENT");
  });

  it("a missing agreement is 400 and an unknown template 404", async () => {
    expect((await app.inject({ method: "POST", url: "/api/economics/preview", payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/economics/preview", payload: { templateId: "nope" } })).statusCode).toBe(404);
  });

  it("configuredProtocolFee refuses a malformed configuration rather than guessing", () => {
    expect(configuredProtocolFee({ PCC_PROTOCOL_FEE_BPS: "235", PCC_PROTOCOL_FEE_RECIPIENT: TREASURY })).toEqual({ feeBps: 235, feeRecipient: TREASURY });
    expect(configuredProtocolFee({ PCC_PROTOCOL_FEE_BPS: "0" })).toEqual({ feeBps: 0, feeRecipient: null });
    expect(configuredProtocolFee({ PCC_PROTOCOL_FEE_BPS: "235" })).toBeNull(); // no recipient
    expect(configuredProtocolFee({ PCC_PROTOCOL_FEE_BPS: "2.35", PCC_PROTOCOL_FEE_RECIPIENT: TREASURY })).toBeNull();
    expect(configuredProtocolFee({ PCC_PROTOCOL_FEE_BPS: "5000", PCC_PROTOCOL_FEE_RECIPIENT: TREASURY })).toBeNull();
    expect(configuredProtocolFee({})).toBeNull();
  });
});
