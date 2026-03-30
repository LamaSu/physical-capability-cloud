/**
 * Tool Manifest Service
 *
 * Loads and caches device tool manifests. Provides helpers to check
 * whether a tool is safe (no execution scope needed) for a given
 * device type.
 *
 * Manifest resolution order:
 *   1. In-memory cache (hot path)
 *   2. Bundled manifests from @pcc/spec/tool-manifests
 *   3. Fallback to "generic" manifest for unknown device types
 */

import type { DeviceToolManifest } from "@pcc/spec";

// Lazy-loaded bundled manifests from @pcc/spec
let _bundledManifests: Record<string, DeviceToolManifest> | null = null;

async function loadBundledManifests(): Promise<Record<string, DeviceToolManifest>> {
  if (_bundledManifests) return _bundledManifests;
  try {
    const mod = await import("@pcc/spec/tool-manifests");
    _bundledManifests = mod.BUNDLED_MANIFESTS;
  } catch {
    // If the spec package tool-manifests entry isn't built yet, fall back to empty
    _bundledManifests = {};
  }
  return _bundledManifests;
}

/** Cache of resolved manifests */
const manifestCache = new Map<string, DeviceToolManifest>();

/**
 * Get the tool manifest for a device type.
 * Returns the generic manifest if the device type is unknown.
 */
export async function getManifest(deviceType: string): Promise<DeviceToolManifest | null> {
  // 1. Check cache
  if (manifestCache.has(deviceType)) {
    return manifestCache.get(deviceType)!;
  }

  // 2. Load bundled manifests
  const bundled = await loadBundledManifests();
  const manifest = bundled[deviceType] ?? null;

  if (manifest) {
    manifestCache.set(deviceType, manifest);
    return manifest;
  }

  // 3. Fall back to generic
  const generic = bundled["generic"] ?? null;
  if (generic) {
    manifestCache.set(deviceType, generic);
  }
  return generic;
}

/**
 * Synchronous variant for hot paths.
 * Only returns a result if manifests have already been loaded via getManifest().
 * Falls back to empty safe-tools if not yet loaded.
 */
export function getManifestSync(deviceType: string): DeviceToolManifest | null {
  if (manifestCache.has(deviceType)) {
    return manifestCache.get(deviceType)!;
  }
  if (_bundledManifests) {
    const manifest = _bundledManifests[deviceType] ?? _bundledManifests["generic"] ?? null;
    if (manifest) {
      manifestCache.set(deviceType, manifest);
    }
    return manifest;
  }
  return null;
}

/** Get safe tool names for a device type (synchronous, best-effort) */
export function getSafeTools(deviceType: string): string[] {
  const manifest = getManifestSync(deviceType);
  return manifest?.safeTools ?? [];
}

/** Check if a specific tool is safe (no scope needed) for a device type */
export function isToolSafe(deviceType: string, toolName: string): boolean {
  return getSafeTools(deviceType).includes(toolName);
}

/**
 * Pre-warm the manifest cache. Call once at startup so that
 * synchronous lookups work immediately.
 */
export async function warmManifestCache(): Promise<void> {
  const bundled = await loadBundledManifests();
  for (const [key, manifest] of Object.entries(bundled)) {
    manifestCache.set(key, manifest);
  }
}

/** Clear the manifest cache (for testing) */
export function clearManifestCache(): void {
  manifestCache.clear();
  _bundledManifests = null;
}
