/**
 * Tests for the contributor-economics persistence layer:
 *   - 4 Drizzle tables (profiles, rate_schedules, training_manifests,
 *     composition_manifests).
 *   - ContributorRepository implementation of IContributorRepository.
 *   - Migration creates tables and indexes without error.
 *
 * Style mirrors __tests__/story-db.test.ts: in-memory DB via createStore,
 * seed:false to keep state under test, and afterEach close to release the
 * better-sqlite3 handle.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createStore, type Store, ContributorRepository } from "../index.js";
import { createHash } from "node:crypto";

// ── Helpers ────────────────────────────────────────────────────────────────

/** Compact, deterministic JSON canonicalizer mirroring @pcc/spec. */
function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalize).join(",") + "]";
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const pairs = keys
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .map(
        (k) =>
          JSON.stringify(k) + ":" + canonicalize((value as Record<string, unknown>)[k]),
      );
    return "{" + pairs.join(",") + "}";
  }
  return String(value);
}

function hash(input: string): `0x${string}` {
  return ("0x" + createHash("sha256").update(input).digest("hex")) as `0x${string}`;
}

interface RateSegmentLite {
  kind: string;
  startTime: number;
  endTime: number | null;
  bps?: number;
  startBps?: number;
  endBps?: number;
  decayPerSecond?: number;
  scale?: number;
  floorBps?: number;
  capBps?: number;
  thresholdCents?: number;
  bpsLow?: number;
  bpsHigh?: number;
}

function makeSchedule(
  segments: RateSegmentLite[],
  publishedBy = "0xpublisher",
  version = 1,
) {
  const segmentsJson = canonicalize(segments);
  const scheduleHash = hash(canonicalize({ version, segments }));
  return {
    scheduleHash,
    version,
    segmentsJson,
    notes: null as string | null,
    publishedBy,
    publishedAt: "2026-04-23T00:00:00.000Z",
  };
}

// ── Test fixture ──────────────────────────────────────────────────────────

describe("@pcc/store — contributor economics persistence", () => {
  let store: Store;

  beforeEach(() => {
    store = createStore({ seed: false });
  });

  afterEach(() => {
    store.close();
  });

  // ── contributorProfiles ──────────────────────────────────────────────────

  describe("contributorProfiles", () => {
    const baseProfile = {
      id: "0xalice:protocol-author:1",
      address: "0xalice",
      role: "protocol-author",
      scheduleHash: hash("seed-schedule-0"),
      ipId: "0xip-alice",
      contributorNftTokenId: "1",
      metadataUri: "ipfs://bafyalice",
      registeredAt: "2026-04-23T00:00:00.000Z",
    };

    it("[1] upsertProfile + getProfile round-trips a profile", () => {
      store.repos.contributors.upsertProfile(baseProfile);
      const found = store.repos.contributors.getProfile(baseProfile.id);
      expect(found).not.toBeNull();
      expect(found!.address).toBe("0xalice");
      expect(found!.role).toBe("protocol-author");
      expect(found!.scheduleHash).toBe(baseProfile.scheduleHash);
      expect(found!.ipId).toBe("0xip-alice");
      expect(found!.contributorNftTokenId).toBe("1");
      expect(found!.metadataUri).toBe("ipfs://bafyalice");
    });

    it("[2] upsertProfile updates existing on same id", () => {
      store.repos.contributors.upsertProfile(baseProfile);
      const newHash = hash("seed-schedule-1");
      store.repos.contributors.upsertProfile({
        ...baseProfile,
        scheduleHash: newHash,
        metadataUri: "ipfs://bafyalice-v2",
      });
      const found = store.repos.contributors.getProfile(baseProfile.id);
      expect(found!.scheduleHash).toBe(newHash);
      expect(found!.metadataUri).toBe("ipfs://bafyalice-v2");
    });

    it("[3] listProfilesByAddress returns all roles for an address", () => {
      store.repos.contributors.upsertProfile(baseProfile);
      store.repos.contributors.upsertProfile({
        ...baseProfile,
        id: "0xalice:model-author:2",
        role: "model-author",
        contributorNftTokenId: "2",
      });
      store.repos.contributors.upsertProfile({
        ...baseProfile,
        id: "0xbob:protocol-author:3",
        address: "0xbob",
        contributorNftTokenId: "3",
      });
      const aliceProfiles = store.repos.contributors.listProfilesByAddress("0xalice");
      expect(aliceProfiles).toHaveLength(2);
      expect(new Set(aliceProfiles.map((p) => p.role))).toEqual(
        new Set(["protocol-author", "model-author"]),
      );
    });

    it("[4] listProfilesByRole returns all addresses with that role", () => {
      store.repos.contributors.upsertProfile(baseProfile);
      store.repos.contributors.upsertProfile({
        ...baseProfile,
        id: "0xbob:protocol-author:7",
        address: "0xbob",
        contributorNftTokenId: "7",
      });
      store.repos.contributors.upsertProfile({
        ...baseProfile,
        id: "0xcarol:operator:8",
        address: "0xcarol",
        role: "operator",
        contributorNftTokenId: "8",
      });
      const protocolAuthors =
        store.repos.contributors.listProfilesByRole("protocol-author");
      expect(protocolAuthors).toHaveLength(2);
      expect(new Set(protocolAuthors.map((p) => p.address))).toEqual(
        new Set(["0xalice", "0xbob"]),
      );
    });

    it("getProfile returns null for unknown id", () => {
      expect(store.repos.contributors.getProfile("0xnonexistent")).toBeNull();
    });

    it("listProfilesByAddress returns empty array when no profiles", () => {
      expect(store.repos.contributors.listProfilesByAddress("0xnobody")).toEqual([]);
    });
  });

  // ── rateSchedules ────────────────────────────────────────────────────────

  describe("rateSchedules", () => {
    it("[5] publishSchedule + getSchedule round-trip", () => {
      const sch = makeSchedule([
        { kind: "constant", startTime: 0, endTime: null, bps: 50 },
      ]);
      store.repos.contributors.publishSchedule(sch);
      const found = store.repos.contributors.getSchedule(sch.scheduleHash);
      expect(found).not.toBeNull();
      expect(found!.version).toBe(1);
      expect(found!.publishedBy).toBe("0xpublisher");
      expect(found!.segmentsJson).toBe(sch.segmentsJson);
    });

    it("[6] publishSchedule is a no-op on duplicate scheduleHash (sealed-immutable)", () => {
      const sch = makeSchedule([
        { kind: "constant", startTime: 0, endTime: null, bps: 50 },
      ]);
      store.repos.contributors.publishSchedule(sch);
      // Second publish with same hash but different publisher — should NOT
      // overwrite, by sealed-immutable semantics.
      store.repos.contributors.publishSchedule({
        ...sch,
        publishedBy: "0ximposter",
        publishedAt: "2027-01-01T00:00:00.000Z",
      });
      const found = store.repos.contributors.getSchedule(sch.scheduleHash);
      expect(found!.publishedBy).toBe("0xpublisher");
    });

    it("[7] scheduleExists returns true for published, false for unknown", () => {
      const sch = makeSchedule([
        { kind: "constant", startTime: 0, endTime: null, bps: 25 },
      ]);
      expect(store.repos.contributors.scheduleExists(sch.scheduleHash)).toBe(false);
      store.repos.contributors.publishSchedule(sch);
      expect(store.repos.contributors.scheduleExists(sch.scheduleHash)).toBe(true);
    });

    it("[8] listSchedulesByPublisher returns publisher's schedules", () => {
      const a = makeSchedule(
        [{ kind: "constant", startTime: 0, endTime: null, bps: 100 }],
        "0xpub-a",
      );
      const b = makeSchedule(
        [{ kind: "constant", startTime: 0, endTime: null, bps: 200 }],
        "0xpub-a",
        2,
      );
      const c = makeSchedule(
        [{ kind: "constant", startTime: 0, endTime: null, bps: 300 }],
        "0xpub-b",
      );
      store.repos.contributors.publishSchedule(a);
      store.repos.contributors.publishSchedule(b);
      store.repos.contributors.publishSchedule(c);

      const aSchedules = store.repos.contributors.listSchedulesByPublisher("0xpub-a");
      expect(aSchedules).toHaveLength(2);
      expect(aSchedules.every((s) => s.publishedBy === "0xpub-a")).toBe(true);

      const bSchedules = store.repos.contributors.listSchedulesByPublisher("0xpub-b");
      expect(bSchedules).toHaveLength(1);
    });

    it("[9] segmentsJson can be parsed back into a structurally equivalent array", () => {
      const segments: RateSegmentLite[] = [
        { kind: "constant", startTime: 0, endTime: 100, bps: 50 },
        {
          kind: "linear-decay",
          startTime: 100,
          endTime: 200,
          startBps: 50,
          endBps: 10,
        },
      ];
      const sch = makeSchedule(segments);
      store.repos.contributors.publishSchedule(sch);
      const found = store.repos.contributors.getSchedule(sch.scheduleHash);
      const parsed = JSON.parse(found!.segmentsJson) as RateSegmentLite[];
      expect(parsed).toHaveLength(2);
      expect(parsed[0].kind).toBe("constant");
      expect(parsed[1].kind).toBe("linear-decay");
      expect(parsed[1].startBps).toBe(50);
      expect(parsed[1].endBps).toBe(10);
    });

    it("[17] schedule with all 6 segment kinds round-trips correctly", () => {
      const allKinds: RateSegmentLite[] = [
        { kind: "constant", startTime: 0, endTime: 100, bps: 50 },
        { kind: "step", startTime: 100, endTime: 200, bps: 75 },
        {
          kind: "linear-decay",
          startTime: 200,
          endTime: 300,
          startBps: 75,
          endBps: 25,
        },
        {
          kind: "exponential-decay",
          startTime: 300,
          endTime: 400,
          startBps: 100,
          endBps: 10,
          decayPerSecond: 0.001,
        },
        {
          kind: "adoption-indexed",
          startTime: 400,
          endTime: 500,
          scale: 1000,
          floorBps: 5,
          capBps: 200,
        },
        {
          kind: "piecewise-value",
          startTime: 500,
          endTime: null,
          thresholdCents: 5000,
          bpsLow: 25,
          bpsHigh: 100,
        },
      ];
      const sch = makeSchedule(allKinds);
      store.repos.contributors.publishSchedule(sch);
      const found = store.repos.contributors.getSchedule(sch.scheduleHash);
      const parsed = JSON.parse(found!.segmentsJson) as RateSegmentLite[];
      expect(parsed.map((s) => s.kind)).toEqual([
        "constant",
        "step",
        "linear-decay",
        "exponential-decay",
        "adoption-indexed",
        "piecewise-value",
      ]);
      // Spot-check the kind-specific fields
      expect(parsed[3].decayPerSecond).toBeCloseTo(0.001);
      expect(parsed[4].scale).toBe(1000);
      expect(parsed[5].thresholdCents).toBe(5000);
    });

    it("getSchedule returns null for unknown hash", () => {
      expect(store.repos.contributors.getSchedule("0xfoo")).toBeNull();
    });
  });

  // ── trainingManifests ────────────────────────────────────────────────────

  describe("trainingManifests", () => {
    function makeTrainingManifest(modelIpId = "0xmodel-1") {
      const datasets = [
        { datasetIpId: "0xds-1", weightBps: 7000 },
        { datasetIpId: "0xds-2", weightBps: 3000 },
      ];
      const datasetWeightsJson = canonicalize(datasets);
      const manifestHash = hash(
        canonicalize({ modelIpId, datasets }),
      );
      return {
        modelIpId,
        baseModelIpId: null as string | null,
        datasetWeightsJson,
        methodologyHash: null as string | null,
        manifestHash,
        createdAt: "2026-04-23T00:00:00.000Z",
      };
    }

    it("[10] setTrainingManifest + getTrainingManifest round-trip", () => {
      const m = makeTrainingManifest();
      store.repos.contributors.setTrainingManifest(m);
      const found = store.repos.contributors.getTrainingManifest("0xmodel-1");
      expect(found).not.toBeNull();
      expect(found!.modelIpId).toBe("0xmodel-1");
      expect(found!.manifestHash).toBe(m.manifestHash);
      const parsed = JSON.parse(found!.datasetWeightsJson) as Array<{
        datasetIpId: string;
        weightBps: number;
      }>;
      expect(parsed).toHaveLength(2);
      expect(parsed[0].weightBps + parsed[1].weightBps).toBe(10000);
    });

    it("[11] getTrainingManifest returns null when absent", () => {
      expect(
        store.repos.contributors.getTrainingManifest("0xnonexistent"),
      ).toBeNull();
    });

    it("[12] setTrainingManifest updates on duplicate modelIpId (upsert)", () => {
      const original = makeTrainingManifest();
      store.repos.contributors.setTrainingManifest(original);
      const updatedDatasets = [
        { datasetIpId: "0xds-1", weightBps: 5000 },
        { datasetIpId: "0xds-2", weightBps: 5000 },
      ];
      const updated = {
        ...original,
        datasetWeightsJson: canonicalize(updatedDatasets),
        manifestHash: hash(
          canonicalize({ modelIpId: original.modelIpId, datasets: updatedDatasets }),
        ),
        baseModelIpId: "0xbase-1",
      };
      store.repos.contributors.setTrainingManifest(updated);
      const found = store.repos.contributors.getTrainingManifest("0xmodel-1");
      expect(found!.manifestHash).toBe(updated.manifestHash);
      expect(found!.baseModelIpId).toBe("0xbase-1");
    });

    it("training manifest stores methodologyHash and baseModelIpId when provided", () => {
      const m = {
        ...makeTrainingManifest("0xmodel-2"),
        baseModelIpId: "0xbase-model",
        methodologyHash: hash("methodology-script-v1"),
      };
      store.repos.contributors.setTrainingManifest(m);
      const found = store.repos.contributors.getTrainingManifest("0xmodel-2");
      expect(found!.baseModelIpId).toBe("0xbase-model");
      expect(found!.methodologyHash).toBe(m.methodologyHash);
    });
  });

  // ── compositionManifests ─────────────────────────────────────────────────

  describe("compositionManifests", () => {
    function makeCompositionManifest(
      id = "comp-1",
      escrowAddress = "0xescrow-aaa",
      milestoneIndex = 0,
      capabilityIpId = "0xcap-aaa",
    ) {
      const entries = [
        {
          ipId: "0xip-protocol",
          role: "protocol-author",
          contributorAddress: "0x" + "1".repeat(40),
          rateScheduleHash: hash("schedule-protocol"),
          groupBps: 4000,
        },
        {
          ipId: "0xip-model",
          role: "model-author",
          contributorAddress: "0x" + "2".repeat(40),
          rateScheduleHash: hash("schedule-model"),
          groupBps: 3500,
        },
      ];
      const manifestJson = canonicalize(entries);
      const manifestHash = hash(canonicalize({ capabilityIpId, entries }));
      const totalBps = 4000 + 3500;
      return {
        id,
        capabilityIpId,
        escrowAddress,
        milestoneIndex,
        manifestJson,
        manifestHash,
        operatorResidualBps: 10000 - totalBps,
        createdAt: "2026-04-23T00:00:00.000Z",
      };
    }

    it("[13] saveCompositionManifest returns id, getCompositionManifest retrieves", () => {
      const m = makeCompositionManifest();
      const id = store.repos.contributors.saveCompositionManifest(m);
      expect(id).toBe("comp-1");
      const found = store.repos.contributors.getCompositionManifest("comp-1");
      expect(found).not.toBeNull();
      expect(found!.escrowAddress).toBe("0xescrow-aaa");
      expect(found!.milestoneIndex).toBe(0);
      expect(found!.operatorResidualBps).toBe(2500);
    });

    it("[14] getByEscrowAndMilestone composite key works", () => {
      const m1 = makeCompositionManifest("comp-1", "0xescrow-x", 0, "0xcap-x");
      const m2 = makeCompositionManifest("comp-2", "0xescrow-x", 1, "0xcap-x");
      const m3 = makeCompositionManifest("comp-3", "0xescrow-y", 0, "0xcap-y");
      store.repos.contributors.saveCompositionManifest(m1);
      store.repos.contributors.saveCompositionManifest(m2);
      store.repos.contributors.saveCompositionManifest(m3);

      const found1 = store.repos.contributors.getByEscrowAndMilestone(
        "0xescrow-x",
        0,
      );
      expect(found1!.id).toBe("comp-1");
      const found2 = store.repos.contributors.getByEscrowAndMilestone(
        "0xescrow-x",
        1,
      );
      expect(found2!.id).toBe("comp-2");
      const found3 = store.repos.contributors.getByEscrowAndMilestone(
        "0xescrow-y",
        0,
      );
      expect(found3!.id).toBe("comp-3");
      const notFound = store.repos.contributors.getByEscrowAndMilestone(
        "0xescrow-z",
        0,
      );
      expect(notFound).toBeNull();
    });

    it("[15] manifestHash is recomputable from manifestJson (canonicalization invariant)", () => {
      const m = makeCompositionManifest();
      store.repos.contributors.saveCompositionManifest(m);
      const found = store.repos.contributors.getCompositionManifest("comp-1");
      const entries = JSON.parse(found!.manifestJson) as unknown[];
      const recomputed = hash(
        canonicalize({ capabilityIpId: found!.capabilityIpId, entries }),
      );
      expect(recomputed).toBe(found!.manifestHash);
    });

    it("[16] operatorResidualBps stored correctly", () => {
      const m = makeCompositionManifest("comp-2");
      store.repos.contributors.saveCompositionManifest(m);
      const found = store.repos.contributors.getCompositionManifest("comp-2");
      expect(found!.operatorResidualBps).toBe(2500);
      // operator residual + sum-of-entry-bps == 10000
      const entries = JSON.parse(found!.manifestJson) as Array<{
        groupBps?: number;
      }>;
      const sumBps = entries.reduce((s, e) => s + (e.groupBps ?? 0), 0);
      expect(found!.operatorResidualBps + sumBps).toBe(10000);
    });

    it("getCompositionManifest returns null for unknown id", () => {
      expect(store.repos.contributors.getCompositionManifest("ghost")).toBeNull();
    });

    it("saveCompositionManifest is upsert on duplicate id", () => {
      const m = makeCompositionManifest("comp-dup");
      store.repos.contributors.saveCompositionManifest(m);
      store.repos.contributors.saveCompositionManifest({
        ...m,
        operatorResidualBps: 1000,
      });
      const found = store.repos.contributors.getCompositionManifest("comp-dup");
      expect(found!.operatorResidualBps).toBe(1000);
    });
  });

  // ── Migration / barrel exports ───────────────────────────────────────────

  describe("[18] Migration creates all 4 tables and indexes", () => {
    it("contributor_profiles table exists", () => {
      // Driving via raw SQL so we exercise the schema, not just the repo
      // (SQLite will throw "no such table" on unknown tables).
      const handle = (store as unknown as { db: unknown }).db as {
        $client: { prepare: (s: string) => { all: () => unknown[] } };
      };
      const rows = handle.$client
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all() as Array<{ name: string }>;
      const names = new Set(rows.map((r) => r.name));
      expect(names.has("contributor_profiles")).toBe(true);
      expect(names.has("rate_schedules")).toBe(true);
      expect(names.has("training_manifests")).toBe(true);
      expect(names.has("composition_manifests")).toBe(true);
    });

    it("expected indexes are present", () => {
      const handle = (store as unknown as { db: unknown }).db as {
        $client: { prepare: (s: string) => { all: () => unknown[] } };
      };
      const rows = handle.$client
        .prepare("SELECT name FROM sqlite_master WHERE type='index'")
        .all() as Array<{ name: string }>;
      const names = new Set(rows.map((r) => r.name));
      expect(names.has("contributor_profiles_address")).toBe(true);
      expect(names.has("contributor_profiles_role")).toBe(true);
      expect(names.has("rate_schedules_published_by")).toBe(true);
      expect(names.has("composition_manifests_escrow_milestone")).toBe(true);
    });

    it("ContributorRepository class exported from package barrel", () => {
      expect(ContributorRepository).toBeDefined();
      expect(typeof ContributorRepository).toBe("function");
      expect(store.repos.contributors).toBeInstanceOf(ContributorRepository);
    });
  });
});
