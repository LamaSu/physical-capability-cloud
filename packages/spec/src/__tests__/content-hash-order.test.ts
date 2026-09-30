/**
 * Content hashes sort by UTF-16 code unit, never by locale collation
 * (oracle #3348 / #3350). The vectors in util/code-unit-order.vectors.json
 * are what a non-JS mirror reproduces. Code-unit order is byte order for
 * their ASCII strings, and a Python recomputation matched every value.
 */
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { canonicalize } from "../util/canonical.js";
import { compareCodeUnits } from "../util/code-unit-order.js";
import { computeMapSnapshotHash, type MapEntry } from "../types/registry.js";
import { computeWorkSchemaHash } from "../types/work-schema.js";
import { assertJobSpecIsWellFormed, computeJobSpecHash, type JobSpec } from "../types/job-spec.js";
import vectors from "../util/code-unit-order.vectors.json" with { type: "json" };

const sha = (s: string) => `0x${createHash("sha256").update(s).digest("hex")}`;
/** An independent reference order: the UTF-8 bytes of each string. */
const byBytes = (a: string, b: string) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
const rotations = <T>(xs: readonly T[]): T[][] =>
  xs.map((_, i) => [...xs.slice(i), ...xs.slice(0, i)]).concat([[...xs].reverse()]);

describe("compareCodeUnits", () => {
  it("orders by code unit: punctuation and digits as bytes do, uppercase before lowercase", () => {
    const keys = vectors.mapSnapshot.entries.map((e) => e.key);
    expect([...keys].sort(compareCodeUnits)).toEqual(vectors.mapSnapshot.sortedKeys);
    expect([...keys].sort(byBytes)).toEqual(vectors.mapSnapshot.sortedKeys);
    expect(["cmm_2", "cmm2", "cmm-1"].sort(compareCodeUnits)).toEqual(["cmm-1", "cmm2", "cmm_2"]);
    expect(["0xab", "0xAB", "0xAb"].sort(compareCodeUnits)).toEqual(["0xAB", "0xAb", "0xab"]);
    expect(compareCodeUnits("a", "a")).toBe(0);
  });
});

describe("computeMapSnapshotHash sorts keys by code unit", () => {
  const entries = vectors.mapSnapshot.entries as MapEntry[];

  it("reproduces the vector, whatever the input order, and equals the byte-order reference", () => {
    const reference = sha(canonicalize({ entries: [...entries].sort((a, b) => byBytes(a.key, b.key)) }));
    expect(reference).toBe(vectors.mapSnapshot.snapshotHash);
    for (const r of rotations(entries)) expect(computeMapSnapshotHash(r)).toBe(vectors.mapSnapshot.snapshotHash);
  });

  it("is not the hash over the ICU order the vector's entries are listed in", () => {
    expect(sha(canonicalize({ entries }))).toBe(vectors.mapSnapshot.negativeIcuOrderHash);
    expect(computeMapSnapshotHash(entries)).not.toBe(vectors.mapSnapshot.negativeIcuOrderHash);
  });
});

describe("computeWorkSchemaHash sorts event types and work products by code unit", () => {
  it("reproduces the vector, whatever the input order", () => {
    const s = vectors.workSchema.schema;
    for (const eventTypes of rotations(s.eventTypes)) {
      for (const workProducts of rotations(s.workProducts)) {
        expect(computeWorkSchemaHash({ ...s, eventTypes, workProducts } as never)).toBe(vectors.workSchema.schemaHash);
      }
    }
  });
});

describe("computeJobSpecHash sorts co-funders by code unit (case-sensitive)", () => {
  it("reproduces the vector, whatever the input order", () => {
    const j = vectors.jobSpec.job;
    for (const cofundedBy of rotations(j.cofundedBy)) {
      expect(computeJobSpecHash({ ...j, cofundedBy } as never)).toBe(vectors.jobSpec.jobSpecHash);
    }
  });
});

// E1 finding 3: duplicate buyers stay valid, so the co-funder order must be
// total over the hashed content, not just over `buyer`.
describe("computeJobSpecHash orders duplicate co-funders totally", () => {
  const X = "0xab00000000000000000000000000000000000001";
  const sealed = (cofundedBy: Array<{ buyer: string; amountCents: number }>): JobSpec => {
    const job = {
      ...vectors.jobSpec.job,
      constraints: { deadlineSeconds: 3600, maxBudgetCents: 3, requiredAssuranceTier: 0 as const },
      cofundedBy,
      buyerSignature: "0x01",
      sellerSignature: null,
      createdAt: "2026-09-29T00:00:00.000Z",
    };
    return { ...job, jobSpecHash: computeJobSpecHash(job) };
  };

  it("reproduces the duplicate-buyer vector, whatever the input order", () => {
    const d = vectors.jobSpecDuplicateBuyers;
    for (const cofundedBy of rotations(d.cofundedBy)) {
      expect(computeJobSpecHash({ ...vectors.jobSpec.job, cofundedBy } as never)).toBe(d.jobSpecHash);
    }
  });

  it("the same buyer twice with amounts [1,2] or [2,1] hashes the same", () => {
    const a = sealed([{ buyer: X, amountCents: 1 }, { buyer: X, amountCents: 2 }]);
    const b = sealed([{ buyer: X, amountCents: 2 }, { buyer: X, amountCents: 1 }]);
    expect(a.jobSpecHash).toBe(b.jobSpecHash);
  });

  it("a sealed job still verifies after its co-funder list is reordered; duplicates stay valid", () => {
    const job = sealed([{ buyer: X, amountCents: 1 }, { buyer: X, amountCents: 2 }]);
    expect(() => assertJobSpecIsWellFormed(job)).not.toThrow();
    expect(() => assertJobSpecIsWellFormed({ ...job, cofundedBy: [...job.cofundedBy!].reverse() })).not.toThrow();
  });
});
