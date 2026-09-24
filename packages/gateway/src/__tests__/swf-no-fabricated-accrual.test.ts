/**
 * The Sovereign Wealth Fund's ledger is in memory, and the escrow routes no share of a release to it. A
 * settlement path that accrues to it records money that never moved: both release paths used to accrue a
 * constant 1000 for every released milestone, whatever was paid (readmodels #3284, N34's review of #421).
 * This test keeps any such call from coming back until a real flow into the fund exists.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { swfService } from "../routes/swf.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === "__tests__" ? [] : sources(p);
    return /\.ts$/.test(name) ? [p] : [];
  });
}

describe("no fabricated accruals into the SWF", () => {
  it("no gateway source calls swfAccrue: only a real flow into the fund may, and none exists yet", () => {
    const callers = sources(SRC)
      .filter((p) => relative(SRC, p) !== join("routes", "swf.ts"))
      .filter((p) => /\bswfAccrue\s*\(/.test(readFileSync(p, "utf-8")))
      .map((p) => relative(SRC, p));
    expect(callers).toEqual([]);
  });

  it("the fund's summary invents no distribution time and no chain balance", () => {
    const summary = swfService.getSummary();
    expect(summary.chainBalances).toEqual([]);
    expect(summary.unavailable).toContain("chainBalances");
    if (summary.lastDistributionAt === null) expect(summary.unavailable).toContain("lastDistributionAt");
  });
});
