/**
 * @pcc/alerts — configuration schema + loader.
 *
 * Mirrors the KERNEL_CONFIG / KERNEL_CONFIG_FILE pattern from @pcc/kernel so
 * operators don't have to learn a second convention.
 *
 * Priority order:
 *   1. ALERTS_CONFIG env var (JSON string)
 *   2. ALERTS_CONFIG_FILE env var (path to JSON file)
 *   3. Built-in empty default (no watchers, no probes, no heartbeats, no notifiers)
 *
 * Author: implementer-alpha
 */

import { readFileSync } from "node:fs";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const severityEnum = z.enum(["info", "warning", "critical"]);

/** One ABI event the chain-watcher should subscribe to. */
const chainEventRuleSchema = z.object({
  /** Event name as it appears in the ABI (e.g. "Released", "Disputed"). */
  name: z.string().min(1),
  /** Severity to fire when this event occurs (absent whitelist match). */
  onFire: severityEnum.default("info"),
  /**
   * Optional whitelist of lowercase caller/actor addresses. If the event has a
   * `caller` (or similar address) arg and it's NOT in the whitelist, the alert
   * is upgraded to `critical` regardless of `onFire`. Useful for release()
   * events that should only come from known oracle addresses.
   */
  whitelist: z.array(z.string()).optional(),
  /**
   * Which event arg name to check against the whitelist. Defaults to "caller".
   * Set to e.g. "from" for transfer-style events.
   */
  whitelistArg: z.string().default("caller"),
});
export type ChainEventRule = z.infer<typeof chainEventRuleSchema>;

const chainWatcherSchema = z.object({
  /** Human label (used in alert titles). */
  label: z.string().min(1),
  /** Chain identifier (e.g. "base-sepolia", "mainnet"). Pass-through to viem. */
  chain: z.string().min(1),
  /** RPC URL for viem createPublicClient. */
  rpcUrl: z.string().url(),
  /** 0x-prefixed contract address. */
  address: z.string().regex(/^0x[a-fA-F0-9]{40}$/, "address must be 0x-prefixed 40-hex"),
  /**
   * ABI (JSON array). Only event entries are used by watchContractEvent, but
   * a full ABI is accepted for convenience.
   */
  abi: z.array(z.unknown()),
  /** Per-event firing rules. */
  events: z.array(chainEventRuleSchema).min(1),
});
export type ChainWatcherConfig = z.infer<typeof chainWatcherSchema>;

const rpcProbeSchema = z.object({
  label: z.string().min(1),
  rpcUrl: z.string().url(),
  chain: z.string().min(1),
  /** Probe frequency in milliseconds. Defaults to 30_000. */
  intervalMs: z.number().int().positive().default(30_000),
  /**
   * p95 latency threshold above which `warning` fires. Defaults to 2000ms.
   * Must be sustained across `consecutiveWindows` rolling windows.
   */
  p95WarnMs: z.number().int().positive().default(2000),
  /**
   * Number of consecutive windows that must breach the threshold before a
   * warning fires. Prevents single-spike false positives.
   */
  consecutiveWindows: z.number().int().positive().default(3),
  /** Number of samples in each rolling window. Defaults to 10. */
  windowSize: z.number().int().positive().default(10),
});
export type RpcProbeConfig = z.infer<typeof rpcProbeSchema>;

const heartbeatSchema = z.object({
  /** Worker identifier (matches the :worker path segment on POST). */
  worker: z.string().min(1),
  /**
   * Max silence in milliseconds before a `critical` alert fires.
   * Defaults to 5 minutes.
   */
  maxSilenceMs: z.number().int().positive().default(5 * 60 * 1000),
});
export type HeartbeatConfig = z.infer<typeof heartbeatSchema>;

const discordNotifierSchema = z.object({
  webhookUrl: z.string().url(),
});
export type DiscordNotifierConfig = z.infer<typeof discordNotifierSchema>;

const notifiersSchema = z.object({
  discord: discordNotifierSchema.optional(),
});
export type NotifiersConfig = z.infer<typeof notifiersSchema>;

export const alertsConfigSchema = z.object({
  /**
   * Fastify bind address. Defaults to 0.0.0.0 (Railway-friendly).
   */
  host: z.string().default("0.0.0.0"),
  /** Fastify port. Defaults to 8787. */
  port: z.number().int().min(1).max(65535).default(8787),
  /**
   * Optional Bearer token required on POST /heartbeat/:worker. If unset,
   * heartbeats are unauthenticated. GET /health is always open.
   */
  heartbeatToken: z.string().optional(),
  /** Ring buffer capacity for GET /alerts/recent. Defaults to 500. */
  ringBufferSize: z.number().int().positive().default(500),
  chainWatchers: z.array(chainWatcherSchema).default([]),
  rpcProbes: z.array(rpcProbeSchema).default([]),
  heartbeats: z.array(heartbeatSchema).default([]),
  notifiers: notifiersSchema.default({}),
});
export type AlertsConfig = z.infer<typeof alertsConfigSchema>;

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

function buildEmptyDefault(): AlertsConfig {
  // All arrays empty, no notifiers — the server will still start and expose
  // /health, which is useful for smoke-testing the deployment before
  // populating config.
  return alertsConfigSchema.parse({});
}

/**
 * Load the alerts configuration.
 *
 * Throws if:
 *   - Inline JSON is malformed
 *   - Config file cannot be read
 *   - Parsed object fails Zod validation
 */
export function loadAlertsConfig(): AlertsConfig {
  const inline = process.env.ALERTS_CONFIG;
  if (inline) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(inline);
    } catch (err) {
      throw new Error(
        `Failed to parse ALERTS_CONFIG env var as JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return alertsConfigSchema.parse(parsed);
  }

  const configFile = process.env.ALERTS_CONFIG_FILE;
  if (configFile) {
    let raw: string;
    try {
      raw = readFileSync(configFile, "utf-8");
    } catch (err) {
      throw new Error(
        `Failed to read ALERTS_CONFIG_FILE "${configFile}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `Failed to parse ALERTS_CONFIG_FILE "${configFile}" as JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return alertsConfigSchema.parse(parsed);
  }

  return buildEmptyDefault();
}
