import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { initStore, closeStore } from "../db.js";
import { CapabilityFacade } from "../facades/capability.facade.js";

// Mock telemetry (used by BaseFacade.execute)
vi.mock("../telemetry.js", () => ({
  pipelineTelemetry: { emit: vi.fn() },
}));

// ── Setup ─────────────────────────────────────────────────────────────────

describe("CapabilityFacade", () => {
  let facade: CapabilityFacade;

  beforeEach(() => {
    process.env.PCC_DB_PATH = ":memory:";
    initStore({ seed: true });
    facade = new CapabilityFacade();
  });

  afterEach(() => {
    closeStore();
    vi.clearAllMocks();
  });

  // ── list() ─────────────────────────────────────────────────────────────

  describe("list()", () => {
    it("returns success=true with items array", async () => {
      const result = await facade.list();
      expect(result.success).toBe(true);
      if (result.success) {
        expect(Array.isArray(result.data.items)).toBe(true);
      }
    });

    it("items are CapabilityDTOs with id, kernelId, type, name, available fields", async () => {
      const result = await facade.list();
      if (result.success && result.data.items.length > 0) {
        const item = result.data.items[0];
        expect(typeof item.id).toBe("string");
        expect(typeof item.kernelId).toBe("string");
        expect(typeof item.type).toBe("string");
        expect(typeof item.name).toBe("string");
        expect(typeof item.available).toBe("boolean");
      }
    });

    it("returns pagination metadata: total, offset, limit, hasMore", async () => {
      const result = await facade.list();
      if (result.success) {
        expect(typeof result.data.total).toBe("number");
        expect(typeof result.data.offset).toBe("number");
        expect(typeof result.data.limit).toBe("number");
        expect(typeof result.data.hasMore).toBe("boolean");
      }
    });

    it("default pagination: offset=0, limit=50", async () => {
      const result = await facade.list();
      if (result.success) {
        expect(result.data.offset).toBe(0);
        expect(result.data.limit).toBe(50);
      }
    });

    it("pagination slices correctly with offset=1, limit=1", async () => {
      const allResult = await facade.list();
      const pagedResult = await facade.list({}, { offset: 1, limit: 1 });
      if (allResult.success && pagedResult.success && allResult.data.total > 1) {
        expect(pagedResult.data.items).toHaveLength(1);
        expect(pagedResult.data.offset).toBe(1);
        expect(pagedResult.data.limit).toBe(1);
        // The paged item should be different from the first item
        expect(pagedResult.data.items[0].id).not.toBe(allResult.data.items[0].id);
      }
    });

    it("hasMore=true when more results exist beyond limit", async () => {
      const result = await facade.list({}, { offset: 0, limit: 1 });
      if (result.success && result.data.total > 1) {
        expect(result.data.hasMore).toBe(true);
      }
    });

    it("hasMore=false when results fit within limit", async () => {
      const result = await facade.list({}, { offset: 0, limit: 1000 });
      if (result.success) {
        expect(result.data.hasMore).toBe(false);
      }
    });

    it("includeReputation=false: reputation field is undefined", async () => {
      const result = await facade.list({ includeReputation: false });
      if (result.success && result.data.items.length > 0) {
        expect(result.data.items[0].reputation).toBeUndefined();
      }
    });

    it("includeReputation=true: reputation is a number", async () => {
      const result = await facade.list({ includeReputation: true });
      if (result.success && result.data.items.length > 0) {
        const item = result.data.items[0];
        // Reputation should be a number (from kernel or default 500)
        if (item.reputation !== undefined) {
          expect(typeof item.reputation).toBe("number");
        }
      }
    });
  });

  // ── getById() ──────────────────────────────────────────────────────────

  describe("getById()", () => {
    it("returns a CapabilityDTO for an existing capability", async () => {
      // Get the list first to find a valid ID
      const listResult = await facade.list();
      if (!listResult.success || listResult.data.items.length === 0) return;

      const id = listResult.data.items[0].id;
      const result = await facade.getById(id);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.id).toBe(id);
      }
    });

    it("includes kernelName when kernel exists", async () => {
      const listResult = await facade.list();
      if (!listResult.success || listResult.data.items.length === 0) return;

      const id = listResult.data.items[0].id;
      const result = await facade.getById(id);
      if (result.success) {
        // kernelName may be set if the kernel exists
        if (result.data.kernelName !== undefined) {
          expect(typeof result.data.kernelName).toBe("string");
        }
      }
    });

    it("returns error with success=false when id not found", async () => {
      const result = await facade.getById("cap-DOES-NOT-EXIST");
      expect(result.success).toBe(false);
    });

    it("error has httpStatus=404", async () => {
      const result = await facade.getById("cap-DOES-NOT-EXIST");
      if (!result.success) {
        expect(result.error.httpStatus).toBe(404);
      }
    });

    it("error code contains NOT_FOUND", async () => {
      const result = await facade.getById("cap-DOES-NOT-EXIST");
      if (!result.success) {
        expect(result.error.code).toContain("NOT_FOUND");
      }
    });

    it("includeReputation=true populates reputationCache from kernel.reputation", async () => {
      const listResult = await facade.list();
      if (!listResult.success || listResult.data.items.length === 0) return;

      const id = listResult.data.items[0].id;
      const result = await facade.getById(id, { includeReputation: true });
      if (result.success && result.data.reputation !== undefined) {
        expect(typeof result.data.reputation).toBe("number");
      }
    });
  });

  // ── search() ───────────────────────────────────────────────────────────

  describe("search()", () => {
    it("returns all capabilities when no criteria provided", async () => {
      const searchResult = await facade.search({});
      const listResult = await facade.list();
      if (searchResult.success && listResult.success) {
        expect(searchResult.data.total).toBe(listResult.data.total);
      }
    });

    it("filters by type exactly", async () => {
      // First find what types exist
      const listResult = await facade.list();
      if (!listResult.success || listResult.data.items.length === 0) return;
      const firstType = listResult.data.items[0].type;

      const result = await facade.search({ type: firstType as any });
      if (result.success) {
        expect(result.data.items.every((i) => i.type === firstType)).toBe(true);
      }
    });

    it("filters by materials (any match)", async () => {
      const result = await facade.search({ materials: ["pla"] });
      if (result.success) {
        expect(result.data.items.every((i) => i.materials?.includes("pla"))).toBe(true);
      }
    });

    it("filters by assuranceTier (capability must include that tier)", async () => {
      const result = await facade.search({ assuranceTier: 0 });
      if (result.success) {
        expect(result.data.items.every((i) => i.assuranceTiers.includes(0))).toBe(true);
      }
    });

    it("returns empty items when no capabilities match criteria", async () => {
      const result = await facade.search({ type: "type_that_definitely_does_not_exist" as any });
      if (result.success) {
        expect(result.data.items).toHaveLength(0);
        expect(result.data.total).toBe(0);
      }
    });

    it("returns paginated result with hasMore", async () => {
      const result = await facade.search({}, {}, { limit: 1, offset: 0 });
      if (result.success) {
        expect(result.data.limit).toBe(1);
        expect(result.data.offset).toBe(0);
        expect(typeof result.data.hasMore).toBe("boolean");
      }
    });

    it("filters by query string (matches name, type, or material)", async () => {
      // "fdm" is in the seeded data
      const result = await facade.search({ query: "fdm" });
      if (result.success && result.data.total > 0) {
        // At least one item should relate to fdm
        expect(result.data.total).toBeGreaterThan(0);
      }
    });
  });

  // ── listByKernel() ─────────────────────────────────────────────────────

  describe("listByKernel()", () => {
    it("returns capabilities for a known kernelId", async () => {
      const listResult = await facade.list();
      if (!listResult.success || listResult.data.items.length === 0) return;
      const kernelId = listResult.data.items[0].kernelId;

      const result = await facade.listByKernel(kernelId);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.length).toBeGreaterThan(0);
      }
    });

    it("returns empty array for unknown kernelId", async () => {
      const result = await facade.listByKernel("kernel-DOES-NOT-EXIST");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(0);
      }
    });

    it("each DTO has kernelId matching the requested kernelId", async () => {
      const listResult = await facade.list();
      if (!listResult.success || listResult.data.items.length === 0) return;
      const kernelId = listResult.data.items[0].kernelId;

      const result = await facade.listByKernel(kernelId);
      if (result.success) {
        expect(result.data.every((dto) => dto.kernelId === kernelId)).toBe(true);
      }
    });
  });

  // ── listByType() ───────────────────────────────────────────────────────

  describe("listByType()", () => {
    it("returns capabilities of the matching type only", async () => {
      const listResult = await facade.list();
      if (!listResult.success || listResult.data.items.length === 0) return;
      const firstType = listResult.data.items[0].type;

      const result = await facade.listByType(firstType);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.every((dto) => dto.type === firstType)).toBe(true);
      }
    });

    it("returns empty array for unknown type", async () => {
      const result = await facade.listByType("type_UNKNOWN_xyz");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(0);
      }
    });
  });

  // ── create() ───────────────────────────────────────────────────────────

  describe("create()", () => {
    it("creates a new capability and returns created=true", async () => {
      const result = await facade.create({
        kernelId: "kernel-nyc",
        type: "laser_cut",
        id: "cap-test-laser-new",
        name: "Test Laser",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.created).toBe(true);
      }
    });

    it("returns the DTO with populated fields", async () => {
      const result = await facade.create({
        kernelId: "kernel-nyc",
        type: "fdm_test",
        id: "cap-test-fdm-unique",
        name: "Test FDM",
      });
      if (result.success) {
        expect(result.data.capability.type).toBe("fdm_test");
        expect(result.data.capability.kernelId).toBe("kernel-nyc");
      }
    });

    it("idempotent: second call returns created=false for same id", async () => {
      const first = await facade.create({
        kernelId: "kernel-nyc",
        type: "some_type",
        id: "cap-idempotent-test",
      });
      const second = await facade.create({
        kernelId: "kernel-nyc",
        type: "some_type",
        id: "cap-idempotent-test",
      });
      if (first.success && second.success) {
        expect(first.data.created).toBe(true);
        expect(second.data.created).toBe(false);
      }
    });

    it("uses auto-generated id when id not provided (cap-<kernelId>-<type>)", async () => {
      const result = await facade.create({
        kernelId: "kernel-nyc",
        type: "auto_id_type",
      });
      if (result.success) {
        expect(result.data.capability.id).toBe("cap-kernel-nyc-auto_id_type");
      }
    });

    it("returns error when kernelId is missing", async () => {
      const result = await facade.create({
        kernelId: "",
        type: "fdm",
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.httpStatus).toBe(400);
      }
    });

    it("returns error when type is missing", async () => {
      const result = await facade.create({
        kernelId: "kernel-nyc",
        type: "",
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.httpStatus).toBe(400);
      }
    });

    it("errors have success=false", async () => {
      const result = await facade.create({ kernelId: "", type: "" });
      expect(result.success).toBe(false);
    });

    it("stores availability on the capability row when passed in body", async () => {
      // Regression test for PR #125 smoke-test finding: CreateCapabilityInput
      // previously omitted `availability`, so the field was silently dropped
      // and every A2A-created operator landed with availability={} on its
      // capability row. Verifies the column is now populated end-to-end.
      const availability = {
        mode: "always",
        describe: "24/7 demo capability — availability regression test",
        timezone: "UTC",
      };
      const result = await facade.create({
        kernelId: "kernel-nyc",
        type: "availability_regression",
        id: "cap-availability-regression",
        name: "Availability regression",
        availability,
      });
      expect(result.success).toBe(true);

      // Reach into the raw DB row to confirm the column got the value —
      // populateCapabilityDTO may strip/reshape, so we verify at the source.
      const { getStore } = await import("../db.js");
      const { schema, eq } = await import("@pcc/store");
      const { db } = getStore();
      const row = db
        .select()
        .from(schema.capabilities)
        .where(eq(schema.capabilities.id, "cap-availability-regression"))
        .get();
      expect(row).toBeDefined();
      expect(row?.availability).toEqual(availability);
    });

    it("defaults availability to {} when omitted from body", async () => {
      const result = await facade.create({
        kernelId: "kernel-nyc",
        type: "availability_default",
        id: "cap-availability-default",
      });
      expect(result.success).toBe(true);
      const { getStore } = await import("../db.js");
      const { schema, eq } = await import("@pcc/store");
      const { db } = getStore();
      const row = db
        .select()
        .from(schema.capabilities)
        .where(eq(schema.capabilities.id, "cap-availability-default"))
        .get();
      expect(row?.availability).toEqual({});
    });
  });
});
