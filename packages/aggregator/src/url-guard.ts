/**
 * URL guard — SSRF prevention for source-adapter fetches.
 *
 * The MCP and OpenAPI adapters take a user-controlled URL and call fetch()
 * on it. Without a guard, an attacker can point the aggregator at internal
 * services (cloud metadata, RFC-1918 hosts, link-local, loopback) and
 * exfiltrate data via the fetched response.
 *
 * This module exposes `assertSafeFetchUrl(url)` which validates the URL
 * against an allow list of public-internet hosts. Adapters must call it
 * BEFORE the `fetch()` and let `SSRFRejected` bubble for telemetry.
 *
 * Rules (sync, IP-literal only):
 *   - Must parse as a URL.
 *   - Scheme must be `https:` (or `http:` only for localhost / 127.0.0.1
 *     during dev + unit tests).
 *   - No credentials in the URL (`user:pass@host`).
 *   - Host must not be in any private/internal range:
 *       - 10.0.0.0/8                  RFC-1918
 *       - 172.16.0.0/12               RFC-1918
 *       - 192.168.0.0/16              RFC-1918
 *       - 169.254.0.0/16              link-local + AWS/GCP/Azure metadata
 *       - 127.0.0.0/8                 loopback (except literal 127.0.0.1 for tests)
 *       - 0.0.0.0/8                   "this network"
 *       - 100.64.0.0/10               carrier-grade NAT
 *       - 224.0.0.0/4                 multicast
 *       - 240.0.0.0/4                 reserved
 *       - ::1                         IPv6 loopback
 *       - fc00::/7                    IPv6 unique local
 *       - fe80::/10                   IPv6 link-local
 *       - ::ffff:0:0/96 wrapped IPv4  IPv4-mapped IPv6 (route through IPv4 check)
 *
 * For hostnames (not IP literals), an optional DNS resolver callback can
 * be supplied to do a real lookup at runtime. Unit tests pass a no-op
 * resolver so the check is hermetic.
 *
 * Throws `SSRFRejected` on any rejection. The error message names the
 * specific rule that fired so the telemetry pipeline can group failures.
 */

/** Thrown when a URL fails the SSRF guard. */
export class SSRFRejected extends Error {
  constructor(
    public readonly reason: string,
    public readonly rawUrl: string,
  ) {
    super(`SSRF guard rejected URL (${reason}): ${rawUrl}`);
    this.name = "SSRFRejected";
  }
}

/** Optional injectable resolver. Returns IPv4/IPv6 strings for a host. */
export type HostResolver = (host: string) => Promise<string[]>;

/**
 * Options for {@link assertSafeFetchUrl}.
 *
 * `allowLocalhostHttp` defaults to TRUE so that local dev + unit tests
 * can hit `http://localhost/...` and `http://127.0.0.1/...`. Production
 * callers that want to reject http even for localhost should pass
 * `false` explicitly.
 *
 * `resolver` is unused in this synchronous helper; the async variant
 * `assertSafeFetchUrlWithDns` accepts it for real DNS rebinding defense.
 */
export interface UrlGuardOptions {
  allowLocalhostHttp?: boolean;
}

/**
 * Validate a URL against the SSRF guard rules (synchronous IP-literal check).
 *
 * @returns the parsed URL on success.
 * @throws SSRFRejected on any rule violation.
 */
export function assertSafeFetchUrl(
  url: string,
  options: UrlGuardOptions = {},
): URL {
  const allowLocalhostHttp = options.allowLocalhostHttp ?? true;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SSRFRejected("invalid-url", url);
  }

  // Credentials in URL — always reject.
  if (parsed.username || parsed.password) {
    throw new SSRFRejected("credentials-in-url", url);
  }

  // Scheme allow list.
  const scheme = parsed.protocol.toLowerCase();
  const host = parsed.hostname.toLowerCase();
  if (scheme === "http:") {
    if (!allowLocalhostHttp || !isLocalhostHost(host)) {
      throw new SSRFRejected("http-not-allowed", url);
    }
  } else if (scheme !== "https:") {
    throw new SSRFRejected(`scheme-not-allowed:${scheme}`, url);
  }

  // Host check.
  if (!host) {
    throw new SSRFRejected("empty-host", url);
  }

  // IP-literal check.
  const ipReason = classifyHostAsBlockedIp(host);
  if (ipReason) {
    // Allow literal localhost only when allowLocalhostHttp is on. Even
    // when allowed, we already required http above; https on 127.0.0.1
    // is also fine.
    if (
      allowLocalhostHttp &&
      (host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1")
    ) {
      return parsed;
    }
    throw new SSRFRejected(`blocked-ip:${ipReason}`, url);
  }

  // For hostnames we cannot resolve synchronously here without async DNS.
  // Reject obvious metadata-service hostnames; the async variant does
  // real DNS lookup.
  if (isMetadataHostname(host)) {
    throw new SSRFRejected("metadata-hostname", url);
  }

  return parsed;
}

/**
 * Async variant with DNS resolution. Use in production code paths where
 * DNS rebinding is a real concern.
 *
 * For every A/AAAA record the host resolves to, the same IP-literal
 * check is applied. ANY private/internal IP causes a rejection.
 */
export async function assertSafeFetchUrlWithDns(
  url: string,
  resolver: HostResolver,
  options: UrlGuardOptions = {},
): Promise<URL> {
  const parsed = assertSafeFetchUrl(url, options);
  const host = parsed.hostname.toLowerCase();

  // If it's an IP literal we've already validated it. Done.
  if (isIpLiteral(host)) return parsed;

  // Only resolve real hostnames.
  let addrs: string[];
  try {
    addrs = await resolver(host);
  } catch (err) {
    throw new SSRFRejected(
      `dns-resolution-failed:${(err as Error).message}`,
      url,
    );
  }

  for (const addr of addrs) {
    const reason = classifyHostAsBlockedIp(addr.toLowerCase());
    if (reason) {
      throw new SSRFRejected(`dns-rebind:${reason}:${addr}`, url);
    }
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isLocalhostHost(host: string): boolean {
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "[::1]" ||
    host === "::1"
  );
}

/** Hostnames that always point at cloud-provider metadata services. */
function isMetadataHostname(host: string): boolean {
  return (
    host === "metadata.google.internal" ||
    host === "metadata" ||
    host.endsWith(".internal") ||
    host.endsWith(".local")
  );
}

/**
 * Return the rule name if the host is a blocked IP literal, or null if
 * the host either isn't an IP literal or is a public IP.
 */
function classifyHostAsBlockedIp(host: string): string | null {
  // Strip brackets from IPv6 literals: [::1]
  const stripped = host.startsWith("[") && host.endsWith("]")
    ? host.slice(1, -1)
    : host;

  if (isIpv4Literal(stripped)) {
    return classifyIpv4(stripped);
  }
  if (isIpv6Literal(stripped)) {
    return classifyIpv6(stripped);
  }
  return null;
}

function isIpLiteral(host: string): boolean {
  const stripped = host.startsWith("[") && host.endsWith("]")
    ? host.slice(1, -1)
    : host;
  return isIpv4Literal(stripped) || isIpv6Literal(stripped);
}

function isIpv4Literal(host: string): boolean {
  return /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(host);
}

function isIpv6Literal(host: string): boolean {
  // Conservative IPv6 check — accepts compressed forms.
  return host.includes(":") && /^[0-9a-fA-F:]+$/.test(host);
}

/**
 * Return a rule name if the IPv4 is private/internal, or null if it's
 * a normal public address.
 */
function classifyIpv4(ip: string): string | null {
  const parts = ip.split(".").map((s) => parseInt(s, 10));
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
    // Not actually a valid IPv4 — treat as blocked to be safe.
    return "invalid-ipv4";
  }
  const [a, b] = parts as [number, number, number, number];

  // 0.0.0.0/8 — "this network"
  if (a === 0) return "zero-network";

  // 10.0.0.0/8
  if (a === 10) return "rfc1918-10/8";

  // 100.64.0.0/10 — carrier-grade NAT
  if (a === 100 && b >= 64 && b <= 127) return "cgnat";

  // 127.0.0.0/8 — loopback (allow literal 127.0.0.1; classifier still flags it,
  // caller handles whitelist separately)
  if (a === 127) return "loopback";

  // 169.254.0.0/16 — link-local (covers metadata services on cloud providers)
  if (a === 169 && b === 254) return "link-local";

  // 172.16.0.0/12 — RFC-1918
  if (a === 172 && b >= 16 && b <= 31) return "rfc1918-172.16/12";

  // 192.168.0.0/16 — RFC-1918
  if (a === 192 && b === 168) return "rfc1918-192.168/16";

  // 224.0.0.0/4 — multicast
  if (a >= 224 && a <= 239) return "multicast";

  // 240.0.0.0/4 — reserved
  if (a >= 240) return "reserved";

  return null;
}

/**
 * Return a rule name if the IPv6 is private/internal/loopback, else null.
 */
function classifyIpv6(ip: string): string | null {
  const lower = ip.toLowerCase();
  if (lower === "::1") return "ipv6-loopback";
  if (lower === "::" || lower.startsWith("::0")) return "ipv6-unspecified";

  // IPv4-mapped IPv6 (dotted-quad form): ::ffff:a.b.c.d — re-route to IPv4 classifier.
  const v4MappedDotted = lower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4MappedDotted) {
    const inner = classifyIpv4(v4MappedDotted[1]!);
    return inner ? `ipv4-mapped:${inner}` : null;
  }

  // IPv4-mapped IPv6 (compressed hex form): ::ffff:HHHH:HHHH
  // The URL constructor normalizes [::ffff:10.0.0.1] → [::ffff:a00:1], so we
  // must also catch the hex-collapsed shape and decode the trailing 32 bits.
  const v4MappedHex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (v4MappedHex) {
    const hi = parseInt(v4MappedHex[1]!, 16);
    const lo = parseInt(v4MappedHex[2]!, 16);
    if (!Number.isNaN(hi) && !Number.isNaN(lo)) {
      const a = (hi >> 8) & 0xff;
      const b = hi & 0xff;
      const c = (lo >> 8) & 0xff;
      const d = lo & 0xff;
      const dotted = `${a}.${b}.${c}.${d}`;
      const inner = classifyIpv4(dotted);
      return inner ? `ipv4-mapped:${inner}` : null;
    }
  }

  // fc00::/7 — unique local
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return "ipv6-unique-local";

  // fe80::/10 — link-local
  if (/^fe[89ab][0-9a-f]:/.test(lower)) return "ipv6-link-local";

  // ff00::/8 — multicast
  if (/^ff[0-9a-f]{2}:/.test(lower)) return "ipv6-multicast";

  return null;
}
