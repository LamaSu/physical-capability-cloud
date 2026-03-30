/**
 * Tests for pipeline telemetry extensions:
 *   - operator_register, operator_verify, dht_query phases in PIPELINE_PHASES
 *   - emit() with new phases stores events correctly
 *   - getTimeline() returns events for a job
 *
 * Mocks: streamHub.publish and Sentry to avoid side-effects.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks — hoisted so they apply before module import ───────────────────────

vi.mock("../sentry.js", () => ({
  initSentry: vi.fn(),
  isSentryEnabled: vi.fn().mockReturnValue(false),
  Sentry: {
    addBreadcrumb: vi.fn(),
    captureException: vi.fn(),
  },
}));

vi.mock("../sse/stream-hub.js", () => ({
  streamHub: {
    publish: vi.fn(),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
  },
}));

// ── Imports (after mocks) ────────────────────────────────────────────────────

import {
  PipelineTelemetryService,
  PIPELINE_PHASES,
  pipelineTelemetry,
  type PipelinePhase,
} from "../telemetry.js";

// ── Tests ────────────────────────────────────────────────────────────────────

describe("Pipeline Telemetry Extensions", () => {
  let service: PipelineTelemetryService;

  beforeEach(() => {
    service = new PipelineTelemetryService();
  });

  // ── PIPELINE_PHASES array ──────────────────────────────────────────────────

  describe("PIPELINE_PHASES", () => {
    it("includes operator_register", () => {
      expect(PIPELINE_PHASES).toContain("operator_register");
    });

    it("includes operator_verify", () => {
      expect(PIPELINE_PHASES).toContain("operator_verify");
    });

    it("includes dht_query", () => {
      expect(PIPELINE_PHASES).toContain("dht_query");
    });

    it("still contains all original phases", () => {
      const originalPhases: PipelinePhase[] = [
        "discovery",
        "quote_request",
        "quote_response",
        "negotiation",
        "contract_build",
        "escrow_fund",
        "job_submit",
        "job_accepted",
        "job_started",
        "evidence_capture",
        "evidence_encrypt",
        "evidence_archive",
        "verification_request",
        "verification_result",
        "settlement_claim",
        "settlement_complete",
        "delivery_dispatch",
        "delivery_pickup",
        "delivery_complete",
      ];
      for (const phase of originalPhases) {
        expect(PIPELINE_PHASES).toContain(phase);
      }
    });

    it("has 22 total phases (19 original + 3 new)", () => {
      expect(PIPELINE_PHASES).toHaveLength(22);
    });
  });

  // ── emit() with new phases ────────────────────────────────────────────────

  describe("emit() with new phases", () => {
    it("emits operator_register without throwing", () => {
      expect(() => {
        service.emit("job-reg-1", "operator_register", "started");
      }).not.toThrow();
    });

    it("emits operator_verify without throwing", () => {
      expect(() => {
        service.emit("job-ver-1", "operator_verify", "completed");
      }).not.toThrow();
    });

    it("emits dht_query without throwing", () => {
      expect(() => {
        service.emit("job-dht-1", "dht_query", "completed");
      }).not.toThrow();
    });

    it("returns a TelemetryEvent with the correct phase", () => {
      const evt = service.emit("job-1", "operator_register", "started");
      expect(evt.phase).toBe("operator_register");
      expect(evt.jobId).toBe("job-1");
      expect(evt.status).toBe("started");
    });

    it("sets level to error for failed status", () => {
      const evt = service.emit("job-2", "dht_query", "failed");
      expect(evt.level).toBe("error");
    });

    it("sets level to info for non-failed status by default", () => {
      const evt = service.emit("job-3", "operator_verify", "completed");
      expect(evt.level).toBe("info");
    });

    it("stores metadata from options", () => {
      const evt = service.emit("job-4", "dht_query", "completed", {
        metadata: { resultCount: 5, type: "fdm_print" },
      });
      expect(evt.metadata).toMatchObject({ resultCount: 5, type: "fdm_print" });
    });

    it("includes duration_ms when provided", () => {
      const evt = service.emit("job-5", "operator_register", "completed", {
        duration_ms: 142,
      });
      expect(evt.duration_ms).toBe(142);
    });

    it("uses provided source", () => {
      const evt = service.emit("job-6", "dht_query", "completed", {
        source: "dht-node",
      });
      expect(evt.source).toBe("dht-node");
    });

    it("defaults source to 'gateway'", () => {
      const evt = service.emit("job-7", "operator_verify", "started");
      expect(evt.source).toBe("gateway");
    });
  });

  // ── getTimeline() ─────────────────────────────────────────────────────────

  describe("getTimeline()", () => {
    it("returns empty array for unknown jobId", () => {
      expect(service.getTimeline("nonexistent-job")).toEqual([]);
    });

    it("returns events for a known jobId in insertion order", () => {
      service.emit("job-timeline", "operator_register", "started");
      service.emit("job-timeline", "operator_verify", "started");
      service.emit("job-timeline", "dht_query", "completed");

      const events = service.getTimeline("job-timeline");
      expect(events).toHaveLength(3);
      expect(events[0].phase).toBe("operator_register");
      expect(events[1].phase).toBe("operator_verify");
      expect(events[2].phase).toBe("dht_query");
    });

    it("isolates events by jobId", () => {
      service.emit("job-A", "operator_register", "started");
      service.emit("job-B", "dht_query", "completed");
      service.emit("job-A", "operator_verify", "completed");

      expect(service.getTimeline("job-A")).toHaveLength(2);
      expect(service.getTimeline("job-B")).toHaveLength(1);
    });

    it("each event has id, jobId, timestamp, phase, status fields", () => {
      service.emit("job-shape", "dht_query", "started");
      const events = service.getTimeline("job-shape");
      const evt = events[0];

      expect(typeof evt.id).toBe("string");
      expect(evt.jobId).toBe("job-shape");
      expect(typeof evt.timestamp).toBe("string");
      expect(evt.phase).toBe("dht_query");
      expect(evt.status).toBe("started");
    });
  });

  // ── getActiveJobs() with new phases ───────────────────────────────────────

  describe("getActiveJobs() with new phases", () => {
    it("includes jobs with operator_register as the last phase", () => {
      service.emit("job-active", "operator_register", "started");
      const active = service.getActiveJobs();
      const found = active.find((j) => j.jobId === "job-active");
      expect(found).toBeDefined();
      expect(found!.currentPhase).toBe("operator_register");
    });
  });

  // ── getStats() includes new phases ────────────────────────────────────────

  describe("getStats() with new phases", () => {
    it("includes operator_register, operator_verify, dht_query in byPhase", () => {
      service.emit("job-stats", "operator_register", "completed");
      service.emit("job-stats", "dht_query", "failed");

      const stats = service.getStats();
      expect(stats.byPhase["operator_register"]).toBeDefined();
      expect(stats.byPhase["operator_verify"]).toBeDefined();
      expect(stats.byPhase["dht_query"]).toBeDefined();
      expect(stats.byPhase["operator_register"].total).toBe(1);
      expect(stats.byPhase["dht_query"].failed).toBe(1);
    });
  });

  // ── singleton ─────────────────────────────────────────────────────────────

  describe("singleton pipelineTelemetry", () => {
    it("is an instance of PipelineTelemetryService", () => {
      expect(pipelineTelemetry).toBeInstanceOf(PipelineTelemetryService);
    });

    it("shares the same reference on re-import", async () => {
      const { pipelineTelemetry: imported } = await import("../telemetry.js");
      expect(imported).toBe(pipelineTelemetry);
    });
  });
});
