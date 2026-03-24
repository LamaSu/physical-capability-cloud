/**
 * Service Status Routes — reports which services are running in mock vs real mode.
 *
 * GET /api/status/live → JSON map of every verification/storage/crypto service
 *                        with its current operating mode and configuration.
 */

import type { FastifyInstance } from "fastify";
import { configFromEnv } from "@pcc/verifier";

export async function statusRoutes(app: FastifyInstance) {
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
            ? "Datil-dev threshold encryption — decryption requires on-chain access conditions"
            : "Local AES-256-GCM — no network, no access control enforcement",
          network: litReal ? "datil-dev" : "none",
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
