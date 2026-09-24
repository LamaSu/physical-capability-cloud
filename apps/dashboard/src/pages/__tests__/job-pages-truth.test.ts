/**
 * PX-6 continuity guard: the job detail page (the drill-down from the live Jobs list) is
 * a projection of the gateway's JobExecutionDTO, with no fixtures and no fabricated
 * values. (JobsPage itself is the shell lane's, PX-3.)
 *
 * The dashboard has no React Testing Library, so (like OnboardLandingPage.test.tsx) this
 * reads the page source as text and asserts what must and must not be in it. The
 * rendering rules themselves are unit-tested in lib/__tests__/job-execution-view.test.ts.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (f: string) => readFileSync(resolve(here, "..", f), "utf-8");
const detail = read("JobDetailPage.tsx");

describe("JobDetailPage reads the gateway read model", () => {
  it("uses the JobExecutionDTO hook", () => {
    expect(detail).toContain("useJobExecution");
  });

  it("NEGATIVE: imports no fixtures or demo data", () => {
    const imports = detail.split("\n").filter((l) => /^\s*import\b/.test(l) || /\bfrom\s+"/.test(l)).join("\n");
    expect(imports).not.toMatch(/mock-data|fixtures|viewer/);
    expect(detail).not.toMatch(/mockJobs|mockEscrows|mockEvidence|jobMeta|makeDemo|Load demo trace/);
  });

  it("NEGATIVE: contains no hard-coded hashes, CIDs, DIDs or transaction ids", () => {
    expect(detail).not.toMatch(/0x[0-9a-fA-F]{40,}/);
    expect(detail).not.toMatch(/bafy[a-z0-9]{20,}/);
    expect(detail).not.toMatch(/did:pcc:/);
    expect(detail).not.toMatch(/sha256:[0-9a-f]{16,}/);
  });

  it("tells not-found apart from unavailable", () => {
    expect(detail).toContain("Job not found");
    expect(detail).toContain("Job details are unavailable right now");
    expect(detail).toContain("status === 404");
  });

  it("marks a failed refresh as stale instead of hiding it", () => {
    expect(detail).toMatch(/last successful read/);
  });

  it("NEGATIVE (review P1-4): never re-classifies raw money strings; record statuses go through the neutral badge", () => {
    expect(detail).not.toMatch(/moneyBadgeColor|classifyMoneyStatus|moneyStatusColor/);
    expect(detail).toContain("recordStatusBadge");
    // The only computed color on the page is the payout summary's.
    expect(detail.match(/<GlowBadge color=\{/g) ?? []).toHaveLength(2); // payout.color + RecordBadge's neutral color
  });

  it("NEGATIVE (review P2): a finished job keeps refreshing (polling never turns off)", () => {
    const hooks = read("../api/hooks/use-pcc-data.ts");
    const block = hooks.slice(hooks.indexOf("export function useJobExecution"), hooks.indexOf("export function useDriftAlerts"));
    expect(block).toContain("JOB_EXECUTION_TERMINAL_REFRESH_MS");
    expect(block).not.toMatch(/:\s*false/);
  });
});
