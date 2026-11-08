import { readFileSync } from "node:fs";

/** Computed reads in gateway only; other packages' computed reads are out of scope. */
export const COMPUTED_READS: { names: string[]; prefixes: string[] } = {
  names: [
    // mcp/mcp-api-base.ts: process.env[MCP_API_BASE_ENV]
    "PCC_API_BASE_URL",
    // mcp/mcp-app-view.ts: process.env[MCP_APP_DOMAIN_ENV]
    "PCC_MCP_APP_DOMAIN",
    // mcp/mcp-app-view.ts: process.env[envVarOverride], including docs-mcp-server.ts callers
    "PCC_UI_KIT_PATH", "PCC_IR_KIT_PATH", "PCC_DASHBOARD_SCHEMA_PATH",
    "PCC_DOC_AGENT_GUIDE_PATH", "PCC_DOC_QUICKSTART_PATH",
    // routes/operator-channels.ts: process.env[CHANNEL_CREDENTIALS_ENV]
    "PCC_CHANNEL_CREDENTIALS",
    // routes/setup.ts: process.env[v.name], the ENV_VAR_CHECKS keys
    "PCC_NETWORK", "PCC_GATEWAY_PRIVATE_KEY", "ESCROW_CONTRACT_ADDRESS",
    "ENTRY_POINT_ADDRESS", "KERNEL_FACTORY_ADDRESS", "PAYMASTER_ADDRESS",
    "PORT", "NODE_ENV", "PCC_DB_PATH", "KERNEL_CONFIG", "KERNEL_CONFIG_FILE",
    "KERNEL_ID", "EVIDENCE_STORAGE", "STORACHA_PROOF", "STORACHA_SPACE_DID",
    "LIT_PROTOCOL_REAL", "STARKNET_ACCOUNT_ADDRESS", "STARKNET_PRIVATE_KEY",
    "STARKNET_NETWORK", "X402_ENABLED", "X402_FACILITATOR_URL", "SERVE_DASHBOARD",
    // services/wallet-faucet/client.ts: env[name] and process.env[name], GENERAL_CDP_NAMES
    "CDP_API_KEY_ID", "CDP_API_KEY_NAME", "CDP_API_KEY_SECRET", "CDP_WALLET_SECRET",
  ],
  prefixes: [
    // routes/operator-channels.ts: process.env[`PCC_VAULT_${vaultKeyFor(ref)}`]
    "PCC_VAULT_",
  ],
};

/** Deliberately scans comments too: overcounting can only hide a stale name. */
export function scanEnvReadText(text: string): Set<string> {
  const names = new Set<string>();
  const access = /(?<![\w$])(?:(process\s*\.\s*)?env)\s*(?:\.\s*([A-Za-z_][A-Za-z0-9_]*)|\[\s*(?:"([A-Za-z_][A-Za-z0-9_]*)"|'([A-Za-z_][A-Za-z0-9_]*)'|`([A-Za-z_][A-Za-z0-9_]*)`)\s*\])/g;
  for (const match of text.matchAll(access)) {
    const name = match[2] ?? match[3] ?? match[4] ?? match[5];
    if (match[1] || /^[A-Z_][A-Z0-9_]*$/.test(name)) names.add(name);
  }
  for (const match of text.matchAll(/\{([^{}]*)\}\s*=\s*(?:process\s*\.\s*)?env\b/g)) {
    for (const field of match[1].split(",")) {
      const key = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?=[:=]|$)/.exec(field)?.[1];
      if (key) names.add(key);
    }
  }
  return names;
}

export const ENV_READS_FILE = "/app/ENV_READS.json";
type EnvReads = { names: Set<string>; prefixes: string[] };
let loaded = false;
let cached: EnvReads | null = null;

function load(reader: (path: string) => string | null): EnvReads | null {
  try {
    const raw = reader(ENV_READS_FILE);
    if (raw === null) return null;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const o = value as Record<string, unknown>;
    const validNames = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(s));
    if (Object.keys(o).sort().join(",") !== "names,prefixes,spec" || o.spec !== "pcc.env-reads/v1" || !validNames(o.names) || !validNames(o.prefixes)) return null;
    return { names: new Set(o.names), prefixes: [...new Set(o.prefixes)] };
  } catch {
    return null; // Never expose parser/reader error text.
  }
}

/** The image file is immutable. Injected readers bypass the process cache for tests. */
export function readEnvReads(readFile?: (path: string) => string | null): EnvReads | null {
  if (readFile) return load(readFile);
  if (!loaded) {
    cached = load((path) => readFileSync(path, "utf8"));
    loaded = true;
  }
  return cached;
}
