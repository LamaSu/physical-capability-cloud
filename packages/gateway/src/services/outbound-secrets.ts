import { Sentry } from "../sentry.js";

// Credential-bearing RPC endpoints stay in memory only. Match their request
// targets and long credential components when SDK error formatting extracts them.
const secretTargets = new Set<string>();
const secretTokens = new Set<string>();

export function registerOutboundSecretUrl(value: string): void {
  try {
    const url = new URL(value);
    secretTargets.add(url.origin + url.pathname);
    for (const token of [...url.pathname.split("/"), ...url.searchParams.values()]) {
      if (token.length >= 16) secretTokens.add(token);
    }
  } catch {
    // Refused configuration is never used for an outbound request.
  }
}

export function isOutboundSecretUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  for (const target of secretTargets) if (value.includes(target)) return true;
  for (const token of secretTokens) if (value.includes(token)) return true;
  return false;
}

// Kept here so sentry.ts needs only a first-statement guard in its event hook.
export function isOutboundSecretSentryEvent(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const event = value as {
    request?: { url?: unknown };
    message?: unknown;
    exception?: { values?: Array<{ value?: unknown }> };
  };
  return [event.request?.url, event.message, ...(event.exception?.values ?? []).map(item => item.value)]
    .some(isOutboundSecretUrl);
}

export function withSuppressedTracing<T>(fn: () => T): T {
  return Sentry.suppressTracing(fn);
}
