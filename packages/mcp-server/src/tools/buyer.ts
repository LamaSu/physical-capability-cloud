import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getAddress } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { resolveGatewayUrl } from "../api.js";
import { buyerPrivateKeySecretsFromEnv, createBuyerSession, type BuyerDependencies } from "./buyer-session.js";
import { orderStatusView } from "./buyer-status.js";

export const BUYER_TOOL_NAMES = ["pcc_buyer_sign_in", "pcc_buyer_sign_out", "pcc_buyer_order_status"] as const;

export const BUYER_ERROR_TEXTS = Object.freeze({
  BUYER_SIGNER_MISSING: "No buyer signer is configured. Set PCC_BUYER_SIGNER_URL and PCC_BUYER_ADDRESS for an external signer, or PCC_BUYER_PRIVATE_KEY for a dedicated test-network wallet.",
  BUYER_SIGNER_AMBIGUOUS: "Configure one buyer signer: PCC_BUYER_SIGNER_URL with PCC_BUYER_ADDRESS, or PCC_BUYER_PRIVATE_KEY, not both.",
  BUYER_SIGNER_INVALID: "The buyer signer settings are malformed. Check PCC_BUYER_PRIVATE_KEY, or PCC_BUYER_SIGNER_URL (https, or http on localhost) and PCC_BUYER_ADDRESS.",
  BUYER_CHAIN_REFUSED: "Buyer tools run only on a test network: PCC_BUYER_CHAIN_ID must be 84532 (Base Sepolia) or 31337 (a local anvil chain).",
  BUYER_GATEWAY_INSECURE: "Buyer sign-in needs PCC_URL on https (http only on localhost).",
  BUYER_NOT_SIGNED_IN: "No buyer session. Call pcc_buyer_sign_in first, or set PCC_API_KEY to a key minted from a wallet session.",
  BUYER_IDENTITY_UNVERIFIED: "The gateway shows a job's funding only to a proven wallet. Call pcc_buyer_sign_in, or use a key minted from a wallet session.",
  BUYER_JOB_NOT_FOUND: "The gateway has no job with this id that this buyer can read.",
  BUYER_STATUS_UNAVAILABLE: "The gateway couldn't read the job's funding records. Try again shortly.",
  BUYER_STATUS_FAILED: "The funding read failed{ (HTTP {status})}.",
  BUYER_STATUS_MALFORMED: "The funding read failed (malformed reply).",
});

export const BUYER_TOOL_TEXTS = Object.freeze({
  S26: "Sign in as the buyer with this server's configured wallet signer (Sign-In with Ethereum), and keep the gateway's session key in memory for this server's later calls. Test network only: Base Sepolia (84532) or a local anvil chain (31337). Ends any previous buyer session first. Returns the proven wallet address to use as userAgentId when you open a negotiation. Moves no funds.",
  S27: "End the buyer session: ask the gateway to revoke the session and its key, then forget both. Later calls use PCC_API_KEY again, if it is set.",
  S28: "Read where a job's buyer funding stands, from the gateway's stored records (GET /api/jobs/:jobId/funding). Needs a buyer session (pcc_buyer_sign_in) or a PCC_API_KEY minted from a wallet session. Reports each paid scope's status, network and verification. A verification is a past check at a block, not a live balance.",
  S29: "The jobId from pcc_negotiate_commit's reply.",
});

type ConfigError = "BUYER_SIGNER_MISSING" | "BUYER_SIGNER_AMBIGUOUS" | "BUYER_SIGNER_INVALID"
  | "BUYER_CHAIN_REFUSED" | "BUYER_GATEWAY_INSECURE";
type BuyerSigner = { kind: "local"; address: string; account: PrivateKeyAccount }
  | { kind: "external"; address: string; url: string };
export interface BuyerConfig {
  gatewayUrl: string;
  chainId: number;
  signer?: BuyerSigner;
  error?: ConfigError;
  privateKeySecrets?: () => readonly string[];
}

/** Same URL rule as the reviewed operator-session client. */
function validBaseUrl(value: string): boolean {
  if (/\s/.test(value)) return false;
  if (!/^https?:\/\/[^/\\?#]/i.test(value) || value.includes("\\")) return false;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*@/.test(value)) return false;
  if (value.includes("?") || value.includes("#")) return false;
  try {
    const url = new URL(value);
    return !!url.hostname && !url.username && !url.password && (
      url.protocol === "https:" || (url.protocol === "http:" &&
        ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname.toLowerCase()))
    );
  } catch { return false; }
}

/** Snapshot configuration without retaining the private-key string or throwing. */
export function buyerConfigFromEnv(env: Record<string, string | undefined>): BuyerConfig {
  const config: BuyerConfig = { gatewayUrl: resolveGatewayUrl(env), chainId: 84532, privateKeySecrets: buyerPrivateKeySecretsFromEnv(env) };
  const privateKey = env.PCC_BUYER_PRIVATE_KEY?.trim() || undefined;
  const signerUrl = env.PCC_BUYER_SIGNER_URL || undefined;
  const signerAddress = env.PCC_BUYER_ADDRESS || undefined;
  if (!privateKey && !signerUrl && !signerAddress) config.error = "BUYER_SIGNER_MISSING";
  else if (privateKey && (signerUrl || signerAddress)) config.error = "BUYER_SIGNER_AMBIGUOUS";
  else {
    try {
      if (privateKey) {
        if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new Error();
        const account = privateKeyToAccount(privateKey as `0x${string}`);
        config.signer = { kind: "local", account, address: account.address };
      } else {
        if (!signerUrl || !validBaseUrl(signerUrl) || !signerAddress || !/^0x[0-9a-fA-F]{40}$/.test(signerAddress)) throw new Error();
        config.signer = { kind: "external", url: signerUrl, address: getAddress(signerAddress) };
      }
    } catch { config.error = "BUYER_SIGNER_INVALID"; }
  }
  const chain = env.PCC_BUYER_CHAIN_ID?.trim() || "84532";
  if (chain === "84532" || chain === "31337") config.chainId = Number(chain);
  else config.error ??= "BUYER_CHAIN_REFUSED";
  if (!validBaseUrl(config.gatewayUrl)) config.error ??= "BUYER_GATEWAY_INSECURE";
  return config;
}

function result(data: unknown, isError = false) {
  return { ...(isError ? { isError: true } : {}), content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}
function refusal(error: keyof typeof BUYER_ERROR_TEXTS) {
  return result({ error, message: BUYER_ERROR_TEXTS[error] }, true);
}

export function registerBuyerTools(server: McpServer, config: BuyerConfig, deps: BuyerDependencies = {}): void {
  const session = createBuyerSession(config, deps);
  server.registerTool("pcc_buyer_sign_in", {
    description: "Sign in as the buyer with this server's configured wallet signer (Sign-In with Ethereum), and keep the gateway's session key in memory for this server's later calls. Test network only: Base Sepolia (84532) or a local anvil chain (31337). Ends any previous buyer session first. Returns the proven wallet address to use as userAgentId when you open a negotiation. Moves no funds.",
    inputSchema: {},
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async () => {
    if (config.error) return refusal(config.error);
    const reply = await session.signIn();
    return result(reply, "error" in reply);
  });
  server.registerTool("pcc_buyer_sign_out", {
    description: "End the buyer session: ask the gateway to revoke the session and its key, then forget both. Later calls use PCC_API_KEY again, if it is set.",
    inputSchema: {},
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async () => {
    const reply = await session.signOut();
    return reply ? result(reply) : refusal("BUYER_NOT_SIGNED_IN");
  });
  server.registerTool("pcc_buyer_order_status", {
    description: "Read where a job's buyer funding stands, from the gateway's stored records (GET /api/jobs/:jobId/funding). Needs a buyer session (pcc_buyer_sign_in) or a PCC_API_KEY minted from a wallet session. Reports each paid scope's status, network and verification. A verification is a past check at a block, not a live balance.",
    inputSchema: { jobId: z.string().min(1).max(200).describe("The jobId from pcc_negotiate_commit's reply.") },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async ({ jobId }) => {
    const bearer = session.bearer();
    if (!bearer) return refusal("BUYER_NOT_SIGNED_IN");
    let status: number | null = null;
    try {
      const reply = await session.request(`/api/jobs/${encodeURIComponent(jobId)}/funding`, {
        method: "GET", headers: { Authorization: `Bearer ${bearer}`, Accept: "application/json" },
      });
      status = reply.status;
      if (status === 200) {
        let body: unknown;
        try { body = await session.readJson(reply); } catch { return result({ error: "BUYER_STATUS_FAILED", message: BUYER_ERROR_TEXTS.BUYER_STATUS_MALFORMED }, true); }
        const view = orderStatusView(jobId, body);
        return view ? result(view) : result({ error: "BUYER_STATUS_FAILED", message: BUYER_ERROR_TEXTS.BUYER_STATUS_MALFORMED }, true);
      }
      if (status === 401) return refusal("BUYER_NOT_SIGNED_IN");
      if (status === 403) return refusal("BUYER_IDENTITY_UNVERIFIED");
      if (status === 404) return refusal("BUYER_JOB_NOT_FOUND");
      if (status === 503) return refusal("BUYER_STATUS_UNAVAILABLE");
    } catch { /* No transport or gateway text crosses the tool boundary. */ }
    return result({ error: "BUYER_STATUS_FAILED", status,
      message: BUYER_ERROR_TEXTS.BUYER_STATUS_FAILED.replace("{ (HTTP {status})}", status === null ? "" : ` (HTTP ${status})`),
    }, true);
  });
}
