/**
 * org-watch — the projection behind contract (b), `GET /org/watch`: an
 * AG-UI-compliant SSE stream of `org.*` events as STATE_SNAPSHOT /
 * STATE_DELTA / CUSTOM{name:"org.*"} frames
 * (ai/research/unified-control-plane/UI-COORDINATION.md §9.1-9.2).
 *
 * SEAM, NOT IMPLEMENTATION: the harness exports real AG-UI frame factories
 * at `~/.claude/lib/genui/{agui-events.js,agui-job.js}` (re-exported as
 * `contracts.js`'s `factories`). This package does NOT import that path —
 * it lives outside this repo entirely, and a package meant to be built/
 * tested/published from `packages/coordination/` must not hard-depend on an
 * absolute filesystem path into a harness install. Instead, this module
 * defines {@link OrgWatchFrameFactory} — the shape the harness's real
 * factories already satisfy — and ships {@link stubFrameFactory}, a
 * dependency-free implementation that produces "valid-enough" frames (same
 * `type`/`timestamp` envelope AG-UI events use) so `watchOrgEvents` is
 * useful stand-alone today. A consumer that HAS the harness factories
 * available wires them in with zero changes here:
 *
 *   import { factories } from '<path-to>/lib/genui/contracts.js';
 *   watchOrgEvents(bus, onFrame, { frameFactory: {
 *     stateSnapshot: (s) => factories.ev('STATE_SNAPSHOT', { snapshot: s }),
 *     stateDelta:    (d) => factories.ev('STATE_DELTA', { delta: d }),
 *     custom:        (name, payload) => factories.ev('CUSTOM', { name, value: payload }),
 *   }});
 */

import type { OrgBus, OrgBusUnsubscribe } from "./org-bus.js";
import { ORG_SUBJECTS } from "./org-bus.js";

/** A minimal AG-UI-shaped frame. Real AG-UI events carry more envelope
 *  fields (see ai/research/ag-ui/AG-UI-TECHNICAL-REFERENCE.md) — those are
 *  the harness frame factories' job to add; this type only guarantees the
 *  two fields a `GET /org/watch` route needs to serialize an SSE chunk. */
export interface AguiFrame {
  readonly type: "STATE_SNAPSHOT" | "STATE_DELTA" | "CUSTOM";
  readonly timestamp: string;
  readonly [key: string]: unknown;
}

export interface OrgWatchFrameFactory {
  /** A full-state snapshot frame. */
  stateSnapshot(snapshot: unknown): AguiFrame;
  /** An incremental delta frame. */
  stateDelta(ops: readonly unknown[]): AguiFrame;
  /** A named custom event frame — every `org.*` subject rides here (the
   *  spec's `CUSTOM{name:"org.*"}` requirement). */
  custom(name: string, payload: unknown): AguiFrame;
}

/** Dependency-free default. See module docblock for the swap-in-the-real-
 *  factories pattern. */
export const stubFrameFactory: OrgWatchFrameFactory = {
  stateSnapshot: (snapshot) => ({ type: "STATE_SNAPSHOT", timestamp: new Date().toISOString(), snapshot }),
  stateDelta: (ops) => ({ type: "STATE_DELTA", timestamp: new Date().toISOString(), delta: ops }),
  custom: (name, payload) => ({ type: "CUSTOM", timestamp: new Date().toISOString(), name, value: payload }),
};

export interface OrgWatchOptions {
  frameFactory?: OrgWatchFrameFactory;
}

/**
 * Subscribe to every `org.*` subject and project each event through the
 * frameFactory. Returns an unsubscribe function.
 *
 * This is the seam a `GET /org/watch` route wraps: for every frame handed
 * to `onFrame`, the route writes an SSE chunk
 * (`event: message\ndata: ${JSON.stringify(frame)}\n\n` or whatever wire
 * format the real `@ag-ui/core` encoder expects — plug that encoder in via
 * `frameFactory`, not here; this function only owns the org.* -> frame
 * projection, never the transport).
 */
export async function watchOrgEvents(
  bus: OrgBus,
  onFrame: (frame: AguiFrame) => void,
  opts: OrgWatchOptions = {},
): Promise<OrgBusUnsubscribe> {
  const factory = opts.frameFactory ?? stubFrameFactory;
  const subjects = Object.values(ORG_SUBJECTS);
  const unsubs: OrgBusUnsubscribe[] = [];
  for (const subject of subjects) {
    // eslint-disable-next-line no-await-in-loop -- subscriptions must be
    // registered before this function returns; order across subjects
    // doesn't matter, so sequential await here keeps the unsub list simple.
    const unsub = await bus.subscribe(subject, (event) => {
      onFrame(factory.custom(event.subject, event.payload));
    });
    unsubs.push(unsub);
  }
  return async () => {
    await Promise.all(unsubs.map((u) => u()));
  };
}
