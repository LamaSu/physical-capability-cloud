/**
 * Server-side PostHog analytics for the PCC Gateway.
 *
 * Only active when POSTHOG_API_KEY (or VITE_POSTHOG_KEY) is set in the
 * environment. Uses dynamic ESM import() so the gateway starts cleanly even if
 * posthog-node is not installed.
 */

import { isKnownNodeEnv, logSafeId } from "../redaction.js";
import { consumeServerEventDistinctId, prepareServerEventDistinctId, safeServerEventProperties, safeServerEventDistinctId } from "./posthog-policy.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let posthog: any = null;

function analyticsEnvironment(): string {
  const value = process.env.NODE_ENV;
  return value && isKnownNodeEnv(value) ? value : "unknown";
}

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

export function trackServerEvent(
  event: string,
  properties?: Record<string, unknown>,
  distinctId?: string | ReturnType<typeof prepareServerEventDistinctId>,
): void {
  if (!posthog) return;
  try {
    posthog.capture({
      distinctId: consumeServerEventDistinctId(distinctId),
      event: logSafeId(event),
      properties: {
        ...safeServerEventProperties(properties, event),
        source: "gateway",
        environment: analyticsEnvironment(),
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
 *
 * No-op (silent) when posthog-node is not installed / POSTHOG_API_KEY unset.
 */
export function identifyAgent(
  distinctId: string,
  properties?: Record<string, unknown>,
): void {
  if (!posthog) return;
  try {
    posthog.identify({
      distinctId: safeServerEventDistinctId(distinctId),
      properties: {
        ...safeServerEventProperties(properties),
        kind: "agent_journey",
        source: "gateway",
        environment: analyticsEnvironment(),
      },
    });
  } catch {
    /* never crash on analytics */
  }
}

export function shutdownPostHog(): Promise<void> {
  return posthog?.shutdown?.() ?? Promise.resolve();
}
