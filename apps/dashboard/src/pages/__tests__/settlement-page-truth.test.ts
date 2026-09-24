/**
 * PX-3: the Settlement page started from invented queue numbers and epochs, and kept them
 * whenever a read failed or the gateway had no epochs ("Try to fetch live data, fall back to
 * mock"). The dashboard has no React Testing Library, so (like job-pages-truth) this reads
 * the page source; the view rules are unit-tested in lib/__tests__/settlement-queue-view.test.ts.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const page = readFileSync(resolve(here, "..", "SettlementPage.tsx"), "utf-8");

describe("SettlementPage shows the gateway's queue, or why it can't", () => {
  it("reads through the typed queue view", () => {
    expect(page).toContain("statusFromResponse(");
    expect(page).toContain("epochsFromResponse(");
    expect(page).toContain("flushOutcome(");
  });

  it("NEGATIVE: no mock state, no fallback to it", () => {
    expect(page).not.toMatch(/MOCK_|mockStatus|mockEpochs|fall back to mock|keep mock/i);
    expect(page).not.toMatch(/useState<QueueStatus>\(|useState<EpochSummary\[\]>\(/);
    expect(page).toContain("useState<Read<QueueStatus>>(LOADING)");
    expect(page).toContain("useState<Read<EpochSummary[]>>(LOADING)");
  });

  it("NEGATIVE: contains no hard-coded hashes, addresses or agent names", () => {
    expect(page).not.toMatch(/0x[0-9a-fA-F]{6,}/);
    expect(page).not.toMatch(/kernel-agent-\d|user-agent|broker-agent/);
  });

  it("NEGATIVE: an empty history is never kept as examples, and a failed read is never a zero", () => {
    expect(page).not.toMatch(/epochs\?\.length\)\s*setEpochs/);
    // Both reads are shown as they come back, whatever they hold (an empty list included).
    expect(page).toMatch(/const \[s, e\] = await Promise\.all\(\[loadStatus\(\), loadEpochs\(\)\]\);\s*setStatus\(s\);\s*setEpochs\(e\);/);
    expect(page).toContain("No epoch has settled since the gateway last started.");
    expect(page).toContain('const DASH = "—"');
  });

  it("NEGATIVE: claims no throughput multiplier", () => {
    expect(page).not.toMatch(/x throughput/);
  });
});
