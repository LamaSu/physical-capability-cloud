import { isIP } from "node:net";

/** Resolve a bind address without changing the all-interface default. */
export function resolveListenHost(value: string | undefined): string {
  const host = value?.trim();
  if (!host) return "0.0.0.0";
  if (isIP(host)) return host;

  // DNS labels: ASCII letters, digits and interior hyphens; optional root dot.
  const hostname = host.endsWith(".") ? host.slice(0, -1) : host;
  const validHostname = hostname.length <= 253
    && !/^[\d.]+$/.test(hostname)
    && hostname.split(".").every((label) =>
      /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label),
    );
  if (validHostname) return host;

  throw new Error(`Invalid HOST ${JSON.stringify(value)}: expected an IPv4 literal, IPv6 literal or hostname`);
}
