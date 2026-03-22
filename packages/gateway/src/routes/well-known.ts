import type { FastifyInstance } from "fastify";

/**
 * /.well-known/ routes for discovery:
 *
 * 1. /.well-known/agent-registration.json — ERC-8004 domain verification.
 *    Proves this gateway controls the registered ERC-8004 agent identity.
 *
 * 2. /.well-known/agent-card.json — A2A Agent Card (Google A2A protocol).
 *    Declares PCC capabilities, payment support, and endpoint URLs for
 *    agent-to-agent discovery. See: https://google.github.io/A2A/
 */

// Configuration — set via environment or defaults to demo values
const KERNEL_NAME = process.env.PCC_KERNEL_NAME ?? "PCC Gateway";
const KERNEL_DESC = process.env.PCC_KERNEL_DESCRIPTION ?? "Physical Capability Cloud — manufacturing capabilities as cloud services";
const GATEWAY_URL = process.env.PCC_GATEWAY_URL ?? "https://pcc-gateway-production.up.railway.app";
const AGENT_ID = process.env.PCC_AGENT_ID ? parseInt(process.env.PCC_AGENT_ID, 10) : undefined;
const CHAIN_ID = process.env.PCC_CHAIN_ID ? parseInt(process.env.PCC_CHAIN_ID, 10) : 84532; // Base Sepolia
const REGISTRY_ADDRESS = (process.env.PCC_REGISTRY_ADDRESS ?? "0x8004A818BFB912233c491871b3d84c89A494BD9e") as `0x${string}`;

export async function wellKnownRoutes(app: FastifyInstance) {
  app.get("/.well-known/agent-registration.json", async (_request, reply) => {
    const registrations: Array<{ agentId: number; agentRegistry: string }> = [];

    if (AGENT_ID !== undefined) {
      registrations.push({
        agentId: AGENT_ID,
        agentRegistry: `eip155:${CHAIN_ID}:${REGISTRY_ADDRESS}`,
      });
    }

    const registrationFile = {
      type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
      name: KERNEL_NAME,
      description: KERNEL_DESC,
      services: [
        {
          name: "A2A",
          endpoint: `${GATEWAY_URL}/a2a`,
          version: "1.0",
        },
        {
          name: "web",
          endpoint: `${GATEWAY_URL}/api`,
        },
        {
          name: "MCP",
          endpoint: `${GATEWAY_URL}/mcp`,
          version: "2024-11-05",
        },
        {
          name: "DID",
          endpoint: `${GATEWAY_URL}/api/identity`,
        },
      ],
      x402Support: true,
      active: true,
      registrations,
      supportedTrust: ["reputation", "crypto-economic"],
    };

    return reply
      .header("content-type", "application/json")
      .header("access-control-allow-origin", "*")
      .send(registrationFile);
  });

  // -----------------------------------------------------------------------
  // A2A Agent Card — Google A2A protocol discovery
  // -----------------------------------------------------------------------

  const mppEnabled = process.env.MPP_ENABLED === "true";

  app.get("/.well-known/agent-card.json", async (_request, reply) => {
    const agentCard = {
      name: KERNEL_NAME,
      description: KERNEL_DESC,
      url: GATEWAY_URL,
      version: "0.1.0",
      capabilities: {
        manufacturing: {
          "3d-printing": true,
          "cnc-machining": true,
          "laser-cutting": true,
          "injection-molding": true,
        },
        services: [
          "quote",
          "simulate",
          "route",
          "search",
          "job-submit",
          "evidence-verify",
          "escrow-manage",
        ],
      },
      endpoints: {
        a2a: `${GATEWAY_URL}/a2a`,
        api: `${GATEWAY_URL}/api`,
        mcp: `${GATEWAY_URL}/mcp`,
        sse: `${GATEWAY_URL}/sse`,
      },
      payment: {
        protocol: mppEnabled ? "mpp" : "x402",
        methods: mppEnabled
          ? ["tempo/charge", "tempo/session"]
          : ["x402/exact"],
        currency: "USDC",
        network: "eip155:84532",
        recipient: process.env.TEMPO_RECIPIENT ?? process.env.PCC_TREASURY_ADDRESS ?? "0x0000000000000000000000000000000000000001",
        protectedRoutes: [
          { method: "POST", path: "/api/capabilities/quote", price: "$0.01" },
          { method: "POST", path: "/api/capabilities/simulate", price: "$0.05" },
          { method: "POST", path: "/api/capabilities/route", price: "$0.02" },
          { method: "GET", path: "/api/capabilities/search", price: "$0.001" },
        ],
      },
      identity: {
        erc8004: AGENT_ID !== undefined,
        did: true,
        registrationUrl: `${GATEWAY_URL}/.well-known/agent-registration.json`,
      },
      assuranceTiers: [0, 1, 2, 3],
      active: true,
    };

    return reply
      .header("content-type", "application/json")
      .header("access-control-allow-origin", "*")
      .send(agentCard);
  });
}
