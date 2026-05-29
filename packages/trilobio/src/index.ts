/**
 * @pcc/trilobio — Trilobio (tcode-api) configuration helpers for PCC operators.
 *
 * Trilobio sells the "trilobot" lab automation platform: a fleet controller
 * orchestrating pipettes, robots, and labware. Scripts written against the
 * `tcode-api` Python SDK (https://github.com/trilobio/tcode-api) execute on
 * the fleet controller and exercise commands like ASPIRATE, DISPENSE,
 * ADD_LABWARE, CALIBRATE_LABWARE_HEIGHT, etc.
 *
 * The Trilobio adapter implementation lives in `@pcc/kernel` and is
 * instantiated by the kernel runtime when KERNEL_CONFIG declares
 * `adapterType: "trilobio"`. This package provides:
 *
 *   - `buildTrilobioConfig()`         — generate a valid KERNEL_CONFIG JSON
 *   - `validateTrilobioOptions()`     — sanity-check operator config before submit
 *   - `validateTcodeScript()`         — quick lint of a tcode-api Python script
 *   - `TRILOBIO_CAPABILITY`           — capability template for /api/capabilities
 *   - Type definitions for the operator-facing config shape
 *
 * For the full operator setup recipe (install, config, troubleshooting), see
 * the README in this package directory.
 *
 * tcode-api reference:
 *   Source:        https://github.com/trilobio/tcode-api
 *   API docs:      https://tcode.trilo.bio/
 *   Install:       uv add git+https://github.com/trilobio/tcode-api.git
 */

/** Operator-supplied configuration for a single Trilobio fleet controller. */
export interface TrilobioOperatorOptions {
  /** Fleet-controller URL on the LAN, e.g. `http://192.168.1.50` (no trailing slash, no path) */
  url: string;
  /** Trilobio fleet-controller API key (from the trilobot admin UI) */
  apiKey?: string;
  /** Fleet-controller account username — only required if the controller is in basic-auth mode */
  username?: string;
  /** Fleet-controller account password — only required if the controller is in basic-auth mode */
  password?: string;
  /** Kernel ID this device belongs to (auto-generated if omitted) */
  kernelId?: string;
  /** Logical device ID within the kernel (default `trilobio-fleet-01`) */
  deviceId?: string;
  /**
   * Pinned tcode-api version the operator's fleet controller is running
   * (informational; surfaces in evidence bundles for reproducibility).
   * Format: semver, e.g. `1.25.1`. Default: `latest`.
   */
  tcodeApiVersion?: string;
  /** Mock mode — bypasses real HTTP, simulates runs. Use for CI / demos. */
  mockMode?: boolean;
  /** Poll interval in ms for run status — default 3000 */
  pollIntervalMs?: number;
  /** Maximum allowed wall-clock seconds for a single tcode script — default 3600 (1 hour) */
  maxScriptTimeoutSec?: number;
  /** Mock-mode simulated run duration (ms) — default 2000 */
  mockRunDurationMs?: number;
  /**
   * Whether the operator allows arbitrary operator-supplied tcode scripts
   * to be executed (true), or only protocol IDs from a curated library (false).
   * Default: false (curated only) — safer default for shared operators.
   */
  allowArbitraryScripts?: boolean;
}

/** Shape of a KERNEL_CONFIG fragment that registers exactly one Trilobio device. */
export interface TrilobioKernelConfig {
  kernelId: string;
  devices: Array<{
    id: string;
    type: "machine";
    adapterType: "trilobio";
    config: {
      url: string;
      apiKey?: string;
      username?: string;
      password?: string;
      kernelId: string;
      tcodeApiVersion: string;
      mockMode: boolean;
      pollIntervalMs: number;
      maxScriptTimeoutSec: number;
      mockRunDurationMs: number;
      allowArbitraryScripts: boolean;
    };
  }>;
}

/** Result shape from `validateTrilobioOptions` and `validateTcodeScript`. */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings?: string[];
}

/**
 * Generate a complete KERNEL_CONFIG JSON registering a Trilobio fleet
 * controller with a kernel. Pass to `pcc-node start` via the
 * `KERNEL_CONFIG` env var, or hand to `/api/setup/generate-config` /
 * `/api/setup/register-device` for direct API-driven registration.
 *
 * @example
 * ```ts
 * import { buildTrilobioConfig } from "@pcc/trilobio";
 *
 * const config = buildTrilobioConfig({
 *   url: "http://192.168.1.50",
 *   apiKey: process.env.TRILOBIO_API_KEY!,
 * });
 *
 * // → KERNEL_CONFIG=$JSON pcc-node start
 * ```
 */
export function buildTrilobioConfig(opts: TrilobioOperatorOptions): TrilobioKernelConfig {
  const kernelId = opts.kernelId ?? `kernel_trilobio_${Date.now()}`;
  const deviceId = opts.deviceId ?? "trilobio-fleet-01";
  return {
    kernelId,
    devices: [
      {
        id: deviceId,
        type: "machine",
        adapterType: "trilobio",
        config: {
          url: opts.url,
          apiKey: opts.apiKey,
          username: opts.username,
          password: opts.password,
          kernelId,
          tcodeApiVersion: opts.tcodeApiVersion ?? "latest",
          mockMode: opts.mockMode ?? false,
          pollIntervalMs: opts.pollIntervalMs ?? 3000,
          maxScriptTimeoutSec: opts.maxScriptTimeoutSec ?? 3600,
          mockRunDurationMs: opts.mockRunDurationMs ?? 2000,
          allowArbitraryScripts: opts.allowArbitraryScripts ?? false,
        },
      },
    ],
  };
}

/**
 * Sanity-check operator-supplied options before generating a KERNEL_CONFIG.
 * Catches the most common mistakes (missing creds, malformed URL,
 * out-of-range timeouts) before they hit the gateway or the device.
 */
export function validateTrilobioOptions(
  opts: Partial<TrilobioOperatorOptions>,
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!opts.url) {
    errors.push("url is required (e.g. http://192.168.1.50)");
  } else if (!/^https?:\/\/[^/]+(:\d+)?$/.test(opts.url)) {
    errors.push(
      "url must be host[:port] with no trailing slash and no path (e.g. http://192.168.1.50, http://192.168.1.50:8080)",
    );
  }

  if (!opts.mockMode) {
    const hasApiKey = Boolean(opts.apiKey);
    const hasBasicAuth = Boolean(opts.username && opts.password);
    if (!hasApiKey && !hasBasicAuth) {
      errors.push(
        "either apiKey is required, or both username and password must be set (Trilobio fleet-controller auth)",
      );
    }
    if (hasApiKey && hasBasicAuth) {
      warnings.push(
        "apiKey AND username/password supplied — apiKey will be used; basic-auth is ignored",
      );
    }
  }

  if (opts.pollIntervalMs !== undefined) {
    if (opts.pollIntervalMs < 500 || opts.pollIntervalMs > 60000) {
      errors.push("pollIntervalMs must be between 500 and 60000");
    }
  }

  if (opts.maxScriptTimeoutSec !== undefined) {
    if (opts.maxScriptTimeoutSec < 30 || opts.maxScriptTimeoutSec > 86400) {
      errors.push("maxScriptTimeoutSec must be between 30 and 86400 (1 day)");
    }
  }

  if (opts.tcodeApiVersion && opts.tcodeApiVersion !== "latest") {
    if (!/^\d+\.\d+\.\d+(-[a-zA-Z0-9.-]+)?$/.test(opts.tcodeApiVersion)) {
      errors.push(
        `tcodeApiVersion must be 'latest' or semver (e.g. 1.25.1) — got '${opts.tcodeApiVersion}'`,
      );
    }
  }

  if (opts.allowArbitraryScripts === true) {
    warnings.push(
      "allowArbitraryScripts=true permits arbitrary operator-supplied Python on this device. Sandbox / review carefully — this disables the curated-protocol-only safeguard.",
    );
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

/**
 * Quick lint of a tcode-api Python script before submission. This is a
 * defensive surface check — it is NOT a sandbox or sanitizer. It looks for:
 *
 *   - imports of `tcode_api` (presence required)
 *   - obviously dangerous statements (subprocess, os.system, eval, exec, __import__, open(...,'w'))
 *   - empty or whitespace-only scripts
 *   - missing top-level command (no recognizable tcode call)
 *
 * Operators with `allowArbitraryScripts=true` should treat this as a hint,
 * not a guarantee. The fleet controller is the source of truth on safety.
 */
export function validateTcodeScript(source: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const trimmed = source.trim();
  if (trimmed.length === 0) {
    errors.push("script is empty");
    return { valid: false, errors };
  }

  const importsTcode =
    /\bfrom\s+tcode_api\b/.test(source) || /\bimport\s+tcode_api\b/.test(source);
  if (!importsTcode) {
    errors.push("script does not import tcode_api — not a valid tcode-api script");
  }

  const dangerousPatterns: Array<[RegExp, string]> = [
    [/\bsubprocess\b/, "subprocess module"],
    [/\bos\.system\b/, "os.system call"],
    [/\bos\.popen\b/, "os.popen call"],
    [/\beval\s*\(/, "eval() call"],
    [/\bexec\s*\(/, "exec() call"],
    [/\b__import__\s*\(/, "__import__() call"],
    [/\bsocket\b/, "socket module"],
    [/\burllib\b/, "urllib module"],
    [/\brequests\b/, "requests module"],
    [/\bopen\s*\([^)]*['"]w['"]/, "open(...,'w') write"],
    [/\bopen\s*\([^)]*['"]a['"]/, "open(...,'a') append"],
  ];

  for (const [pattern, label] of dangerousPatterns) {
    if (pattern.test(source)) {
      warnings.push(`script contains ${label} — review before allowing on shared hardware`);
    }
  }

  const hasTcodeCall =
    /\b(ASPIRATE|DISPENSE|ADD_LABWARE|ADD_PIPETTE_TIP_GROUP|ADD_ROBOT|ADD_TOOL|CALIBRATE_LABWARE_HEIGHT|CALIBRATE_LABWARE_HOLDER|CALIBRATE_LABWARE_WELL_DEPTH|MOVE|PICK_UP_TIP|DROP_TIP|MIX|HOME|run_script|run_protocol)\b/.test(
      source,
    );
  if (!hasTcodeCall) {
    warnings.push(
      "script imports tcode_api but no recognizable tcode command call was found — confirm this is intentional",
    );
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

/**
 * Default capability template for a Trilobio fleet controller. Pass to
 * `POST /api/capabilities` to publish a baseline liquid-handling capability
 * for a kernel hosting one of these instruments. Operators can extend the
 * `materials` and `capabilities` arrays to advertise instrument-specific
 * features (e.g. their custom labware library, sample types they handle).
 *
 * Notable difference from `HAMILTON_PREP_CAPABILITY`: trilobot exposes
 * `tcode-script-execution` as a capability — operators can accept jobs
 * that ship a full tcode-api Python script as the protocol payload, not
 * just a parameterized template ID.
 */
export const TRILOBIO_CAPABILITY = {
  type: "liquid-handler",
  subType: "trilobio-trilobot",
  manufacturer: "Trilobio",
  model: "Trilobot fleet",
  materials: [
    "aqueous-buffer",
    "dna",
    "rna",
    "protein",
    "cells",
    "media",
    "reagent",
    "small-molecule",
  ],
  capabilities: [
    "pipetting",
    "plate-reformat",
    "dilution",
    "normalization",
    "hit-picking",
    "serial-dilution",
    "custom-labware-calibration",
    "tcode-script-execution",
  ],
  assuranceTiers: [0, 1, 2],
} as const;

export type TrilobioCapability = typeof TRILOBIO_CAPABILITY;
