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
import { computeJobSpecHash } from "../types/job-spec.js";
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
