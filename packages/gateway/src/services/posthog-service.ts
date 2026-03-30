/**
 * Server-side PostHog analytics for the PCC Gateway.
 *
 * Only active when POSTHOG_API_KEY (or VITE_POSTHOG_KEY) is set in the
 * environment. Uses dynamic ESM import() so the gateway starts cleanly even if
 * posthog-node is not installed.
 */

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

export function trackServerEvent(
  event: string,
  properties?: Record<string, unknown>,
  distinctId?: string,
): void {
  if (!posthog) return;
  try {
    posthog.capture({
      distinctId: distinctId || "pcc-gateway",
      event,
      properties: {
        ...properties,
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
