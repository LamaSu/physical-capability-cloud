import { describe, it, expect } from "vitest";
import {
  madsciWorkflowToPccJob,
  madsciNodeToPccDevice,
} from "../translator.js";
import type { MadsciWorkflow, MadsciNode } from "../types.js";

const WORKFLOW: MadsciWorkflow = {
  schema: "madsci/v1",
  name: "cell-painting",
  steps: [
    {
      name: "stain",
      action: {
        node: "liquid-handler",
        action: "dispense",
        args: { volume_ul: 50 },
      },
    },
  ],
};

describe("madsciWorkflowToPccJob", () => {
  it("emits a PCC job submission with embedded workflow", () => {
    const job = madsciWorkflowToPccJob(WORKFLOW, {
      kernelId: "kernel-prism-01",
      capabilityId: "cap-cell-painting",
    });
    expect(job.kernelId).toBe("kernel-prism-01");
    expect(job.assuranceTier).toBe(1);
    expect(job.params.schema).toBe("madsci-workflow/v1");
    expect(job.params.workflowName).toBe("cell-painting");
    expect(job.params.workflow).toBe(WORKFLOW);
  });

  it("honors a non-default assurance tier", () => {
    const job = madsciWorkflowToPccJob(WORKFLOW, {
      kernelId: "k",
      capabilityId: "c",
      assuranceTier: 3,
    });
    expect(job.assuranceTier).toBe(3);
  });
});

describe("madsciNodeToPccDevice", () => {
  it("translates a node into a PCC device registration", () => {
    const node: MadsciNode = {
      node_id: "ot2-01",
      module_type: "RestNode",
      url: "http://192.168.1.40:2000",
      actions: ["dispense", "aspirate", "move"],
    };
    const device = madsciNodeToPccDevice(node, "kernel-prism-01");
    expect(device.deviceId).toBe("madsci-ot2-01");
    expect(device.adapterType).toBe("generic-http");
    expect(device.adapterConfig.protocol).toBe("madsci-rest-node/v1");
    expect(device.capabilities).toEqual(["dispense", "aspirate", "move"]);
  });
});
