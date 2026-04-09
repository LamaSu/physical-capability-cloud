/**
 * Security Monitor Middleware — event-night hardening for cybersecurity professionals.
 *
 * 1. Attack pattern detection (SQLi, XSS, path traversal, command injection)
 * 2. Honeypot endpoints (/admin, /wp-login.php, /.env, /api/debug)
 * 3. Per-IP rate tracking with alerts at >100 req/min
 * 4. Full request fingerprinting to PostHog on every request
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

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

const XSS_PATTERNS = [
  /<script[\s>]/i,
  /javascript\s*:/i,
  /on(error|load|click|mouse|focus|blur)\s*=/i,
  /<iframe[\s>]/i,
  /<img[^>]+onerror/i,
  /eval\s*\(/i,
  /document\.(cookie|domain|write)/i,
];

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
  if (/puppeteer|playwright|selenium|webdriver|cypress/i.test(ua)) signals.push({ type: "automation", confidence: 0.95, reason: `Automation framework in UA: ${ua.slice(0, 80)}` });
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
    signals.push({ type: "ai_agent", confidence: 0.9, reason: `AI agent in UA: ${ua.slice(0, 80)}` });
  }

  // Known scanners
  if (/nmap|nikto|sqlmap|burp|zap|nuclei|gobuster|dirbuster|wfuzz|ffuf|feroxbuster|masscan|shodan|censys/i.test(ua)) {
    signals.push({ type: "known_scanner", confidence: 0.95, reason: `Security scanner: ${ua.slice(0, 80)}` });
  }

  // Scrapers
  if (/scrapy|httpclient|python-requests|python-urllib|go-http-client|axios|node-fetch|got\//i.test(ua)) {
    signals.push({ type: "scraper", confidence: 0.5, reason: `HTTP library UA: ${ua.slice(0, 80)}` });
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

function buildFingerprint(req: FastifyRequest) {
  return {
    ip: req.ip,
    method: req.method,
    path: req.url.split("?")[0],
    userAgent: req.headers["user-agent"] ?? "unknown",
    referer: req.headers["referer"] ?? "direct",
    acceptLanguage: req.headers["accept-language"] ?? "unknown",
    contentType: req.headers["content-type"] ?? "none",
    cfCountry: req.headers["cf-ipcountry"] ?? req.headers["x-vercel-ip-country"] ?? "unknown",
    cfRay: req.headers["cf-ray"] ?? null,
    xForwardedFor: req.headers["x-forwarded-for"] ?? null,
    railwayEdge: req.headers["x-railway-edge"] ?? null,
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
    _trackServerEvent(name, safeProps, `security:${safeProps.ip ?? "unknown"}`);
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
      app.log.warn({ msg: "HONEYPOT", ip: req.ip, path, ua: req.headers["user-agent"] });
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
        attackType: urlAttack,
        attackSource: "url",
        attackPayload: req.url.slice(0, 500),
        severity: "critical",
      });
      app.log.warn({ msg: "ATTACK_DETECTED", type: urlAttack, ip: req.ip, source: "url", url: req.url });
      // BLOCK known attacks — detection-only is insufficient for tonight
      return reply.status(403).send({ error: "forbidden", message: "Request blocked by security policy" });
    }

    // Scan query params
    if (req.query && typeof req.query === "object") {
      for (const [k, v] of Object.entries(req.query as Record<string, unknown>)) {
        const str = `${k}=${v}`;
        const attack = detectAttack(str);
        if (attack) {
          emitSecurityEvent("attack_detected", { ...fp, attackType: attack, attackSource: "query", attackPayload: str.slice(0, 500), severity: "critical" });
          app.log.warn({ msg: "ATTACK_DETECTED", type: attack, ip: req.ip, source: "query", url: req.url });
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
          emitSecurityEvent("attack_detected", { ...fp, attackType: attack, attackSource: `header:${h}`, attackPayload: val.slice(0, 300), severity: "critical" });
          app.log.warn({ msg: "ATTACK_DETECTED", type: attack, ip: req.ip, source: `header:${h}` });
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
        app.log.warn({ msg: "BOT_DETECTED", type: bot.type, ip: req.ip, reason: bot.reason });
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
      app.log.warn({ msg: "RATE_LIMIT", ip: req.ip, count: rate.count });
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
        attackType: attack,
        attackSource: "body",
        attackPayload: scanTarget.slice(0, 500),
        severity: "critical",
      });
      app.log.warn({ msg: "ATTACK_DETECTED", type: attack, ip: req.ip, source: "body", url: req.url });
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
      responseSize: reply.getHeader("content-length") ?? null,
    });
  });

  app.log.info("[security-monitor] Attack detection, honeypots, rate tracking, and fingerprinting active");
}
