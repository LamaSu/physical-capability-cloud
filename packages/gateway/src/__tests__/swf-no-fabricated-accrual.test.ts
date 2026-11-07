/**
 * The Sovereign Wealth Fund is a design artifact (operator item 69, steward's concurrence): its ledger is in
 * memory, nothing funds it, and its money routes answer 501. These tests keep that true:
 *   - no gateway code may put an amount into the fund, however the call is spelled (astra EC2 F5);
 *   - every unfunded money mutation is refused BEFORE it changes anything (astra EC2 F1);
 *   - the summary invents no distribution time, no chain balance, and does not pass simulated totals off as
 *     a measured fund (astra EC2 F2, F3).
 * Both release paths used to accrue a constant 1000 per released milestone (readmodels #3284).
 */
import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { swfRoutes, swfService } from "../routes/swf.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const SWF_ROUTES = join("routes", "swf.ts");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === "__tests__" ? [] : sources(p);
    return /\.ts$/.test(name) ? [p] : [];
  });
}

describe("no gateway code puts an amount into the SWF", () => {
  it("swfAccrue is named nowhere but its own definition: no import, alias or re-export (astra EC2 F5)", () => {
    const named = sources(SRC)
      .filter((p) => relative(SRC, p) !== SWF_ROUTES)
      .filter((p) => /\bswfAccrue\b/.test(readFileSync(p, "utf-8")))
      .map((p) => relative(SRC, p));
    expect(named).toEqual([]);
    const own = readFileSync(join(SRC, SWF_ROUTES), "utf-8");
    expect(own.match(/\bswfAccrue\b/g)).toHaveLength(1); // the definition; nothing in the file calls it
  });

  it("no gateway code calls an .accrue( method, except the one line inside swfAccrue's definition", () => {
    const calls = sources(SRC).flatMap((p) =>
      (readFileSync(p, "utf-8").match(/\.accrue\s*\(/g) ?? []).map(() => relative(SRC, p)),
    );
    expect(calls).toEqual([SWF_ROUTES]);
  });
});

describe("unfunded SWF money mutations are refused and change nothing (astra EC2 F1)", () => {
  async function app() {
    const a = Fastify({ logger: false });
    // What apiGate does for an authenticated key: the caller has an identity.
    a.addHook("onRequest", async (req) => {
      (req as { operatorId?: string }).operatorId = "sponsor-1";
    });
    await a.register(swfRoutes);
    await a.ready();
    return a;
  }
  const state = () => JSON.stringify({ portfolio: swfService.getEquityPortfolio(), summary: swfService.getSummary(), epochs: swfService.listEpochs() });

  it("accepting terms, activating a position, recording revenue and distributing an epoch all answer 501", async () => {
    const a = await app();
    const proposed = await a.inject({
      method: "POST",
      url: "/api/swf/terms/propose",
      payload: {
        capabilityType: "cnc",
        operatorId: "op-1",
        equityTier: "seed",
        seedAmount: 1000,
        costModel: { capex: 1000, monthlyOpex: 100, avgJobPrice: 100, maxJobsPerMonth: 10, expectedUtilizationPercent: 100 },
      },
    });
    expect(proposed.statusCode).toBe(201); // a proposal moves no money
    const termSheetId = proposed.json<{ termSheet: { id: string } }>().termSheet.id;
    const epochId = swfService.getActiveEpoch()!.id;
    const before = state();

    const accept = await a.inject({ method: "POST", url: `/api/swf/terms/${termSheetId}/accept`, payload: {} });
    const activate = await a.inject({ method: "POST", url: "/api/swf/equity/pos-any/activate", payload: {} });
    const revenue = await a.inject({ method: "POST", url: "/api/swf/equity/record-revenue", payload: { equityPositionId: "pos-any", jobId: "job-invented", protocolFee: 100 } });
    const distribute = await a.inject({ method: "POST", url: `/api/swf/epochs/${epochId}/distribute`, payload: {} });

    expect([accept.statusCode, activate.statusCode, revenue.statusCode, distribute.statusCode]).toEqual([501, 501, 501, 501]);
    for (const r of [accept, activate, revenue, distribute]) expect(r.json<{ error: string }>().error).toBe("not_available");
    expect(state()).toBe(before);
    const portfolio = swfService.getEquityPortfolio();
    expect([portfolio.totalDeployed, portfolio.totalRevenueEarned]).toEqual(["0", "0"]);
    await a.close();
  });
});

describe("the fund's summary tells the truth (astra EC2 F2, F3)", () => {
  it("no distribution time, no chain balance, and every total is labelled simulation and unavailable as a fund figure", () => {
    const summary = swfService.getSummary();
    expect(summary.lastDistributionAt).toBeNull();
    expect(summary.chainBalances).toEqual([]);
    expect(summary.basis).toBe("simulation");
    expect(summary.unavailable).toEqual(["totalBalance", "totalAccruedAllTime", "totalDistributedAllTime", "lastDistributionAt", "chainBalances"]);
  });
});
