import { describe, it, expect } from "vitest";
import {
  CWMSchema,
  EvidenceBundleSchema,
  EvidenceEventSchema,
  SHA256Schema,
  AddressSchema,
  AssuranceTierSchema,
  CapabilitySchema,
  ShopKernelSchema,
} from "../schemas/index.js";
import { EVIDENCE_DEVICE_TYPES, EVIDENCE_EVENT_TYPES } from "../types/evidence.js";
import { isFabricated } from "../evidence/is-fabricated.js";
import type { EvidenceSource } from "../types/evidence.js";

describe("SHA256Schema", () => {
  it("accepts valid sha256 hashes", () => {
    const valid = "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    expect(SHA256Schema.safeParse(valid).success).toBe(true);
  });

  it("rejects invalid formats", () => {
    expect(SHA256Schema.safeParse("not-a-hash").success).toBe(false);
    expect(SHA256Schema.safeParse("sha256:short").success).toBe(false);
    expect(SHA256Schema.safeParse("md5:e3b0c44298fc1c149afbf4c8996fb924").success).toBe(false);
  });
});

describe("AddressSchema", () => {
  it("accepts valid Ethereum addresses", () => {
    expect(AddressSchema.safeParse("0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18").success).toBe(true);
  });

  it("rejects invalid addresses", () => {
    expect(AddressSchema.safeParse("not-an-address").success).toBe(false);
    expect(AddressSchema.safeParse("0x123").success).toBe(false);
  });
});

describe("AssuranceTierSchema", () => {
  it("accepts tiers 0-3", () => {
    expect(AssuranceTierSchema.safeParse(0).success).toBe(true);
    expect(AssuranceTierSchema.safeParse(1).success).toBe(true);
    expect(AssuranceTierSchema.safeParse(2).success).toBe(true);
    expect(AssuranceTierSchema.safeParse(3).success).toBe(true);
  });

  it("rejects invalid tiers", () => {
    expect(AssuranceTierSchema.safeParse(4).success).toBe(false);
    expect(AssuranceTierSchema.safeParse(-1).success).toBe(false);
    expect(AssuranceTierSchema.safeParse("high").success).toBe(false);
  });
});

describe("CWMSchema", () => {
  const validCWM = {
    version: "1.0" as const,
    id: "cwm_test123",
    name: "Test Workflow",
    steps: [
      {
        id: "step_1",
        capability: "fdm",
        params: { material: "pla", infill: 20 },
        inputs: [
          {
            fileHash: "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            mimeType: "application/x-gcode",
            storageRef: "ipfs://QmTest123",
            filename: "part.gcode",
          },
        ],
        assuranceTier: 1 as const,
        dependsOn: [],
      },
      {
        id: "step_2",
        capability: "courier-pickup",
        params: {},
        courier: {
          from: { stepId: "step_1" },
          to: { address: "123 Main St", location: { lat: 40.7128, lng: -74.006 } },
          priority: "standard" as const,
        },
        assuranceTier: 0 as const,
        dependsOn: ["step_1"],
      },
    ],
    settlement: {
      currency: "USDC" as const,
      maxBudget: "50.00",
      payer: "0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18",
    },
    createdAt: "2026-01-15T10:00:00Z",
    submitter: "0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18",
  };

  it("accepts a valid CWM", () => {
    const result = CWMSchema.safeParse(validCWM);
    expect(result.success).toBe(true);
  });

  it("requires at least one step", () => {
    const invalid = { ...validCWM, steps: [] };
    expect(CWMSchema.safeParse(invalid).success).toBe(false);
  });

  it("requires version 1.0", () => {
    const invalid = { ...validCWM, version: "2.0" };
    expect(CWMSchema.safeParse(invalid).success).toBe(false);
  });

  it("validates step capability types", () => {
    const invalid = {
      ...validCWM,
      steps: [{ ...validCWM.steps[0], capability: "teleporter" }],
    };
    expect(CWMSchema.safeParse(invalid).success).toBe(false);
  });
});

describe("EvidenceEventSchema", () => {
  const validEvent = {
    id: "ev_test1",
    type: "execution_completed",
    timestamp: "2026-01-15T10:30:00Z",
    source: {
      deviceId: "dev_printer1",
      deviceType: "controller",
      kernelId: "kernel_shop1",
    },
    payload: { duration_seconds: 3600 },
    hash: "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  };

  it("accepts a valid evidence event", () => {
    expect(EvidenceEventSchema.safeParse(validEvent).success).toBe(true);
  });

  it("validates event types", () => {
    const invalid = { ...validEvent, type: "magic_happened" };
    expect(EvidenceEventSchema.safeParse(invalid).success).toBe(false);
  });

  it("validates device types", () => {
    const invalid = { ...validEvent, source: { ...validEvent.source, deviceType: "quantum" } };
    expect(EvidenceEventSchema.safeParse(invalid).success).toBe(false);
  });

  // ── deviceType enum ↔ TS union reconciliation (coord #312) ────────────────
  // The zod enum had drifted to 9 hand-listed values while the TS union grew
  // to 26 — sila / modbus / opentrons / instrument events failed parse
  // wherever the schema was enforced. The enum now derives from
  // EVIDENCE_DEVICE_TYPES (single source of truth).

  it("accepts every device type in the TS union (sila/modbus/opentrons devices included)", () => {
    for (const deviceType of EVIDENCE_DEVICE_TYPES) {
      const event = { ...validEvent, source: { ...validEvent.source, deviceType } };
      const parsed = EvidenceEventSchema.safeParse(event);
      expect(parsed.success, `deviceType "${deviceType}" must parse`).toBe(true);
    }
  });

  it("accepts every event type in the TS union (instrument/sensor-pipeline/machine-log events included)", () => {
    // The event-type enum had the same drift bug as deviceType (27 of 56
    // values) — this loop pins both to their single source of truth.
    for (const type of EVIDENCE_EVENT_TYPES) {
      const event = { ...validEvent, type };
      const parsed = EvidenceEventSchema.safeParse(event);
      expect(parsed.success, `event type "${type}" must parse`).toBe(true);
    }
  });

  it("accepts a sila-style instrument event (the previously-failing case)", () => {
    const silaEvent = {
      ...validEvent,
      type: "instrument_result",
      source: {
        deviceId: "dev_sila_plate_reader",
        deviceType: "instrument",
        kernelId: "kernel_lab1",
        simulated: true,
      },
      payload: { mock: true, well: "A1" },
    };
    const parsed = EvidenceEventSchema.safeParse(silaEvent);
    expect(parsed.success).toBe(true);
  });

  it("round-trips source.simulated through parse (the honesty tag is not stripped)", () => {
    const tagged = {
      ...validEvent,
      source: { ...validEvent.source, simulated: true },
    };
    const parsed = EvidenceEventSchema.parse(tagged);
    expect(parsed.source.simulated).toBe(true);
  });
});

describe("isFabricated (canonical fabrication predicate)", () => {
  const source = (over: Partial<EvidenceSource> = {}): EvidenceSource => ({
    deviceId: "dev-1",
    deviceType: "controller",
    kernelId: "k-1",
    ...over,
  });

  it("detects the source.simulated leg", () => {
    expect(isFabricated({ source: source({ simulated: true }), payload: {} })).toBe(true);
  });

  it("detects the payload.mock leg", () => {
    expect(isFabricated({ source: source(), payload: { mock: true } })).toBe(true);
  });

  it("is strict === true on both legs (money-path: truthy is not enough)", () => {
    expect(isFabricated({ source: source(), payload: { mock: "true" } })).toBe(false);
    expect(isFabricated({ source: source(), payload: { mock: 1 } })).toBe(false);
    expect(
      isFabricated({
        source: source({ simulated: "yes" as unknown as boolean }),
        payload: {},
      }),
    ).toBe(false);
  });

  it("treats absent / null / undefined as honest", () => {
    expect(isFabricated({ source: source(), payload: {} })).toBe(false);
    expect(isFabricated(null)).toBe(false);
    expect(isFabricated(undefined)).toBe(false);
    expect(isFabricated({})).toBe(false);
  });
});
