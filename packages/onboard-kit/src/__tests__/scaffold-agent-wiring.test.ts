import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { scaffold } from "../scaffolder.js";

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

describe("scaffold agent wiring", () => {
  it("A1 the example's agent imports, builds and wires its three adapters", () => {
    const text = content(example(), "src/agent.ts");
    once(text, `import { profiles } from "./profiles.js";
import { HaasVF2Adapter } from "./adapters/haas-vf2-adapter.js";
import { ShopPowerMeter } from "./adapters/shop-power-meter.js";
import { QCCamera } from "./adapters/qc-camera.js";


const KERNEL_ID = "kernel_acme_cnc_sf";`);
    once(text, `  capabilities,
  adapters: { machine: devHaasVf2, sensors: [devPowerMeter], camera: devQcCamera },
  machineProfiles: profiles,`);
    once(text, 'console.log(`  Wallet: ${kernelAgent.wallet?.address ?? "not configured"}`);\n'
      + 'console.log("  Machine: HaasVF2Adapter (dev-haas-vf2)");\n'
      + 'console.log("  Sensors: ShopPowerMeter (dev-power-meter)");\n'
      + 'console.log("  Camera: QCCamera (dev-qc-camera)");\n'
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
    once(text, "  adapters: { machine: devHaasVf2, sensors: [devPowerMeter, devPowerB], camera: devQcCamera },");
    expect(text).toContain('console.log("  Machine: HaasVF2Adapter (dev-haas-vf2)");');
    expect(text).toContain('console.log("  Sensors: ShopPowerMeter (dev-power-meter), PowerMeterB (dev-power-b)");');
    for (const statement of [
      "const devHaasVf2 = new HaasVF2Adapter(", "const devPowerMeter = new ShopPowerMeter(",
      "const devQcCamera = new QCCamera(", "const devMillB = new MillBAdapter(", "const devPowerB = new PowerMeterB(",
    ]) once(text, statement);
  });
  it("A3 with no sensor adapter the sensor slot is a PCC mock", () => {
    const text = content(noSensor(), "src/agent.ts");
    once(text, "  adapters: { machine: devHaasVf2, camera: devQcCamera },");
    expect(text).not.toContain("sensors:");
    expect(text).toContain('console.log("  Sensors: PCC mock (no sensor adapter in config)");');
    expect(text).toContain('console.log("  Machine: HaasVF2Adapter (dev-haas-vf2)");');
    expect(text).toContain('console.log("  Camera: QCCamera (dev-qc-camera)");');
    expect(text).not.toContain("mockPrintDuration");
  });
  it("A4 with no machine adapter the machine and camera slots are PCC mocks", () => {
    const text = content(sensorOnly(), "src/agent.ts");
    once(text, `  mockPrintDuration: 3000,  // Fast mock for testing
  adapters: { sensors: [devPowerMeter] },`);
    once(text, "  adapters: ");
    expect(text).toContain('console.log("  Machine: PCC mock (no machine adapter in config)");');
    expect(text).toContain('console.log("  Sensors: ShopPowerMeter (dev-power-meter)");');
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
      "  5b. The agent runs your generated adapters; MOCK_MODE=true keeps them off hardware. Nothing loads .env, so export its variables or put them on the command line. A slot with no adapter in the config runs a PCC mock, and the start-up banner says so.",
      "  6. Connect to live network: set GATEWAY_URL in .env",
    ]);
    expect(lines).not.toContain("  4. Test mock mode: npx tsx src/kernel.ts");
    expect(lines).not.toContain("  5. Test with agents: npx tsx src/agent.ts");
  });
  it("A9 with no adapters the agent keeps every PCC mock and says so", () => {
    const text = content(noAdapters(), "src/agent.ts");
    for (const absent of ["  adapters: ", "./adapters/", "Initialize adapters"]) expect(text).not.toContain(absent);
    expect(text).toContain("  mockPrintDuration: 3000,  // Fast mock for testing");
    once(text, 'console.log(`  Wallet: ${kernelAgent.wallet?.address ?? "not configured"}`);\n'
      + 'console.log("  Machine: PCC mock (no machine adapter in config)");\n'
      + 'console.log("  Sensors: PCC mock (no sensor adapter in config)");\n'
      + 'console.log("  Camera: PCC mock (no camera adapter in config)");\n'
      + 'console.log(`  Mock mode: ${process.env.MOCK_MODE === "true"}`);');
  });
});
