/**
 * Analytics Proxy Routes -- server-side proxy for PostHog, Sentry, and GA4 APIs.
 *
 * GET /api/analytics/status       -> Which analytics sources are configured
 * GET /api/analytics/overview     -> Aggregated overview from all available sources
 * GET /api/analytics/traffic      -> Time series pageviews / visitors for charts
 * GET /api/analytics/pages        -> Top pages by views
 * GET /api/analytics/events       -> Custom event breakdown (non-$ events)
 * GET /api/analytics/errors       -> Sentry issues and error stats
 * GET /api/analytics/devices      -> Browser, OS, device type breakdown
 * GET /api/analytics/geography    -> Country breakdown
 */

import type { FastifyInstance } from "fastify";

// ---------------------------------------------------------------------------
// Environment helpers
// ---------------------------------------------------------------------------

function getPostHogConfig() {
  const personalApiKey = process.env.POSTHOG_PERSONAL_API_KEY ?? null;
  const projectId = process.env.POSTHOG_PROJECT_ID ?? null;
  const projectKey =
    process.env.POSTHOG_API_KEY ?? process.env.VITE_POSTHOG_KEY ?? null;
  const configured = Boolean(projectKey) || Boolean(personalApiKey);
  const canQuery = Boolean(personalApiKey) && Boolean(projectId);
  return { personalApiKey, projectId, projectKey, configured, canQuery };
}

function getSentryConfig() {
  const authToken = process.env.SENTRY_AUTH_TOKEN ?? null;
  const org = process.env.SENTRY_ORG ?? null;
  const project = process.env.SENTRY_PROJECT ?? null;
  const configured = Boolean(authToken);
  const canQuery = Boolean(authToken) && Boolean(org) && Boolean(project);
  return { authToken, org, project, configured, canQuery };
}

function getGA4Config() {
  const measurementId =
    process.env.GA4_MEASUREMENT_ID ?? process.env.VITE_GA_MEASUREMENT_ID ?? null;
  const apiSecret = process.env.GA4_API_SECRET ?? null;
  const propertyId = process.env.GA4_PROPERTY_ID ?? null;
  const configured = Boolean(measurementId);
  const hasApiSecret = Boolean(apiSecret);
  return { measurementId, apiSecret, propertyId, configured, hasApiSecret };
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

function defaultRange(from?: string, to?: string): { from: string; to: string } {
  const now = new Date();
  const toDate = to ?? now.toISOString().slice(0, 10);
  const fromDate =
    from ?? new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return { from: fromDate, to: toDate };
}

/** Convert from/to YYYY-MM-DD into Sentry statsPeriod. Sentry only accepts "24h" or "14d". */
function toSentryStatsPeriod(from: string, to: string): string {
  try {
    const diffMs = new Date(to).getTime() - new Date(from).getTime();
    const days = Math.max(1, Math.round(diffMs / (24 * 60 * 60 * 1000)));
    return days <= 1 ? "24h" : "14d";
  } catch {
    return "14d";
  }
}

// ---------------------------------------------------------------------------
// Simple in-memory cache (1 minute TTL)
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 10_000; // 10s — event-night fast refresh
const cache = new Map<string, { data: unknown; ts: number }>();

function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.ts < CACHE_TTL_MS) {
    return Promise.resolve(entry.data as T);
  }
  return fn().then((data) => {
    cache.set(key, { data, ts: Date.now() });
    return data;
  });
}

// ---------------------------------------------------------------------------
// PostHog HogQL helper
// ---------------------------------------------------------------------------

interface HogQLResult {
  columns: string[];
  results: unknown[][];
}

async function posthogQuery(hogql: string): Promise<HogQLResult> {
  const { personalApiKey, projectId } = getPostHogConfig();
  if (!personalApiKey || !projectId) {
    throw new Error("PostHog not configured for querying");
  }

  const resp = await fetch(
    `https://us.posthog.com/api/projects/${projectId}/query/`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${personalApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: { kind: "HogQLQuery", query: hogql } }),
    },
  );

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`PostHog API ${resp.status}: ${text.slice(0, 200)}`);
  }

  const body = (await resp.json()) as HogQLResult;
  return { columns: body.columns ?? [], results: body.results ?? [] };
}

// ---------------------------------------------------------------------------
// Sentry helper
// ---------------------------------------------------------------------------

async function sentryGet<T = unknown>(path: string): Promise<T> {
  const { authToken } = getSentryConfig();
  if (!authToken) {
    throw new Error("Sentry not configured");
  }

  const base = authToken.startsWith("sntrys_") ? "https://us.sentry.io" : "https://sentry.io";
  const resp = await fetch(`${base}${path}`, {
    headers: { Authorization: `Bearer ${authToken}` },
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Sentry API ${resp.status}: ${text.slice(0, 200)}`);
  }

  return resp.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export async function analyticsRoutes(app: FastifyInstance) {
  // -------------------------------------------------------------------------
  // GET /api/analytics/status
  // -------------------------------------------------------------------------

  app.get("/api/analytics/status", async () => {
    const ph = getPostHogConfig();
    const sentry = getSentryConfig();
    const ga4 = getGA4Config();

    const parts: string[] = [];
    if (ph.canQuery) parts.push("PostHog (query)");
    else if (ph.configured) parts.push("PostHog (id only)");
    if (sentry.canQuery) parts.push("Sentry");
    if (ga4.configured) parts.push("GA4");

    return {
      posthog: {
        configured: ph.configured,
        canQuery: ph.canQuery,
        projectId: ph.projectId,
      },
      sentry: {
        configured: sentry.configured,
        canQuery: sentry.canQuery,
        org: sentry.org,
        project: sentry.project,
      },
      ga4: {
        configured: ga4.configured,
        measurementId: ga4.measurementId,
        hasApiSecret: ga4.hasApiSecret,
      },
      message:
        parts.length > 0
          ? `Active sources: ${parts.join(", ")}`
          : "No analytics sources configured",
    };
  });

  // -------------------------------------------------------------------------
  // GET /api/analytics/overview
  // -------------------------------------------------------------------------

  app.get("/api/analytics/overview", async (request) => {
    const qs = request.query as { from?: string; to?: string };
    const range = defaultRange(qs.from, qs.to);
    const ph = getPostHogConfig();
    const sentry = getSentryConfig();
    const ga4 = getGA4Config();

    // PostHog ------------------------------------------------------------------
    type PHResult = {
      available: boolean;
      totalEvents: number;
      uniquePersons: number;
      pageviews: number;
      topEvents: { name: string; count: number }[];
      error?: string;
    };

    const posthogData: PHResult = await (async (): Promise<PHResult> => {
      if (!ph.canQuery) {
        return { available: false, totalEvents: 0, uniquePersons: 0, pageviews: 0, topEvents: [] };
      }
      try {
        return await cached(`overview:ph:${range.from}:${range.to}`, async () => {
          const [totals, topEvents, pageviews] = await Promise.all([
            posthogQuery(
              `SELECT count() as total_events, count(DISTINCT person_id) as unique_persons ` +
                `FROM events WHERE timestamp >= '${range.from}' AND timestamp <= '${range.to} 23:59:59'`,
            ),
            posthogQuery(
              `SELECT event as name, count() as cnt FROM events ` +
                `WHERE timestamp >= '${range.from}' AND timestamp <= '${range.to} 23:59:59' ` +
                `GROUP BY name ORDER BY cnt DESC LIMIT 10`,
            ),
            posthogQuery(
              `SELECT count() as pageviews FROM events ` +
                `WHERE event = '$pageview' AND timestamp >= '${range.from}' AND timestamp <= '${range.to} 23:59:59'`,
            ),
          ]);

          return {
            available: true,
            totalEvents: Number(totals.results[0]?.[0] ?? 0),
            uniquePersons: Number(totals.results[0]?.[1] ?? 0),
            pageviews: Number(pageviews.results[0]?.[0] ?? 0),
            topEvents: topEvents.results.map((r) => ({
              name: String(r[0] ?? ""),
              count: Number(r[1] ?? 0),
            })),
          };
        });
      } catch (err) {
        return {
          available: false,
          totalEvents: 0,
          uniquePersons: 0,
          pageviews: 0,
          topEvents: [],
          error: err instanceof Error ? err.message : String(err),
        };
      }
    })();

    // Sentry -------------------------------------------------------------------
    type SentryResult = {
      available: boolean;
      totalIssues: number;
      unresolvedIssues: number;
      issues: { id: string; title: string; count: number; level: string; firstSeen: string; lastSeen: string }[];
      error?: string;
    };

    const sentryData: SentryResult = await (async (): Promise<SentryResult> => {
      if (!sentry.canQuery) {
        return { available: false, totalIssues: 0, unresolvedIssues: 0, issues: [] };
      }
      try {
        return await cached(`overview:sentry:${range.from}:${range.to}`, async () => {
          const period = toSentryStatsPeriod(range.from, range.to);
          const issues = await sentryGet<
            { id: string; title: string; count: string; level: string; firstSeen: string; lastSeen: string; status?: string }[]
          >(
            `/api/0/projects/${sentry.org}/${sentry.project}/issues/?statsPeriod=${period}&limit=25`,
          );

          const unresolvedIssues = issues.filter((i) => i.status !== "resolved");

          return {
            available: true,
            totalIssues: issues.length,
            unresolvedIssues: unresolvedIssues.length,
            issues: issues.map((i) => ({
              id: i.id,
              title: i.title,
              count: Number(i.count ?? 0),
              level: i.level,
              firstSeen: i.firstSeen,
              lastSeen: i.lastSeen,
            })),
          };
        });
      } catch (err) {
        return {
          available: false,
          totalIssues: 0,
          unresolvedIssues: 0,
          issues: [],
          error: err instanceof Error ? err.message : String(err),
        };
      }
    })();

    // GA4 (placeholder) --------------------------------------------------------
    type GA4Result = { available: boolean; error?: string };
    const ga4Data: GA4Result = ga4.configured
      ? { available: true }
      : { available: false, error: "GA4 not configured" };

    return {
      dateRange: range,
      posthog: posthogData,
      sentry: sentryData,
      ga4: ga4Data,
    };
  });

  // -------------------------------------------------------------------------
  // GET /api/analytics/traffic
  // -------------------------------------------------------------------------

  app.get("/api/analytics/traffic", async (request) => {
    const qs = request.query as { from?: string; to?: string; interval?: string };
    const range = defaultRange(qs.from, qs.to);
    const interval = qs.interval === "hour" ? "hour" : "day";
    const ph = getPostHogConfig();

    if (!ph.canQuery) {
      return { series: [] };
    }

    try {
      return await cached(`traffic:${range.from}:${range.to}:${interval}`, async () => {
        const timeExpr =
          interval === "hour"
            ? "toStartOfHour(timestamp)"
            : "toDate(timestamp)";

        const result = await posthogQuery(
          `SELECT ${timeExpr} as period, ` +
            `count() as events, ` +
            `countIf(event = '$pageview') as pageviews, ` +
            `count(DISTINCT person_id) as visitors ` +
            `FROM events ` +
            `WHERE timestamp >= '${range.from}' AND timestamp <= '${range.to} 23:59:59' ` +
            `GROUP BY period ORDER BY period`,
        );

        return {
          series: result.results.map((r) => ({
            date: String(r[0] ?? ""),
            pageviews: Number(r[2] ?? 0),
            visitors: Number(r[3] ?? 0),
            events: Number(r[1] ?? 0),
          })),
        };
      });
    } catch (err) {
      return {
        series: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/analytics/pages
  // -------------------------------------------------------------------------

  app.get("/api/analytics/pages", async (request) => {
    const qs = request.query as { from?: string; to?: string };
    const range = defaultRange(qs.from, qs.to);
    const ph = getPostHogConfig();

    if (!ph.canQuery) {
      return { pages: [] };
    }

    try {
      return await cached(`pages:${range.from}:${range.to}`, async () => {
        const result = await posthogQuery(
          `SELECT properties.$current_url as url, count() as views, count(DISTINCT person_id) as unique_visitors ` +
            `FROM events ` +
            `WHERE event = '$pageview' AND timestamp >= '${range.from}' AND timestamp <= '${range.to} 23:59:59' ` +
            `GROUP BY url ORDER BY views DESC LIMIT 20`,
        );

        return {
          pages: result.results.map((r) => {
            const rawUrl = String(r[0] ?? "");
            let path = rawUrl;
            try {
              path = new URL(rawUrl).pathname;
            } catch {
              // Not a valid URL -- use raw value as path
            }
            return {
              url: rawUrl,
              path,
              views: Number(r[1] ?? 0),
              uniqueVisitors: Number(r[2] ?? 0),
            };
          }),
        };
      });
    } catch (err) {
      return {
        pages: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/analytics/events
  // -------------------------------------------------------------------------

  app.get("/api/analytics/events", async (request) => {
    const qs = request.query as { from?: string; to?: string };
    const range = defaultRange(qs.from, qs.to);
    const ph = getPostHogConfig();

    if (!ph.canQuery) {
      return { events: [] };
    }

    try {
      return await cached(`events:${range.from}:${range.to}`, async () => {
        const result = await posthogQuery(
          `SELECT event as name, count() as total, count(DISTINCT person_id) as unique_users ` +
            `FROM events ` +
            `WHERE event NOT LIKE '$%' AND timestamp >= '${range.from}' AND timestamp <= '${range.to} 23:59:59' ` +
            `GROUP BY name ORDER BY total DESC LIMIT 30`,
        );

        return {
          events: result.results.map((r) => ({
            name: String(r[0] ?? ""),
            count: Number(r[1] ?? 0),
            uniqueUsers: Number(r[2] ?? 0),
          })),
        };
      });
    } catch (err) {
      return {
        events: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/analytics/errors
  // -------------------------------------------------------------------------

  app.get("/api/analytics/errors", async (request) => {
    const qs = request.query as { from?: string; to?: string };
    const range = defaultRange(qs.from, qs.to);
    const sentry = getSentryConfig();

    if (!sentry.canQuery) {
      return { issues: [], errorSeries: [], totalErrors: 0 };
    }

    try {
      return await cached(`errors:${range.from}:${range.to}`, async () => {
        const period = toSentryStatsPeriod(range.from, range.to);

        const [issues, stats] = await Promise.all([
          sentryGet<
            {
              id: string;
              title: string;
              count: string;
              level: string;
              firstSeen: string;
              lastSeen: string;
              shortId: string;
            }[]
          >(
            `/api/0/projects/${sentry.org}/${sentry.project}/issues/?query=is:unresolved&sort=freq&statsPeriod=${period}&limit=25`,
          ),
          sentryGet<{
            intervals: string[];
            groups: { totals: { "sum(quantity)": number }; series: { "sum(quantity)": number[] } }[];
          }>(
            `/api/0/organizations/${sentry.org}/stats_v2/?field=sum(quantity)&category=error&interval=1d&statsPeriod=${period}`,
          ),
        ]);

        const intervals = stats.intervals ?? [];
        const seriesData = stats.groups?.[0]?.series?.["sum(quantity)"] ?? [];
        const errorSeries = intervals.map((ts: string, i: number) => ({
          date: ts.slice(0, 10),
          count: seriesData[i] ?? 0,
        }));
        const totalErrors = errorSeries.reduce((sum: number, s: { count: number }) => sum + s.count, 0);

        return {
          issues: issues.map((i) => ({
            id: i.id,
            title: i.title,
            count: Number(i.count ?? 0),
            level: i.level,
            firstSeen: i.firstSeen,
            lastSeen: i.lastSeen,
            shortId: i.shortId ?? i.id,
          })),
          errorSeries,
          totalErrors,
        };
      });
    } catch (err) {
      return {
        issues: [],
        errorSeries: [],
        totalErrors: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/analytics/devices
  // -------------------------------------------------------------------------

  app.get("/api/analytics/devices", async (request) => {
    const qs = request.query as { from?: string; to?: string };
    const range = defaultRange(qs.from, qs.to);
    const ph = getPostHogConfig();

    if (!ph.canQuery) {
      return { browsers: [], os: [], devices: [] };
    }

    try {
      return await cached(`devices:${range.from}:${range.to}`, async () => {
        const where = `event = '$pageview' AND timestamp >= '${range.from}' AND timestamp <= '${range.to} 23:59:59'`;

        const [browsers, osData, deviceTypes] = await Promise.all([
          posthogQuery(
            `SELECT properties.$browser as browser, count() as cnt ` +
              `FROM events WHERE ${where} GROUP BY browser ORDER BY cnt DESC LIMIT 10`,
          ),
          posthogQuery(
            `SELECT properties.$os as os, count() as cnt ` +
              `FROM events WHERE ${where} GROUP BY os ORDER BY cnt DESC LIMIT 10`,
          ),
          posthogQuery(
            `SELECT properties.$device_type as device_type, count() as cnt ` +
              `FROM events WHERE ${where} GROUP BY device_type ORDER BY cnt DESC LIMIT 10`,
          ),
        ]);

        return {
          browsers: browsers.results.map((r) => ({
            name: String(r[0] ?? "Unknown"),
            count: Number(r[1] ?? 0),
          })),
          os: osData.results.map((r) => ({
            name: String(r[0] ?? "Unknown"),
            count: Number(r[1] ?? 0),
          })),
          devices: deviceTypes.results.map((r) => ({
            type: String(r[0] ?? "Unknown"),
            count: Number(r[1] ?? 0),
          })),
        };
      });
    } catch (err) {
      return {
        browsers: [],
        os: [],
        devices: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/analytics/geography
  // -------------------------------------------------------------------------

  app.get("/api/analytics/geography", async (request) => {
    const qs = request.query as { from?: string; to?: string };
    const range = defaultRange(qs.from, qs.to);
    const ph = getPostHogConfig();

    if (!ph.canQuery) {
      return { countries: [] };
    }

    try {
      return await cached(`geo:${range.from}:${range.to}`, async () => {
        const result = await posthogQuery(
          `SELECT properties.$geoip_country_name as country, properties.$geoip_country_code as code, ` +
            `count(DISTINCT person_id) as visitors ` +
            `FROM events ` +
            `WHERE event = '$pageview' AND timestamp >= '${range.from}' AND timestamp <= '${range.to} 23:59:59' ` +
            `GROUP BY country, code ORDER BY visitors DESC LIMIT 20`,
        );

        return {
          countries: result.results.map((r) => ({
            name: String(r[0] ?? "Unknown"),
            code: String(r[1] ?? ""),
            visitors: Number(r[2] ?? 0),
          })),
        };
      });
    } catch (err) {
      return {
        countries: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/analytics/security — security events from PostHog
  // -------------------------------------------------------------------------

  app.get("/api/analytics/security", async (request) => {
    const qs = request.query as { from?: string; to?: string };
    const range = defaultRange(qs.from, qs.to);
    const ph = getPostHogConfig();

    if (!ph.canQuery) {
      return { attacks: [], honeypots: [], bots: [], rateLimits: [], totalSecurityEvents: 0 };
    }

    try {
      return await cached(`security:${range.from}:${range.to}`, async () => {
        const where = `timestamp >= '${range.from}' AND timestamp <= '${range.to} 23:59:59'`;

        const [attacks, honeypots, bots, rateLimits, summary] = await Promise.all([
          posthogQuery(
            `SELECT properties.attackType as type, properties.ip as ip, properties.path as path, ` +
              `properties.attackPayload as payload, properties.userAgent as ua, properties.timestamp as ts, count() as cnt ` +
              `FROM events WHERE event = 'attack_detected' AND ${where} ` +
              `GROUP BY type, ip, path, payload, ua, ts ORDER BY ts DESC LIMIT 50`,
          ),
          posthogQuery(
            `SELECT properties.honeypotPath as path, properties.ip as ip, properties.userAgent as ua, count() as cnt ` +
              `FROM events WHERE event = 'honeypot_triggered' AND ${where} ` +
              `GROUP BY path, ip, ua ORDER BY cnt DESC LIMIT 30`,
          ),
          posthogQuery(
            `SELECT properties.botType as type, properties.confidence as confidence, properties.ip as ip, ` +
              `properties.reason as reason, properties.userAgent as ua, count() as cnt ` +
              `FROM events WHERE event = 'bot_detected' AND ${where} ` +
              `GROUP BY type, confidence, ip, reason, ua ORDER BY cnt DESC LIMIT 50`,
          ),
          posthogQuery(
            `SELECT properties.ip as ip, properties.requestCount as count, properties.userAgent as ua ` +
              `FROM events WHERE event = 'rate_limit_exceeded' AND ${where} ` +
              `ORDER BY count DESC LIMIT 20`,
          ),
          posthogQuery(
            `SELECT event as name, count() as cnt FROM events ` +
              `WHERE event IN ('attack_detected', 'honeypot_triggered', 'bot_detected', 'rate_limit_exceeded') ` +
              `AND ${where} GROUP BY name`,
          ),
        ]);

        const summaryMap: Record<string, number> = {};
        for (const r of summary.results) {
          summaryMap[String(r[0])] = Number(r[1]);
        }

        return {
          attacks: attacks.results.map((r) => ({
            type: String(r[0] ?? ""), ip: String(r[1] ?? ""), path: String(r[2] ?? ""),
            payload: String(r[3] ?? "").slice(0, 200), ua: String(r[4] ?? ""), timestamp: String(r[5] ?? ""), count: Number(r[6] ?? 0),
          })),
          honeypots: honeypots.results.map((r) => ({
            path: String(r[0] ?? ""), ip: String(r[1] ?? ""), ua: String(r[2] ?? ""), count: Number(r[3] ?? 0),
          })),
          bots: bots.results.map((r) => ({
            type: String(r[0] ?? ""), confidence: Number(r[1] ?? 0), ip: String(r[2] ?? ""),
            reason: String(r[3] ?? ""), ua: String(r[4] ?? ""), count: Number(r[5] ?? 0),
          })),
          rateLimits: rateLimits.results.map((r) => ({
            ip: String(r[0] ?? ""), requestCount: Number(r[1] ?? 0), ua: String(r[2] ?? ""),
          })),
          totalSecurityEvents: Object.values(summaryMap).reduce((a, b) => a + b, 0),
          breakdown: summaryMap,
        };
      });
    } catch (err) {
      return {
        attacks: [], honeypots: [], bots: [], rateLimits: [],
        totalSecurityEvents: 0, breakdown: {},
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });
}
