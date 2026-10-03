/**
 * Security Monitor Middleware — event-night hardening for cybersecurity professionals.
 *
 * 1. Attack pattern detection (SQLi, XSS, path traversal, command injection)
 * 2. Honeypot endpoints (/admin, /wp-login.php, /.env, /api/debug)
 * 3. Per-IP rate tracking with alerts at >100 req/min
 * 4. Full request fingerprinting to PostHog on every request
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { isIP } from "node:net";
import { keyedHash, METHODS, uaClass } from "../observability/closed-schema.js";

// ---------------------------------------------------------------------------
// Attack Signatures
// ---------------------------------------------------------------------------

const SQLI_PATTERNS = [
  /(\b(union|select|insert|update|delete|drop|alter|create|exec)\b.*?\b(from|into|table|database|where)\b)/i,
  /(['"];\s*(drop|delete|update|insert|alter)\b)/i,
  /(\bor\b\s+\d+\s*=\s*\d+)/i,
  /(--\s*$|;\s*--)/,
  /(\b(sleep|benchmark|waitfor)\s*\()/i,
];

// STRICT patterns: clear attacks, always block (return 403)
const XSS_PATTERNS = [
  /<script[\s>]/i,
  /javascript\s*:/i,
  /on(error|load|click|mouse|focus|blur)\s*=/i,
  /<iframe[\s>]/i,
  /<img[^>]+onerror/i,
  /eval\s*\(/i,
  /document\.(cookie|domain|write)/i,
];

// SOFT patterns: suspicious but possibly legitimate (rich content, icons,
// custom styles). Logged as bot/attack signal, not blocked. Some user fields
// may legitimately contain SVG icons or inline styles.
const XSS_SOFT_PATTERNS = [
  /<svg[^>]+onload/i,             // svg with event handler - real attack
  /<details[^>]+ontoggle/i,
  /<meta[^>]+http-equiv/i,
  /<style[\s>]/i,                  // CSS injection - usually attack but blocks legit rich content
  /on(toggle)\s*=/i,
];

/** Check soft patterns separately — caller decides whether to block or just log */
function detectSoftXss(input: string): string | null {
  for (const p of XSS_SOFT_PATTERNS) {
    if (p.test(input)) return p.source;
  }
  return null;
}

const PATH_TRAVERSAL_PATTERNS = [
  /\.\.[/\\]/,
  /%2e%2e[/\\%]/i,
  /\.\.\%2f/i,
  /etc\/passwd/i,
  /proc\/self/i,
  /\.git\//i,
];

const CMD_INJECTION_PATTERNS = [
  /[;&|`]\s*(cat|ls|id|whoami|curl|wget|nc|ncat|bash|sh|python|perl|ruby|node)\b/i,
  /\$\(.*\)/,
  /`[^`]+`/,
  /\|\s*(bash|sh|cmd|powershell)/i,
];

type AttackType = "sqli" | "xss" | "path_traversal" | "cmd_injection";

function detectAttack(input: string): AttackType | null {
  for (const p of SQLI_PATTERNS) if (p.test(input)) return "sqli";
  for (const p of XSS_PATTERNS) if (p.test(input)) return "xss";
  for (const p of PATH_TRAVERSAL_PATTERNS) if (p.test(input)) return "path_traversal";
  for (const p of CMD_INJECTION_PATTERNS) if (p.test(input)) return "cmd_injection";
  return null;
}

// ---------------------------------------------------------------------------
// Bot / Stealth Browser Detection
// ---------------------------------------------------------------------------

interface BotSignal {
  type: "headless" | "automation" | "stealth_browser" | "scraper" | "ai_agent" | "known_scanner";
  confidence: number; // 0-1
  reason: string;
}

function detectBot(req: FastifyRequest): BotSignal | null {
  const ua = (req.headers["user-agent"] ?? "").toLowerCase();
  const signals: BotSignal[] = [];

  // Known headless/automation frameworks
  if (/headlesschrome|headless/i.test(ua)) signals.push({ type: "headless", confidence: 0.95, reason: "HeadlessChrome in UA" });
  if (/puppeteer|playwright|selenium|webdriver|cypress/i.test(ua)) signals.push({ type: "automation", confidence: 0.95, reason: "Automation framework in UA" });
  if (/phantomjs|slimerjs|splash/i.test(ua)) signals.push({ type: "headless", confidence: 0.9, reason: "Legacy headless browser" });

  // Stealth browsers (camoufox, undetected-chromedriver, etc.)
  // These hide their UA but leave behavioral fingerprints:
  // 1. Missing common headers that real browsers always send
  const hasAcceptLang = !!req.headers["accept-language"];
  const hasAcceptEnc = !!req.headers["accept-encoding"];
  const hasSecFetchSite = !!req.headers["sec-fetch-site"];
  const hasSecFetchMode = !!req.headers["sec-fetch-mode"];
  const hasSecChUa = !!req.headers["sec-ch-ua"];

  // Real Chrome/Firefox always send sec-fetch-* and sec-ch-ua
  // Stealth browsers often miss these or send inconsistent values
  if (ua.includes("chrome/") && !hasSecChUa && !ua.includes("mobile")) {
    signals.push({ type: "stealth_browser", confidence: 0.6, reason: "Chrome UA but missing sec-ch-ua header" });
  }
  if ((ua.includes("chrome/") || ua.includes("firefox/")) && !hasSecFetchSite && !hasSecFetchMode) {
    signals.push({ type: "stealth_browser", confidence: 0.5, reason: "Browser UA but missing sec-fetch-* headers" });
  }

  // 2. Missing accept-language (every real browser sends this)
  if (!hasAcceptLang && ua.length > 20) {
    signals.push({ type: "stealth_browser", confidence: 0.4, reason: "No accept-language header" });
  }

  // 3. Connection patterns — API calls without prior page load
  // (detected per-session, not per-request — tracked via fingerprint events)

  // Known AI agent patterns
  if (/claude|anthropic|openai|chatgpt|gpt-4|langchain|autogpt|babyagi/i.test(ua)) {
    signals.push({ type: "ai_agent", confidence: 0.9, reason: "AI agent in UA" });
  }

  // Known scanners
  if (/nmap|nikto|sqlmap|burp|zap|nuclei|gobuster|dirbuster|wfuzz|ffuf|feroxbuster|masscan|shodan|censys/i.test(ua)) {
    signals.push({ type: "known_scanner", confidence: 0.95, reason: "Security scanner in UA" });
  }

  // Scrapers
  if (/scrapy|httpclient|python-requests|python-urllib|go-http-client|axios|node-fetch|got\//i.test(ua)) {
    signals.push({ type: "scraper", confidence: 0.5, reason: "HTTP library in UA" });
  }

  // No UA at all
  if (!ua || ua.length < 5) {
    signals.push({ type: "scraper", confidence: 0.7, reason: "Missing or minimal user-agent" });
  }

  // Return highest confidence signal
  if (signals.length === 0) return null;
  signals.sort((a, b) => b.confidence - a.confidence);
  return signals[0];
}

function scanRequest(req: FastifyRequest): { type: AttackType; source: string; value: string } | null {
  // Scan URL
  const urlAttack = detectAttack(req.url);
  if (urlAttack) return { type: urlAttack, source: "url", value: req.url };

  // Scan query params
  if (req.query && typeof req.query === "object") {
    for (const [k, v] of Object.entries(req.query as Record<string, unknown>)) {
      const str = `${k}=${v}`;
      const attack = detectAttack(str);
      if (attack) return { type: attack, source: "query", value: str };
    }
  }

  // Scan body (string or object) — scan first 10KB, don't skip large payloads
  if (req.body) {
    const bodyStr = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
    const scanSlice = bodyStr.slice(0, 10_000);
    const attack = detectAttack(scanSlice);
    if (attack) return { type: attack, source: "body", value: bodyStr.slice(0, 500) };
  }

  // Scan select headers
  for (const h of ["referer", "user-agent", "x-forwarded-for", "cookie"]) {
    const val = req.headers[h];
    if (val && typeof val === "string") {
      const attack = detectAttack(val);
      if (attack) return { type: attack, source: `header:${h}`, value: val.slice(0, 300) };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Honeypot Paths
// ---------------------------------------------------------------------------

const HONEYPOT_PATHS = new Set([
  "/admin",
  "/admin/",
  "/wp-admin",
  "/wp-admin/",
  "/wp-login.php",
  "/wp-login",
  "/.env",
  "/.git/config",
  "/.git/HEAD",
  "/api/debug",
  "/debug",
  "/phpmyadmin",
  "/phpMyAdmin",
  "/server-status",
  "/actuator",
  "/actuator/health",
  "/api/v1/admin",
  "/.aws/credentials",
  "/config.json",
  "/package.json",
  "/.DS_Store",
  "/robots.txt.bak",
  "/backup.sql",
  "/dump.sql",
  "/console",
  "/shell",
  "/cgi-bin/",
  "/xmlrpc.php",
]);

// ---------------------------------------------------------------------------
// Rate Tracker
// ---------------------------------------------------------------------------

const ipCounts = new Map<string, { count: number; windowStart: number; flagged: boolean }>();
const RATE_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT = 100; // requests per minute before alert

function trackRate(ip: string): { overLimit: boolean; count: number } {
  const now = Date.now();
  let entry = ipCounts.get(ip);
  if (!entry || now - entry.windowStart > RATE_WINDOW_MS) {
    entry = { count: 0, windowStart: now, flagged: false };
    ipCounts.set(ip, entry);
  }
  entry.count++;
  const overLimit = entry.count > RATE_LIMIT;
  return { overLimit, count: entry.count };
}

// Periodic cleanup (every 5 min)
setInterval(() => {
  const cutoff = Date.now() - RATE_WINDOW_MS * 2;
  for (const [ip, entry] of ipCounts) {
    if (entry.windowStart < cutoff) ipCounts.delete(ip);
  }
}, 300_000);

// ---------------------------------------------------------------------------
// Fingerprint Builder
// ---------------------------------------------------------------------------

/**
 * The route a request matched, as the app declared it (N107): its pattern, never the caller's
 * path. A path can carry a value (a token or code in a segment, an encoded query); a pattern
 * cannot.
 */
const routeOf = (req: FastifyRequest) => req.routeOptions?.url ?? "unmatched";

/** The client's address when it is one; anything else in its place is not reported. */
const clientIpOf = (req: FastifyRequest) => (isIP(req.ip) ? req.ip : "invalid");

const headerText = (value: unknown) => (typeof value === "string" ? value : Array.isArray(value) ? value.join(",") : "");


/** Where an attack was found: a closed name, never built from the request. */
const HEADER_SOURCES: Readonly<Record<string, string>> = {
  referer: "header:referer",
  "user-agent": "header:user-agent",
  "x-forwarded-for": "header:x-forwarded-for",
  cookie: "header:cookie",
};

const MEDIA_TYPES: ReadonlySet<string> = new Set([
  "application/json", "application/x-www-form-urlencoded", "multipart/form-data", "text/plain",
  "text/html", "application/xml", "text/xml", "application/octet-stream",
]);

/** Where a request came from, as a kind: never the Referer's text (it can hold userinfo or values). */
function refererKindOf(req: FastifyRequest): "direct" | "same_origin" | "cross_origin" | "invalid" {
  const referer = headerText(req.headers["referer"]);
  if (!referer) return "direct";
  try {
    return new URL(referer).host === headerText(req.headers.host) ? "same_origin" : "cross_origin";
  } catch {
    return "invalid";
  }
}

/**
 * What an attack event says about the content that matched (N107, N107b): its type and where it
 * was found, both closed names. Never the content or its length: a URL, cookie or body that matched
 * a pattern can also hold the caller's credentials.
 */
function attackSummary(attackType: AttackType, attackSource: string) {
  return { attackType, attackSource };
}

/**
 * A request's fingerprint as the security events carry it (r1 of #514; N107b, the PR steward's
 * closed schema): derived values only. The client is a keyed hash (observability/closed-schema.ts,
 * under PCC_TELEMETRY_KEY), the User-Agent one of four classes, the Referer a kind, the content type
 * an allowlisted media type, the edge an enum and the forwarding chain a count capped at 5. Neither
 * the Accept-Language (#514 r2, MEDIUM 1) nor the country (the PR steward's ruling #5664: not a
 * class the schema keeps unless gateway names a forensics need) is reported.
 */
function buildFingerprint(req: FastifyRequest) {
  const media = headerText(req.headers["content-type"]).split(";", 1)[0]!.trim().toLowerCase();
  const forwarded = headerText(req.headers["x-forwarded-for"]);
  const ip = clientIpOf(req);
  return {
    clientId: ip === "invalid" ? "invalid" : keyedHash(ip),
    method: METHODS.has(req.method) ? req.method : "OTHER",
    path: routeOf(req),
    uaClass: uaClass(req.headers["user-agent"]),
    referer: refererKindOf(req),
    contentType: media ? (MEDIA_TYPES.has(media) ? media : "other") : "none",
    edge:
      req.headers["cf-ray"] !== undefined ? "cloudflare"
        : req.headers["x-railway-edge"] !== undefined ? "railway"
        : req.headers["x-vercel-ip-country"] !== undefined ? "vercel"
        : "none",
    forwardedHops: forwarded ? Math.min(forwarded.split(",").length, 5) : 0,
    timestamp: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// PostHog Event Emitter (lazy import to avoid circular deps)
// ---------------------------------------------------------------------------

let _trackServerEvent: ((name: string, props: Record<string, unknown>, distinctId?: string) => void) | null = null;

/** Strip HTML tags and escape special chars to prevent XSS when viewed in PostHog dashboards */
function sanitize(val: unknown): unknown {
  if (typeof val === "string") return val.replace(/[<>'"&]/g, (c) => `&#${c.charCodeAt(0)};`).slice(0, 500);
  if (typeof val === "object" && val !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val)) out[k] = sanitize(v);
    return out;
  }
  return val;
}

async function emitSecurityEvent(name: string, props: Record<string, unknown>) {
  try {
    if (!_trackServerEvent) {
      const mod = await import("../services/posthog-service.js");
      _trackServerEvent = mod.trackServerEvent;
    }
    // Sanitize all props to prevent XSS when attacker-controlled data is viewed in dashboards
    const safeProps = sanitize(props) as Record<string, unknown>;
    _trackServerEvent(name, safeProps, `security:${safeProps.clientId ?? "unknown"}`);
  } catch {
    // PostHog not initialized — non-fatal
  }
}

// ---------------------------------------------------------------------------
// Plugin Registration
// ---------------------------------------------------------------------------

export async function securityMonitorPlugin(app: FastifyInstance) {
  // ── Honeypot Routes ─────────────────────────────────────────────────────
  for (const path of HONEYPOT_PATHS) {
    const handler = async (req: FastifyRequest, reply: FastifyReply) => {
      const fp = buildFingerprint(req);
      emitSecurityEvent("honeypot_triggered", {
        ...fp,
        honeypotPath: path,
        severity: "high",
      });
      app.log.warn({ msg: "HONEYPOT", ip: clientIpOf(req), path, uaClass: fp.uaClass });
      // Add random delay (50-200ms) to match real 404 timing — prevents timing side-channel
      await new Promise((r) => setTimeout(r, 50 + Math.random() * 150));
      return reply.status(404).send({ error: "not_found" });
    };

    // Register GET and POST for each honeypot
    try { app.get(path, handler); } catch { /* route may conflict */ }
    try { app.post(path, handler); } catch { /* route may conflict */ }
  }

  // ── Request Scanning Hook (onRequest — URL + headers only, body not yet parsed) ──
  app.addHook("onRequest", async (req, reply) => {
    const fp = buildFingerprint(req);

    // 1. Attack pattern detection (URL + query + headers only — body is not available yet)
    const urlAttack = detectAttack(req.url);
    if (urlAttack) {
      emitSecurityEvent("attack_detected", {
        ...fp,
        ...attackSummary(urlAttack, "url"),
        severity: "critical",
      });
      app.log.warn({ msg: "ATTACK_DETECTED", type: urlAttack, ip: clientIpOf(req), source: "url", path: fp.path });
      // BLOCK known attacks — detection-only is insufficient for tonight
      return reply.status(403).send({ error: "forbidden", message: "Request blocked by security policy" });
    }

    // Scan query params
    if (req.query && typeof req.query === "object") {
      for (const [k, v] of Object.entries(req.query as Record<string, unknown>)) {
        const str = `${k}=${v}`;
        const attack = detectAttack(str);
        if (attack) {
          emitSecurityEvent("attack_detected", { ...fp, ...attackSummary(attack, "query"), severity: "critical" });
          app.log.warn({ msg: "ATTACK_DETECTED", type: attack, ip: clientIpOf(req), source: "query", path: fp.path });
          return reply.status(403).send({ error: "forbidden", message: "Request blocked by security policy" });
        }
      }
    }

    // Scan headers
    for (const h of ["referer", "user-agent", "x-forwarded-for", "cookie"]) {
      const val = req.headers[h];
      if (val && typeof val === "string") {
        const attack = detectAttack(val);
        if (attack) {
          emitSecurityEvent("attack_detected", { ...fp, ...attackSummary(attack, HEADER_SOURCES[h] ?? "header"), severity: "critical" });
          app.log.warn({ msg: "ATTACK_DETECTED", type: attack, ip: clientIpOf(req), source: HEADER_SOURCES[h] ?? "header", path: fp.path });
          return reply.status(403).send({ error: "forbidden", message: "Request blocked by security policy" });
        }
      }
    }

    // 2. Bot / stealth browser detection
    const bot = detectBot(req);
    if (bot && bot.confidence >= 0.4) {
      emitSecurityEvent("bot_detected", {
        ...fp,
        botType: bot.type,
        confidence: bot.confidence,
        reason: bot.reason,
        severity: bot.confidence >= 0.8 ? "high" : "medium",
      });
      if (bot.confidence >= 0.7) {
        app.log.warn({ msg: "BOT_DETECTED", type: bot.type, ip: clientIpOf(req), reason: bot.reason });
      }
    }

    // 3. Rate tracking
    const rate = trackRate(req.ip);
    if (rate.overLimit && rate.count === RATE_LIMIT + 1) {
      emitSecurityEvent("rate_limit_exceeded", {
        ...fp,
        requestCount: rate.count,
        windowMs: RATE_WINDOW_MS,
        severity: "medium",
      });
      app.log.warn({ msg: "RATE_LIMIT", ip: clientIpOf(req), count: rate.count });
    }
  });

  // ── Body Scanning Hook (preHandler — body IS parsed here) ─────────────
  // IMPORTANT: This must be in preHandler, NOT onRequest. Fastify parses the
  // body between onRequest and preHandler. Scanning in onRequest misses all
  // body-based attacks (the most common attack vector).
  app.addHook("preHandler", async (req, reply) => {
    if (!req.body || req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return;

    const bodyStr = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
    // Scan first 10KB (don't skip large bodies — scan the beginning)
    const scanTarget = bodyStr.slice(0, 10_000);
    const attack = detectAttack(scanTarget);

    if (attack) {
      const fp = buildFingerprint(req);
      emitSecurityEvent("attack_detected", {
        ...fp,
        ...attackSummary(attack, "body"),
        severity: "critical",
      });
      app.log.warn({ msg: "ATTACK_DETECTED", type: attack, ip: clientIpOf(req), source: "body", path: fp.path });
      return reply.status(403).send({ error: "forbidden", message: "Request blocked by security policy" });
    }
  });

  // ── Full Request Fingerprinting (onResponse — captures status code + duration)
  app.addHook("onResponse", async (req, reply) => {
    // Skip SSE streams, health checks, and static assets
    if (req.url.startsWith("/sse/") || req.url === "/health" || req.url === "/api/health") return;
    if (req.url.startsWith("/assets/") || req.url.endsWith(".js") || req.url.endsWith(".css")) return;

    const fp = buildFingerprint(req);
    emitSecurityEvent("request_fingerprint", {
      ...fp,
      statusCode: reply.statusCode,
      durationMs: Math.round(reply.elapsedTime ?? 0),
    });
  });

  app.log.info("[security-monitor] Attack detection, honeypots, rate tracking, and fingerprinting active");
}
