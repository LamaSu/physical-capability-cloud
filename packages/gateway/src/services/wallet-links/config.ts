import { deploymentEnvName } from "../../mcp/mcp-api-base.js";

/** Current server settings are read at proof/approval time, never from a request. */
export interface WalletLinkConfig {
  publicOrigin: string;
  domain: string;
  uri: string;
  env: string;
  allowedChainIds: readonly number[];
}

export function walletLinkConfig(): WalletLinkConfig {
  const configured = process.env.PCC_PUBLIC_URL || process.env.PCC_GATEWAY_URL || "https://capability.network";
  let origin: URL;
  try {
    origin = new URL(configured);
  } catch {
    throw new Error("invalid_wallet_public_origin");
  }
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password) {
    throw new Error("invalid_wallet_public_origin");
  }
  const env = deploymentEnvName() || process.env.NODE_ENV || "development";
  return {
    publicOrigin: origin.origin,
    domain: origin.host,
    uri: `${origin.origin}/link`,
    env: env === "production" ? "prod" : env,
    allowedChainIds: [84532],
  };
}
