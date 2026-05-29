import { loadSigningKey, type LoadedSigningKey } from "@pcc/a2a-signing";

/**
 * Module-scoped cache of the active agent-card signing key.
 *
 * Loaded once at boot via `initSigningKey()`. If `PCC_AGENT_CARD_SIGNING_KEY`
 * is unset, `_active` stays null and the gateway serves unsigned cards
 * (backwards-compatible with the pre-A2A-v1.0 behavior).
 *
 * Why module-scope: signing a card per request would re-import the PEM
 * each time (a few ms of CPU + key-parsing allocations). One-shot at boot
 * means every card sign is a pure crypto call against an already-parsed
 * KeyLike.
 */
let _active: LoadedSigningKey | null = null;
let _initialised = false;

/**
 * Initialise the signing key once at gateway boot.
 *
 * Safe to call multiple times — subsequent calls are no-ops.
 *
 * If the env var is misconfigured (malformed PEM), this throws. The
 * boot path SHOULD let that propagate — refusing to start the gateway
 * is better than silently serving unsigned cards when an operator
 * intended signing.
 */
export async function initSigningKey(): Promise<void> {
  if (_initialised) return;
  _initialised = true;
  _active = await loadSigningKey();
}

/**
 * Get the currently-loaded signing key, or null if none configured.
 *
 * Returns null until `initSigningKey()` has been awaited at boot, OR
 * if `PCC_AGENT_CARD_SIGNING_KEY` was unset at boot time.
 */
export function getActiveSigningKey(): LoadedSigningKey | null {
  return _active;
}

/**
 * Reset state — testing only.
 */
export function _resetForTests(): void {
  _active = null;
  _initialised = false;
}
