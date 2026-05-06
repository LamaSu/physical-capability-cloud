/**
 * @pcc/hamilton — Hamilton ML Prep configuration helpers for PCC operators.
 *
 * The Hamilton adapter implementation lives in `@pcc/kernel` and is
 * instantiated by the kernel runtime when KERNEL_CONFIG declares
 * `adapterType: "hamilton"`. This package provides:
 *
 *   - `buildHamiltonConfig()`      — generate a valid KERNEL_CONFIG JSON
 *   - `validateHamiltonOptions()`  — sanity-check operator config before submit
 *   - `HAMILTON_PREP_CAPABILITY`   — capability template for /api/capabilities
 *   - Type definitions for the operator-facing config shape
 *
 * For the full operator setup recipe (install, config, troubleshooting), see
 * the README in this package directory.
 *
 * Hamilton API reference:
 *   https://developer.hamiltoncompany.com/products/prep/api/openapi
 */

/** Operator-supplied configuration for a single Hamilton ML Prep instrument. */
export interface HamiltonOperatorOptions {
  /** Instrument URL on the LAN, e.g. `http://192.168.1.50` (no trailing slash, no path) */
  url: string;
  /** Hamilton account username (used for JWT login at POST /api/v1/authenticate) */
  username: string;
  /** Hamilton account password */
  password: string;
  /** Kernel ID this device belongs to (auto-generated if omitted) */
  kernelId?: string;
  /** Logical device ID within the kernel (default `hamilton-prep-01`) */
  deviceId?: string;
  /** Mock mode — bypasses real HTTP, simulates runs. Use for CI / demos. */
  mockMode?: boolean;
  /** Poll interval in ms for run status — default 3000 */
  pollIntervalMs?: number;
  /** Refresh JWT this many seconds before expiry — default 60 */
  refreshLeadSeconds?: number;
  /** Mock-mode simulated run duration (ms) — default 2000 */
  mockRunDurationMs?: number;
}

/** Shape of a KERNEL_CONFIG fragment that registers exactly one Hamilton device. */
export interface HamiltonKernelConfig {
  kernelId: string;
  devices: Array<{
    id: string;
    type: "machine";
    adapterType: "hamilton";
    config: {
      url: string;
      username: string;
      password: string;
      kernelId: string;
      mockMode: boolean;
      pollIntervalMs: number;
      refreshLeadSeconds: number;
      mockRunDurationMs: number;
    };
  }>;
}

/** Result shape from `validateHamiltonOptions`. */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Generate a complete KERNEL_CONFIG JSON registering a Hamilton ML Prep
 * instrument with a kernel. Pass to `pcc-node start` via the
 * `KERNEL_CONFIG` env var, or hand to `/api/setup/generate-config` /
 * `/api/setup/register-device` for direct API-driven registration.
 *
 * @example
 * ```ts
 * import { buildHamiltonConfig } from "@pcc/hamilton";
 *
 * const config = buildHamiltonConfig({
 *   url: "http://192.168.1.50",
 *   username: "alice",
 *   password: process.env.HAMILTON_PASSWORD!,
 * });
 *
 * // → KERNEL_CONFIG=$JSON pcc-node start
 * ```
 */
export function buildHamiltonConfig(opts: HamiltonOperatorOptions): HamiltonKernelConfig {
  const kernelId = opts.kernelId ?? `kernel_hamilton_${Date.now()}`;
  const deviceId = opts.deviceId ?? "hamilton-prep-01";
  return {
    kernelId,
    devices: [
      {
        id: deviceId,
        type: "machine",
        adapterType: "hamilton",
        config: {
          url: opts.url,
          username: opts.username,
          password: opts.password,
          kernelId,
          mockMode: opts.mockMode ?? false,
          pollIntervalMs: opts.pollIntervalMs ?? 3000,
          refreshLeadSeconds: opts.refreshLeadSeconds ?? 60,
          mockRunDurationMs: opts.mockRunDurationMs ?? 2000,
        },
      },
    ],
  };
}

/**
 * Sanity-check operator-supplied options before generating a KERNEL_CONFIG.
 * Catches the most common mistakes (missing creds, malformed URL,
 * out-of-range poll intervals) before they hit the gateway or the device.
 */
export function validateHamiltonOptions(
  opts: Partial<HamiltonOperatorOptions>,
): ValidationResult {
  const errors: string[] = [];

  if (!opts.url) {
    errors.push("url is required (e.g. http://192.168.1.50)");
  } else if (!/^https?:\/\/[^/]+(:\d+)?$/.test(opts.url)) {
    errors.push(
      "url must be host[:port] with no trailing slash and no path (e.g. http://192.168.1.50, http://192.168.1.50:8080)",
    );
  }

  if (!opts.mockMode) {
    if (!opts.username) errors.push("username is required (Hamilton account login)");
    if (!opts.password) errors.push("password is required (Hamilton account password)");
  }

  if (opts.pollIntervalMs !== undefined) {
    if (opts.pollIntervalMs < 500 || opts.pollIntervalMs > 60000) {
      errors.push("pollIntervalMs must be between 500 and 60000");
    }
  }

  if (opts.refreshLeadSeconds !== undefined) {
    if (opts.refreshLeadSeconds < 5 || opts.refreshLeadSeconds > 600) {
      errors.push("refreshLeadSeconds must be between 5 and 600");
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Default capability template for a Hamilton ML Prep instrument. Pass to
 * `POST /api/capabilities` to publish a baseline liquid-handling capability
 * for a kernel hosting one of these instruments. Operators can extend the
 * `materials` and `capabilities` arrays to advertise instrument-specific
 * features (e.g. their custom protocol library, sample types they handle).
 */
export const HAMILTON_PREP_CAPABILITY = {
  type: "liquid-handler",
  subType: "hamilton-ml-prep",
  manufacturer: "Hamilton Robotics",
  model: "Microlab Prep",
  materials: [
    "aqueous-buffer",
    "dna",
    "rna",
    "protein",
    "cells",
    "media",
    "reagent",
  ],
  capabilities: [
    "pipetting",
    "plate-reformat",
    "dilution",
    "normalization",
    "hit-picking",
    "serial-dilution",
  ],
  assuranceTiers: [0, 1, 2],
} as const;

export type HamiltonPrepCapability = typeof HAMILTON_PREP_CAPABILITY;
