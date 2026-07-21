import { describe, it, expect } from "vitest";
import { verifyBundleSignature } from "@pcc/kernel-sdk";

import {
  GalaxySynBioCadKernel,
  MockGalaxyClient,
  createGalaxyExecute,
  buildGalaxySynBioCadManifest,
  type GalaxyAdapterOptions,
} from "../index.js";

const baseOpts: GalaxyAdapterOptions = {
  endpointURL: "https://kernel.example.com/run",
  builderAgentId: "eip155:84532:0xAgent",
  mockMode: true,
};

function fromHex(hex: string): Uint8Array {
  const b = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) b[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  return b;
}

describe("buildGalaxySynBioCadManifest", () => {
  it("produces a structurally valid DigitalKernelManifest", () => {
    const m = buildGalaxySynBioCadManifest(baseOpts);
    expect(m.manifestVersion).toBe("1.0.0");
    expect(m.kernelId).toBe("galaxy-synbiocad");
    expect(m.capabilityType).toBe("synbio-metabolic-design");
    expect(m.endpointURL).toMatch(/^https:\/\//);
    expect(m.maxAssuranceTier).toBe(1);
    expect(m.workflowSteps.length).toBeGreaterThan(3);
    expect(m.workflowSteps[0].dependsOn).toEqual([]);
    // stage DAG is chained
    expect(m.workflowSteps[1].dependsOn).toEqual([m.workflowSteps[0].stepId]);
  });

  it("rejects a non-HTTPS endpoint (manifest guardrail)", () => {
    expect(() => buildGalaxySynBioCadManifest({ ...baseOpts, endpointURL: "http://insecure" })).toThrow(
      /HTTPS/,
    );
  });
});

describe("GalaxySynBioCadKernel (mock transport)", () => {
  it("advertises a stable tool menu", () => {
    const kernel = new GalaxySynBioCadKernel(baseOpts);
    const caps = kernel.capabilities();
    expect(caps.length).toBeGreaterThan(40);
    expect(caps.every((t) => t.status === "stable")).toBe(true);
  });

  it("executes a tool and returns declared outputs", async () => {
    const kernel = new GalaxySynBioCadKernel(baseOpts);
    const out = await kernel.execute({
      tool_id: "retropath2",
      params: { rulesfile: "hda-1", source_inchi: "InChI=1S/CH4/h1H4" },
    });
    expect(out.provider).toBe("galaxy-synbiocad");
    expect(out.state).toBe("ok");
    expect((out.outputs as Record<string, unknown>).Reaction_Network).toBeTruthy();
  });

  it("rejects invalid params before hitting the transport", async () => {
    const kernel = new GalaxySynBioCadKernel(baseOpts);
    await expect(kernel.execute({ tool_id: "retropath2", params: {} })).rejects.toThrow(
      /validation failed/,
    );
  });

  it("surfaces a transport error as a thrown error", async () => {
    const execute = createGalaxyExecute(new MockGalaxyClient({ failToolIds: ["retropath2"] }));
    await expect(
      execute({ tool_id: "retropath2", params: { rulesfile: "hda-1", source_inchi: "x" } }),
    ).rejects.toThrow(/errored/);
  });

  it("throws a helpful error when no transport is configured", () => {
    const prevUrl = process.env.GALAXY_URL;
    delete process.env.GALAXY_URL;
    try {
      expect(
        () =>
          new GalaxySynBioCadKernel({
            endpointURL: "https://k.example.com/run",
            builderAgentId: "eip155:84532:0xAgent",
          }),
      ).toThrow(/no transport/);
    } finally {
      if (prevUrl !== undefined) process.env.GALAXY_URL = prevUrl;
    }
  });
});

describe("signed evidence", () => {
  it("ephemeral handler returns a verifiable signed evidence bundle", async () => {
    const kernel = new GalaxySynBioCadKernel(baseOpts);
    const { handler } = kernel.createEphemeralHandler();
    const res = await handler({
      jobId: "job-1",
      input: {
        tool_id: "rptools_rpfba",
        params: { pathway: "hda-1", model: "hda-2", biomass_rxn_id: "R_BIOMASS" },
      },
    });
    expect(res.evidenceBundle.jobId).toBe("job-1");
    expect((res.output as Record<string, unknown>).state).toBe("ok");
    const sessionPk = fromHex(res.kernelSessionPublicKey);
    expect(verifyBundleSignature(res.evidenceBundle, sessionPk)).toBe(true);
  });
});
