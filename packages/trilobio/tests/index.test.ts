import { describe, expect, it } from "vitest";
import {
  buildTrilobioConfig,
  validateTrilobioOptions,
  validateTcodeScript,
  TRILOBIO_CAPABILITY,
} from "../src/index.js";

describe("buildTrilobioConfig", () => {
  it("generates a config with all defaults populated", () => {
    const config = buildTrilobioConfig({
      url: "http://192.168.1.50",
      apiKey: "test-key",
    });

    expect(config.kernelId).toMatch(/^kernel_trilobio_\d+$/);
    expect(config.devices).toHaveLength(1);

    const device = config.devices[0];
    expect(device.id).toBe("trilobio-fleet-01");
    expect(device.type).toBe("machine");
    expect(device.adapterType).toBe("trilobio");
    expect(device.config.url).toBe("http://192.168.1.50");
    expect(device.config.apiKey).toBe("test-key");
    expect(device.config.tcodeApiVersion).toBe("latest");
    expect(device.config.mockMode).toBe(false);
    expect(device.config.pollIntervalMs).toBe(3000);
    expect(device.config.maxScriptTimeoutSec).toBe(3600);
    expect(device.config.mockRunDurationMs).toBe(2000);
    expect(device.config.allowArbitraryScripts).toBe(false);
  });

  it("respects user-provided overrides", () => {
    const config = buildTrilobioConfig({
      url: "http://192.168.1.50",
      apiKey: "test-key",
      kernelId: "kernel_custom_01",
      deviceId: "trilobot-bench-A",
      tcodeApiVersion: "1.25.1",
      mockMode: true,
      pollIntervalMs: 5000,
      maxScriptTimeoutSec: 7200,
      mockRunDurationMs: 500,
      allowArbitraryScripts: true,
    });

    expect(config.kernelId).toBe("kernel_custom_01");
    expect(config.devices[0].id).toBe("trilobot-bench-A");
    expect(config.devices[0].config.tcodeApiVersion).toBe("1.25.1");
    expect(config.devices[0].config.mockMode).toBe(true);
    expect(config.devices[0].config.pollIntervalMs).toBe(5000);
    expect(config.devices[0].config.maxScriptTimeoutSec).toBe(7200);
    expect(config.devices[0].config.mockRunDurationMs).toBe(500);
    expect(config.devices[0].config.allowArbitraryScripts).toBe(true);
  });

  it("propagates kernelId from generated id when not provided", () => {
    const config = buildTrilobioConfig({
      url: "http://192.168.1.50",
      apiKey: "test-key",
    });
    expect(config.devices[0].config.kernelId).toBe(config.kernelId);
  });

  it("propagates basic-auth credentials when provided", () => {
    const config = buildTrilobioConfig({
      url: "http://192.168.1.50",
      username: "alice",
      password: "secret",
    });
    expect(config.devices[0].config.username).toBe("alice");
    expect(config.devices[0].config.password).toBe("secret");
    expect(config.devices[0].config.apiKey).toBeUndefined();
  });
});

describe("validateTrilobioOptions", () => {
  it("accepts a valid apiKey config", () => {
    const result = validateTrilobioOptions({
      url: "http://192.168.1.50",
      apiKey: "test-key",
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("accepts a valid basic-auth config", () => {
    const result = validateTrilobioOptions({
      url: "http://192.168.1.50",
      username: "alice",
      password: "secret",
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("accepts mock mode without auth", () => {
    const result = validateTrilobioOptions({
      url: "http://192.0.2.1",
      mockMode: true,
    });
    expect(result.valid).toBe(true);
  });

  it("warns when both apiKey and basic-auth are provided", () => {
    const result = validateTrilobioOptions({
      url: "http://192.168.1.50",
      apiKey: "test-key",
      username: "alice",
      password: "secret",
    });
    expect(result.valid).toBe(true);
    expect(result.warnings).toBeDefined();
    expect(result.warnings?.[0]).toMatch(/apiKey AND username\/password/);
  });

  it("rejects missing url", () => {
    const result = validateTrilobioOptions({
      apiKey: "test-key",
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/url is required/);
  });

  it("rejects malformed url with trailing slash", () => {
    const result = validateTrilobioOptions({
      url: "http://192.168.1.50/",
      apiKey: "test-key",
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/no trailing slash/);
  });

  it("rejects malformed url with path", () => {
    const result = validateTrilobioOptions({
      url: "http://192.168.1.50/api/v1",
      apiKey: "test-key",
    });
    expect(result.valid).toBe(false);
  });

  it("rejects missing auth in non-mock mode", () => {
    const result = validateTrilobioOptions({
      url: "http://192.168.1.50",
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/apiKey is required.*username and password/);
  });

  it("rejects partial basic-auth (username without password)", () => {
    const result = validateTrilobioOptions({
      url: "http://192.168.1.50",
      username: "alice",
    });
    expect(result.valid).toBe(false);
  });

  it("rejects pollIntervalMs out of range", () => {
    const tooLow = validateTrilobioOptions({
      url: "http://192.168.1.50",
      apiKey: "k",
      pollIntervalMs: 100,
    });
    expect(tooLow.valid).toBe(false);

    const tooHigh = validateTrilobioOptions({
      url: "http://192.168.1.50",
      apiKey: "k",
      pollIntervalMs: 999999,
    });
    expect(tooHigh.valid).toBe(false);
  });

  it("rejects maxScriptTimeoutSec out of range", () => {
    const tooShort = validateTrilobioOptions({
      url: "http://192.168.1.50",
      apiKey: "k",
      maxScriptTimeoutSec: 5,
    });
    expect(tooShort.valid).toBe(false);

    const tooLong = validateTrilobioOptions({
      url: "http://192.168.1.50",
      apiKey: "k",
      maxScriptTimeoutSec: 999999,
    });
    expect(tooLong.valid).toBe(false);
  });

  it("rejects malformed tcodeApiVersion", () => {
    const result = validateTrilobioOptions({
      url: "http://192.168.1.50",
      apiKey: "k",
      tcodeApiVersion: "v1.25",
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/semver/);
  });

  it("accepts 'latest' as tcodeApiVersion", () => {
    const result = validateTrilobioOptions({
      url: "http://192.168.1.50",
      apiKey: "k",
      tcodeApiVersion: "latest",
    });
    expect(result.valid).toBe(true);
  });

  it("warns when allowArbitraryScripts is true", () => {
    const result = validateTrilobioOptions({
      url: "http://192.168.1.50",
      apiKey: "k",
      allowArbitraryScripts: true,
    });
    expect(result.valid).toBe(true);
    expect(result.warnings?.[0]).toMatch(/arbitrary operator-supplied Python/);
  });
});

describe("validateTcodeScript", () => {
  it("accepts a minimal valid script", () => {
    const script = `from tcode_api import ASPIRATE, DISPENSE
ASPIRATE(robot_id="r", volume={"value": 50, "unit": "ul"}, speed={"value": 100, "unit": "ul_per_sec"})
DISPENSE(robot_id="r", volume={"value": 50, "unit": "ul"}, speed={"value": 100, "unit": "ul_per_sec"})
`;
    const result = validateTcodeScript(script);
    expect(result.valid).toBe(true);
    expect(result.warnings).toBeUndefined();
  });

  it("accepts an `import tcode_api` style script", () => {
    const script = `import tcode_api
tcode_api.ASPIRATE(robot_id="r", volume={"value": 50, "unit": "ul"}, speed={"value": 100, "unit": "ul_per_sec"})
`;
    const result = validateTcodeScript(script);
    expect(result.valid).toBe(true);
  });

  it("rejects an empty script", () => {
    const result = validateTcodeScript("   \n  ");
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/empty/);
  });

  it("rejects a script that doesn't import tcode_api", () => {
    const script = `print("hello world")
`;
    const result = validateTcodeScript(script);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/does not import tcode_api/);
  });

  it("warns about subprocess usage", () => {
    const script = `from tcode_api import ASPIRATE
import subprocess
subprocess.run(["ls"])
ASPIRATE(robot_id="r", volume={"value": 50, "unit": "ul"}, speed={"value": 100, "unit": "ul_per_sec"})
`;
    const result = validateTcodeScript(script);
    expect(result.valid).toBe(true);
    expect(result.warnings?.some((w) => /subprocess/.test(w))).toBe(true);
  });

  it("warns about eval, exec, __import__", () => {
    const script = `from tcode_api import ASPIRATE
eval("1+1")
exec("pass")
__import__("os")
ASPIRATE(robot_id="r", volume={"value": 50, "unit": "ul"}, speed={"value": 100, "unit": "ul_per_sec"})
`;
    const result = validateTcodeScript(script);
    expect(result.valid).toBe(true);
    expect(result.warnings?.length ?? 0).toBeGreaterThanOrEqual(3);
  });

  it("warns about file-write open()", () => {
    const script = `from tcode_api import ASPIRATE
with open("/tmp/leak", "w") as f: f.write("nope")
ASPIRATE(robot_id="r", volume={"value": 50, "unit": "ul"}, speed={"value": 100, "unit": "ul_per_sec"})
`;
    const result = validateTcodeScript(script);
    expect(result.warnings?.some((w) => /open/.test(w))).toBe(true);
  });

  it("warns when no recognizable tcode call is found", () => {
    const script = `from tcode_api import some_helper
x = 1 + 1
`;
    const result = validateTcodeScript(script);
    expect(result.valid).toBe(true);
    expect(result.warnings?.some((w) => /no recognizable tcode command/.test(w))).toBe(true);
  });

  it("does not warn when a recognized tcode command is present", () => {
    const script = `from tcode_api import ADD_ROBOT, MOVE
ADD_ROBOT(id="r", descriptor={"kind": "x"})
MOVE(robot_id="r", target={"x": 1})
`;
    const result = validateTcodeScript(script);
    expect(result.valid).toBe(true);
    expect(result.warnings?.some((w) => /no recognizable/.test(w))).toBeFalsy();
  });
});

describe("TRILOBIO_CAPABILITY", () => {
  it("declares the expected shape", () => {
    expect(TRILOBIO_CAPABILITY.type).toBe("liquid-handler");
    expect(TRILOBIO_CAPABILITY.subType).toBe("trilobio-trilobot");
    expect(TRILOBIO_CAPABILITY.manufacturer).toBe("Trilobio");
    expect(TRILOBIO_CAPABILITY.assuranceTiers).toEqual([0, 1, 2]);
  });

  it("includes tcode-script-execution as a unique capability vs Hamilton", () => {
    expect(TRILOBIO_CAPABILITY.capabilities).toContain("tcode-script-execution");
    expect(TRILOBIO_CAPABILITY.capabilities).toContain("custom-labware-calibration");
  });

  it("covers core liquid-handling capabilities", () => {
    const expected = [
      "pipetting",
      "plate-reformat",
      "dilution",
      "normalization",
      "hit-picking",
      "serial-dilution",
    ];
    for (const cap of expected) {
      expect(TRILOBIO_CAPABILITY.capabilities).toContain(cap);
    }
  });

  it("covers expected materials", () => {
    expect(TRILOBIO_CAPABILITY.materials).toContain("dna");
    expect(TRILOBIO_CAPABILITY.materials).toContain("rna");
    expect(TRILOBIO_CAPABILITY.materials).toContain("protein");
    expect(TRILOBIO_CAPABILITY.materials).toContain("cells");
    expect(TRILOBIO_CAPABILITY.materials).toContain("small-molecule");
  });
});
