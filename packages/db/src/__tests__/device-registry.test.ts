import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createStore, type Store } from "../index.js";

/**
 * Tests for extended device registry:
 *   - adapterType / adapterConfig columns
 *   - capabilities column
 *   - healthStatus / lastHealthCheck columns
 *   - findDevicesByAdapter, updateHealth, findHealthyDevices repo methods
 */
describe("Device Registry — adapter config + health", () => {
  let store: Store;

  /** A minimal kernel row required by the FK constraint on kernel_devices */
  const TEST_KERNEL = {
    id: "kernel-test-dr",
    name: "Test Kernel",
    operatorAddress: "0x0000000000000000000000000000000000000001",
    location: { lat: 0, lng: 0 },
    physicalAddress: "1 Test St",
    maxAssuranceTier: 1 as const,
    publicKey: "0x04test",
    reputation: 0,
    totalJobsCompleted: 0,
    status: "online" as const,
    registeredAt: new Date().toISOString(),
    lastHeartbeat: new Date().toISOString(),
    version: "1.0.0",
  };

  beforeEach(() => {
    // Start with no seed data so we control exactly what's in the DB
    store = createStore({ seed: false });
    store.repos.kernels.insert(TEST_KERNEL);
  });

  afterEach(() => {
    store.close();
  });

  // ── Insert with adapter config ─────────────────────────────────────

  describe("insertDevice with adapter config", () => {
    it("stores adapterType and adapterConfig as JSON", () => {
      const adapterCfg = JSON.stringify({
        type: "octoprint",
        url: "http://192.168.1.50",
        apiKey: "ABCDEF1234567890",
        mockMode: false,
      });

      const inserted = store.repos.kernels.insertDevice({
        id: "dev-octo-001",
        kernelId: TEST_KERNEL.id,
        type: "machine",
        model: "Prusa MK4",
        firmware: "5.1.0",
        status: "idle",
        contributesToCapabilities: ["cap-fdm"],
        lastUpdated: new Date().toISOString(),
        adapterType: "octoprint",
        adapterConfig: adapterCfg,
        capabilities: ["cap-fdm"],
        healthStatus: "unknown",
        lastHealthCheck: null,
      });

      expect(inserted).toBeDefined();
      expect(inserted!.adapterType).toBe("octoprint");
      expect(inserted!.adapterConfig).toBe(adapterCfg);
      expect(inserted!.capabilities).toEqual(["cap-fdm"]);
      expect(inserted!.healthStatus).toBe("unknown");
      expect(inserted!.lastHealthCheck).toBeNull();
    });

    it("stores a modbus device config", () => {
      const adapterCfg = JSON.stringify({
        type: "modbus",
        host: "10.0.0.5",
        port: 502,
        unitId: 1,
        mockMode: false,
      });

      const inserted = store.repos.kernels.insertDevice({
        id: "dev-modbus-001",
        kernelId: TEST_KERNEL.id,
        type: "machine",
        model: "CNC Router X200",
        firmware: "2.3.0",
        status: "idle",
        contributesToCapabilities: ["cap-cnc"],
        lastUpdated: new Date().toISOString(),
        adapterType: "modbus",
        adapterConfig: adapterCfg,
        capabilities: ["cap-cnc"],
        healthStatus: "unknown",
      });

      expect(inserted!.adapterType).toBe("modbus");
      const cfg = JSON.parse(inserted!.adapterConfig!);
      expect(cfg.port).toBe(502);
      expect(cfg.unitId).toBe(1);
    });

    it("allows null adapterType for sensors/cameras", () => {
      const inserted = store.repos.kernels.insertDevice({
        id: "dev-cam-001",
        kernelId: TEST_KERNEL.id,
        type: "camera",
        model: "Arducam IMX477",
        firmware: "2.0.0",
        status: "idle",
        contributesToCapabilities: ["cap-fdm"],
        lastUpdated: new Date().toISOString(),
        adapterType: null,
        adapterConfig: null,
        healthStatus: "unknown",
      });

      expect(inserted!.adapterType).toBeNull();
      expect(inserted!.adapterConfig).toBeNull();
    });

    it("defaults healthStatus to 'unknown' when not specified", () => {
      const inserted = store.repos.kernels.insertDevice({
        id: "dev-default-health-001",
        kernelId: TEST_KERNEL.id,
        type: "machine",
        model: "Test Machine",
        firmware: "1.0.0",
        status: "idle",
        contributesToCapabilities: [],
        lastUpdated: new Date().toISOString(),
      });

      // Drizzle default applies on the DB level
      const fetched = store.repos.kernels.findDeviceById("dev-default-health-001");
      expect(fetched!.healthStatus).toBe("unknown");
    });
  });

  // ── findDevicesByAdapter ───────────────────────────────────────────

  describe("findDevicesByAdapter", () => {
    beforeEach(() => {
      // Insert three devices: two octoprint, one modbus
      store.repos.kernels.insertDevice({
        id: "dev-octo-a",
        kernelId: TEST_KERNEL.id,
        type: "machine",
        model: "Prusa MK4",
        firmware: "5.1.0",
        status: "idle",
        contributesToCapabilities: [],
        lastUpdated: new Date().toISOString(),
        adapterType: "octoprint",
        adapterConfig: JSON.stringify({ type: "octoprint", url: "http://printer-a" }),
        healthStatus: "healthy",
      });
      store.repos.kernels.insertDevice({
        id: "dev-octo-b",
        kernelId: TEST_KERNEL.id,
        type: "machine",
        model: "Prusa MK3S+",
        firmware: "3.13.0",
        status: "idle",
        contributesToCapabilities: [],
        lastUpdated: new Date().toISOString(),
        adapterType: "octoprint",
        adapterConfig: JSON.stringify({ type: "octoprint", url: "http://printer-b" }),
        healthStatus: "degraded",
      });
      store.repos.kernels.insertDevice({
        id: "dev-modbus-a",
        kernelId: TEST_KERNEL.id,
        type: "machine",
        model: "CNC Router",
        firmware: "2.0.0",
        status: "idle",
        contributesToCapabilities: [],
        lastUpdated: new Date().toISOString(),
        adapterType: "modbus",
        adapterConfig: JSON.stringify({ type: "modbus", host: "10.0.0.5", port: 502 }),
        healthStatus: "healthy",
      });
    });

    it("returns all devices with the specified adapter type", () => {
      const octoDevices = store.repos.kernels.findDevicesByAdapter("octoprint");
      expect(octoDevices).toHaveLength(2);
      expect(octoDevices.every((d) => d.adapterType === "octoprint")).toBe(true);
    });

    it("returns only devices with modbus adapter", () => {
      const modbusDevices = store.repos.kernels.findDevicesByAdapter("modbus");
      expect(modbusDevices).toHaveLength(1);
      expect(modbusDevices[0].id).toBe("dev-modbus-a");
    });

    it("returns empty array when no devices match adapter type", () => {
      const sila = store.repos.kernels.findDevicesByAdapter("sila");
      expect(sila).toHaveLength(0);
    });
  });

  // ── updateHealth ──────────────────────────────────────────────────

  describe("updateHealth", () => {
    beforeEach(() => {
      store.repos.kernels.insertDevice({
        id: "dev-health-test",
        kernelId: TEST_KERNEL.id,
        type: "machine",
        model: "Hamilton STAR",
        firmware: "4.7.2",
        status: "idle",
        contributesToCapabilities: [],
        lastUpdated: new Date().toISOString(),
        adapterType: "generic-http",
        adapterConfig: JSON.stringify({ type: "generic-http", url: "http://hamilton-api" }),
        healthStatus: "unknown",
        lastHealthCheck: null,
      });
    });

    it("updates health status and timestamp", () => {
      const ts = Math.floor(Date.now() / 1000);
      const updated = store.repos.kernels.updateHealth("dev-health-test", "healthy", ts);

      expect(updated).toBeDefined();
      expect(updated!.healthStatus).toBe("healthy");
      expect(updated!.lastHealthCheck).toBe(ts);
    });

    it("can mark a device as degraded", () => {
      const ts = Math.floor(Date.now() / 1000);
      const updated = store.repos.kernels.updateHealth("dev-health-test", "degraded", ts);
      expect(updated!.healthStatus).toBe("degraded");
    });

    it("can mark a device as offline", () => {
      const ts = Math.floor(Date.now() / 1000);
      const updated = store.repos.kernels.updateHealth("dev-health-test", "offline", ts);
      expect(updated!.healthStatus).toBe("offline");
    });

    it("persists health update — findDeviceById reflects change", () => {
      const ts = Math.floor(Date.now() / 1000);
      store.repos.kernels.updateHealth("dev-health-test", "healthy", ts);

      const fetched = store.repos.kernels.findDeviceById("dev-health-test");
      expect(fetched!.healthStatus).toBe("healthy");
      expect(fetched!.lastHealthCheck).toBe(ts);
    });
  });

  // ── findHealthyDevices ────────────────────────────────────────────

  describe("findHealthyDevices", () => {
    beforeEach(() => {
      const now = new Date().toISOString();
      const ts = Math.floor(Date.now() / 1000);

      // Healthy devices for test kernel
      store.repos.kernels.insertDevice({
        id: "dev-h1",
        kernelId: TEST_KERNEL.id,
        type: "machine",
        model: "Machine A",
        firmware: "1.0",
        status: "idle",
        contributesToCapabilities: [],
        lastUpdated: now,
        healthStatus: "healthy",
        lastHealthCheck: ts,
      });
      store.repos.kernels.insertDevice({
        id: "dev-h2",
        kernelId: TEST_KERNEL.id,
        type: "machine",
        model: "Machine B",
        firmware: "1.0",
        status: "idle",
        contributesToCapabilities: [],
        lastUpdated: now,
        healthStatus: "healthy",
        lastHealthCheck: ts,
      });

      // Degraded device for same kernel — should NOT appear
      store.repos.kernels.insertDevice({
        id: "dev-h3",
        kernelId: TEST_KERNEL.id,
        type: "machine",
        model: "Machine C",
        firmware: "1.0",
        status: "error",
        contributesToCapabilities: [],
        lastUpdated: now,
        healthStatus: "degraded",
        lastHealthCheck: ts,
      });

      // Healthy device for a DIFFERENT kernel — should NOT appear when querying TEST_KERNEL
      store.repos.kernels.insert({
        id: "kernel-other",
        name: "Other Kernel",
        operatorAddress: "0x0000000000000000000000000000000000000002",
        location: { lat: 1, lng: 1 },
        physicalAddress: "2 Other St",
        maxAssuranceTier: 1,
        publicKey: "0x04other",
        reputation: 0,
        totalJobsCompleted: 0,
        status: "online",
        registeredAt: now,
        lastHeartbeat: now,
        version: "1.0.0",
      });
      store.repos.kernels.insertDevice({
        id: "dev-other-healthy",
        kernelId: "kernel-other",
        type: "machine",
        model: "Machine D",
        firmware: "1.0",
        status: "idle",
        contributesToCapabilities: [],
        lastUpdated: now,
        healthStatus: "healthy",
        lastHealthCheck: ts,
      });
    });

    it("returns only healthy devices for the specified kernel", () => {
      const healthy = store.repos.kernels.findHealthyDevices(TEST_KERNEL.id);
      expect(healthy).toHaveLength(2);
      expect(healthy.every((d) => d.healthStatus === "healthy")).toBe(true);
      expect(healthy.every((d) => d.kernelId === TEST_KERNEL.id)).toBe(true);
    });

    it("does not include devices from other kernels", () => {
      const healthy = store.repos.kernels.findHealthyDevices(TEST_KERNEL.id);
      const ids = healthy.map((d) => d.id);
      expect(ids).not.toContain("dev-other-healthy");
    });

    it("returns empty array when no healthy devices exist", () => {
      // Create a kernel with only degraded/offline devices
      store.repos.kernels.insert({
        id: "kernel-sick",
        name: "Sick Kernel",
        operatorAddress: "0x0000000000000000000000000000000000000003",
        location: { lat: 2, lng: 2 },
        physicalAddress: "3 Sick St",
        maxAssuranceTier: 1,
        publicKey: "0x04sick",
        reputation: 0,
        totalJobsCompleted: 0,
        status: "online",
        registeredAt: new Date().toISOString(),
        lastHeartbeat: new Date().toISOString(),
        version: "1.0.0",
      });
      store.repos.kernels.insertDevice({
        id: "dev-sick-1",
        kernelId: "kernel-sick",
        type: "machine",
        model: "Broken Machine",
        firmware: "1.0",
        status: "error",
        contributesToCapabilities: [],
        lastUpdated: new Date().toISOString(),
        healthStatus: "offline",
      });

      const healthy = store.repos.kernels.findHealthyDevices("kernel-sick");
      expect(healthy).toHaveLength(0);
    });
  });
});
