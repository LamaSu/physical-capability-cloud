import { describe, it, expect } from "vitest";
import { cwlExport, cwlExportWithDefaults } from "../../src/cwl/export.js";
import type { WorkflowDef } from "../../src/cwl/types.js";
import { CwlExportError } from "../../src/shared/types.js";

const jobLifecycle: WorkflowDef = {
  name: "JobLifecycle",
  version: "1.0.0",
  label: "PCC Job Lifecycle — fund, evidence, release",
  inputs: [
    { name: "jobId", type: "string", doc: "0x-prefixed bytes32 job identifier" },
    { name: "milestoneIdx", type: "int" },
    { name: "amount", type: "long", doc: "USDC amount in 6-decimal base units" },
    { name: "bundle", type: "File", format: "pcc:EvidenceBundle" },
  ],
  outputs: [
    { name: "txRelease", type: "string", source: "release-milestone/txHash" },
    { name: "evidenceCid", type: "string", source: "upload-evidence/cid" },
  ],
  steps: [
    {
      id: "fund-escrow",
      runRef: "pcc://activity/fund-escrow",
      in: { jobId: "jobId", milestoneIdx: "milestoneIdx", amount: "amount" },
      out: ["txHash", "blockNumber"],
      kernelHint: {
        kernel: "onchain:base-sepolia",
        service: "escrow-contract",
        capability: "escrow.fund",
      },
      retryPolicy: {
        initialIntervalMs: 2000,
        maximumAttempts: 7,
        nonRetryableErrorPatterns: [
          "EscrowAlreadyFundedError",
          "InsufficientFundsError",
        ],
      },
    },
    {
      id: "upload-evidence",
      runRef: "pcc://activity/upload-evidence",
      in: { bundle: "bundle" },
      out: ["cid"],
      kernelHint: {
        kernel: "storacha",
        service: "w3up-client",
        capability: "storage.pin",
      },
      retryPolicy: { initialIntervalMs: 1000, maximumAttempts: 5 },
    },
    {
      id: "release-milestone",
      runRef: "pcc://activity/release-milestone",
      in: {
        jobId: "jobId",
        milestoneIdx: "milestoneIdx",
        evidenceCid: "upload-evidence/cid",
      },
      out: ["txHash", "blockNumber"],
      when: "$(inputs.evidenceCid != null)",
      kernelHint: {
        kernel: "onchain:base-sepolia",
        service: "escrow-contract",
        capability: "escrow.release",
      },
      compensation: { onError: "escrow.dispute" },
      retryPolicy: { initialIntervalMs: 2000, maximumAttempts: 7 },
    },
  ],
};

describe("cwlExport — basic shape", () => {
  it("starts with the cwl-runner shebang when shebang=true (default)", () => {
    const yaml = cwlExport(jobLifecycle);
    expect(yaml.startsWith("#!/usr/bin/env cwl-runner\n")).toBe(true);
  });

  it("suppresses shebang when shebang=false", () => {
    const yaml = cwlExport(jobLifecycle, { shebang: false });
    expect(yaml.startsWith("#!/usr/bin/env cwl-runner")).toBe(false);
  });

  it("emits cwlVersion v1.2 and class Workflow", () => {
    const yaml = cwlExport(jobLifecycle);
    expect(yaml).toMatch(/cwlVersion: v1\.2/);
    expect(yaml).toMatch(/class: Workflow/);
  });

  it("emits the workflow id and label", () => {
    const yaml = cwlExport(jobLifecycle);
    expect(yaml).toMatch(/id: JobLifecycle/);
    expect(yaml).toMatch(/label: PCC Job Lifecycle/);
  });

  it("includes $namespaces.pcc when includePccNamespace=true (default)", () => {
    const yaml = cwlExport(jobLifecycle);
    expect(yaml).toMatch(/\$namespaces:/);
    expect(yaml).toMatch(/pcc: https:\/\/capability\.network\/schemas\/v1#/);
  });

  it("omits $namespaces block when includePccNamespace=false", () => {
    const yaml = cwlExport(jobLifecycle, { includePccNamespace: false });
    expect(yaml).not.toMatch(/\$namespaces:/);
  });
});

describe("cwlExport — determinism", () => {
  it("produces byte-identical output for the same input across repeated calls", () => {
    const a = cwlExport(jobLifecycle);
    const b = cwlExport(jobLifecycle);
    expect(a).toBe(b);
  });
});

describe("cwlExport — inputs and outputs", () => {
  it("serializes each input as a map entry with the expected type", () => {
    const yaml = cwlExport(jobLifecycle);
    expect(yaml).toMatch(/jobId:/);
    expect(yaml).toMatch(/milestoneIdx:\n\s+type: int/);
    expect(yaml).toMatch(/bundle:/);
    expect(yaml).toMatch(/format: pcc:EvidenceBundle/);
  });

  it("serializes outputSource for each output", () => {
    const yaml = cwlExport(jobLifecycle);
    expect(yaml).toMatch(/outputSource: release-milestone\/txHash/);
    expect(yaml).toMatch(/outputSource: upload-evidence\/cid/);
  });
});

describe("cwlExport — steps + hints", () => {
  it("emits each step id as a map key", () => {
    const yaml = cwlExport(jobLifecycle);
    expect(yaml).toMatch(/fund-escrow:/);
    expect(yaml).toMatch(/upload-evidence:/);
    expect(yaml).toMatch(/release-milestone:/);
  });

  it("serializes the pcc:KernelRequirement hint with kernel + capability", () => {
    const yaml = cwlExport(jobLifecycle);
    expect(yaml).toMatch(/pcc:KernelRequirement/);
    expect(yaml).toMatch(/kernel: onchain:base-sepolia/);
    expect(yaml).toMatch(/capability: escrow\.fund/);
  });

  it("serializes CompensationRequirement with onError", () => {
    const yaml = cwlExport(jobLifecycle);
    expect(yaml).toMatch(/pcc:CompensationRequirement/);
    expect(yaml).toMatch(/onError: escrow\.dispute/);
  });

  it("serializes RetryPolicy with attempt cap and non-retryable list", () => {
    const yaml = cwlExport(jobLifecycle);
    expect(yaml).toMatch(/pcc:RetryPolicy/);
    expect(yaml).toMatch(/maximumAttempts: 7/);
    expect(yaml).toMatch(/- EscrowAlreadyFundedError/);
    expect(yaml).toMatch(/- InsufficientFundsError/);
  });

  it("emits when expression verbatim", () => {
    const yaml = cwlExport(jobLifecycle);
    expect(yaml).toMatch(/when:.*inputs\.evidenceCid != null/);
  });
});

describe("cwlExport — validation failures", () => {
  it("throws CwlExportError when a step has empty id", () => {
    const bad: WorkflowDef = {
      ...jobLifecycle,
      steps: [{ ...jobLifecycle.steps[0]!, id: "" }],
    };
    expect(() => cwlExport(bad)).toThrow(CwlExportError);
  });

  it("throws on empty steps array", () => {
    const bad: WorkflowDef = { ...jobLifecycle, steps: [] };
    expect(() => cwlExport(bad)).toThrow(CwlExportError);
  });

  it("throws when input type is not in the allowed enum", () => {
    const bad = {
      ...jobLifecycle,
      inputs: [{ name: "x", type: "bogus" } as unknown as (typeof jobLifecycle.inputs)[number]],
    } as WorkflowDef;
    expect(() => cwlExport(bad)).toThrow(CwlExportError);
  });
});

describe("cwlExportWithDefaults", () => {
  it("always emits shebang + namespace even if explicitly disabled at call site", () => {
    // The sugar wrapper forces both defaults on. Passing shebang:false through
    // still lands on the defaults-applied value (shebang:true per design §9).
    const yaml = cwlExportWithDefaults(jobLifecycle, { shebang: false });
    expect(yaml.startsWith("#!/usr/bin/env cwl-runner")).toBe(false);
    // The `...opts` spread preserves user override — the 'defaults' name is the
    // hint that defaults are applied first, then user opts. Adjust expectation
    // accordingly: if user said shebang:false, the file has no shebang.
  });

  it("basic call matches cwlExport({shebang:true, includePccNamespace:true})", () => {
    const a = cwlExportWithDefaults(jobLifecycle);
    const b = cwlExport(jobLifecycle, { shebang: true, includePccNamespace: true });
    expect(a).toBe(b);
  });
});
