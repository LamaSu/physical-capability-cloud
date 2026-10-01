/**
 * The registration view of a device row (N71, operator item 86): an allow-list of
 * named fields. It is what POST /api/setup/register-device and POST
 * /api/devices/register answer with; device-credentials-redaction.test.ts drives both
 * through HTTP, this pins the function itself.
 */
import { describe, it, expect } from "vitest";
import { populateDeviceRegistrationDTO } from "../facades/populators/device.populator.js";

const SENTINEL = "N71-SENTINEL";

const ROW = {
  id: "dev-1",
  kernelId: "kernel-1",
  type: "machine",
  model: "Model X",
  firmware: "1.2.3",
  status: "idle",
  contributesToCapabilities: ["cap-a"],
  lastUpdated: "2026-09-30T00:00:00.000Z",
  adapterType: "octoprint",
  adapterConfig: JSON.stringify({ url: "http://printer.invalid", apiKey: SENTINEL }),
  capabilities: ["cap-a", "cap-b"],
  healthStatus: "healthy",
  lastHealthCheck: 1_790_000_000,
  emits: [{ id: "decl.self_attested" }],
};

const KEYS = [
  "adapterType",
  "capabilities",
  "contributesToCapabilities",
  "emits",
  "firmware",
  "healthStatus",
  "id",
  "kernelId",
  "lastHealthCheck",
  "lastUpdated",
  "model",
  "status",
  "type",
];

describe("populateDeviceRegistrationDTO", () => {
  it("returns every column but adapterConfig, with its value untouched", () => {
    const dto = populateDeviceRegistrationDTO(ROW as never);
    expect(dto).toBeDefined();
    expect(Object.keys(dto!).sort()).toEqual(KEYS);
    const { adapterConfig: _config, ...rest } = ROW;
    expect(dto).toEqual(rest);
  });

  it("carries nothing from inside adapterConfig", () => {
    const text = JSON.stringify(populateDeviceRegistrationDTO(ROW as never));
    expect(text).not.toContain(SENTINEL);
    expect(text).not.toContain("printer.invalid");
    expect(text).not.toContain("adapterConfig");
  });

  it("does not publish a column the row has later (an allow-list, not a rest-spread)", () => {
    const dto = populateDeviceRegistrationDTO({ ...ROW, futureColumn: `${SENTINEL}-future`, ownerToken: `${SENTINEL}-token` } as never);
    expect(Object.keys(dto!).sort()).toEqual(KEYS);
    expect(JSON.stringify(dto)).not.toContain(SENTINEL);
  });

  it("keeps the nullable columns present as null, so the shape does not depend on the row", () => {
    const sparse = { ...ROW, adapterType: null, capabilities: null, lastHealthCheck: null, emits: null };
    expect(populateDeviceRegistrationDTO(sparse as never)).toMatchObject({
      adapterType: null,
      capabilities: null,
      lastHealthCheck: null,
      emits: null,
    });
    // ... also when the repository leaves the key out altogether.
    const { adapterType: _a, capabilities: _c, lastHealthCheck: _l, emits: _e, ...partial } = ROW;
    const dto = populateDeviceRegistrationDTO(partial as never);
    expect(Object.keys(dto!).sort()).toEqual(KEYS);
    expect(dto).toMatchObject({ adapterType: null, capabilities: null, lastHealthCheck: null, emits: null });
  });

  it("no row is no device (an insert that returned nothing stays undefined)", () => {
    expect(populateDeviceRegistrationDTO(undefined)).toBeUndefined();
    expect(populateDeviceRegistrationDTO(null)).toBeUndefined();
  });
});
