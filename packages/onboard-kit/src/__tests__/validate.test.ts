import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validate } from "../validate.js";
import type { OnboardConfig } from "../types.js";
import { getRegisteredTypes } from "@pcc/contract-builder";
import { loadBuiltinCsds } from "@pcc/spec";
import { getKnownCapabilityTypes } from "../known-types.js";

function makeValidConfig(): OnboardConfig {
  return {
    kernel: {
      kernelId: "kernel_test_001",
      name: "Test Workshop",
      location: { lat: 37.77, lng: -122.41 },
      walletPrivateKeyEnvVar: "KERNEL_PRIVATE_KEY",
      gatewayUrl: "http://localhost:3200",
      httpPort: 3100,
    },
    adapters: [
      {
        adapterId: "dev-machine-01",
        className: "TestMachine",
        adapterType: "machine",
        protocol: "http",
        connectionString: "http://localhost:8080",
        deviceType: "controller",
        firmwareVersion: "Test-1.0.0",
        endpoints: [
          { method: "GET", path: "/status", purpose: "status", description: "Status" },
          { method: "POST", path: "/start", purpose: "start", description: "Start" },
        ],
      },
      {
        adapterId: "dev-sensor-01",
        className: "TestSensor",
        adapterType: "sensor",
        protocol: "http",
        connectionString: "http://localhost:9090",
        deviceType: "sensor",
        firmwareVersion: "Sensor-1.0.0",
      },
    ],
    capabilities: [
      {
        type: "fdm",
        name: "Test Printer",
        materials: ["pla", "petg"],
        assuranceTiers: [0, 1],
        pricing: {
          currency: "USDC",
          baseCost: "5.00",
          perMinute: "0.10",
          minimum: "10.00",
        },
        adapterId: "dev-machine-01",
      },
    ],
  };
}

describe("validate", () => {
  it("should pass for a valid configuration", () => {
    const result = validate({ config: makeValidConfig() });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("should fail for missing kernel ID", () => {
    const config = makeValidConfig();
    config.kernel.kernelId = "";
    const result = validate({ config });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.name.includes("kernelId"))).toBe(true);
  });

  it("should warn for an unknown capability type", () => {
    const config = makeValidConfig();
    (config.capabilities[0] as any).type = "invalid-type";
    const result = validate({ config });
    expect(result.valid).toBe(true);
    expect(result.warnings.some(e => e.name === "capability[invalid-type].type")).toBe(true);
  });

  it("should fail for invalid currency", () => {
    const config = makeValidConfig();
    (config.capabilities[0].pricing as any).currency = "BTC";
    const result = validate({ config });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.message.includes("Invalid currency"))).toBe(true);
  });

  it("should fail for missing adapters", () => {
    const config = makeValidConfig();
    config.adapters = [];
    const result = validate({ config });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.message.includes("At least one adapter"))).toBe(true);
  });

  it("should fail for duplicate adapter IDs", () => {
    const config = makeValidConfig();
    config.adapters.push({ ...config.adapters[0] });
    const result = validate({ config });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.message.includes("Duplicate adapter ID"))).toBe(true);
  });

  it("should fail for capability referencing non-existent adapter", () => {
    const config = makeValidConfig();
    config.capabilities[0].adapterId = "nonexistent";
    const result = validate({ config });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.message.includes("does not exist"))).toBe(true);
  });

  it("should warn for tier 2 without camera adapter", () => {
    const config = makeValidConfig();
    config.capabilities[0].assuranceTiers = [0, 1, 2] as any;
    const result = validate({ config });
    expect(result.warnings.some(w => w.message.includes("camera adapter"))).toBe(true);
  });

  it("should warn for kernel ID not starting with kernel_", () => {
    const config = makeValidConfig();
    config.kernel.kernelId = "my-shop";
    const result = validate({ config });
    expect(result.warnings.some(w => w.message.includes("kernel_"))).toBe(true);
  });

  it("should fail for out-of-range location", () => {
    const config = makeValidConfig();
    config.kernel.location.lat = 200;
    const result = validate({ config });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.name.includes("lat"))).toBe(true);
  });

  it("V1: a machine adapter with no capability class gives a named error", () => {
    const config = makeValidConfig();
    config.capabilities = [];
    const result = validate({ config });
    expect(result.valid).toBe(false);
    const error = result.errors.find(e => e.name === "adapter[dev-machine-01].capabilityClass");
    expect(error).toBeDefined();
    expect(error?.message).toContain("dev-machine-01");
    expect(error?.message).toMatch(/add exactly one capability class/i);
  });

  it("V2: two distinct classes on one machine adapter give a named error", () => {
    const config = makeValidConfig();
    config.capabilities[0]!.type = "liquid-handler";
    config.capabilities.push({ ...config.capabilities[0]!, type: "hplc" });
    const result = validate({ config });
    expect(result.valid).toBe(false);
    const error = result.errors.find(e => e.name === "adapter[dev-machine-01].capabilityClass");
    expect(error).toBeDefined();
    expect(error?.message).toContain("dev-machine-01");
    expect(error?.message).toContain("liquid-handler");
    expect(error?.message).toContain("hplc");
  });

  it("V3: a liquid-handler ladder does not inherit FDM sensor or camera hints", () => {
    const config = makeValidConfig();
    config.capabilities[0]!.type = "liquid-handler";
    config.capabilities[0]!.assuranceTiers = [0, 1, 2];
    config.adapters = config.adapters.filter(adapter => adapter.adapterType === "machine");
    const result = validate({ config });
    expect(result.valid).toBe(true);
    expect(result.warnings.filter(w => w.name.endsWith("tier1.sensors") || w.name.endsWith("tier2.camera"))).toEqual([]);
  });

  it("V4: each of two machine adapters has its own capability class", () => {
    const config = makeValidConfig();
    config.adapters.push({ ...config.adapters[0]!, adapterId: "dev-liquid-02", className: "LiquidAdapter" });
    config.capabilities.push({ ...config.capabilities[0]!, adapterId: "dev-liquid-02", type: "liquid-handler" });
    const result = validate({ config });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    for (const [id, type] of [["dev-machine-01", "fdm"], ["dev-liquid-02", "liquid-handler"]]) {
      expect(result.checks.find(check => check.name === `adapter[${id}].capabilityClass`)).toEqual(expect.objectContaining({
        passed: true, severity: "error", message: `Adapter "${id}" has capability class ${type}`,
      }));
    }
  });
});

describe("local config rules", () => {
  const error = (name: string, message: string) => ({ name, message, passed: false, severity: "error" });
  const warning = (name: string, message: string) => ({ name, message, passed: false, severity: "warning" });
  const amountError = (value: string, reason: "invalid-price" | "invalid-minimum") =>
    `${JSON.stringify(value)} is not an amount with at most two decimals; the gateway's discovery quote refuses it (capability_price_undeclared: ${reason})`;
  const slugWarning = (type: string) => `${JSON.stringify(type)} is not a slug (lowercase letters and digits joined by single "-" or "."); the gateway accepts any type`;
  const walletMessage = "the scaffolded agent never reads the variable named in walletPrivateKeyEnvVar; KernelAgent takes no wallet setting, so its wallet is a new random key each start";
  const walletError = 'is not an environment variable name (a letter or "_", then letters, digits or "_"); the scaffold writes it as a key of .env.example';
  const withType = (type: string) => {
    const config = makeValidConfig();
    config.capabilities[0].type = type as any;
    return config;
  };

  it("CV1: recognizes a capability known only through a CSD", () => {
    const result = validate({ config: withType("2d-print") });
    expect(result.valid).toBe(true);
    expect(result.errors.some(e => e.name === "capability[2d-print].type")).toBe(false);
    expect(result.checks).toContainEqual({
      name: "capability[2d-print].type", passed: true, severity: "info",
      message: "2d-print has a template or CSD in this kit",
    });
  });

  it("CV2: unknown types warn with a nearest-name hint when available", () => {
    for (const [type, hint] of [["cnc-3-axis", "cnc-3axis"], ["FDM", "fdm"], ["zzzz-unrelated", undefined]]) {
      const result = validate({ config: withType(type!) });
      expect(result.valid, type).toBe(true);
      const name = `capability[${type}].type`;
      expect(result.warnings).toContainEqual(warning(name,
        `${type} has no template or CSD in this kit, so buyers can't price it with the contract builder${hint ? ` (did you mean ${hint}?)` : ""}; the gateway accepts any type`));
      expect(result.warnings.filter(w => w.name === name && w.message.includes("is not a slug")))
        .toEqual(type === "FDM" ? [warning(name, slugWarning(type))] : []);
    }
  });

  it("CV3: discovery quotes accept only a syntactically valid USDC currency", () => {
    for (const currency of ["ETH", "DAI", "SOL", "eth"]) {
      const config = makeValidConfig();
      config.capabilities[0].pricing.currency = currency as any;
      const result = validate({ config });
      expect(result.valid, currency).toBe(false);
      expect(result.errors).toContainEqual(error("capability[fdm].pricing.currency", currency === "eth"
        ? 'Invalid currency "eth": the gateway\'s discovery quote refuses it (capability_price_undeclared: invalid-currency)'
        : `Invalid currency "${currency}": the gateway quotes only USDC, with no conversion (capability_price_unsupported_currency)`));
    }
  });

  it("CV4: refuses a partially numeric baseCost", () => {
    const config = makeValidConfig();
    config.capabilities[0].pricing.baseCost = "5abc";
    const result = validate({ config });
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(error("capability[fdm].pricing.baseCost", amountError("5abc", "invalid-price")));
  });

  it("CV5: refuses a zero baseCost but accepts a zero minimum", () => {
    const zero = makeValidConfig();
    zero.capabilities[0].pricing.baseCost = "0";
    const result = validate({ config: zero });
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(error("capability[fdm].pricing.baseCost",
      '"0" is zero; the gateway\'s discovery quote refuses a zero price (capability_price_undeclared: zero-price)'));
    const config = makeValidConfig();
    config.capabilities[0].pricing.minimum = "0";
    const accepted = validate({ config });
    expect(accepted.valid).toBe(true);
    expect(accepted.errors.filter(e => e.name.includes(".pricing"))).toEqual([]);
  });

  it("CV6: follows the shared amount and usage precision rules", () => {
    for (const value of ["10.555", "05.00"]) {
      const config = makeValidConfig();
      config.capabilities[0].pricing.baseCost = value;
      expect(validate({ config }).errors).toContainEqual(error("capability[fdm].pricing.baseCost", amountError(value, "invalid-price")));
    }
    const minimum = makeValidConfig();
    minimum.capabilities[0].pricing.minimum = "1.5.0";
    expect(validate({ config: minimum }).errors).toContainEqual(error("capability[fdm].pricing.minimum", amountError("1.5.0", "invalid-minimum")));
    for (const field of ["perMinute", "perGram", "perCm3"] as const) {
      const config = makeValidConfig();
      config.capabilities[0].pricing[field] = "0.1234567";
      expect(validate({ config }).errors).toContainEqual(error("capability[fdm].pricing",
        "a usage rate (perMinute, perGram, perCm3) is not an amount with at most six decimals; the gateway's discovery quote refuses it (capability_price_undeclared: invalid-usage)"));
    }
  });

  it("CV7: funded deals must be able to name the kernel id", () => {
    for (const id of ["kernel_acme cnc", "EIP155:1:abc", "Ed25519:abc", "x".repeat(129)]) {
      const config = makeValidConfig();
      config.kernel.kernelId = id;
      const result = validate({ config });
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(error("kernel.kernelId",
        `${JSON.stringify(id)} cannot be named in a funded deal: use 1 to 128 printable ASCII characters, no spaces, not starting with eip155: or ed25519:`));
    }
  });

  it("CV8: refuses one ambiguous type exactly once", () => {
    const config = makeValidConfig();
    config.capabilities.push({ ...config.capabilities[0], name: "Another Printer" });
    const result = validate({ config });
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([error("capability[fdm]",
      "more than one capability of type fdm on one kernel; the gateway's quote refuses an ambiguous type (capability_ambiguous)")]);
  });

  it("CV9: reports only distinct tiers missing from the committed-program registry", () => {
    for (const [type, tiers, missing] of [
      ["cnc-3axis", [0, 1, 2], [1, 2]], ["cnc-3axis", [2, 1, 2, 0], [1, 2]],
      ["cnc-3axis", [0, 1], [1]], ["cnc-3axis", [0], []],
      ["document-print-leg", [0, 1], []], ["document-print-and-mail", [0, 1, 2], [1]],
    ] as const) {
      const config = withType(type);
      config.capabilities[0].assuranceTiers = [...tiers];
      const result = validate({ config });
      expect(result.valid, type).toBe(true);
      const name = `capability[${type}].fundableTiers`;
      const list = missing.join(", ");
      expect(result.warnings.filter(w => w.name === name)).toEqual(missing.length === 0 ? [] : [warning(name,
        missing.length === 1
          ? `tier ${list} has no committed program for ${type} in this kit, so a buyer can't fund this capability at tier ${list}`
          : `tiers ${list} have no committed program for ${type} in this kit, so a buyer can't fund this capability at tiers ${list}`)]);
    }
  });

  it("CV10: shape failures precede rules but retain scaffold-rule errors", () => {
    const config = makeValidConfig();
    delete (config.kernel as any).location;
    expect(() => validate({ config })).not.toThrow();
    const result = validate({ config });
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(error("kernel.location", "required"));
    config.kernel.walletPrivateKeyEnvVar = "KERNEL-KEY";
    expect(validate({ config }).errors).toEqual([
      error("kernel.location", "required"), error("kernel.walletPrivateKeyEnvVar", walletError),
    ]);
  });

  it("CV11: malformed roots and arrays return shape errors without pricing rules", () => {
    const config = makeValidConfig();
    delete (config as any).adapters;
    expect(() => validate({ config })).not.toThrow();
    expect(validate({ config }).errors).toContainEqual(error("adapters", "required"));
    config.capabilities[0].pricing.baseCost = "5abc";
    expect(validate({ config }).checks.some(c => c.name === "capability[fdm].pricing.baseCost")).toBe(false);
    const missingCaps = makeValidConfig();
    delete (missingCaps as any).capabilities;
    expect(() => validate({ config: missingCaps })).not.toThrow();
    expect(validate({ config: missingCaps }).errors).toContainEqual(error("capabilities", "required"));
    const badAdapter = makeValidConfig();
    badAdapter.adapters = [7] as any;
    expect(validate({ config: badAdapter }).errors).toContainEqual(error("adapters[0]", "Expected object, received number"));
    expect(validate({ config: null as any }).errors).toContainEqual(error("config", "Expected object, received null"));
    for (const root of [[], 7]) expect(validate({ config: root as any }).errors.some(e => e.name === "config")).toBe(true);

    const nested = makeValidConfig();
    (nested.adapters[0].endpoints![1] as any).path = 7;
    (nested.capabilities[0].pricing as any).baseCost = 5;
    (nested as any).extra = "allowed";
    expect(validate({ config: nested }).errors).toEqual([
      error("adapter[dev-machine-01].endpoints[1].path", "Expected string, received number"),
      error("capability[fdm].pricing.baseCost", "Expected string, received number"),
    ]);
    const opaqueId = makeValidConfig();
    opaqueId.adapters[0].adapterId = { toString: 1 } as any;
    expect(() => validate({ config: opaqueId })).not.toThrow();
    expect(validate({ config: opaqueId }).errors.some(e => e.name === 'adapter[{"toString":1}].adapterId')).toBe(true);
    (opaqueId.adapters[0] as any).deviceType = 7;
    expect(validate({ config: opaqueId }).errors).toContainEqual(error('adapter[{"toString":1}].deviceType', "Expected string, received number"));
  });

  it("CV12: preserves the wallet variable error and explains the unused setting", () => {
    const config = makeValidConfig();
    config.kernel.walletPrivateKeyEnvVar = "KERNEL-KEY";
    expect(validate({ config }).errors).toContainEqual(error("kernel.walletPrivateKeyEnvVar", walletError));
    expect(validate({ config: makeValidConfig() }).warnings).toContainEqual(warning("kernel.walletPrivateKeyEnvVar", walletMessage));
  });

  it("CV13: deviceType warnings follow what each generated adapter writes", () => {
    const sensorMessage = 'the generated sensor adapter writes deviceType "sensor" whatever this field says, and "sensor" is not an evidence device type in @pcc/spec; schema-checking verifiers refuse its events until you change it in the generated adapter (for example to power_monitor)';
    const result = validate({ config: makeValidConfig() });
    expect(result.warnings).toContainEqual(warning("adapter[dev-sensor-01].deviceType", sensorMessage));
    expect(result.warnings.some(w => w.name === "adapter[dev-machine-01].deviceType")).toBe(false);

    const sensor = makeValidConfig();
    sensor.adapters[1].deviceType = "power_monitor";
    const sensorResult = validate({ config: sensor });
    expect(sensorResult.warnings).toContainEqual(warning("adapter[dev-sensor-01].deviceType", sensorMessage));
    expect(sensorResult.warnings.filter(w => w.name === "adapter[dev-sensor-01].deviceType")).toHaveLength(1);

    const machine = makeValidConfig();
    machine.adapters[0].deviceType = "robot";
    expect(validate({ config: machine }).warnings).toContainEqual(warning("adapter[dev-machine-01].deviceType",
      '"robot" is not an evidence device type in @pcc/spec (for example controller, power_monitor, robot_arm); schema-checking verifiers refuse its events'));

    const camera: OnboardConfig = JSON.parse(readFileSync(fileURLToPath(new URL("../examples/cnc-shop-config.json", import.meta.url)), "utf8"));
    camera.adapters.find(adapter => adapter.adapterId === "dev-qc-camera")!.deviceType = "robot";
    const cameraResult = validate({ config: camera });
    expect(cameraResult.checks.some(c => c.name === "adapter[dev-qc-camera].connectionString")).toBe(true);
    expect(cameraResult.warnings.some(w => w.name === "adapter[dev-qc-camera].deviceType")).toBe(false);
  });

  it("CV14: only machine adapters warn about the generated HTTP transport", () => {
    const config = makeValidConfig();
    config.adapters[0].protocol = "opcua";
    config.adapters[1].protocol = "modbus";
    const result = validate({ config });
    expect(result.valid).toBe(true);
    expect(result.warnings).toContainEqual(warning("adapter[dev-machine-01].protocol",
      "the scaffold writes an HTTP adapter for every machine adapter; write the opcua transport yourself"));
    expect(result.warnings.some(w => w.name === "adapter[dev-sensor-01].protocol")).toBe(false);
  });

  it("CV15: gateway URL advice omits credentials and permits HTTP loopback", () => {
    for (const url of ["ftp://user:pw@x", "not a url", "http://gw.example"]) {
      const config = makeValidConfig();
      config.kernel.gatewayUrl = url;
      const result = validate({ config });
      expect(result.valid).toBe(true);
      expect(result.checks.some(c => c.message.includes("pw@"))).toBe(false);
      expect(result.warnings).toContainEqual(warning("kernel.gatewayUrl", url === "http://gw.example"
        ? "plain http to gw.example; operator sessions accept plain http only on loopback" : "not an http or https URL"));
    }
    for (const url of ["http://localhost:3200", "http://127.0.0.1:3200", "http://[::1]:3200", "https://gw.example"]) {
      const config = makeValidConfig();
      config.kernel.gatewayUrl = url;
      expect(validate({ config }).checks.filter(c => !c.passed && c.name === "kernel.gatewayUrl")).toEqual([]);
    }
  });

  it("CV16: the original valid fixture gains precisely the five advisory warnings", () => {
    const result = validate({ config: makeValidConfig() });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings.map(w => w.name)).toEqual([
      "kernel.walletPrivateKeyEnvVar", "adapter[dev-sensor-01].deviceType",
      "capability[fdm].pricing", "capability[fdm].pricing", "capability[fdm].fundableTiers",
    ]);
    expect(result.warnings.filter(w => w.name === "capability[fdm].pricing")).toEqual([
      warning("capability[fdm].pricing", "a non-zero usage rate is set; the gateway's discovery quote discloses it without charging it, and the plan path refuses it"),
      warning("capability[fdm].pricing", 'baseCost "5.00" is below minimum "10.00"; the discovery quote charges the minimum, and the plan path refuses a baseCost below the minimum'),
    ]);
    const config = makeValidConfig();
    config.capabilities[0].pricing.perMinute = "0";
    config.capabilities[0].pricing.minimum = "5.00";
    expect(validate({ config }).warnings.filter(w => w.name === "capability[fdm].pricing")).toEqual([]);
  });

  it("CV17: a malformed type remains accepted with two warnings", () => {
    const result = validate({ config: withType("Not A Type!") });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings.filter(w => w.name === "capability[Not A Type!].type")).toEqual([
      warning("capability[Not A Type!].type", "Not A Type! has no template or CSD in this kit, so buyers can't price it with the contract builder; the gateway accepts any type"),
      warning("capability[Not A Type!].type", slugWarning("Not A Type!")),
    ]);
  });

  it("CV18: httpPort must be an integer in the port range", () => {
    for (const port of [99999, 0, 3100.5, 3100]) {
      const config = makeValidConfig();
      config.kernel.httpPort = port;
      expect(validate({ config }).errors.filter(e => e.name === "kernel.httpPort")).toEqual(port === 3100 ? [] : [
        error("kernel.httpPort", `${port} is not a port (1-65535)`),
      ]);
    }
  });

  it("CV19: only an empty type fails, and gets exactly one type check", () => {
    const result = validate({ config: withType("") });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.name.includes(".type"))).toBe(true);
    expect(result.checks.filter(c => c.name === "capability[].type")).toEqual([error("capability[].type",
      "type is required (the gateway answers 400 when kernelId or type is missing)")]);
    const whitespace = validate({ config: withType("  ") });
    expect(whitespace.valid).toBe(true);
    expect(whitespace.errors.some(e => e.name === "capability[  ].type")).toBe(false);
    expect(whitespace.warnings.filter(w => w.name === "capability[  ].type")).toHaveLength(2);
  });

  it("CV20: profiles use the same open taxonomy and keep adapter references", () => {
    for (const type of ["2d-print", "zz-unknown", "", "FDM"]) {
      const config = makeValidConfig();
      config.profiles = [{ profileId: "p1", profileName: "P1", capabilityType: type as any, adapterId: "dev-machine-01" }];
      const result = validate({ config });
      expect(result.valid).toBe(type !== "");
      const name = "profile[p1].capabilityType";
      expect(result.checks.filter(c => c.name === name)).toEqual(type === "2d-print" ? [] : type === "" ? [
        error(name, "capabilityType is required"),
      ] : type === "FDM" ? [
        warning(name, "FDM has no template or CSD in this kit (did you mean fdm?)"), warning(name, slugWarning(type)),
      ] : [warning(name, "zz-unknown has no template or CSD in this kit")]);
    }
  });

  it("CV21: the wallet warning never prints the configured value", () => {
    const hex = "ab".repeat(32);
    for (const value of ["0x" + hex, hex]) {
      const config = makeValidConfig();
      config.kernel.walletPrivateKeyEnvVar = value;
      const result = validate({ config });
      expect(JSON.stringify(result)).not.toContain(hex);
      expect(result.warnings).toContainEqual(warning("kernel.walletPrivateKeyEnvVar", walletMessage));
      if (value === "0x" + hex) {
        expect(result.errors).toContainEqual(error("kernel.walletPrivateKeyEnvVar", walletError));
      } else {
        expect(result.valid).toBe(true);
      }
    }
  });

  it("KT1: known types equal the template and built-in CSD union in both directions", () => {
    const expected = new Set<string>(getRegisteredTypes());
    for (const csd of loadBuiltinCsds().list()) {
      const record = csd as Record<string, unknown>;
      const explicit = record.type;
      if (typeof explicit === "string" && explicit.trim()) expected.add(explicit.trim());
      else if (typeof record.url === "string") {
        const match = record.url.match(/^pcc:\/\/capabilities\/([^/]+)\//i);
        if (match?.[1]) expected.add(match[1]);
      }
    }
    const actual = getKnownCapabilityTypes();
    expect([...actual].filter(type => !expected.has(type))).toEqual([]);
    expect([...expected].filter(type => !actual.has(type))).toEqual([]);
    expect(actual.has("2d-print")).toBe(true);
    expect(actual.has("fdm")).toBe(true);
  });

  it("accepts an unknown type such as wood-fired-pizza with a warning", () => {
    const result = validate({ config: withType("wood-fired-pizza") });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.warnings.some(w => w.name === "capability[wood-fired-pizza].type" && w.message.startsWith("wood-fired-pizza has no template or CSD in this kit"))).toBe(true);
  });

  it("accepts a dotted slug such as pizza.order", () => {
    const result = validate({ config: withType("pizza.order") });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("recognizes the fdm type without a type warning", () => {
    const result = validate({ config: withType("fdm") });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.warnings.some(w => w.name === "capability[fdm].type")).toBe(false);
  });
});
