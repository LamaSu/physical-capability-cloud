import { describe, it, expect, beforeEach } from "vitest";
import { CsdSchema, type CSD } from "../csd/schema.js";
import { CsdRegistry, loadBuiltinCsds } from "../csd/registry.js";

// ── Import JSON files directly ──────────────────────────────────────
import fdmRaw from "../csds/fdm.csd.json" with { type: "json" };
import slaRaw from "../csds/sla.csd.json" with { type: "json" };
import cnc3axisRaw from "../csds/cnc-3axis.csd.json" with { type: "json" };
import laserCutRaw from "../csds/laser-cut.csd.json" with { type: "json" };
import print2dRaw from "../csds/2d-print.csd.json" with { type: "json" };
import makePizzaRaw from "../csds/make-pizza.csd.json" with { type: "json" };
import courierRouteRaw from "../csds/courier-route.csd.json" with { type: "json" };
import hotFoodPrepRaw from "../csds/hot-food-prep.csd.json" with { type: "json" };

// ── CSD JSON validation ─────────────────────────────────────────────

describe("CsdSchema — built-in CSD files", () => {
  it("validates fdm.csd.json", () => {
    const result = CsdSchema.safeParse(fdmRaw);
    if (!result.success) {
      console.error("fdm validation errors:", result.error.errors);
    }
    expect(result.success).toBe(true);
  });

  it("validates sla.csd.json", () => {
    const result = CsdSchema.safeParse(slaRaw);
    if (!result.success) {
      console.error("sla validation errors:", result.error.errors);
    }
    expect(result.success).toBe(true);
  });

  it("validates cnc-3axis.csd.json", () => {
    const result = CsdSchema.safeParse(cnc3axisRaw);
    if (!result.success) {
      console.error("cnc-3axis validation errors:", result.error.errors);
    }
    expect(result.success).toBe(true);
  });

  it("validates laser-cut.csd.json", () => {
    const result = CsdSchema.safeParse(laserCutRaw);
    if (!result.success) {
      console.error("laser-cut validation errors:", result.error.errors);
    }
    expect(result.success).toBe(true);
  });

  it("validates 2d-print.csd.json (the hello-world capability)", () => {
    const result = CsdSchema.safeParse(print2dRaw);
    if (!result.success) {
      console.error("2d-print validation errors:", result.error.errors);
    }
    expect(result.success).toBe(true);
  });

  it("validates make-pizza.csd.json (demo: vibecodenights)", () => {
    const result = CsdSchema.safeParse(makePizzaRaw);
    if (!result.success) {
      console.error("make-pizza validation errors:", result.error.errors);
    }
    expect(result.success).toBe(true);
  });

  it("validates courier-route.csd.json (demo: agentic delivery)", () => {
    const result = CsdSchema.safeParse(courierRouteRaw);
    if (!result.success) {
      console.error("courier-route validation errors:", result.error.errors);
    }
    expect(result.success).toBe(true);
  });

  it("validates hot-food-prep.csd.json (demo: hot food substrate)", () => {
    const result = CsdSchema.safeParse(hotFoodPrepRaw);
    if (!result.success) {
      console.error("hot-food-prep validation errors:", result.error.errors);
    }
    expect(result.success).toBe(true);
  });
});

// ── CSD spec example from design doc ────────────────────────────────

describe("CsdSchema — design spec example", () => {
  it("validates the 2D print example from CAPABILITY_PROFILES.md", () => {
    const example = {
      $schema: "https://pcc.network/schemas/csd/v1",
      url: "pcc://capabilities/2d-print/v1",
      version: "1.0.0",
      status: "active",
      name: "2D Print",
      description: "Standard 2D document and image printing via inkjet or laser",
      kind: "base",
      baseDefinition: null,
      discovery: {
        protocols: ["ipp", "usb", "mdns", "manual"],
        detect: {
          ipp: { attributes: ["printer-make-and-model", "media-supported", "print-color-mode-supported"] },
          mdns: { serviceType: "_ipp._tcp" },
        },
      },
      adapter: {
        type: "ipp",
        configSchema: {
          type: "object",
          properties: {
            uri: { type: "string", description: "IPP printer URI" },
            name: { type: "string", description: "Human-readable printer name" },
          },
          required: ["uri"],
        },
        commands: {
          print: { description: "Send a document to the printer", input: "file", output: "jobId" },
          status: { description: "Get printer status", output: "printerState" },
          cancel: { description: "Cancel a print job", input: "jobId" },
        },
      },
      parameters: [
        {
          key: "mediaSize",
          type: "enum",
          label: "Paper Size",
          required: true,
          group: "media",
          options: [
            { value: "na_letter_8.5x11in", label: "Letter (8.5×11\")" },
            { value: "iso_a4_210x297mm", label: "A4 (210×297mm)" },
          ],
          pricingImpact: null,
        },
        {
          key: "copies",
          type: "number",
          label: "Number of Copies",
          required: true,
          group: "job",
          min: 1,
          max: 9999,
          step: 1,
          defaultValue: 1,
          pricingImpact: { mode: "per_unit", value: 1.0 },
        },
        {
          key: "borderless",
          type: "boolean",
          label: "Borderless Printing",
          required: false,
          group: "layout",
          defaultValue: false,
          pricingImpact: { mode: "percent", value: 15 },
        },
      ],
      constraints: [
        {
          key: "2d-print-1",
          human: "Borderless printing only available on photo paper",
          severity: "error",
          when: [
            { param: "borderless", operator: "equals", value: true },
            { param: "mediaType", operator: "notIn", value: ["photographic-high-gloss", "photographic-matte"] },
          ],
          then: [{ action: "reject", message: "Borderless printing requires photo paper" }],
        },
      ],
      evidence: {
        tier0: { description: "Job completion receipt", required: ["jobId", "timestamp", "pageCount", "printerModel"] },
      },
      pricing: {
        basePrice: "0.10",
        currency: "USDC",
        unit: "per page",
        minimumCharge: "1.00",
      },
    };

    const result = CsdSchema.safeParse(example);
    if (!result.success) {
      console.error("design spec example errors:", result.error.errors);
    }
    expect(result.success).toBe(true);
  });
});

// ── CSD schema rejection tests ───────────────────────────────────────

describe("CsdSchema — invalid CSD rejection", () => {
  const validBase: CSD = {
    url: "pcc://capabilities/test/v1",
    version: "1.0.0",
    status: "active",
    name: "Test",
    description: "A test capability",
    kind: "base",
    baseDefinition: null,
    parameters: [
      {
        type: "enum",
        key: "material",
        label: "Material",
        required: true,
        options: [{ value: "pla", label: "PLA" }],
      },
    ],
    constraints: [],
    pricing: { basePrice: "10.00", currency: "USDC" },
  };

  it("rejects CSD missing url", () => {
    const invalid = { ...validBase, url: "" };
    const result = CsdSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it("rejects CSD with non-semver version", () => {
    const invalid = { ...validBase, version: "1.0" };
    const result = CsdSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it("rejects CSD with invalid status", () => {
    const invalid = { ...validBase, status: "pending" };
    const result = CsdSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it("rejects CSD with invalid constraint operator", () => {
    const invalid = {
      ...validBase,
      constraints: [
        {
          key: "c1",
          human: "Test constraint",
          severity: "error",
          when: [{ param: "material", operator: "INVALID_OPERATOR", value: "pla" }],
          then: [{ action: "reject", message: "bad" }],
        },
      ],
    };
    const result = CsdSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it("rejects CSD with invalid kind", () => {
    const invalid = { ...validBase, kind: "unknown_kind" };
    const result = CsdSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it("rejects CSD with empty parameters array when parameter type is invalid", () => {
    const invalid = {
      ...validBase,
      parameters: [
        {
          type: "color_picker",
          key: "bg",
          label: "Background",
          required: false,
        },
      ],
    };
    const result = CsdSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it("rejects CSD missing pricing", () => {
    const { pricing: _pricing, ...withoutPricing } = validBase;
    const result = CsdSchema.safeParse(withoutPricing);
    expect(result.success).toBe(false);
  });
});

// ── CsdRegistry — basic CRUD ─────────────────────────────────────────

describe("CsdRegistry — register / get / list / findByKind", () => {
  let registry: CsdRegistry;

  const testCsd: CSD = {
    url: "pcc://capabilities/test-cap/v1",
    version: "1.0.0",
    status: "active",
    name: "Test Capability",
    description: "Used in unit tests",
    kind: "base",
    baseDefinition: null,
    parameters: [
      {
        type: "enum",
        key: "mode",
        label: "Mode",
        required: true,
        options: [
          { value: "fast", label: "Fast" },
          { value: "slow", label: "Slow" },
        ],
      },
    ],
    constraints: [],
    pricing: { basePrice: "5.00", currency: "USDC" },
  };

  beforeEach(() => {
    registry = new CsdRegistry();
  });

  it("registers a valid CSD without throwing", () => {
    expect(() => registry.register(testCsd)).not.toThrow();
  });

  it("retrieves a CSD by URL after registering", () => {
    registry.register(testCsd);
    const found = registry.get("pcc://capabilities/test-cap/v1");
    expect(found).toBeDefined();
    expect(found?.name).toBe("Test Capability");
  });

  it("returns undefined for unknown URL", () => {
    expect(registry.get("pcc://capabilities/does-not-exist/v1")).toBeUndefined();
  });

  it("lists all registered CSDs", () => {
    registry.register(testCsd);
    const list = registry.list();
    expect(list).toHaveLength(1);
    expect(list[0].url).toBe("pcc://capabilities/test-cap/v1");
  });

  it("filters CSDs by kind", () => {
    registry.register(testCsd);
    const profileCsd: CSD = {
      ...testCsd,
      url: "pcc://capabilities/test-cap-profile/v1",
      kind: "profile",
      baseDefinition: "pcc://capabilities/test-cap/v1",
    };
    registry.register(profileCsd);

    const bases = registry.findByKind("base");
    const profiles = registry.findByKind("profile");
    const workflows = registry.findByKind("workflow");

    expect(bases).toHaveLength(1);
    expect(bases[0].url).toBe("pcc://capabilities/test-cap/v1");
    expect(profiles).toHaveLength(1);
    expect(profiles[0].url).toBe("pcc://capabilities/test-cap-profile/v1");
    expect(workflows).toHaveLength(0);
  });

  it("throws when registering an invalid CSD", () => {
    const invalid = { ...testCsd, version: "not-semver" };
    expect(() => registry.register(invalid as CSD)).toThrow();
  });

  it("reports the correct size", () => {
    expect(registry.size).toBe(0);
    registry.register(testCsd);
    expect(registry.size).toBe(1);
  });
});

// ── CsdRegistry.validate ─────────────────────────────────────────────

describe("CsdRegistry.validate", () => {
  let registry: CsdRegistry;

  beforeEach(() => {
    registry = new CsdRegistry();
  });

  it("returns valid: true for a correct CSD", () => {
    const csd: CSD = {
      url: "pcc://capabilities/val-test/v1",
      version: "1.0.0",
      status: "active",
      name: "Val Test",
      description: "validation test",
      kind: "base",
      baseDefinition: null,
      parameters: [],
      constraints: [],
      pricing: { basePrice: "1.00", currency: "USDC" },
    };
    const result = registry.validate(csd);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("returns valid: false with error messages for invalid CSD", () => {
    const invalid = { url: 123, version: "bad", name: "" };
    const result = registry.validate(invalid);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("reports missing url error", () => {
    const invalid = {
      version: "1.0.0",
      status: "active",
      name: "No URL",
      description: "test",
      kind: "base",
      baseDefinition: null,
      parameters: [],
      constraints: [],
      pricing: { basePrice: "1.00", currency: "USDC" },
    };
    const result = registry.validate(invalid);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("url"))).toBe(true);
  });
});

// ── CsdRegistry.resolve — inheritance ────────────────────────────────

describe("CsdRegistry.resolve — baseDefinition inheritance", () => {
  let registry: CsdRegistry;

  const baseCsd: CSD = {
    url: "pcc://capabilities/base-print/v1",
    version: "1.0.0",
    status: "active",
    name: "Base Print",
    description: "Base capability",
    kind: "base",
    baseDefinition: null,
    parameters: [
      {
        type: "enum",
        key: "paperSize",
        label: "Paper Size",
        required: true,
        options: [
          { value: "a4", label: "A4" },
          { value: "a3", label: "A3" },
          { value: "letter", label: "Letter" },
        ],
      },
      {
        type: "enum",
        key: "colorMode",
        label: "Color Mode",
        required: true,
        options: [
          { value: "color", label: "Color" },
          { value: "bw", label: "B&W" },
        ],
      },
    ],
    constraints: [
      {
        key: "base-c1",
        human: "A3 requires special handling",
        severity: "warning",
        when: [{ param: "paperSize", operator: "equals", value: "a3" }],
        then: [{ action: "warn", message: "A3 costs more" }],
      },
    ],
    pricing: { basePrice: "0.10", currency: "USDC", unit: "per page" },
  };

  const profileCsd: CSD = {
    url: "pcc://capabilities/inkjet-print/v1",
    version: "1.0.0",
    status: "active",
    name: "Inkjet Print",
    description: "Inkjet-specific profile",
    kind: "profile",
    baseDefinition: "pcc://capabilities/base-print/v1",
    parameters: [
      // Override existing param — remove A3 (not supported on inkjet)
      {
        type: "enum",
        key: "paperSize",
        label: "Paper Size",
        required: true,
        options: [
          { value: "a4", label: "A4" },
          { value: "letter", label: "Letter" },
        ],
      },
      // New param not in base
      {
        type: "boolean",
        key: "borderless",
        label: "Borderless",
        required: false,
        defaultValue: false,
      },
    ],
    constraints: [
      // Add new constraint not in base
      {
        key: "inkjet-c1",
        human: "Borderless only on photo paper",
        severity: "error",
        when: [{ param: "borderless", operator: "equals", value: true }],
        then: [{ action: "warn", message: "Use photo paper for borderless" }],
      },
    ],
    pricing: { basePrice: "0.08", currency: "USDC", unit: "per page" },
  };

  beforeEach(() => {
    registry = new CsdRegistry();
    registry.register(baseCsd);
    registry.register(profileCsd);
  });

  it("resolves a base CSD (no inheritance) as-is", () => {
    const resolved = registry.resolve("pcc://capabilities/base-print/v1");
    expect(resolved.url).toBe("pcc://capabilities/base-print/v1");
    expect(resolved.parameters).toHaveLength(2);
    expect(resolved.constraints).toHaveLength(1);
  });

  it("resolves a profile CSD applying baseDefinition", () => {
    const resolved = registry.resolve("pcc://capabilities/inkjet-print/v1");

    // Profile name/pricing wins
    expect(resolved.name).toBe("Inkjet Print");
    expect(resolved.pricing.basePrice).toBe("0.08");
  });

  it("merges parameters: profile overrides base params with same key", () => {
    const resolved = registry.resolve("pcc://capabilities/inkjet-print/v1");

    // paperSize was overridden — should have only 2 options (no A3)
    const paperSize = resolved.parameters.find((p) => p.key === "paperSize");
    expect(paperSize).toBeDefined();
    expect(paperSize?.type).toBe("enum");
    if (paperSize?.type === "enum") {
      expect(paperSize.options.map((o) => o.value)).not.toContain("a3");
      expect(paperSize.options.map((o) => o.value)).toContain("a4");
    }
  });

  it("merges parameters: base params not overridden are inherited", () => {
    const resolved = registry.resolve("pcc://capabilities/inkjet-print/v1");

    // colorMode is from base and should still be there
    const colorMode = resolved.parameters.find((p) => p.key === "colorMode");
    expect(colorMode).toBeDefined();
  });

  it("adds new parameters from profile not in base", () => {
    const resolved = registry.resolve("pcc://capabilities/inkjet-print/v1");

    // borderless is new in profile
    const borderless = resolved.parameters.find((p) => p.key === "borderless");
    expect(borderless).toBeDefined();
    expect(borderless?.type).toBe("boolean");
  });

  it("merges constraints: profile adds new constraints to base constraints", () => {
    const resolved = registry.resolve("pcc://capabilities/inkjet-print/v1");

    // Should have base-c1 + inkjet-c1
    expect(resolved.constraints).toHaveLength(2);
    const keys = resolved.constraints.map((c) => c.key);
    expect(keys).toContain("base-c1");
    expect(keys).toContain("inkjet-c1");
  });

  it("throws when resolving an unknown URL", () => {
    expect(() => registry.resolve("pcc://capabilities/nonexistent/v1")).toThrow(/not found/i);
  });

  it("throws when baseDefinition references an unregistered CSD", () => {
    const orphan: CSD = {
      url: "pcc://capabilities/orphan/v1",
      version: "1.0.0",
      status: "active",
      name: "Orphan",
      description: "inherits from nothing registered",
      kind: "profile",
      baseDefinition: "pcc://capabilities/does-not-exist/v1",
      parameters: [],
      constraints: [],
      pricing: { basePrice: "1.00", currency: "USDC" },
    };
    registry.register(orphan);
    expect(() => registry.resolve("pcc://capabilities/orphan/v1")).toThrow(/not found/i);
  });
});

// ── loadBuiltinCsds ───────────────────────────────────────────────────

describe("loadBuiltinCsds", () => {
  it("loads without errors", () => {
    expect(() => loadBuiltinCsds()).not.toThrow();
  });

  it("loads exactly 8 built-in CSDs", () => {
    const registry = loadBuiltinCsds();
    expect(registry.size).toBe(8);
  });

  it("all built-in CSDs are retrievable by URL", () => {
    const registry = loadBuiltinCsds();
    expect(registry.get("pcc://capabilities/fdm/v2")).toBeDefined();
    expect(registry.get("pcc://capabilities/sla/v2")).toBeDefined();
    expect(registry.get("pcc://capabilities/cnc-3axis/v2")).toBeDefined();
    expect(registry.get("pcc://capabilities/laser-cut/v2")).toBeDefined();
    expect(registry.get("pcc://capabilities/2d-print/v1")).toBeDefined();
    expect(registry.get("pcc://capabilities/make-pizza/v1")).toBeDefined();
    expect(registry.get("pcc://capabilities/courier-route/v1")).toBeDefined();
    expect(registry.get("pcc://capabilities/hot-food-prep/v1")).toBeDefined();
  });

  it("all built-in CSDs have kind = 'base'", () => {
    const registry = loadBuiltinCsds();
    const bases = registry.findByKind("base");
    expect(bases).toHaveLength(8);
  });

  it("all built-in CSDs resolve without inheritance errors", () => {
    const registry = loadBuiltinCsds();
    const urls = [
      "pcc://capabilities/fdm/v2",
      "pcc://capabilities/sla/v2",
      "pcc://capabilities/cnc-3axis/v2",
      "pcc://capabilities/laser-cut/v2",
      "pcc://capabilities/2d-print/v1",
      "pcc://capabilities/make-pizza/v1",
      "pcc://capabilities/courier-route/v1",
      "pcc://capabilities/hot-food-prep/v1",
    ];
    for (const url of urls) {
      expect(() => registry.resolve(url)).not.toThrow();
    }
  });

  it("fdm CSD has correct pricing", () => {
    const registry = loadBuiltinCsds();
    const fdm = registry.get("pcc://capabilities/fdm/v2");
    expect(fdm?.pricing.basePrice).toBe("15.00");
    expect(fdm?.pricing.currency).toBe("USDC");
  });

  it("2d-print CSD has minimumCharge", () => {
    const registry = loadBuiltinCsds();
    const print = registry.get("pcc://capabilities/2d-print/v1");
    expect(print?.pricing.minimumCharge).toBe("1.00");
  });

  it("fdm CSD has expected parameters", () => {
    const registry = loadBuiltinCsds();
    const fdm = registry.get("pcc://capabilities/fdm/v2");
    const paramKeys = fdm?.parameters.map((p) => p.key) ?? [];
    expect(paramKeys).toContain("material");
    expect(paramKeys).toContain("infill");
    expect(paramKeys).toContain("layerHeight");
    expect(paramKeys).toContain("quantity");
  });

  it("cnc-3axis CSD has constraints", () => {
    const registry = loadBuiltinCsds();
    const cnc = registry.get("pcc://capabilities/cnc-3axis/v2");
    expect((cnc?.constraints.length ?? 0)).toBeGreaterThan(0);
  });

  it("laser-cut CSD has evidence tiers", () => {
    const registry = loadBuiltinCsds();
    const laser = registry.get("pcc://capabilities/laser-cut/v2");
    expect(laser?.evidence).toBeDefined();
    expect(laser?.evidence?.["tier0"]).toBeDefined();
  });
});

// ── Demo-relevant CSDs (vibecodenights pizza demo) ─────────────────

describe("loadBuiltinCsds — demo CSDs (make-pizza, courier-route, hot-food-prep)", () => {
  it("make-pizza CSD has expected pizza-shop parameters", () => {
    const registry = loadBuiltinCsds();
    const pizza = registry.get("pcc://capabilities/make-pizza/v1");
    expect(pizza).toBeDefined();
    const paramKeys = pizza?.parameters.map((p) => p.key) ?? [];
    expect(paramKeys).toContain("size");
    expect(paramKeys).toContain("crust");
    expect(paramKeys).toContain("toppings");
    expect(paramKeys).toContain("dietary");
    expect(paramKeys).toContain("notes");
    expect(paramKeys).toContain("quantity");
  });

  it("make-pizza CSD has realistic pricing (base ~$12)", () => {
    const registry = loadBuiltinCsds();
    const pizza = registry.get("pcc://capabilities/make-pizza/v1");
    expect(pizza?.pricing.basePrice).toBe("12.00");
    expect(pizza?.pricing.currency).toBe("USDC");
    expect(pizza?.pricing.unit).toBe("per pizza");
  });

  it("make-pizza CSD has per-topping pricing on the toppings parameter", () => {
    const registry = loadBuiltinCsds();
    const pizza = registry.get("pcc://capabilities/make-pizza/v1");
    const toppings = pizza?.parameters.find((p) => p.key === "toppings");
    expect(toppings).toBeDefined();
    expect(toppings?.pricingImpact).toBeDefined();
    expect(toppings?.pricingImpact?.mode).toBe("per_unit");
  });

  it("make-pizza CSD has at least one constraint", () => {
    const registry = loadBuiltinCsds();
    const pizza = registry.get("pcc://capabilities/make-pizza/v1");
    expect((pizza?.constraints.length ?? 0)).toBeGreaterThan(0);
  });

  it("courier-route CSD has expected delivery parameters", () => {
    const registry = loadBuiltinCsds();
    const courier = registry.get("pcc://capabilities/courier-route/v1");
    expect(courier).toBeDefined();
    const paramKeys = courier?.parameters.map((p) => p.key) ?? [];
    expect(paramKeys).toContain("vehicle");
    expect(paramKeys).toContain("pickupLat");
    expect(paramKeys).toContain("pickupLng");
    expect(paramKeys).toContain("dropoffLat");
    expect(paramKeys).toContain("dropoffLng");
    expect(paramKeys).toContain("distanceKm");
    expect(paramKeys).toContain("deadlineMinutes");
  });

  it("courier-route CSD has per-km pricing on distance + plausible base ($5)", () => {
    const registry = loadBuiltinCsds();
    const courier = registry.get("pcc://capabilities/courier-route/v1");
    expect(courier?.pricing.basePrice).toBe("5.00");
    expect(courier?.pricing.unit).toBe("per delivery");
    const distance = courier?.parameters.find((p) => p.key === "distanceKm");
    expect(distance?.pricingImpact?.mode).toBe("per_unit");
  });

  it("courier-route CSD has vehicle options covering bike/car/van/foot", () => {
    const registry = loadBuiltinCsds();
    const courier = registry.get("pcc://capabilities/courier-route/v1");
    const vehicle = courier?.parameters.find((p) => p.key === "vehicle");
    expect(vehicle?.type).toBe("enum");
    if (vehicle?.type === "enum") {
      const values = vehicle.options.map((o) => o.value);
      expect(values).toContain("bike");
      expect(values).toContain("car");
      expect(values).toContain("van");
      expect(values).toContain("foot");
    }
  });

  it("hot-food-prep CSD has expected generic hot-food parameters", () => {
    const registry = loadBuiltinCsds();
    const hotFood = registry.get("pcc://capabilities/hot-food-prep/v1");
    expect(hotFood).toBeDefined();
    const paramKeys = hotFood?.parameters.map((p) => p.key) ?? [];
    expect(paramKeys).toContain("temperature");
    expect(paramKeys).toContain("prepTimeMinutes");
    expect(paramKeys).toContain("kitchenType");
  });

  it("hot-food-prep CSD has kitchen-type options covering commercial/home/food-truck", () => {
    const registry = loadBuiltinCsds();
    const hotFood = registry.get("pcc://capabilities/hot-food-prep/v1");
    const kitchen = hotFood?.parameters.find((p) => p.key === "kitchenType");
    expect(kitchen?.type).toBe("enum");
    if (kitchen?.type === "enum") {
      const values = kitchen.options.map((o) => o.value);
      expect(values).toContain("commercial");
      expect(values).toContain("home");
      expect(values).toContain("food-truck");
    }
  });

  it("hot-food-prep CSD has temperature enum (warm/hot/very-hot)", () => {
    const registry = loadBuiltinCsds();
    const hotFood = registry.get("pcc://capabilities/hot-food-prep/v1");
    const temp = hotFood?.parameters.find((p) => p.key === "temperature");
    expect(temp?.type).toBe("enum");
    if (temp?.type === "enum") {
      const values = temp.options.map((o) => o.value);
      expect(values).toContain("warm");
      expect(values).toContain("hot");
      expect(values).toContain("very-hot");
    }
  });

  it("all 3 demo CSDs surface via registry.list()", () => {
    const registry = loadBuiltinCsds();
    const urls = registry.list().map((c) => c.url);
    expect(urls).toContain("pcc://capabilities/make-pizza/v1");
    expect(urls).toContain("pcc://capabilities/courier-route/v1");
    expect(urls).toContain("pcc://capabilities/hot-food-prep/v1");
  });
});
