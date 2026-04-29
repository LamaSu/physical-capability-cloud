/**
 * Approval Live Activity wrapper — Week 6 B5 (v1, one-phase scaffold).
 *
 * Mounts a thin abstraction on top of `capacitor-live-activity`
 * (kisimediaDE) so the rest of the app doesn't bind to the plugin
 * directly. Three goals:
 *
 *   1. Start a Live Activity when an approval-request lands.
 *   2. End the Activity with an outcome string when the user resolves
 *      the request (approve / reject / dismiss).
 *   3. No-op gracefully when the plugin isn't installed (web build,
 *      Android, missing native bits) or when the platform refuses
 *      (iOS user disabled Live Activities, simulator on iOS < 16.1, etc.).
 *
 * What's NOT here yet (deferred to Week 7):
 *   - Phases 2-8 of the UI ladder: status changes, progress bar,
 *     dismiss-action, deep-link to ApprovalSheet, Dynamic Island
 *     compact/expanded/minimal layouts.
 *   - APNs push-update integration (`startActivityWithPush` +
 *     `liveActivityPushToken`).
 *   - Native iOS Widget Extension target. The user must run
 *     `npx cap add ios` from a Mac and add `PCCSessionLiveActivity` as a
 *     Widget Extension target. See README.md for the checklist.
 *
 * Test surface:
 *   - Tests mock the plugin module by setting `__pluginOverride` via
 *     `_setPluginForTests()`. Production resolves the plugin lazily
 *     from `capacitor-live-activity`.
 */

/** Inputs the caller provides when starting an approval activity. */
export interface ApprovalActivityInput {
  /** Session id — used as the logical activity id. */
  id: string;
  /** Capability label for plain-English copy ("haircut", "3D-printing"). */
  capability: string;
  /** USD amount, plain number. The widget side formats as currency. */
  amountUsd: number;
  /** Operator-facing name, e.g. "Andre's Hair Salon". */
  operatorName: string;
  /** Optional ISO-8601 expiry — when set, widget can show a countdown. */
  expiresAt?: string;
}

/**
 * Returned to the caller. Opaque so future versions can swap in
 * push-token-bearing handles without breaking callers.
 */
export interface ApprovalActivityHandle {
  /** Logical id (same as input.id). */
  readonly id: string;
  /**
   * True when the underlying plugin actually started a native activity.
   * False when we no-op'd because the plugin isn't available — callers
   * can treat both as "successful start" since the contract is "fire-and-
   * forget; do not crash the JS path".
   */
  readonly started: boolean;
}

/** Outcome strings recognised by `endApprovalActivity`. */
export type ApprovalActivityOutcome = "approve" | "reject" | "dismiss";

/**
 * Minimal subset of the plugin API we use. Lifted into our own type so
 * (a) we don't depend on a specific package version's TS surface, and
 * (b) tests can mock with a hand-rolled object.
 */
export interface LiveActivityPlugin {
  startActivity(opts: { id: string; data: Record<string, unknown> }): Promise<unknown>;
  updateActivity?(opts: { id: string; data: Record<string, unknown> }): Promise<unknown>;
  endActivity(opts: { id: string; data?: Record<string, unknown> }): Promise<unknown>;
}

// ── Plugin resolution ─────────────────────────────────────────────────

let __pluginOverride: LiveActivityPlugin | null = null;
let __pluginLoaded: { value: LiveActivityPlugin | null } | null = null;

/** Test-only: inject a mock plugin and bypass dynamic resolution. */
export function _setPluginForTests(p: LiveActivityPlugin | null): void {
  __pluginOverride = p;
  __pluginLoaded = null; // force re-resolve next call
}

/**
 * Resolve the plugin without burning the import path at compile time.
 *
 * We intentionally use a string-typed indirection here:
 *   - Vite/Rollup statically analyze direct `import("literal-string")`
 *     calls and try to resolve the package, which fails the bundle
 *     when the optional plugin isn't installed (web build, devs without
 *     iOS toolchain, etc.).
 *   - Routing the specifier through a variable makes the import
 *     opaque to static analysis: the bundler keeps the call as a
 *     runtime resolution attempt that throws cleanly when missing.
 *
 * The result is the SAME runtime behavior — but no bundle-time error
 * when the optional native plugin isn't pulled into the workspace.
 */
const PLUGIN_SPECIFIER = "capacitor-live-activity";

async function resolvePlugin(): Promise<LiveActivityPlugin | null> {
  if (__pluginOverride) return __pluginOverride;
  if (__pluginLoaded) return __pluginLoaded.value;
  try {
    // The variable-routed dynamic import (see comment above).
    const mod = (await import(/* @vite-ignore */ PLUGIN_SPECIFIER)) as {
      LiveActivity?: LiveActivityPlugin;
      default?: LiveActivityPlugin;
    };
    const plugin = mod.LiveActivity ?? mod.default ?? null;
    __pluginLoaded = { value: plugin };
    return plugin;
  } catch {
    __pluginLoaded = { value: null };
    return null;
  }
}

/**
 * Synchronous plugin resolution path used by `startApprovalActivity`.
 * The function is sync because callers (the SSE listener's onApproval
 * callback) want a simple "fire and forget" API. We kick off the plugin
 * call asynchronously and capture errors locally.
 */
function fireStart(input: ApprovalActivityInput): ApprovalActivityHandle {
  const handle: { id: string; started: boolean } = {
    id: input.id,
    started: false,
  };

  // Fire async without awaiting; capture errors so they don't crash the
  // enclosing onApproval callback.
  void (async () => {
    const plugin = await resolvePlugin();
    if (!plugin) return; // graceful no-op, handle.started stays false
    try {
      await plugin.startActivity({
        id: input.id,
        data: {
          capability: input.capability,
          amountUsd: input.amountUsd,
          operatorName: input.operatorName,
          expiresAt: input.expiresAt ?? null,
          phase: "pending", // v1 = single phase
        },
      });
      handle.started = true;
    } catch (err) {
      // Plugin error (e.g. user disabled Live Activities). Log and stay
      // silent — the JS app is still functional.
      // eslint-disable-next-line no-console
      console.warn(
        "[approval-activity] startActivity failed:",
        (err as Error).message,
      );
    }
  })();

  return handle as ApprovalActivityHandle;
}

/**
 * Start a Live Activity for a pending approval-request. Always returns a
 * handle synchronously. The actual native call happens in the background;
 * `handle.started` flips to true once the plugin acknowledges. Callers
 * MUST NOT crash on a handle whose `.started` stays false — that's the
 * graceful no-op path.
 */
export function startApprovalActivity(
  input: ApprovalActivityInput,
): ApprovalActivityHandle {
  return fireStart(input);
}

/**
 * End the Live Activity with an outcome. Same fire-and-forget model as
 * start. Calling end() on a handle whose `.started` is false is a no-op.
 */
export function endApprovalActivity(
  handle: ApprovalActivityHandle,
  opts: { outcome: ApprovalActivityOutcome },
): void {
  void (async () => {
    const plugin = await resolvePlugin();
    if (!plugin) return;
    try {
      await plugin.endActivity({
        id: handle.id,
        data: {
          phase: "ended",
          outcome: opts.outcome,
          endedAt: new Date().toISOString(),
        },
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        "[approval-activity] endActivity failed:",
        (err as Error).message,
      );
    }
  })();
}
