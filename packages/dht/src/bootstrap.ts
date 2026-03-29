/**
 * Bootstrap node management — well-known nodes to connect to on startup.
 *
 * Operators can extend the list with a local config file.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";

/** Default bootstrap nodes (the PCC gateway acts as a relay) */
export const DEFAULT_BOOTSTRAP_NODES: string[] = [
  "wss://capability.network/ws/dht",
];

/**
 * Load bootstrap nodes from a JSON config file, falling back to defaults.
 *
 * The config file is a simple JSON array of WebSocket URLs:
 * ```json
 * ["wss://my-relay.example.com/ws/dht", "ws://192.168.1.10:9090"]
 * ```
 */
export function loadBootstrapNodes(configPath?: string): string[] {
  if (!configPath) return [...DEFAULT_BOOTSTRAP_NODES];

  try {
    if (!existsSync(configPath)) return [...DEFAULT_BOOTSTRAP_NODES];
    const raw = readFileSync(configPath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [...DEFAULT_BOOTSTRAP_NODES];
    // Filter to strings that look like ws/wss URLs
    const urls = parsed.filter(
      (v): v is string =>
        typeof v === "string" && /^wss?:\/\//i.test(v),
    );
    return urls.length > 0 ? urls : [...DEFAULT_BOOTSTRAP_NODES];
  } catch {
    return [...DEFAULT_BOOTSTRAP_NODES];
  }
}

/**
 * Save bootstrap nodes to a JSON config file.
 */
export function saveBootstrapNodes(
  nodes: string[],
  configPath: string,
): void {
  writeFileSync(configPath, JSON.stringify(nodes, null, 2) + "\n", "utf-8");
}
