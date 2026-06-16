/**
 * Config resolution for the npx CLI.
 *
 * Three sources, in priority order:
 *   1. CLI flags (--api-key, --gateway, --role, --model, --persist)
 *   2. Environment variables (ANTHROPIC_API_KEY, PCC_GATEWAY_URL, etc.)
 *   3. Local config file (~/.pcc/config.json) — written when user opts in
 *
 * The "persist" step only writes when the user explicitly opts in; we never
 * touch ~/.pcc/config.json without consent. ANTHROPIC_API_KEY is treated as
 * a secret in transit (never echoed back to the terminal, never logged).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";

export interface PccOnboardConfig {
  /** Anthropic API key — the LLM that drives the chat. */
  anthropicApiKey?: string;
  /** Base URL of the PCC gateway. Defaults to https://capability.network. */
  gatewayUrl: string;
  /** Model id (defaults to claude-sonnet-4-6). */
  model: string;
  /** Optional bias for the assistant's opening question. */
  role?: "operator" | "buyer" | "machine-owner";
  /** Whether to write the config back to ~/.pcc/config.json after a session. */
  persist: boolean;
}

export const DEFAULT_GATEWAY = "https://capability.network";
export const DEFAULT_MODEL = "claude-sonnet-4-6";

export function getConfigPath(): string {
  return join(homedir(), ".pcc", "config.json");
}

function readConfigFile(): Partial<PccOnboardConfig> {
  const path = getConfigPath();
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as Partial<PccOnboardConfig>;
    return parsed ?? {};
  } catch {
    return {};
  }
}

/** Sanitize-on-write: we never persist `persist` itself, only data. */
export function writeConfigFile(cfg: Partial<PccOnboardConfig>): void {
  const path = getConfigPath();
  mkdirSync(dirname(path), { recursive: true });
  const { persist: _ignore, ...rest } = cfg;
  writeFileSync(path, JSON.stringify(rest, null, 2), { encoding: "utf-8", mode: 0o600 });
}

export interface CliFlags {
  apiKey?: string;
  gateway?: string;
  model?: string;
  role?: PccOnboardConfig["role"];
  persist?: boolean;
}

/**
 * Resolve config from (flags + env + file). Flags win, then env, then file
 * defaults. The returned object is always fully populated (with defaults
 * filled in for gateway/model/persist) so the caller can rely on it.
 */
export function resolveConfig(flags: CliFlags = {}): PccOnboardConfig {
  const fromFile = readConfigFile();
  const fromEnv: Partial<PccOnboardConfig> = {
    anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? undefined,
    gatewayUrl: process.env.PCC_GATEWAY_URL ?? process.env.PCC_URL ?? undefined,
    model: process.env.ANTHROPIC_MODEL ?? undefined,
  };

  return {
    anthropicApiKey: flags.apiKey ?? fromEnv.anthropicApiKey ?? fromFile.anthropicApiKey,
    gatewayUrl: flags.gateway ?? fromEnv.gatewayUrl ?? fromFile.gatewayUrl ?? DEFAULT_GATEWAY,
    model: flags.model ?? fromEnv.model ?? fromFile.model ?? DEFAULT_MODEL,
    role: flags.role ?? fromFile.role,
    persist: flags.persist ?? false,
  };
}

/**
 * Detect whether the current process can prompt the user interactively.
 * Used to decide if we should call into the inquirer-style API-key prompt
 * or just bail with a clear error.
 */
export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/** True when running on Windows. Used to format example commands in the help text. */
export function isWindows(): boolean {
  return platform() === "win32";
}
