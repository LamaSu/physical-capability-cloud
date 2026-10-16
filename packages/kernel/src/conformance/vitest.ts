import { describe, expect, it } from "vitest";
import type { MachineAdapter } from "../adapters/types.js";
import {
  CLAUSES,
  runAdapterConformance,
  type ConformanceProfile,
  type ConformanceReport,
} from "./index.js";

type Clause = ConformanceReport["clauses"][number];

/** Explicit status expectations for known failures or inapplicable contract clauses. */
export type ConformanceExpectations = Partial<Record<Clause["id"], Clause["status"]>>;

/**
 * Register one Vitest test per adapter-contract clause.
 *
 * The runner is shared within this describe block, and still creates a fresh
 * adapter for every clause. Its real timer deadlines implement the bounded
 * handshake in adapters/types.ts:8-23 and :79-84. This opt-in subpath is the
 * only conformance entry that imports Vitest.
 */
export function describeAdapterConformance(
  name: string,
  makeAdapter: () => MachineAdapter | Promise<MachineAdapter>,
  profile: ConformanceProfile,
  expected: ConformanceExpectations = {},
): void {
  describe(name, () => {
    let report: Promise<ConformanceReport> | undefined;
    // The first test runs all clauses. Allow the sum of their bounded waits,
    // including cleanup, with room for a busy author or lane process.
    const timing = profile.timing;
    const timeout = Math.max(5_000, 40 * (
      timing.cancelConfirmMs + timing.pollMs + timing.jobTimeoutMs +
      timing.quiesceTimeoutMs + timing.settleMs
    ));

    for (const clause of CLAUSES) {
      it(`${clause.id}: ${clause.title}`, async () => {
        report ??= runAdapterConformance(makeAdapter, profile);
        const result = await report;
        const row = result.clauses.find((candidate) => candidate.id === clause.id);
        expect(row, `runner omitted ${clause.id}`).toBeDefined();
        if (!row) return;
        const status = expected[clause.id] ?? (row.status === "n/a" ? "n/a" : "pass");
        expect(row.status, `${row.id}: ${row.reason}`).toBe(status);
      }, timeout);
    }
  });
}
