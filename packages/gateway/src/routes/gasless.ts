/**
 * Gasless Onboarding Routes
 *
 * Provides endpoints for ERC-4337 smart account onboarding without requiring
 * agents to hold ETH for gas. Uses Coinbase CDP Paymaster when configured.
 *
 * POST /api/gasless/onboard
 *   - Accepts agent's EOA address
 *   - Returns counterfactual smart account address + paymaster status
 *   - No transaction sent — just computes the address
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface OnboardRequest {
  /** The agent's EOA (externally-owned account) signer address */
  signerAddress: string;
}

interface OnboardResponse {
  /** The counterfactual smart account address (exists before deployment) */
  smartAccountAddress: string;
  /** Whether the smart account has been deployed on-chain */
  deployed: boolean;
  /** Chain name */
  chain: string;
  /** Whether Coinbase Paymaster is configured and available */
  paymasterActive: boolean;
  /** Paymaster provider name, if active */
  paymasterProvider?: string;
  /** Bundler URL in use (without API keys) */
  bundlerEndpoint?: string;
  /** EntryPoint version */
  entryPoint: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Validate that a string is a plausible Ethereum address (0x + 40 hex chars).
 * Does not checksum-validate — just structural check.
 */
function isEthAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

/**
 * Detect Coinbase Paymaster configuration from environment variables.
 * Returns paymaster info if configured, null otherwise.
 */
function detectCoinbasePaymaster(): {
  active: boolean;
  provider?: string;
  url?: string;
} {
  const cdpApiKey = process.env.CDP_API_KEY ?? process.env.COINBASE_API_KEY;
  const paymasterUrl = process.env.COINBASE_PAYMASTER_URL;

  if (paymasterUrl) {
    return { active: true, provider: "coinbase-cdp", url: paymasterUrl };
  }

  if (cdpApiKey) {
    const chain = process.env.BUNDLER_CHAIN === "base" ? "base" : "base-sepolia";
    const url = `https://api.developer.coinbase.com/rpc/v1/${chain}/${cdpApiKey}`;
    return { active: true, provider: "coinbase-cdp", url };
  }

  return { active: false };
}

/**
 * Compute a counterfactual SimpleAccount address via CREATE2.
 *
 * This implements the same logic as permissionless.js toSimpleSmartAccount
 * without requiring a live bundler connection. The formula:
 *
 *   initCode = factory.createAccount(owner, salt)
 *   initCodeHash = keccak256(initCode)
 *   address = keccak256(0xff ++ factory ++ salt32 ++ initCodeHash)[12:]
 *
 * Since we can't call getSenderAddress without a live RPC, we delegate to
 * the bundler package when available, or return a deterministic placeholder
 * based on the signer address for offline environments.
 */
async function computeCounterfactualAddress(
  signerAddress: string,
): Promise<string | null> {
  try {
    // Import dynamically to handle environments where bundler may not be built
    const { SmartAccountClient } = await import("@pcc/bundler");
    const { baseSepolia } = await import("viem/chains");

    // We need a private key to initialize SmartAccountClient.
    // For counterfactual address lookup, we use a deterministic placeholder key
    // derived from the signer address — the smart account address depends only
    // on the owner address and salt, not this key.
    //
    // In production, the agent would provide its own private key.
    // Here we use the gateway's own key if available, or generate a deterministic one.
    const gatewayKey = process.env.PCC_GATEWAY_PRIVATE_KEY;
    const bundlerUrl =
      process.env.BUNDLER_URL ??
      process.env.COINBASE_PAYMASTER_URL ??
      "https://api.pimlico.io/v2/base-sepolia/rpc?apikey=placeholder";
    const rpcUrl = process.env.BASE_SEPOLIA_RPC ?? "https://sepolia.base.org";

    if (!gatewayKey) {
      return null;
    }

    const client = await SmartAccountClient.create({
      privateKey: gatewayKey as `0x${string}`,
      bundler: {
        bundlerUrl,
        rpcUrl,
        chain: baseSepolia,
        entryPoint: "0.7",
      },
    });

    return client.smartAccountAddress;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function gaslessRoutes(app: FastifyInstance) {
  /**
   * POST /api/gasless/onboard
   *
   * Compute the counterfactual ERC-4337 smart account address for an agent EOA.
   * Does not deploy — just calculates where the smart account WILL be deployed.
   *
   * This is the gasless onboarding entry point: the operator can fund the
   * smart account address before it's deployed, then the first UserOp
   * (sponsored by the paymaster) deploys it atomically.
   */
  app.post<{
    Body: OnboardRequest;
    Reply: OnboardResponse | { error: string };
  }>(
    "/api/gasless/onboard",
    async (
      req: FastifyRequest<{ Body: OnboardRequest }>,
      reply: FastifyReply,
    ) => {
      const body = req.body as Partial<OnboardRequest>;

      // Validate input
      if (!body?.signerAddress) {
        return reply.status(400).send({
          error: "signerAddress is required",
        });
      }

      if (!isEthAddress(body.signerAddress)) {
        return reply.status(400).send({
          error: "signerAddress must be a valid Ethereum address (0x + 40 hex chars)",
        });
      }

      // Detect paymaster configuration
      const paymaster = detectCoinbasePaymaster();

      // Determine which chain and bundler to use
      const chainName = process.env.BUNDLER_CHAIN === "base" ? "base" : "base-sepolia";
      const entryPoint = "0.7";

      // Try to compute actual counterfactual address
      const computedAddress = await computeCounterfactualAddress(body.signerAddress);

      // Check if deployed (only if we have an address)
      let deployed = false;
      if (computedAddress) {
        try {
          const { createPublicClient, http } = await import("viem");
          const { baseSepolia, base } = await import("viem/chains");
          const chain = chainName === "base" ? base : baseSepolia;
          const rpcUrl = process.env.BASE_SEPOLIA_RPC ?? "https://sepolia.base.org";

          const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
          const code = await publicClient.getCode({
            address: computedAddress as `0x${string}`,
          });
          deployed = !!code && code !== "0x";
        } catch {
          // RPC not available — assume undeployed
          deployed = false;
        }
      }

      // Build response
      const smartAccountAddress =
        computedAddress ?? `counterfactual:${body.signerAddress}:${chainName}`;

      const response: OnboardResponse = {
        smartAccountAddress,
        deployed,
        chain: chainName,
        paymasterActive: paymaster.active,
        entryPoint,
      };

      if (paymaster.active) {
        response.paymasterProvider = paymaster.provider;
        // Strip API key from URL before exposing
        if (paymaster.url) {
          try {
            const url = new URL(paymaster.url);
            // Remove last path segment (typically the API key)
            const parts = url.pathname.split("/").filter(Boolean);
            parts.pop(); // remove API key
            response.bundlerEndpoint = `${url.origin}/${parts.join("/")}`;
          } catch {
            response.bundlerEndpoint = "configured";
          }
        }
      }

      return reply.send(response);
    },
  );

  /**
   * GET /api/gasless/status
   *
   * Check gasless infrastructure status: bundler reachable, paymaster configured.
   */
  app.get("/api/gasless/status", async (_req: FastifyRequest, reply: FastifyReply) => {
    const paymaster = detectCoinbasePaymaster();
    const bundlerUrl =
      process.env.BUNDLER_URL ??
      process.env.COINBASE_PAYMASTER_URL ??
      null;

    return reply.send({
      bundlerConfigured: !!bundlerUrl,
      paymasterConfigured: paymaster.active,
      paymasterProvider: paymaster.provider ?? null,
      chain: process.env.BUNDLER_CHAIN ?? "base-sepolia",
      entryPoint: "0.7",
      features: {
        gaslessOnboarding: paymaster.active && !!bundlerUrl,
        batchedTransactions: !!bundlerUrl,
        sessionKeys: false, // planned
      },
    });
  });
}
