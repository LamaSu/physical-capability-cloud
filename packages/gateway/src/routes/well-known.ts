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

  // MPP is the default; x402 is legacy opt-in via PCC_X402_LEGACY=true
  const mppEnabled = process.env.PCC_X402_LEGACY !== "true";

  app.get("/.well-known/agent-card.json", async (_request, reply) => {
    const agentCard = {
      protocolVersion: "0.3.0",
      name: KERNEL_NAME,
      description: KERNEL_DESC,
      url: `${GATEWAY_URL}/a2a`,
      version: "2.0.0",
      preferredTransport: "http+sse",

      provider: {
        organization: "Physical Capability Cloud",
        url: "https://capability.network",
      },

      documentationUrl: "https://capability.network/whitepaper.md",
      iconUrl: `${GATEWAY_URL}/icon.png`,

      capabilities: {
        streaming: true,
        pushNotifications: false,
        stateTransitionHistory: false,
      },

      defaultInputModes: ["application/json", "text/plain"],
      defaultOutputModes: ["application/json", "text/event-stream"],

      securitySchemes: {
        apiKey: {
          type: "http",
          scheme: "bearer",
          description: "PCC API key (pcc_live_... or pcc_test_...). Provision at POST /api/auth/provision. Pass as: Authorization: Bearer pcc_live_<key>",
        },
        siwe: {
          type: "oauth2",
          description: "Sign-In with Ethereum (SIWE / EIP-4361). Nonce at GET /api/auth/nonce, verify at POST /api/auth/verify. Returns session cookie or bearer token.",
          flows: {
            authorizationCode: {
              authorizationUrl: "https://capability.network/api/auth/nonce",
              tokenUrl: "https://capability.network/api/auth/verify",
              scopes: {
                operator: "Operator-level access (submit jobs, manage kernels)",
                admin: "Admin-level access (reward epochs, slash bonds)",
              },
            },
          },
        },
        x402: {
          type: "http",
          scheme: "bearer",
          "x-payment-protocol": mppEnabled ? "mpp" : "x402",
          "x-network": "eip155:84532",
          "x-currency": "USDC",
          "x-recipient": process.env.TEMPO_RECIPIENT ?? process.env.PCC_TREASURY_ADDRESS ?? "0x0000000000000000000000000000000000000001",
          description: `Micropayment via ${mppEnabled ? "MPP/Tempo" : "x402 (Coinbase)"} on Base Sepolia. Price declared in WWW-Authenticate header on 402 response.`,
        },
      },

      security: [
        { apiKey: [] },
        { siwe: ["operator"] },
      ],

      supportsAuthenticatedExtendedCard: false,

      skills: [
        {
          id: "pcc-discover",
          name: "Capability Discovery",
          description: "Discover and search physical manufacturing capabilities across the PCC network. Returns available capability types (3D printing, CNC machining, laser cutting, HPLC, liquid handling), active Shop Kernels, pricing, assurance tiers, and real-time queue depth.",
          tags: ["discovery", "manufacturing", "search", "capabilities", "kernels", "physical-world"],
          examples: [
            "Find FDM 3D printers near Austin TX that can print PLA under $50",
            "List available CNC machining capabilities with assurance tier 2",
            "Search for liquid handling capabilities compatible with 96-well plates",
          ],
          inputModes: ["application/json", "text/plain"],
          outputModes: ["application/json"],
        },
        {
          id: "pcc-quote",
          name: "Capability Quoting",
          description: "Get price quotes for physical capability contracts. Accepts capability type, material, parameters, quantity, deadline, and assurance tier. Returns itemized quote with operator bond, escrow amount, and validity window. Supports negotiation over A2A message bus.",
          tags: ["quoting", "pricing", "manufacturing", "negotiation", "escrow"],
          examples: [
            "Quote FDM print: 100g PLA, 0.2mm layer height, assurance tier 1",
            "Get CNC quote for aluminum part, quantity 5, 48-hour turnaround",
            "Quote HPLC batch: 24 samples, USP compliance tier 3",
          ],
          inputModes: ["application/json"],
          outputModes: ["application/json"],
        },
        {
          id: "pcc-submit",
          name: "Job Submission and Tracking",
          description: "Submit and track physical manufacturing jobs through the full lifecycle: pending → scheduled → in_progress → awaiting_verification → verified → completed. Supports milestone-based escrow funding, SSE streaming for real-time status updates, and batch job manifests.",
          tags: ["job-submission", "workflow", "manufacturing", "tracking", "escrow", "milestones", "sse"],
          examples: [
            "Submit 3D print job with STL file, PLA material, 0.2mm resolution",
            "Stream real-time status for job job_abc123",
            "Submit multi-step protocol: PCR amplification then gel electrophoresis",
          ],
          inputModes: ["application/json", "multipart/form-data"],
          outputModes: ["application/json", "text/event-stream"],
        },
        {
          id: "pcc-verify",
          name: "Evidence Verification",
          description: "Verify physical execution evidence bundles. Evidence is SHA-256 content-addressed, stored on Storacha/IPFS, optionally anchored to Starknet ZK proofs, and attested by the Bittensor verifier subnet. Supports photo verification (pHash+SSIM), sensor data, and human consensus.",
          tags: ["verification", "evidence", "ipfs", "zk-proof", "bittensor", "storacha", "trust"],
          examples: [
            "Verify evidence bundle for job job_abc123",
            "Check ZK proof anchor for evidence CID bafyrei...",
            "Get Bittensor attestation scores for operator 0x1234...",
          ],
          inputModes: ["application/json"],
          outputModes: ["application/json"],
        },
        {
          id: "pcc-settle",
          name: "Escrow and Settlement",
          description: "Manage milestone escrow for physical capability contracts. Fund with USDC on Base Sepolia, release milestones after evidence verification, handle disputes and operator bond slashing. Supports x402 micropayments, NEAR cross-chain payment intents, and DePIN reward epochs.",
          tags: ["escrow", "settlement", "payment", "usdc", "base", "depin", "x402", "near"],
          examples: [
            "Fund escrow for contract cap_xyz with 50 USDC on Base Sepolia",
            "Release milestone payment after verified evidence",
            "Check DePIN reward epoch and claim operator rewards",
          ],
          inputModes: ["application/json"],
          outputModes: ["application/json"],
        },
      ],

      // PCC-specific extension fields (non-standard, prefixed with x-)
      "x-erc8004": {
        registered: AGENT_ID !== undefined,
        agentId: AGENT_ID,
        registryAddress: REGISTRY_ADDRESS,
        chainId: CHAIN_ID,
        registrationUrl: `${GATEWAY_URL}/.well-known/agent-registration.json`,
      },
      "x-pcc-assurance-tiers": [0, 1, 2, 3],
      "x-pcc-networks": ["eip155:84532", "eip155:11155111", "near:testnet"],
      "x-pcc-mcp-endpoint": `${GATEWAY_URL}/mcp`,
      "x-pcc-sse-endpoint": `${GATEWAY_URL}/sse`,
      "x-pcc-agent-package": `${GATEWAY_URL}/agent-package.json`,
    };

    return reply
      .header("content-type", "application/json")
      .header("access-control-allow-origin", "*")
      .header("cache-control", "public, max-age=300")
      .send(agentCard);
  });
}
