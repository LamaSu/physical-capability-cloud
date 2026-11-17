import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { scaffold } from "../scaffolder.js";
import { validate } from "../validate.js";

type OnboardConfig = Parameters<typeof scaffold>[0]["config"];
const packageDir = fileURLToPath(new URL("../..", import.meta.url));
const example = (): OnboardConfig => JSON.parse(readFileSync(join(packageDir, "src/examples/cnc-shop-config.json"), "utf8"));
const twoEach = (): OnboardConfig => {
  const c = example();
  c.adapters.push({ ...c.adapters[0], adapterId: "dev-mill-b", className: "MillBAdapter" }, { ...c.adapters[1], adapterId: "dev-power-b", className: "PowerMeterB" });
  c.capabilities.push({ ...c.capabilities[0], adapterId: "dev-mill-b", name: "Second mill" });
  return c;
};
const noSensor = (): OnboardConfig => { const c = example(); c.adapters = c.adapters.filter(a => a.adapterType !== "sensor"); return c; };
const sensorOnly = (): OnboardConfig => { const c = example(); c.adapters = c.adapters.filter(a => a.adapterType === "sensor"); c.capabilities = []; return c; };
const noAdapters = (): OnboardConfig => { const c = example(); c.adapters = []; c.capabilities = []; return c; };
function content(config: OnboardConfig, path: string): string {
  const file = scaffold({ config }).files.find(f => f.path === path);
  expect(file, path).toBeDefined();
  return file!.content;
}
function once(text: string, block: string): void {
  expect(text.split(block)).toHaveLength(2);
}
function refusal(config: OnboardConfig, name: string, message: string): void {
  expect(validate({ config }).errors).toContainEqual({ name, message, passed: false, severity: "error" });
  let error: unknown;
  try { scaffold({ config }); } catch (e) { error = e; }
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain(`${name}: ${message}`);
}

describe("scaffold agent wiring", () => {
  it("A1 the example's agent imports, builds and wires its three adapters", () => {
    const text = content(example(), "src/agent.ts");
    once(text, `import { profiles } from "./profiles.js";
import { HaasVF2Adapter } from "./adapters/haas-vf2-adapter.js";
import { ShopPowerMeter } from "./adapters/shop-power-meter.js";
import { QCCamera } from "./adapters/qc-camera.js";


const KERNEL_ID = "kernel_acme_cnc_sf";`);
    once(text, `  capabilities,
  // MOCK_MODE=true passes no generated adapter, so every slot runs a PCC mock.
  ...(process.env.MOCK_MODE === "true" ? {} : { adapters: { machine: devHaasVf2, sensors: [devPowerMeter], camera: devQcCamera } }),
  machineProfiles: profiles,`);
    once(text, 'console.log(`  Wallet: ${kernelAgent.wallet?.address ?? "not configured"}`);\n'
      + 'console.log(process.env.MOCK_MODE === "true"\n'
      + '  ? "  Machine: PCC mock (MOCK_MODE=true)"\n'
      + '  : "  Machine: HaasVF2Adapter (dev-haas-vf2); its jobs are refused until KernelAgent passes inputHash, inputData and tierLadder");\n'
      + 'console.log(process.env.MOCK_MODE === "true"\n'
      + '  ? "  Sensors: PCC mock (MOCK_MODE=true)"\n'
      + '  : "  Sensors: ShopPowerMeter (dev-power-meter)");\n'
      + 'console.log(process.env.MOCK_MODE === "true"\n'
      + '  ? "  Camera: PCC mock (MOCK_MODE=true)"\n'
      + '  : "  Camera: QCCamera (dev-qc-camera)");\n'
      + 'console.log(`  Mock mode: ${process.env.MOCK_MODE === "true"}`);');
    expect(text).not.toContain("mockPrintDuration");
  });
  it("A1b a second machine and sensor follow kernel.ts's selection", () => {
    const config = twoEach();
    expect(content(config, "src/kernel.ts")).toContain(`const jobRunner = new JobRunner(
  devHaasVf2,
  [devPowerMeter, devPowerB],
  devQcCamera,`);
    const text = content(config, "src/agent.ts");
    once(text, '  ...(process.env.MOCK_MODE === "true" ? {} : { adapters: { machine: devHaasVf2, sensors: [devPowerMeter, devPowerB], camera: devQcCamera } }),');
    expect(text).toContain('  : "  Machine: HaasVF2Adapter (dev-haas-vf2); its jobs are refused until KernelAgent passes inputHash, inputData and tierLadder");');
    expect(text).toContain('  : "  Sensors: ShopPowerMeter (dev-power-meter), PowerMeterB (dev-power-b)");');
    for (const statement of [
      "const devHaasVf2 = new HaasVF2Adapter(", "const devPowerMeter = new ShopPowerMeter(",
      "const devQcCamera = new QCCamera(", "const devMillB = new MillBAdapter(", "const devPowerB = new PowerMeterB(",
    ]) once(text, statement);
  });
  it("A3 with no sensor adapter the sensor slot is a PCC mock", () => {
    const text = content(noSensor(), "src/agent.ts");
    once(text, '  ...(process.env.MOCK_MODE === "true" ? {} : { adapters: { machine: devHaasVf2, camera: devQcCamera } }),');
    expect(text).not.toContain("sensors:");
    expect(text).toContain('console.log("  Sensors: PCC mock (no sensor adapter in config)");');
    expect(text).toContain('  : "  Machine: HaasVF2Adapter (dev-haas-vf2); its jobs are refused until KernelAgent passes inputHash, inputData and tierLadder");');
    expect(text).toContain('  : "  Camera: QCCamera (dev-qc-camera)");');
    expect(text).not.toContain("mockPrintDuration");
  });
  it("A4 with no machine adapter the machine and camera slots are PCC mocks", () => {
    const text = content(sensorOnly(), "src/agent.ts");
    once(text, `  mockPrintDuration: 3000,  // Fast mock for testing
  // MOCK_MODE=true passes no generated adapter, so every slot runs a PCC mock.
  ...(process.env.MOCK_MODE === "true" ? {} : { adapters: { sensors: [devPowerMeter] } }),`);
    once(text, "{ adapters: ");
    expect(text).toContain('console.log("  Machine: PCC mock (no machine adapter in config)");');
    expect(text).toContain('  : "  Sensors: ShopPowerMeter (dev-power-meter)");');
    expect(text).toContain('console.log("  Camera: PCC mock (no camera adapter in config)");');
  });
  it("A7 the next steps put MOCK_MODE on the command line", () => {
    const lines = scaffold({ config: example() }).summary.split("\n");
    const step4 = "  4. Test mock mode: MOCK_MODE=true npx tsx src/kernel.ts";
    const start = lines.indexOf(step4);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(lines.slice(start, start + 4)).toEqual([
      step4,
      "  5. Test with agents: MOCK_MODE=true npx tsx src/agent.ts",
      "  5b. Without MOCK_MODE=true the agent runs your generated adapters; with it, every slot runs a PCC mock. A machine whose capability class isn't fdm takes the prepare path, and its jobs are refused until KernelAgent passes inputHash, inputData and tierLadder. Nothing loads .env, so export its variables or put them on the command line. A slot with no adapter in the config runs a PCC mock, and the start-up banner says so.",
      "  6. Connect to live network: export GATEWAY_URL",
    ]);
    expect(lines).not.toContain("  4. Test mock mode: npx tsx src/kernel.ts");
    expect(lines).not.toContain("  5. Test with agents: npx tsx src/agent.ts");
  });
  it("A9 with no adapters the agent keeps every PCC mock and says so", () => {
    const text = content(noAdapters(), "src/agent.ts");
    for (const absent of ["  adapters: ", "./adapters/", "Initialize adapters", 'MOCK_MODE === "true" ?']) expect(text).not.toContain(absent);
    expect(text).toContain("  mockPrintDuration: 3000,  // Fast mock for testing");
    once(text, 'console.log(`  Wallet: ${kernelAgent.wallet?.address ?? "not configured"}`);\n'
      + 'console.log("  Machine: PCC mock (no machine adapter in config)");\n'
      + 'console.log("  Sensors: PCC mock (no sensor adapter in config)");\n'
      + 'console.log("  Camera: PCC mock (no camera adapter in config)");\n'
      + 'console.log(`  Mock mode: ${process.env.MOCK_MODE === "true"}`);');
  });
  it("E5 adapter ids make no _URL name that a dependency of the generated agent reads", () => {
    for (const id of ["anthropic-base", "anthropic_base", "editor", "lit-api", "lit_api", "nats", "NATS", "unbrowse"]) {
      const config = sensorOnly();
      config.adapters[0].adapterId = id;
      const name = id.replace(/-/g, "_").toUpperCase();
      refusal(config, `adapter[${id}].adapterId`, `${JSON.stringify(id)} makes the environment variable ${name}_URL, which a package the generated agent depends on already reads; choose another adapter id`);
    }
    const allowed = sensorOnly();
    allowed.adapters[0].adapterId = "nats1";
    expect(validate({ config: allowed }).errors.some(e => e.name === "adapter[nats1].adapterId")).toBe(false);
    expect(scaffold({ config: allowed }).files.length).toBeGreaterThan(0);
    const apiKey = sensorOnly();
    apiKey.adapters[0].adapterId = "lit";
    refusal(apiKey, "adapter[lit].adapterId", '"lit" makes the environment variable LIT_API_KEY, which other software already reads as its API key; choose another adapter id');
  });
});
