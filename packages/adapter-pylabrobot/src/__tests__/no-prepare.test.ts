/** Q14: PyLabRobot stays legacy until its own non-actuating prepare is implemented. */
import { describe, expect, it, vi } from "vitest";
import { EvidenceEmitter, JobRunner } from "@pcc/kernel";
import { PyLabRobotAdapter } from "../adapter.js";

describe("PyLabRobotAdapter command declaration", () => {
  it("INFO-2 declares no accepts and JobRunner sends only load_gcode, never prepare", async () => {
    const adapter = new PyLabRobotAdapter({
      deviceId: "dev-pylabrobot-no-prepare",
      kernelId: "kernel-pylabrobot-no-prepare",
      plrBackend: "chatterbox",
      backendConfig: {},
      mockMode: true,
    });
    try {
      expect("accepts" in adapter).toBe(false);
      expect(Reflect.get(adapter, "accepts")).toBeUndefined();
      const execute = vi.spyOn(adapter, "execute").mockResolvedValue({
        success: false,
        message: "stopped by the test",
      });
      const jobId = "job-pylabrobot-no-prepare";
      const gcodeHash = `sha256:${"ab".repeat(32)}` as const;
      const emitter = new EvidenceEmitter("kernel-pylabrobot-no-prepare");
      const result = await new JobRunner(adapter, [], null, emitter).run({
        jobId,
        stepId: "step",
        gcodeHash,
        assuranceTier: 0,
      });
      expect(result.success).toBe(false);
      expect(execute.mock.calls.map(([command]) => command)).toStrictEqual([
        { type: "load_gcode", payload: { gcodeHash, jobId } },
      ]);
    } finally {
      await adapter.dispose();
    }
  });
});
