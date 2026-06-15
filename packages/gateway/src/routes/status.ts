/**
 * Service Status Routes — reports which services are running in mock vs real mode.
 *
 * GET /api/status/live       → JSON map of every verification/storage/crypto service
 *                              with its current operating mode and configuration.
 * GET /api/status/integrations → Integration telemetry for all connected services
 * GET /api/telemetry/system  → Comprehensive system telemetry aggregator (all subsystems)
 */

import type { FastifyInstance } from "fastify";
import { configFromEnv } from "@pcc/verifier";
import { getRepos } from "../db.js";
import { getKernelFacade, getJobFacade } from "../facades/index.js";
import { isAgentBridgeReady, getConversations, getRecentMessages } from "../agent-bridge.js";
import { litEncryptionService } from "../services.js";
import { auditService } from "../services/audit-service.js";

export async function statusRoutes(app: FastifyInstance) {
  const kernelFacade = getKernelFacade();
  const jobFacade = getJobFacade();
  // ---------------------------------------------------------------------------
  // GET /api/status/integrations — real configuration state of each integration
  // ---------------------------------------------------------------------------

  app.get("/api/status/integrations", async () => {
    const evidenceBackend = process.env["EVIDENCE_STORAGE"] ?? "helia";
    const storachaReal =
      evidenceBackend === "storacha" && Boolean(process.env["STORACHA_PROOF"]);

    return {
      timestamp: new Date().toISOString(),
      storacha: {
        configured: storachaReal,
        mode: evidenceBackend,
        spaceId: process.env["STORACHA_SPACE_DID"] ?? null,
      },
      starknet: {
        configured: Boolean(process.env.STARKNET_ACCOUNT_ADDRESS),
        network: process.env.STARKNET_NETWORK ?? "sepolia",
        contractAddress: process.env.STARKNET_CONTRACT_ADDRESS ?? null,
      },
      litProtocol: {
        configured: process.env.LIT_PROTOCOL_REAL === "true",
        mode: process.env.LIT_PROTOCOL_REAL === "true" ? "real" : "local-aes",
        live: litEncryptionService.getStatus(),
      },
      flow: {
        configured: Boolean(process.env.ESCROW_CONTRACT_ADDRESS),
        chainId: 545,
        escrowAddress: process.env.ESCROW_CONTRACT_ADDRESS ?? null,
      },
      near: {
        configured: process.env.NEAR_MOCK !== "true" && process.env.NODE_ENV === "production",
        endpoint: "https://1click.chaindefuser.com/v0/",
      },
      protocol: {
        escrowAddress: process.env.ESCROW_CONTRACT_ADDRESS ?? null,
        feeBps: parseInt(process.env.PCC_FEE_BPS ?? "235", 10),
        feeRecipient: process.env.PCC_FEE_RECIPIENT ?? "0xdDF476D86afD5e2075b8c95CBFfd3d76aEfa4b6B",
      },
    };
  });

  // ---------------------------------------------------------------------------
  // GET /api/telemetry/system — raw DB state dump, no fake numbers, no summaries
  // ---------------------------------------------------------------------------

  app.get("/api/telemetry/system", async () => {
    const startedAt = process.hrtime.bigint();

    let kernels: unknown[] = [];
    let jobs: unknown[] = [];
    let evidence: unknown[] = [];
    let devices: unknown[] = [];
    let registrations: unknown[] = [];
    let capabilities: unknown[] = [];

    // kernels + jobs via facades (standardized Result<T> — never throws)
    const kernelResult = await kernelFacade.list();
    if (kernelResult.success) {
      kernels = kernelResult.data;
      // Devices are embedded in KernelDTO — flatten them
      for (const k of kernelResult.data as Array<{ id: string; devices?: unknown[] }>) {
        if (Array.isArray(k.devices)) devices.push(...k.devices);
      }
    }

    const jobResult = await jobFacade.list();
    if (jobResult.success) {
      jobs = jobResult.data.items;
    }

    // evidence, registrations, capabilities have no facade getter — stay inline
    try {
      const repos = getRepos();
      evidence = repos.evidence.findAll();
      registrations = repos.registrations?.findAll?.() ?? [];
      capabilities = repos.capabilities?.findAll?.() ?? [];
    } catch {
      // DB not ready
    }

    const agentBridgeReady = isAgentBridgeReady();
    const conversations = agentBridgeReady ? getConversations() : [];
    const recentMessages = agentBridgeReady ? getRecentMessages(100) : [];

    const elapsed = Number(process.hrtime.bigint() - startedAt) / 1_000_000;

    return {
      timestamp: new Date().toISOString(),
      uptime_seconds: Math.floor(process.uptime()),
      response_ms: Math.round(elapsed * 10) / 10,
      db: {
        kernels,
        devices,
        jobs,
        evidence,
        registrations,
        capabilities,
      },
      agents: {
        conversations,
        recentMessages,
      },
      audit: auditService.query({ limit: 50 }),
      env: {
        PCC_NETWORK: process.env.PCC_NETWORK ?? null,
        EVIDENCE_STORAGE: process.env["EVIDENCE_STORAGE"] ?? null,
        STORACHA_SPACE_DID: process.env["STORACHA_SPACE_DID"] ?? null,
        STARKNET_ACCOUNT_ADDRESS: process.env.STARKNET_ACCOUNT_ADDRESS ? "set" : null,
        LIT_PROTOCOL_REAL: process.env.LIT_PROTOCOL_REAL ?? null,
        ESCROW_CONTRACT_ADDRESS: process.env.ESCROW_CONTRACT_ADDRESS ?? null,
        NODE_ENV: process.env.NODE_ENV ?? null,
      },
    };
  });

  app.get("/api/status/live", async () => {
    const oracleConfig = configFromEnv();
    const oracleMock = oracleConfig.mock;

    const litReal = process.env.LIT_PROTOCOL_REAL === "true";

    const evidenceBackend = process.env["EVIDENCE_STORAGE"] ?? "helia";
    const storachaReal =
      evidenceBackend === "storacha" && Boolean(process.env["STORACHA_PROOF"]);

    const starknetReal = Boolean(process.env.STARKNET_ACCOUNT_ADDRESS);

    const hasDeployerKey =
      Boolean(process.env.UMA_ASSERTER_PRIVATE_KEY) ||
      Boolean(process.env.DEPLOYER_PRIVATE_KEY);

    const escrowAddress = process.env.ESCROW_CONTRACT_ADDRESS;
    const network = process.env.PCC_NETWORK ?? "unknown";

    return {
      timestamp: new Date().toISOString(),
      network,
      services: {
        uma_oracle: {
          mode: oracleMock ? "mock" : "real",
          details: oracleMock
            ? "ORACLE_MOCK not set to false"
            : hasDeployerKey
              ? "Live on Base Sepolia — assertions submitted to OOv3"
              : "ORACLE_MOCK=false but no private key — will fail on submit",
          contract: "0xFd9e2642a170aDD10F53Ee14a93FcF2F31924944",
          chain: "base-sepolia (84532)",
        },
        chainlink_oracle: {
          mode: "mock",
          details: "Fallback oracle — no Chainlink consumer contract deployed",
        },
        eigenlayer_avs: {
          mode: "stub",
          details: "Future integration — always unavailable",
        },
        lit_protocol: {
          mode: litReal ? "real" : "mock",
          details: litReal
            ? "Chipotle threshold encryption — decryption requires on-chain access conditions"
            : "Local AES-256-GCM — no network, no access control enforcement",
          // Was previously hardcoded to "datil-dev" — the live network is
          // "chipotle" (matches lit-provision.ts:134 / services.ts:178).
          network: litReal ? "chipotle" : "none",
          live: litEncryptionService.getStatus(),
        },
        evidence_storage: {
          mode: storachaReal ? "real" : "mock",
          backend: evidenceBackend,
          details: storachaReal
            ? "Storacha w3up — evidence bundles uploaded to IPFS + Filecoin"
            : evidenceBackend === "storacha"
              ? "Storacha configured but STORACHA_PROOF missing — running mock CIDs"
              : "Helia in-process IPFS node (ephemeral)",
        },
        starknet_anchoring: {
          mode: starknetReal ? "real" : "mock",
          details: starknetReal
            ? "Starknet Sepolia — ZK proof hashes anchored on-chain"
            : "Mock mode — simulated tx hashes, no on-chain anchoring",
        },
        zk_proofs: {
          mode: "mock",
          details: "HMAC-based mock proofs — Noir circuits compiled but backend_barretenberg not verified in Docker",
        },
        escrow_contract: {
          mode: escrowAddress ? "deployed" : "not_configured",
          address: escrowAddress ?? null,
          details: escrowAddress
            ? `MilestoneEscrow live on ${network} at ${escrowAddress}`
            : "No ESCROW_CONTRACT_ADDRESS configured",
        },
        bittensor_subnets: {
          mode: "mock",
          details: "In-process mock miners — capability routing, quality scoring, similarity detection. No real Bittensor network calls.",
          subnets: ["capability_routing", "quality_scoring", "similarity_detection"],
        },
        identity: {
          mode: "local",
          details: "W3C DIDs generated locally (did:key + did:pcc). No on-chain DID registry deployed.",
        },
      },
      summary: {
        real: [
          ...(oracleMock ? [] : ["uma_oracle"]),
          ...(litReal ? ["lit_protocol"] : []),
          ...(storachaReal ? ["evidence_storage"] : []),
          ...(starknetReal ? ["starknet_anchoring"] : []),
          ...(escrowAddress ? ["escrow_contract"] : []),
        ],
        mock: [
          ...(oracleMock ? ["uma_oracle"] : []),
          ...(!litReal ? ["lit_protocol"] : []),
          ...(!storachaReal ? ["evidence_storage"] : []),
          ...(!starknetReal ? ["starknet_anchoring"] : []),
          "zk_proofs",
          "chainlink_oracle",
          "bittensor_subnets",
          "identity",
        ],
        stub: ["eigenlayer_avs"],
      },
    };
  });
}
