import { describe, it, expect } from "vitest";
import { generateRegistrationFile, generateDomainVerification } from "../registration-file.js";

describe("generateRegistrationFile", () => {
  it("generates a valid registration file from minimal kernel input", () => {
    const result = generateRegistrationFile({
      name: "BioPunk HPLC Lab",
      description: "Shimadzu HPLC system with UV detector for pharmaceutical purity analysis",
      gatewayURL: "https://lab.biopunk.io",
    });

    expect(result.type).toBe("https://eips.ethereum.org/EIPS/eip-8004#registration-v1");
    expect(result.name).toBe("BioPunk HPLC Lab");
    expect(result.active).toBe(true);
    expect(result.x402Support).toBe(true);
    expect(result.services).toHaveLength(4); // A2A, web, MCP, DID
    expect(result.services[0]).toEqual({
      name: "A2A",
      endpoint: "https://lab.biopunk.io/a2a",
      version: "1.0",
    });
    expect(result.services[1]).toEqual({
      name: "web",
      endpoint: "https://lab.biopunk.io/api",
    });
    expect(result.services[2]).toEqual({
      name: "MCP",
      endpoint: "https://lab.biopunk.io/mcp",
      version: "2024-11-05",
    });
    expect(result.registrations).toEqual([]);
    expect(result.supportedTrust).toEqual(["reputation"]);
  });

  it("includes registrations when agentId is provided", () => {
    const result = generateRegistrationFile({
      name: "CNC Shop",
      description: "5-axis CNC machining center",
      gatewayURL: "https://cnc.example.com",
      agentId: 42,
      chainId: 8453,
      registryAddress: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
    });

    expect(result.registrations).toHaveLength(1);
    expect(result.registrations[0]).toEqual({
      agentId: 42,
      agentRegistry: "eip155:8453:0x8004A818BFB912233c491871b3d84c89A494BD9e",
    });
  });

  it("adds crypto-economic trust for tier 2+", () => {
    const tier2 = generateRegistrationFile({
      name: "Lab",
      description: "Lab",
      gatewayURL: "https://lab.io",
      assuranceTier: 2,
    });
    expect(tier2.supportedTrust).toContain("reputation");
    expect(tier2.supportedTrust).toContain("crypto-economic");
    expect(tier2.supportedTrust).not.toContain("tee-attestation");

    const tier3 = generateRegistrationFile({
      name: "Lab",
      description: "Lab",
      gatewayURL: "https://lab.io",
      assuranceTier: 3,
    });
    expect(tier3.supportedTrust).toContain("tee-attestation");
  });

  it("includes OASF service with capabilities", () => {
    const result = generateRegistrationFile({
      name: "Multi-Cap Lab",
      description: "Multi-capability lab",
      gatewayURL: "https://multi.lab.io",
      capabilities: ["hplc-purity", "mass-spec", "flow-reactor"],
    });

    const oasf = result.services.find(s => s.name === "OASF");
    expect(oasf).toBeDefined();
    expect(oasf!.skills).toEqual(["hplc-purity", "mass-spec", "flow-reactor"]);
    expect(oasf!.domains).toEqual(["manufacturing", "physical-infrastructure"]);
  });

  it("omits MCP when hasMcp is false", () => {
    const result = generateRegistrationFile({
      name: "Simple",
      description: "Simple kernel",
      gatewayURL: "https://simple.io",
      hasMcp: false,
    });

    const mcp = result.services.find(s => s.name === "MCP");
    expect(mcp).toBeUndefined();
  });

  it("includes image when provided", () => {
    const result = generateRegistrationFile({
      name: "Lab",
      description: "Lab",
      gatewayURL: "https://lab.io",
      avatarURL: "https://lab.io/avatar.png",
    });
    expect(result.image).toBe("https://lab.io/avatar.png");
  });
});

describe("generateDomainVerification", () => {
  it("generates domain verification object", () => {
    const result = generateDomainVerification(
      42,
      8453,
      "0x8004A818BFB912233c491871b3d84c89A494BD9e",
    );

    expect(result.registrations).toHaveLength(1);
    expect(result.registrations[0].agentId).toBe(42);
    expect(result.registrations[0].agentRegistry).toBe(
      "eip155:8453:0x8004A818BFB912233c491871b3d84c89A494BD9e",
    );
  });
});
