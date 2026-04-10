import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createStore, type Store } from "../index.js";

describe("@pcc/store", () => {
  let store: Store;

  beforeEach(() => {
    store = createStore({ seed: true });
  });

  afterEach(() => {
    store.close();
  });

  // ── createStore ─────────────────────────────────────────────────

  describe("createStore", () => {
    it("creates an in-memory store with repos", () => {
      expect(store.db).toBeDefined();
      expect(store.repos).toBeDefined();
      expect(store.close).toBeInstanceOf(Function);
    });

    it("creates store without seed data", () => {
      const unseeded = createStore({ seed: false });
      expect(unseeded.repos.kernels.findAll()).toHaveLength(0);
      unseeded.close();
    });
  });

  // ── Kernels ─────────────────────────────────────────────────────

  describe("KernelRepository", () => {
    it("finds all seeded kernels", () => {
      const kernels = store.repos.kernels.findAll();
      expect(kernels.length).toBeGreaterThanOrEqual(3);
      expect(kernels.map((k) => k.id)).toContain("kernel-nyc");
    });

    it("finds kernel by id", () => {
      const kernel = store.repos.kernels.findById("kernel-sf");
      expect(kernel).toBeDefined();
      expect(kernel!.name).toBe("SF Precision Workshop");
      expect(kernel!.status).toBe("online");
    });

    it("returns undefined for missing kernel", () => {
      const kernel = store.repos.kernels.findById("kernel-nonexistent");
      expect(kernel).toBeUndefined();
    });

    it("finds devices by kernel", () => {
      const devices = store.repos.kernels.findDevicesByKernel("kernel-nyc");
      expect(devices.length).toBeGreaterThanOrEqual(2);
    });

    it("inserts a new kernel", () => {
      const inserted = store.repos.kernels.insert({
        id: "kernel-test",
        name: "Test Kernel",
        operatorAddress: "0x0000000000000000000000000000000000000000",
        location: { lat: 0, lng: 0 },
        physicalAddress: "123 Test St",
        maxAssuranceTier: 1,
        publicKey: "0x04test",
        reputation: 100,
        totalJobsCompleted: 0,
        status: "online",
        registeredAt: new Date().toISOString(),
        lastHeartbeat: new Date().toISOString(),
        version: "1.0.0",
      });
      expect(inserted!.id).toBe("kernel-test");
      expect(store.repos.kernels.findById("kernel-test")).toBeDefined();
    });
  });

  // ── Capabilities ────────────────────────────────────────────────

  describe("CapabilityRepository", () => {
    it("finds all capabilities", () => {
      const caps = store.repos.capabilities.findAll();
      expect(caps.length).toBeGreaterThanOrEqual(4);
    });

    it("finds capabilities by kernel", () => {
      const caps = store.repos.capabilities.findByKernel("kernel-nyc");
      expect(caps.length).toBeGreaterThanOrEqual(2);
      expect(caps.every((c) => c.kernelId === "kernel-nyc")).toBe(true);
    });

    it("searches capabilities by name", () => {
      const results = store.repos.capabilities.search("HPLC");
      expect(results.length).toBeGreaterThanOrEqual(1);
    });

    it("finds capability by type", () => {
      const fdmCaps = store.repos.capabilities.findByType("fdm");
      expect(fdmCaps.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── Jobs ────────────────────────────────────────────────────────

  describe("JobRepository", () => {
    it("finds all jobs", () => {
      const allJobs = store.repos.jobs.findAll();
      expect(allJobs.length).toBeGreaterThanOrEqual(4);
    });

    it("finds job by id", () => {
      const job = store.repos.jobs.findById("job-001");
      expect(job).toBeDefined();
      expect(job!.status).toBe("executing");
      expect(job!.progress).toBe(67);
    });

    it("finds jobs by status", () => {
      const executing = store.repos.jobs.findByStatus("executing");
      expect(executing.length).toBeGreaterThanOrEqual(2);
    });

    it("updates job status", () => {
      const updated = store.repos.jobs.updateStatus("job-003", "executing", 10);
      expect(updated!.status).toBe("executing");
      expect(updated!.progress).toBe(10);
    });
  });

  // ── Escrows ─────────────────────────────────────────────────────

  describe("EscrowRepository", () => {
    it("finds all escrows", () => {
      const allEscrows = store.repos.escrows.findAll();
      expect(allEscrows.length).toBe(3);
    });

    it("finds escrow by cwm", () => {
      const escrow = store.repos.escrows.findByCwm("cwm-001");
      expect(escrow).toBeDefined();
      expect(escrow!.totalAmount).toBe("77.00");
    });

    it("finds milestones by escrow", () => {
      const milestones = store.repos.escrows.findMilestonesByEscrow("esc-001");
      expect(milestones).toHaveLength(2);
    });
  });

  // ── Protocols ───────────────────────────────────────────────────

  describe("ProtocolTemplateRepository", () => {
    it("finds all templates", () => {
      const templates = store.repos.protocols.findAll();
      expect(templates.length).toBeGreaterThanOrEqual(2);
    });

    it("finds template by id", () => {
      const template = store.repos.protocols.findById("ptpl_bioassay001");
      expect(template).toBeDefined();
      expect(template!.name).toBe("Serum Protein Analysis");
      expect(template!.status).toBe("published");
    });

    it("finds steps by template", () => {
      const steps = store.repos.protocols.findStepsByTemplate("ptpl_bioassay001");
      expect(steps).toHaveLength(4);
    });

    it("finds transfers by template", () => {
      const transfers = store.repos.protocols.findTransfersByTemplate("ptpl_bioassay001");
      expect(transfers).toHaveLength(3);
    });

    it("finds forks by template", () => {
      const forks = store.repos.protocols.findForksByTemplate("ptpl_bioassay001");
      expect(forks).toHaveLength(1);
      expect(forks[0].name).toContain("High Volume");
    });

    it("publishes a draft template", () => {
      const published = store.repos.protocols.publish("ptpl_3dprint_qc001");
      expect(published!.status).toBe("published");
    });
  });

  // ── Protocol Runs ───────────────────────────────────────────────

  describe("ProtocolRunRepository", () => {
    it("finds run by id", () => {
      const run = store.repos.protocolRuns.findById("prun_active_001");
      expect(run).toBeDefined();
      expect(run!.status).toBe("running");
      expect(run!.currentStepIndex).toBe(2);
    });

    it("finds run steps", () => {
      const steps = store.repos.protocolRuns.findRunSteps("prun_active_001");
      expect(steps).toHaveLength(4);
    });

    it("finds run transfers", () => {
      const transfers = store.repos.protocolRuns.findRunTransfers("prun_active_001");
      expect(transfers).toHaveLength(3);
    });
  });

  // ── Automation Status ───────────────────────────────────────────

  describe("AutomationStatusRepository", () => {
    it("finds statuses by kernel", () => {
      const statuses = store.repos.automationStatuses.findByKernel("kernel-biolab-01");
      expect(statuses).toHaveLength(2);
    });

    it("finds status by transfer pair", () => {
      const status = store.repos.automationStatuses.findByTransferPair("node-liquid", "node-centrifuge");
      expect(status).toBeDefined();
      expect(status!.currentLevel).toBe("manual");
      expect(status!.episodeCount).toBe(5);
    });

    it("records an episode", () => {
      const updated = store.repos.automationStatuses.recordEpisode("astatus-liq-centri");
      expect(updated).toBeDefined();
      expect(updated!.episodeCount).toBe(6);
    });

    it("finds transfer agents", () => {
      const agents = store.repos.automationStatuses.findAllAgents();
      expect(agents).toHaveLength(2);
    });
  });

  // ── Orchestrator ────────────────────────────────────────────────

  describe("OrchestratorRepository", () => {
    it("finds graph by kernel", () => {
      const graph = store.repos.orchestrator.findGraphByKernel("kernel-biolab-01");
      expect(graph).toBeDefined();
      expect(graph!.id).toBe("graph-biolab-01");
    });

    it("finds nodes by graph", () => {
      const nodes = store.repos.orchestrator.findNodesByGraph("graph-biolab-01");
      expect(nodes).toHaveLength(5);
    });

    it("finds edges by graph", () => {
      const edges = store.repos.orchestrator.findEdgesByGraph("graph-biolab-01");
      expect(edges).toHaveLength(4);
    });

    it("finds samples by job", () => {
      const jobSamples = store.repos.orchestrator.findSamplesByJob("job-bio-42");
      expect(jobSamples).toHaveLength(2);
    });

    it("finds movements by sample", () => {
      const movements = store.repos.orchestrator.findMovementsBySample("samp-001");
      expect(movements).toHaveLength(2);
    });

    it("finds active claims", () => {
      const claims = store.repos.orchestrator.findActiveClaims();
      expect(claims).toHaveLength(1);
      expect(claims[0].nodeId).toBe("node-centrifuge");
    });

    it("releases a claim", () => {
      const released = store.repos.orchestrator.releaseClaim("claim-001");
      expect(released!.released).toBe(true);
      expect(released!.releasedAt).toBeDefined();
      expect(store.repos.orchestrator.findActiveClaims()).toHaveLength(0);
    });
  });

  // ── Logistics ───────────────────────────────────────────────────

  describe("LogisticsRepository", () => {
    it("finds all providers", () => {
      const providers = store.repos.logistics.findAllProviders();
      expect(providers).toHaveLength(3);
    });

    it("finds shipment by id", () => {
      const shipment = store.repos.logistics.findShipmentById("shp-001");
      expect(shipment).toBeDefined();
      expect(shipment!.status).toBe("in_transit");
      expect(shipment!.equipmentDescription).toBe("Prusa MK4 + MMU3 + Enclosure");
    });

    it("finds tracking events for shipment", () => {
      const events = store.repos.logistics.findTrackingEvents("shp-001");
      expect(events).toHaveLength(3);
    });

    it("finds condition readings for shipment", () => {
      const readings = store.repos.logistics.findConditionReadings("shp-001");
      expect(readings).toHaveLength(2);
    });

    it("finds all bookings", () => {
      const bookings = store.repos.logistics.findAllBookings();
      expect(bookings).toHaveLength(2);
    });

    it("finds installations by status", () => {
      const scheduled = store.repos.logistics.findInstallationsByStatus("scheduled");
      expect(scheduled).toHaveLength(1);
      expect(scheduled[0].id).toBe("inst-001");
    });

    it("finds installation steps", () => {
      const steps = store.repos.logistics.findInstallationSteps("inst-001");
      expect(steps).toHaveLength(10);
    });

    it("finds installation notes", () => {
      const notes = store.repos.logistics.findInstallationNotes("inst-002");
      expect(notes).toHaveLength(2);
    });

    it("finds timeline events", () => {
      const events = store.repos.logistics.findAllTimelineEvents();
      expect(events).toHaveLength(5);
    });
  });
});
