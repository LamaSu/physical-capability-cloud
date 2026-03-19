import type { FastifyInstance } from "fastify";

/**
 * /.well-known/agent-registration.json — ERC-8004 domain verification.
 *
 * Serves the Agent Registration File that proves this gateway controls
 * the registered ERC-8004 agent identity. Any MCP/A2A/OASF client can
 * fetch this to discover PCC capabilities.
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
}
