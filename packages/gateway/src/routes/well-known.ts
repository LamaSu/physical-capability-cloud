import type { FastifyInstance } from "fastify";
import { getStore } from "../db.js";
import { schema, eq } from "@pcc/store";
import { signAgentCard, type AgentCard } from "@pcc/a2a-signing";
import { getActiveSigningKey } from "../signing-key.js";

/**
 * /.well-known/ routes for discovery:
 *
 * 1. /.well-known/agent-registration.json — ERC-8004 domain verification.
 *    Proves this gateway controls the registered ERC-8004 agent identity.
 *
 * 2. /.well-known/agent-card.json — A2A Agent Card (Google A2A protocol).
 *    Declares PCC capabilities, payment support, and endpoint URLs for
 *    agent-to-agent discovery. See: https://google.github.io/A2A/
 *
 * 3. /.well-known/agent-descriptions — ANP CollectionPage (W3C ActivityStreams
 *    2.0 + JSON-LD) listing every active agent card on this network: the
 *    gateway's own card plus every active kernel's card. Lets a remote agent
 *    enumerate the federation without scraping HTML.
 *    See: https://www.w3.org/TR/activitystreams-core/#collections
 *
 * 4. /api/kernels/:kernelId/agent-card.json — Per-kernel A2A agent card,
 *    synthesized from the kernel + its registered capabilities. Each active
 *    kernel is its own A2A agent in the federation.
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
          endpoint: `${GATEWAY_URL}/a2a/tasks/send`,
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

  app.get(
    "/.well-known/agent-card.json",
    {
      schema: {
        tags: ["well-known"],
        summary: "Google A2A Agent Card discovery document",
        description:
          "Returns the A2A protocol Agent Card declaring PCC's capabilities, " +
          "skills (discover/quote/submit/verify/settle), payment support, " +
          "and security schemes. Used by agent-to-agent discovery. " +
          "See https://google.github.io/A2A/. PUBLIC.",
        response: {
          200: {
            type: "object",
            additionalProperties: true,
            properties: {
              protocolVersion: { type: "string" },
              name: { type: "string" },
              description: { type: "string" },
              url: { type: "string" },
              version: { type: "string" },
              preferredTransport: { type: "string" },
              provider: { type: "object", additionalProperties: true },
              capabilities: { type: "object", additionalProperties: true },
              skills: {
                type: "array",
                items: { type: "object", additionalProperties: true },
              },
            },
          },
        },
      },
    },
    async (_request, reply) => {
    const agentCard = {
      protocolVersion: "1.0",
      name: KERNEL_NAME,
      description: KERNEL_DESC,
      url: `${GATEWAY_URL}/a2a/tasks/send`,
      version: "2.0.0",
      preferredTransport: "JSONRPC",
      supportedInterfaces: [
        {
          url: `${GATEWAY_URL}/a2a/tasks/send`,
          protocolBinding: "JSONRPC",
          protocolVersion: "1.0",
        },
      ],

      provider: {
        organization: "Physical Capability Cloud",
        url: "https://capability.network",
      },

      documentationUrl: "https://capability.network/whitepaper.md",
      iconUrl: `${GATEWAY_URL}/icon.png`,

      capabilities: {
        streaming: false,
        pushNotifications: false,
        stateTransitionHistory: false,
        extendedAgentCard: false,
      },

      defaultInputModes: ["application/json", "text/plain"],
      defaultOutputModes: ["application/json"],

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
      securityRequirements: [
        { apiKey: [] },
        { siwe: ["operator"] },
      ],

      supportsAuthenticatedExtendedCard: false,

      skills: [
        {
          id: "discover_capability",
          name: "Discover Physical Capabilities",
          description: "Find real physical capabilities through POST /ask, GET /api/capabilities/search?q=, GET /api/capabilities/types, or POST /a2a/tasks/send with skill discover_capability.",
          tags: ["discovery", "physical-capability", "search"],
          examples: [
            "Find a physical capability that can manufacture this part",
            "What laboratory capability is available for this protocol?",
          ],
          inputModes: ["application/json", "text/plain"],
          outputModes: ["application/json"],
        },
        {
          id: "hire_capability",
          name: "Hire a Physical Capability",
          description: "Hire a discovered capability through POST /a2a/tasks/send with skill hire_capability or submit directly at POST /api/jobs/submit.",
          tags: ["hiring", "physical-capability", "job-submission"],
          examples: ["Hire the selected 3D-printing capability for this job"],
          inputModes: ["application/json"],
          outputModes: ["application/json"],
        },
        {
          id: "verify_evidence",
          name: "Verify Physical Evidence",
          description: "Assess execution evidence through POST /a2a/tasks/send with skill verify_evidence and retrieve job evidence at GET /api/evidence/:jobId.",
          tags: ["verification", "evidence", "physical-capability"],
          examples: ["Verify the evidence for this completed physical job"],
          inputModes: ["application/json"],
          outputModes: ["application/json"],
        },
        {
          id: "pcc-discover",
          name: "Capability Discovery",
          description: "Discover and search physical capabilities across PCC's live registry. Invoke this skill at POST /a2a/tasks/send with skill pcc-discover, use POST /ask for natural-language discovery, or query GET /api/capabilities/search?q= and GET /api/capabilities/types.",
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
          description: "Hire a discovered capability by invoking POST /a2a/tasks/send with skill pcc-submit, or submit directly at POST /api/jobs/submit, then track the physical job through its execution lifecycle.",
          tags: ["job-submission", "workflow", "manufacturing", "tracking", "escrow", "milestones", "sse"],
          examples: [
            "Submit 3D print job with STL file, PLA material, 0.2mm resolution",
            "Stream real-time status for job job_abc123",
            "Submit multi-step protocol: PCR amplification then gel electrophoresis",
          ],
          inputModes: ["application/json", "multipart/form-data"],
          outputModes: ["application/json"],
        },
        {
          id: "pcc-verify",
          name: "Evidence Verification",
          description: "Verify physical execution evidence by invoking POST /a2a/tasks/send with skill pcc-verify. Retrieve the real job evidence surface at GET /api/evidence/:jobId and use the returned bundles for assurance assessment.",
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
        {
          id: "pcc-author-integration",
          name: "Author an Integration",
          description: "Onboard a new operator end-to-end: from a machine or human-skill description, register the kernel, publish the capability (with optional human-lane accept/deadline SLA, optional availability windows, and optional notification channels), and return the live A2A agent-card URL. Accepts channels[] and availability inline so a fully-formed operator can be onboarded in one call.",
          tags: ["onboarding", "operator", "integration", "kernel", "capability", "physical-world", "channels", "availability"],
          examples: [
            "Publish my Opentrons OT-2 as a liquid-handling capability via generic-http",
            "List me as a same-day SF courier - accept within 90s, finish within 1h",
            "Publish my pizza shop with a webhook channel to my receipt printer and availability windows 9am-10pm daily",
          ],
          inputModes: ["application/json"],
          outputModes: ["application/json"],
        },
        {
          id: "pcc-attach-channel",
          name: "Attach a Notification Channel",
          description: "Attach a notification/dispatch channel to an existing operator so PCC knows how to ping them when a job lands. Channels carry a small stable transport enum (webhook/email/sms/voice/push/mqtt/file/manual) plus a plain-English describe field the operator's onboarding agent fills in by conversation. PCC the substrate stays neutral on specific vendors — new backend types appear by conversation, not code change. Returns the channel record + a test-dispatch URL for end-to-end verification.",
          tags: ["onboarding", "operator", "channel", "notification", "integration", "wire-protocol"],
          examples: [
            "Add a webhook channel for my pizza shop that POSTs to my receipt printer's local URL",
            "Add an SMS channel to my phone so I get pinged for new courier jobs",
            "Attach an MQTT topic on my lab's broker for incoming HPLC runs",
            "Add a manual channel (dashboard only) for my one-person studio",
          ],
          inputModes: ["application/json"],
          outputModes: ["application/json"],
        },
        {
          id: "pcc-suggest-templates",
          name: "Suggest Capability Templates",
          description: "Bidirectional onboarding: the registry talks back. A user's agent describes in plain English what they're trying to set up (\"I'm publishing a wood-fired pizza shop\", \"I have an Opentrons OT-2\", \"I want to do same-day courier runs in SF\") and the registry returns N candidate CSD (Capability StructureDefinition) templates with relevance scores and usage attribution. The user's agent then picks one — or rolls a new template via POST /api/csd — and passes the chosen type to pcc-author-integration. Templates carry adoption counters (the marketplace data layer for future smart-contract gating + free/paid choice). Empty query returns popularity-ordered top picks.",
          tags: ["onboarding", "templates", "csd", "registry", "discovery", "marketplace", "bidirectional"],
          examples: [
            "I'm setting up a wood-fired Neapolitan pizza shop in SF",
            "I have an Opentrons OT-2 I want to publish as a liquid-handling capability",
            "Show me the most-adopted human-skill templates",
            "I want to do same-day courier runs — what templates are close to that?",
          ],
          inputModes: ["application/json", "text/plain"],
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
      "x-pcc-core-skills": {
        discover_capability: {
          a2aSkill: "pcc-discover",
          endpoints: [
            { method: "POST", url: `${GATEWAY_URL}/ask` },
            { method: "GET", url: `${GATEWAY_URL}/api/capabilities/search` },
            { method: "GET", url: `${GATEWAY_URL}/api/capabilities/types` },
          ],
        },
        hire_capability: {
          a2aSkill: "pcc-submit",
          endpoints: [
            { method: "POST", url: `${GATEWAY_URL}/a2a/tasks/send` },
            { method: "POST", url: `${GATEWAY_URL}/api/jobs/submit` },
          ],
        },
        verify_evidence: {
          a2aSkill: "pcc-verify",
          endpoints: [
            { method: "POST", url: `${GATEWAY_URL}/a2a/tasks/send` },
            { method: "GET", url: `${GATEWAY_URL}/api/evidence/:jobId` },
          ],
        },
      },
    };

    // A2A v1.0 §8.4 — if a signing key is loaded, sign the card in flight.
    // Backwards compat: when no key is configured, serve the unsigned card.
    const signingKey = getActiveSigningKey();
    const responseBody = signingKey
      ? await signAgentCard(agentCard as AgentCard, {
          privateKey: signingKey.privateKey,
          kid: signingKey.kid,
          jwksUrl: `${GATEWAY_URL}/.well-known/jwks.json`,
        })
      : agentCard;

    return reply
      .header("content-type", "application/json")
      .header("access-control-allow-origin", "*")
      .header("cache-control", "public, max-age=300")
      .send(responseBody);
  });

  // -----------------------------------------------------------------------
  // ANP CollectionPage — list every active agent card in the federation
  // -----------------------------------------------------------------------

  app.get("/.well-known/agent-descriptions", async (_request, reply) => {
    const { shopKernels } = schema;
    let kernelItems: string[] = [];

    try {
      const { db } = getStore();
      const rows = db
        .select({ id: shopKernels.id, status: shopKernels.status })
        .from(shopKernels)
        .all();
      // "active" = the operator is at least theoretically reachable
      kernelItems = rows
        .filter((r) => r.status === "online" || r.status === "maintenance")
        .map((r) => `${GATEWAY_URL}/api/kernels/${r.id}/agent-card.json`);
    } catch {
      // DB may not be initialised in some test contexts; return only the
      // network card. The endpoint must never fail just because the DB is
      // empty.
    }

    const items = [
      `${GATEWAY_URL}/.well-known/agent-card.json`,
      ...kernelItems,
    ];

    const collection = {
      "@context": [
        "https://www.w3.org/ns/activitystreams",
        { agentCard: "https://google.github.io/A2A/ns#agentCard" },
      ],
      type: "CollectionPage",
      id: `${GATEWAY_URL}/.well-known/agent-descriptions`,
      partOf: `${GATEWAY_URL}/.well-known/agent-descriptions`,
      summary: `${KERNEL_NAME} — federated A2A agent descriptions`,
      totalItems: items.length,
      items,
    };

    return reply
      .header("content-type", "application/ld+json")
      .header("access-control-allow-origin", "*")
      .header("cache-control", "public, max-age=300")
      .send(collection);
  });

  // -----------------------------------------------------------------------
  // Per-kernel A2A agent card — every active kernel is its own agent
  // -----------------------------------------------------------------------

  app.get<{ Params: { kernelId: string } }>(
    "/api/kernels/:kernelId/agent-card.json",
    async (request, reply) => {
      const { shopKernels, capabilities } = schema;
      const { kernelId } = request.params;
      let kernelRow:
        | {
            id: string;
            name: string;
            operatorAddress: string;
            status: string;
            version: string;
          }
        | undefined;
      let capTypes: string[] = [];

      try {
        const { db } = getStore();
        kernelRow = db
          .select({
            id: shopKernels.id,
            name: shopKernels.name,
            operatorAddress: shopKernels.operatorAddress,
            status: shopKernels.status,
            version: shopKernels.version,
          })
          .from(shopKernels)
          .where(eq(shopKernels.id, kernelId))
          .get() as typeof kernelRow;
        if (!kernelRow) {
          return reply.status(404).send({ error: "kernel_not_found" });
        }
        const caps = db
          .select({ type: capabilities.type })
          .from(capabilities)
          .where(eq(capabilities.kernelId, kernelId))
          .all();
        capTypes = [...new Set(caps.map((c) => c.type as string))];
      } catch {
        return reply.status(500).send({ error: "kernel_lookup_failed" });
      }

      const kernelCard = {
        protocolVersion: "1.0",
        name: kernelRow.name,
        description: `Physical Capability Cloud kernel ${kernelRow.name}. ${capTypes.length} capability type(s).`,
        url: `${GATEWAY_URL}/a2a/tasks/send`,
        version: kernelRow.version,
        preferredTransport: "JSONRPC",
        supportedInterfaces: [
          {
            url: `${GATEWAY_URL}/a2a/tasks/send`,
            protocolBinding: "JSONRPC",
            protocolVersion: "1.0",
          },
        ],

        provider: {
          organization: "Physical Capability Cloud",
          url: "https://capability.network",
        },

        capabilities: {
          streaming: false,
          pushNotifications: false,
          stateTransitionHistory: false,
          extendedAgentCard: false,
        },

        defaultInputModes: ["application/json"],
        defaultOutputModes: ["application/json"],

        securitySchemes: {
          apiKey: {
            type: "http",
            scheme: "bearer",
            description:
              "PCC API key. Provision at POST /api/auth/provision.",
          },
        },

        security: [{ apiKey: [] }],
        securityRequirements: [{ apiKey: [] }],

        skills: [
          {
            id: "pcc-discover",
            name: "Capability Discovery",
            description: `Discover capabilities offered by this kernel: ${capTypes.join(", ") || "(none registered)"}.`,
            tags: ["discovery", "kernel", ...capTypes],
            inputModes: ["application/json"],
            outputModes: ["application/json"],
          },
          {
            id: "pcc-submit",
            name: "Submit Job",
            description: `Submit a job to this kernel's capabilities. Maps to POST /api/jobs/submit with kernelId=${kernelRow.id}.`,
            tags: ["job-submission", "kernel"],
            inputModes: ["application/json"],
            outputModes: ["application/json"],
          },
        ],

        "x-pcc-kernel-id": kernelRow.id,
        "x-pcc-kernel-status": kernelRow.status,
        "x-pcc-kernel-operator": kernelRow.operatorAddress,
        "x-pcc-capability-types": capTypes,
        "x-pcc-agent-package": `${GATEWAY_URL}/api/kernels/${kernelRow.id}/agent-package`,
      };

      // A2A v1.0 §8.4 — sign per-kernel card too when a key is loaded.
      const signingKey = getActiveSigningKey();
      const responseBody = signingKey
        ? await signAgentCard(kernelCard as AgentCard, {
            privateKey: signingKey.privateKey,
            kid: signingKey.kid,
            jwksUrl: `${GATEWAY_URL}/.well-known/jwks.json`,
          })
        : kernelCard;

      return reply
        .header("content-type", "application/json")
        .header("access-control-allow-origin", "*")
        .header("cache-control", "public, max-age=300")
        .send(responseBody);
    },
  );
}

// ---------------------------------------------------------------------------
// Unimplemented /.well-known/* — shared decision, used by server.ts's
// setNotFoundHandler AND by its tests.
//
// This lives here rather than inline in server.ts for a specific reason: the
// first version of this test MIRRORED the handler's logic instead of calling
// it, so the suite passed identically whether or not the handler existed —
// exactly the "proxy satisfiable without the property" failure class escrow
// documented in coord #1219. A mirror proves the mirror works. Exporting the
// real decision and importing it into the test removes the mirror.
// ---------------------------------------------------------------------------

/** Paths under /.well-known/ that genuinely resolve today (routes + static). */
export const PUBLISHED_WELL_KNOWN = [
  "/.well-known/agent-card.json",
  "/.well-known/agent-registration.json",
  "/.well-known/agent-descriptions",
  "/.well-known/mcp/server-card.json",
  "/.well-known/agent-skills/index.json",
  "/.well-known/ard.json",
  "/.well-known/ai-catalog.json",
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-authorization-server",
] as const;

/**
 * The 404 body for an unimplemented /.well-known path, or null when the path is
 * not on that prefix (caller then falls through to its normal handling).
 *
 * Call this ONLY after real-file and directory-index checks have already had
 * their chance: /.well-known/agent-card.json is a static file, not a registered
 * route, and blanket-404ing the prefix would break the one path on it that is
 * fully correct today.
 */
export function unimplementedWellKnownBody(
  cleanPath: string,
): { error: string; message: string; available: string[] } | null {
  if (!cleanPath.startsWith("/.well-known/")) return null;
  return {
    error: "not_found",
    message: `No document is published at ${cleanPath}.`,
    available: [...PUBLISHED_WELL_KNOWN],
  };
}
