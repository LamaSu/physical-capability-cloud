import { readFileSync } from "node:fs";
import { CdpWalletClient } from "@pcc/payments";

export interface FaucetClient {
  readonly isMock?: boolean;
  requestFaucet(address: `0x${string}`, token: "eth" | "usdc"): Promise<unknown>;
}

const GENERAL_CDP_NAMES = ["CDP_API_KEY_ID", "CDP_API_KEY_NAME", "CDP_API_KEY_SECRET", "CDP_WALLET_SECRET"] as const;

function isolatedEnvironment(env: NodeJS.ProcessEnv): boolean {
  return GENERAL_CDP_NAMES.every((name) => env[name] === undefined && process.env[name] === undefined);
}

function dedicatedCredentials(env: NodeJS.ProcessEnv): { apiKeyId: string; apiKeySecret: string } | undefined {
  let apiKeyId: string | undefined;
  let apiKeySecret: string | undefined;
  if (env.PCC_FAUCET_CDP_ENV_FILE !== undefined) {
    try {
      for (const line of readFileSync(env.PCC_FAUCET_CDP_ENV_FILE, "utf8").split(/\r?\n/)) {
        const match = /^CDP_API_KEY_(ID|SECRET)=(.*)$/.exec(line.trim());
        if (!match) continue;
        let value = match[2]!.trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        if (match[1] === "ID") apiKeyId = value;
        else apiKeySecret = value;
      }
    } catch {
      return undefined;
    }
  } else {
    apiKeyId = env.PCC_FAUCET_CDP_API_KEY_ID;
    apiKeySecret = env.PCC_FAUCET_CDP_API_KEY_SECRET;
  }
  if (!apiKeyId?.trim() || !apiKeySecret?.trim()) return undefined;
  return { apiKeyId, apiKeySecret };
}

/** Each plugin gets one lazy client; configuration failures expose no source detail. */
export function createFaucetClientProvider(
  env: NodeJS.ProcessEnv = process.env,
  injected?: FaucetClient,
): () => FaucetClient | undefined {
  let initialized = false;
  let client: FaucetClient | undefined;
  return () => {
    if (!isolatedEnvironment(env)) return undefined;
    if (!initialized) {
      initialized = true;
      const credentials = dedicatedCredentials(env);
      if (!credentials) return undefined;
      try {
        const candidate = injected ?? new CdpWalletClient({
          ...credentials, network: "base-sepolia", mock: false,
        });
        if (!candidate.isMock) client = candidate;
      } catch {
        return undefined;
      }
    }
    return client?.isMock ? undefined : client;
  };
}
