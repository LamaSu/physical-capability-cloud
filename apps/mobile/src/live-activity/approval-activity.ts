/**
 * Approval Live Activity wrapper — Week 6 B5 (scaffold) + Week 8 (Phases 2/3/4/5/8).
 *
 * Mounts a thin abstraction on top of `capacitor-live-activity`
 * (kisimediaDE) so the rest of the app doesn't bind to the plugin
 * directly. Five goals:
 *
 *   1. Start a Live Activity when an approval-request lands.
 *   2. Update the Live Activity content state (phase, progress, ETA) so the
 *      iOS lock-screen / Dynamic Island UI keeps the user informed.
 *   3. End the Activity with an outcome string (approve / reject / dismiss /
 *      expired) when the user resolves the request or the timeout fires.
 *   4. Surface tap / dismiss callbacks so App.tsx can re-open the
 *      ApprovalSheet (tap) or quietly end the activity locally (dismiss
 *      from lock-screen).
 *   5. No-op gracefully when the plugin isn't installed (web build,
 *      Android, missing native bits) or when the platform refuses
 *      (iOS user disabled Live Activities, simulator on iOS < 16.1, etc.).
 *
 * Mac-required Phases (deferred to a Mac session):
 *   - Phase 6: Dynamic Island compact / expanded / minimal layouts (SwiftUI).
 *   - Phase 7: APNs `liveactivity` push-update payloads + push token registration.
 *
 * Test surface:
 *   - Tests mock the plugin module by setting `__pluginOverride` via
 *     `_setPluginForTests()`. Production resolves the plugin lazily
 *     from `capacitor-live-activity`.
 *   - The notify* helpers below let App.tsx tests simulate OS taps /
 *     dismisses without requiring a real iOS event bridge.
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
  started: boolean;
}

/** Outcome strings recognised by `endApprovalActivity`. */
export type ApprovalActivityOutcome =
  | "approve"
  | "reject"
  | "dismiss"
  | "expired";

/**
 * Phase ladder for the iOS Live Activity content state. Drives the
 * visible status copy on the lock-screen / Dynamic Island. Driven from
 * App.tsx as the user / network progresses through the approval flow.
 *
 *   waiting   → request landed; user has not yet decided.
 *   approved  → user tapped approve + biometric signed; gateway POST
 *               in flight.
 *   settling  → gateway accepted the decision; the centralized-settle
 *               path is running (ledger release + signed receipt).
 *   done      → terminal. Activity is ending with an outcome.
 */
export type ApprovalActivityPhase =
  | "waiting"
  | "approved"
  | "settling"
  | "done";

/**
 * Content-state delta applied via `updateApprovalActivity`. All fields
 * are optional — callers update only what changed and the wrapper
 * forwards exactly that to the plugin's `updateActivity` so the iOS
 * widget can re-render with merged content state on its side.
 *
 * NOTE: keep this minimal. Each field added is one more thing the
 * SwiftUI widget must understand. v1 ships phase + progress + eta.
 */
export interface ApprovalActivityContentState {
  /** Phase ladder transition. */
  phase?: ApprovalActivityPhase;
  /** 0..1 progress for the settling phase. Clamped at the wrapper. */
  progress?: number;
  /** Estimated seconds remaining for whichever phase is active. */
  etaSeconds?: number;
  /** ISO-8601 expiry refresh (rare — usually set at start time). */
  expiresAt?: string;
}

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

// ── Tap / dismiss callback registry (Phase 4) ─────────────────────────
//
// iOS surfaces two OS-level interactions on a Live Activity:
//   - Tap: opens the host app and (when configured with a deep-link)
//     navigates to a path like `pcc-mobile://approval/<sessionId>`.
//   - Dismiss: user swipes the activity off the lock-screen / Dynamic
//     Island. The activity ends locally without a user decision.
//
// On the JS side we expose two registries that App.tsx subscribes to.
// Production native bridge (Mac-required) will dispatch to these via a
// Capacitor event listener; for v1 mobile-side only and tests, the
// `notifyActivityTap` / `notifyActivityDismiss` helpers below are the
// dispatch surface.
//
// Multiple subscribers are allowed (defensive — one App.tsx instance per
// process in practice, but tests may stack subscribers across runs).

type TapCallback = (id: string) => void;
type DismissCallback = (id: string) => void;

const __tapSubscribers = new Set<TapCallback>();
const __dismissSubscribers = new Set<DismissCallback>();

/**
 * Subscribe to OS-level tap events on a running Live Activity. Returns
 * an unsubscribe function. App.tsx calls this once on mount and uses
 * the callback to re-open the ApprovalSheet for the tapped session.
 */
export function onApprovalActivityTap(cb: TapCallback): () => void {
  __tapSubscribers.add(cb);
  return () => __tapSubscribers.delete(cb);
}

/**
 * Subscribe to OS-level dismiss events (user swipes the activity away).
 * App.tsx ends the activity locally; the W6 server-side approval
 * timeout will catch it server-side.
 */
export function onApprovalActivityDismiss(cb: DismissCallback): () => void {
  __dismissSubscribers.add(cb);
  return () => __dismissSubscribers.delete(cb);
}

/**
 * Test / native-bridge helper: dispatch a tap event for a given session
 * id. In production the native bridge calls this from a Capacitor
 * event handler; in tests the simulated tap is invoked directly.
 */
export function notifyActivityTap(id: string): void {
  for (const cb of __tapSubscribers) {
    try {
      cb(id);
    } catch {
      // Subscriber threw — swallow, don't crash other subscribers.
    }
  }
}

/** Test / native-bridge helper: dispatch a dismiss event for an activity. */
export function notifyActivityDismiss(id: string): void {
  for (const cb of __dismissSubscribers) {
    try {
      cb(id);
    } catch {
      // Subscriber threw — swallow.
    }
  }
}

/** Test-only: clear the tap / dismiss subscriber lists. */
export function _clearActivityCallbacksForTests(): void {
  __tapSubscribers.clear();
  __dismissSubscribers.clear();
}

// ── Public lifecycle: start / update / end ────────────────────────────

/**
 * Synchronous plugin resolution path used by `startApprovalActivity`.
 * The function is sync because callers (the SSE listener's onApproval
 * callback) want a simple "fire and forget" API. We kick off the plugin
 * call asynchronously and capture errors locally.
 */
function fireStart(input: ApprovalActivityInput): ApprovalActivityHandle {
  const handle: ApprovalActivityHandle = {
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
          // W8 Phase 2: start at "waiting". updateApprovalActivity will
          // walk this up to approved → settling → done as the user /
          // server progress through the flow.
          phase: "waiting",
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

  return handle;
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
 * Apply a content-state delta to a running Live Activity (W8 Phase 2/3).
 *
 * Same fire-and-forget contract as start/end. Calling on a handle whose
 * `.started` is false is harmless: we still attempt the plugin call,
 * which is a no-op when the plugin is missing. We do NOT branch on
 * `started` because the plugin may have completed startActivity after
 * this update was queued; the plugin itself is the ground truth.
 *
 * Optional fields are omitted from the payload when undefined so the
 * widget side can merge non-destructively. The plugin is responsible
 * for calling `updateActivity` only when implemented (kisimediaDE
 * 7.x exposes it via the optional `updateActivity` method); when the
 * plugin doesn't have updateActivity at all, the wrapper still no-ops
 * without throwing.
 */
export function updateApprovalActivity(
  handle: ApprovalActivityHandle,
  contentState: ApprovalActivityContentState,
): void {
  void (async () => {
    const plugin = await resolvePlugin();
    if (!plugin) return; // plugin missing → no-op
    if (typeof plugin.updateActivity !== "function") {
      // Plugin doesn't expose updateActivity. Older versions of
      // kisimediaDE/capacitor-live-activity may not implement it; we
      // log once and bail rather than crashing.
      // eslint-disable-next-line no-console
      console.warn(
        "[approval-activity] updateActivity not supported by plugin; skipping update",
      );
      return;
    }
    // Build the payload, omitting undefined keys so the widget merges.
    const data: Record<string, unknown> = {};
    if (contentState.phase !== undefined) data.phase = contentState.phase;
    if (contentState.progress !== undefined) {
      // Clamp 0..1 here so the widget can trust the wire shape.
      const p = Math.max(0, Math.min(1, contentState.progress));
      data.progress = p;
    }
    if (contentState.etaSeconds !== undefined) {
      data.etaSeconds = Math.max(0, Math.floor(contentState.etaSeconds));
    }
    if (contentState.expiresAt !== undefined) {
      data.expiresAt = contentState.expiresAt;
    }
    // Don't issue an empty-payload update — wastes a native round-trip
    // for nothing. Skip silently.
    if (Object.keys(data).length === 0) return;

    try {
      await plugin.updateActivity({ id: handle.id, data });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        "[approval-activity] updateActivity failed:",
        (err as Error).message,
      );
    }
  })();
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
          phase: "done",
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
