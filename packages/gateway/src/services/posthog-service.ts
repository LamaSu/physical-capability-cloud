/**
 * Server-side PostHog analytics for the PCC Gateway.
 *
 * Only active when POSTHOG_API_KEY (or VITE_POSTHOG_KEY) is set in the
 * environment. Uses dynamic ESM import() so the gateway starts cleanly even if
 * posthog-node is not installed.
 *
 * Every event leaves under the closed observability schema (N107b, the PR steward's ruling of
 * 10/03): the distinct id is a keyed hash, the event name a declared name (lit) or its keyed hash,
 * and each property is rebuilt under the closed rules (observability/closed-schema.ts): a declared
 * field as declared, anything else as its keyed hash. No request-controlled value reaches PostHog
 * except as a keyed hash or a coarse class, whatever a producer passes.
 */
import { closedId, closedText, closeValue, type Declared } from "../observability/closed-schema.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let posthog: any = null;

export function initPostHog(): void {
  const apiKey =
    process.env.POSTHOG_API_KEY || process.env.VITE_POSTHOG_KEY;
  if (!apiKey) return;
  // Fire-and-forget async init — gateway stays up even if import fails
  void (async () => {
    try {
      const { PostHog } = await import("posthog-node");
      posthog = new PostHog(apiKey, { host: "https://us.i.posthog.com" });
      console.log("[posthog] Server-side analytics initialised");
    } catch {
      /* posthog-node not installed — silent degrade */
    }
  })();
}

/** The gateway's own distinct id, which no caller supplies. */
const GATEWAY_ID = "pcc-gateway";

const closedProperties = (properties: Record<string, unknown> | undefined) =>
  (closeValue(properties ?? {}, 1) ?? {}) as Record<string, unknown>;

export function trackServerEvent(
  event: string | Declared,
  properties?: Record<string, unknown>,
  distinctId?: string | Declared,
): void {
  if (!posthog) return;
  try {
    posthog.capture({
      distinctId: distinctId ? closedId(distinctId) : GATEWAY_ID,
      event: closedText(event),
      properties: {
        ...closedProperties(properties),
        source: "gateway",
        environment: process.env.NODE_ENV,
      },
    });
  } catch {
    /* never crash on analytics */
  }
}

/**
 * Anchor a PostHog person profile for an agent journey.
 *
 * PostHog funnel *conversion* requires identified events — anonymous
 * `capture()` alone under-counts. The funnel tracker (observability piece 4)
 * calls this once, at the `provision` stage, with distinctId = trace_id so
 * the subsequent `onboarding_*` events drive the funnel chart correctly.
 * The distinct id leaves as the same keyed hash trackServerEvent sends, so they still join.
 *
 * No-op (silent) when posthog-node is not installed / POSTHOG_API_KEY unset.
 */
export function identifyAgent(
  distinctId: string | Declared,
  properties?: Record<string, unknown>,
): void {
  if (!posthog) return;
  try {
    posthog.identify({
      distinctId: closedId(distinctId),
      properties: {
        ...closedProperties(properties),
        kind: "agent_journey",
        source: "gateway",
        environment: process.env.NODE_ENV,
      },
    });
  } catch {
    /* never crash on analytics */
  }
}

export function shutdownPostHog(): Promise<void> {
  return posthog?.shutdown?.() ?? Promise.resolve();
}
