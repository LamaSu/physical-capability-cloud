/**
 * Every request the shipped code sends other than through authorizedFetch, and how it gets past
 * the gateway's API gate (N103, client half).
 *
 * The gateway's API gate (packages/gateway/src/middleware/api-gate.ts) admits an /api request on
 * an API key or on a SIWE session cookie. N103 (gateway's ruling #6597) honors that cookie only
 * beside the key the session was verified under, so a request sent without the key stops working
 * unless the gate lets its route through without auth. Requests made through authorizedFetch carry
 * the key. This lists every other request in the shipped code (src/, index.html, and
 * everything runnable under public/ at any depth) and how it gets past the gate:
 * - "public": the gate admits the route without auth; `gate` is the rule, checked against the gate;
 * - "outside": not an /api route, so the gate never sees it (static files, /sse/* streams, other sites);
 * - "keyed": the request carries a key itself (a page's own key field or a key it provisioned);
 * - "logout": sends the cookie by design, since it ends whatever session the cookie names;
 * - "unused": the code that would send it never runs (no caller, or a mode the page never enters);
 * - "host": an embedding host's own fetch channel, which authenticates the request itself;
 * - "example": a code sample shown on a page, not a script;
 * - "residual": reaches a gated route without a key. It passes today only on a SIWE cookie, if at
 *   all, and after N103 not at all. Each one says whose row it is.
 *
 * A new request fails this test until it is classified. That is the point: a request to a gated
 * route that relies on the cookie should go through authorizedFetch instead. This is an inventory
 * kept by a regular expression, not a security boundary: the gateway enforces N103 whatever this
 * finds, and a request missed here fails closed (401), it doesn't leak.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const APP = resolve(__dirname, "../..");
const GATE = readFileSync(resolve(APP, "../../packages/gateway/src/middleware/api-gate.ts"), "utf8");

type Kind = "public" | "outside" | "keyed" | "logout" | "unused" | "host" | "example" | "residual";
interface Entry {
  kind: Kind;
  why: string;
  /** For "public": text that must appear in api-gate.ts, the rule that admits the route. */
  gate?: string;
  /** How many identical call sites the file has (default 1). */
  count?: number;
}

/** `<file> :: <callee>(<first argument>`, whitespace collapsed. */
const INVENTORY: Record<string, Entry> = {
  // ── src/: the dashboard ─────────────────────────────────────────────────────
  "src/lib/gateway-base.ts :: fetch(resolved.url": {
    kind: "keyed",
    why: "fetchWithKey itself: authorizedFetch's request, with the stored key, to the configured gateway only",
  },
  "src/components/ConnectWallet.tsx :: fetch(\"/api/auth/nonce\"": { kind: "public", why: "the SIWE challenge", gate: "\"/api/auth/nonce\"" },
  "src/hooks/use-auth.ts :: fetch(\"/api/auth/nonce\"": { kind: "public", why: "the SIWE challenge", gate: "\"/api/auth/nonce\"" },
  "src/components/ConnectWallet.tsx :: fetch(\"/api/auth/logout\"": {
    kind: "logout",
    why: "ends the session its cookie names and authenticates nothing; the gate passes it on that cookie today, and N103's gateway half makes the route public",
  },
  "src/hooks/use-auth.ts :: fetch(\"/api/auth/logout\"": {
    kind: "logout",
    why: "as ConnectWallet's logout",
  },
  "src/components/marketplace/TemplateMatchFinder.tsx :: fetch(`${API_ROOT}/api/capabilities/templates/match`": {
    kind: "public",
    why: "the landing page's template matcher, a POST that stores nothing",
    gate: "if (method === \"POST\" && path === PUBLIC_TEMPLATE_MATCH_PATH) return true;",
  },
  "src/components/operator/RatingsPanel.tsx :: fetch(`${API_ROOT}/api/operators/${encodeURIComponent(operatorId)}/ratings`": {
    kind: "public",
    why: "operator ratings are a public reputation read",
    gate: "if (PUBLIC_OPERATOR_RATINGS_RE.test(path)) return true;",
  },
  "src/pages/OnboardChatPage.tsx :: fetch(`${API}/api/onboard/chat/health`": { kind: "public", why: "layperson onboarding chat", gate: "\"/api/onboard/chat\"" },
  "src/pages/OnboardChatPage.tsx :: fetch(`${API}/api/onboard/chat`": { kind: "public", why: "layperson onboarding chat", gate: "\"/api/onboard/chat\"" },
  "src/pages/SetupWizardPage.tsx :: fetch(gatewayUrl(\"/api/health\")": { kind: "public", why: "the health check", gate: "\"/api/health\"" },
  "src/pages/AgentLinkPage.tsx :: fetch(\"/agent-package.json\"": { kind: "outside", why: "a static file" },
  "src/pages/WhitepaperPage.tsx :: fetch(\"/whitepaper.md\"": { kind: "outside", why: "a static file" },
  "src/pages/LandingPage.tsx :: fetch(`${base}/agent-context-pack`": { kind: "outside", why: "a gateway route outside /api" },
  "src/pages/LandingPage.tsx :: fetch(`${base}/agent-package.json`": { kind: "outside", why: "a static file" },
  "src/hooks/use-sse-stream.ts :: EventSource(url": {
    kind: "outside",
    why: "its callers open /sse/* streams (notifications, kernel), which the API gate never sees; they are the SSE row's",
  },
  "src/realtime/sse-client.ts :: EventSource(url": { kind: "unused", why: "createSSEClient has no caller" },
  "src/pages/TelemetryPage.tsx :: EventSource(\"/api/telemetry/logs/stream\"": {
    kind: "residual",
    why: "SSE row: EventSource can't send the key, so the live stream passes the gate only on a session cookie. The polled reads carry the key; #408 makes the stream an addition to them",
  },
  "src/pages/TracesPage.tsx :: EventSource(\"/api/traces/stream\"": {
    kind: "residual",
    why: "SSE row: as the telemetry stream. On master a stream error shows sample traces; #408 removes that",
  },
  "src/pages/EarnFromYourWorkPage.tsx :: fetch(gatewayUrl(\"/api/contributors/quickstart\")": {
    kind: "residual",
    why: "gateway: an anonymous sign-up (it mints the key) behind the gate, so it passes only on a session cookie, already today",
  },
  "src/components/onboard/ActivityFeed.tsx :: fetch(`${endpoint}?since=${cursorRef.current}`": {
    kind: "residual",
    why: "polls /api/onboard/events, which no gateway route serves; it fails either way and shows nothing",
  },
  "src/lib/passkey-registration.ts :: fetchFn(`${apiBase}/api/onboard/passkey/register-challenge`": {
    kind: "residual",
    why: "gateway: the anonymous registration only (a bound one goes through authorizedFetch). The route allows anonymous callers, but the gate doesn't",
  },
  "src/lib/passkey-registration.ts :: fetchFn(`${apiBase}/api/onboard/passkey/verify-attestation`": {
    kind: "residual",
    why: "gateway: as the anonymous challenge",
  },
  "src/hooks/usePasskey.ts :: fetch(input": {
    kind: "residual",
    why: "the plain fetch passkey-registration uses for the anonymous registration (above)",
  },

  // ── public/: the static pages ───────────────────────────────────────────────
  "public/commentary.html :: fetch(url": { kind: "keyed", why: "sends the key entered in its key field (N103)" },
  "public/onboard.html :: fetch(base+path": { kind: "keyed", why: "sends the key entered in its key field; provisioning is public" },
  "public/operator-capture.html :: fetch(\"/api/capture/challenge\"": { kind: "keyed", why: "authHeaders(): the key it provisioned" },
  "public/operator-capture.html :: fetch(\"/api/capture/upload\"": { kind: "keyed", why: "authHeaders(): the key it provisioned" },
  "public/operator-capture.html :: fetch(url": { kind: "keyed", why: "authHeaders(): the key it provisioned" },
  "public/operator-capture.html :: fetch(\"/api/auth/provision\"": { kind: "public", why: "key provisioning", gate: "\"/api/auth/provision\"" },
  "public/pizza-onboard-driver.html :: fetch(base+path": { kind: "keyed", why: "auth(): the key it provisioned", count: 3 },
  "public/pizza-onboard-shop.html :: fetch(base+path": { kind: "keyed", why: "auth(): the key it provisioned", count: 3 },
  "public/pizza-onboard-user.html :: fetch(base+path": { kind: "public", why: "only key provisioning", gate: "\"/api/auth/provision\"" },
  "public/install.html :: fetch('/api/onboard/identify-device'": { kind: "public", why: "device identification", gate: "\"/api/onboard/identify-device\"" },
  "public/install.html :: fetch('/api/feedback'": { kind: "public", why: "the feedback sink", gate: "\"/api/feedback\"" },
  "public/install.html :: fetch('https://formsubmit.co/ajax/' + FEEDBACK_EMAIL": { kind: "outside", why: "another site, no credentials" },
  "public/install.html :: fetch('/agent-package.json'": { kind: "outside", why: "a static file" },
  "public/landing.html :: fetch(ENDPOINT": { kind: "public", why: "ENDPOINT is /api/feedback", gate: "\"/api/feedback\"" },
  "public/pizza-llm-agent-prompt.html :: fetch(PROMPT_URL": { kind: "outside", why: "a static prompt file", count: 2 },
  "public/pizza-llm-bootstrap.html :: fetch(PROMPT_URL": { kind: "outside", why: "a static prompt file", count: 2 },
  "public/driver.html :: EventSource(`${BASE}/sse/demo/driver/${slug}`": { kind: "outside", why: "an /sse/* demo stream" },
  "public/operator.html :: EventSource(`${BASE}/sse/demo/operator/${slug}`": { kind: "outside", why: "an /sse/* demo stream" },
  "public/order.html :: EventSource(`${BASE}/sse/demo/order/${S.orderId}`": { kind: "outside", why: "an /sse/* demo stream" },
  "public/pizza-observability.html :: EventSource(BASE+\"/sse/demo/firehose\"": { kind: "outside", why: "an /sse/* demo stream" },
  "public/driver.html :: fetch(BASE+path": {
    kind: "residual",
    why: "demo: /api/demo/jobs/* is behind the gate and the page has no key, so it passes only on a session cookie, already today",
  },
  "public/operator.html :: fetch(BASE+path": { kind: "residual", why: "demo: as driver.html" },
  "public/order.html :: fetch(BASE+path": { kind: "residual", why: "demo: /api/demo/pizza-order and /api/demo/orders/*, as driver.html" },
  "public/pizza-observability.html :: fetch(BASE+path": { kind: "residual", why: "demo: /api/demo/orders/observability, as driver.html" },
  "public/operator-status.html :: fetch('/api/operators/'+encodeURIComponent(slug)+'/status'": {
    kind: "residual",
    why: "gateway: /api/operators/:slug/status is behind the gate (only /ratings is public) and the page has no key",
  },

  // ── public/, nested, and its scripts (astra n103c-586-r1 F2) ───────────────
  "public/visualizer.js :: fetch(`${origin}/api/visualizer/events.json?limit=1`": {
    kind: "residual",
    why: "visualizer: its probe of /api/visualizer (gated) sends no credentials at all, so against a gated gateway it falls back to offline mode, today and after N103",
  },
  "public/visualizer.js :: EventSource(url": {
    kind: "residual",
    why: "visualizer: the live stream on /api/visualizer/events (gated), opened only after the probe above passes",
  },
  "public/visualizer.js :: fetch(url": { kind: "residual", why: "visualizer: the replay read of /api/visualizer/events.json, no credentials, as the probe" },
  "public/visualizer.js :: fetch(\"/visualizer-test-fixtures.json\"": { kind: "outside", why: "a static file" },
  "public/ui-kit/v1/pcc-ir-kit.js :: fetch(url": {
    kind: "residual",
    why: "ui-kit: the closed-IR kit reads its bindings with no credentials and no key, so a binding on a gated route (/api/jobs) fails, today and after N103",
  },
  "public/ui-kit/v1/pcc-ui.js :: fetch(url": {
    kind: "keyed",
    why: "the kit's transport (getJSON, send, streamSSE): the viewer's key, pinned to the API origin, credentials omitted, redirects refused",
    count: 3,
  },
  "public/ui-kit/v1/pcc-ui.js :: fetch(safe": {
    kind: "host",
    why: "window.__PCC_HOST_BRIDGE__.fetch, an embedding host's channel (MCP Apps); the host authenticates it",
  },
  "public/ui-kit/v1/example-manifests/demo-snapshot.html :: fetch(this.base + path + this.qs(query)": {
    kind: "unused",
    why: "the page bakes in its snapshot, so detectMode always answers 'snapshot' and the live transport never runs. That transport is an older copy of pcc-ui.js's, without the origin pin (latent; reported to the ui-kit owner)",
  },
  "public/ui-kit/v1/example-manifests/demo-snapshot.html :: fetch(this.base + path": {
    kind: "unused",
    why: "as the demo snapshot's getJSON: send and streamSSE never run in snapshot mode",
    count: 2,
  },
  "public/docs/index.html :: fetch(\"https://YOUR_DEPLOYMENT/api/agent/tools.json\"": {
    kind: "example",
    why: "inside a <pre><code> sample; the page has no script",
  },
  "public/docs/index.html :: fetch(\"https://YOUR_DEPLOYMENT/api/kernels\"": {
    kind: "example",
    why: "inside a <pre><code> sample; the page has no script",
  },
};

// ── The scan ─────────────────────────────────────────────────────────────────

const CALL = /\b(fetch|fetchFn|EventSource|sendBeacon|WebSocket)\s*\(|\bXMLHttpRequest\b/g;

function* shippedFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name !== "__tests__" && name !== "node_modules") yield* shippedFiles(full);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name)) {
      yield full;
    }
  }
}

/** The first argument's source text, from just after "(" to the first top-level "," or ")". */
function firstArgument(src: string, from: number): string {
  const frames: string[] = [];
  let quote: string | null = null;
  let i = from;
  for (; i < src.length; i++) {
    const c = src[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (quote === "`" && c === "$" && src[i + 1] === "{") {
        frames.push("${");
        quote = null;
        i++;
      } else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "(" || c === "[" || c === "{") frames.push(c);
    else if (c === ")" || c === "]" || c === "}") {
      if (frames.length === 0) break;
      if (frames.pop() === "${") quote = "`";
    } else if (c === "," && frames.length === 0) break;
  }
  return src.slice(from, i).replace(/\s+/g, " ").trim();
}

/** Each request call site in `files`, as `<file> :: <callee>(<first argument>` → how many times it occurs. */
function sitesIn(files: Array<{ rel: string; src: string }>): Map<string, number> {
  const sites = new Map<string, number>();
  for (const { rel, src } of files) {
    for (const m of src.matchAll(CALL)) {
      const lineStart = src.lastIndexOf("\n", m.index!) + 1;
      if (/^\s*(\*|\/\/|\/\*)/.test(src.slice(lineStart, m.index!))) continue; // a comment
      const callee = m[1] ?? "XMLHttpRequest";
      const arg = m[1] ? firstArgument(src, m.index! + m[0].length) : "";
      const key = `${rel} :: ${callee}(${arg}`;
      sites.set(key, (sites.get(key) ?? 0) + 1);
    }
  }
  return sites;
}

/** Files under public/ a browser can run: scripts, and pages with their inline scripts. */
const RUNNABLE = /\.(m?js|cjs|html?)$/;

/** The shipped code this scans: src/ (tests excluded), index.html, and everything runnable under public/, at any depth. */
function shippedSources(): Array<{ rel: string; src: string }> {
  const files = [
    ...shippedFiles(join(APP, "src")),
    join(APP, "index.html"),
    ...(readdirSync(join(APP, "public"), { recursive: true }) as string[])
      .filter((n) => RUNNABLE.test(n))
      .map((n) => join(APP, "public", n)),
  ];
  return files.map((file) => ({ rel: relative(APP, file), src: readFileSync(file, "utf8") }));
}

function requestSites(): Map<string, number> {
  return sitesIn(shippedSources());
}

/**
 * Requests that reach a gated route without a key. This only shrinks: a new one goes through
 * authorizedFetch. It was 12 until the scan covered public/'s scripts (astra n103c-586-r1 F2), which
 * found 4 more that predate this test: the visualizer's three and the closed-IR kit's.
 */
const MAX_RESIDUALS = 16;

// ── The checks ───────────────────────────────────────────────────────────────

describe("every request sent without the API key is accounted for (N103)", () => {
  const sites = requestSites();

  it("scans everything the app ships that can run: every script and page under public/, and index.html (astra n103c-586-r1 F2)", () => {
    const scanned = new Set(shippedSources().map((f) => f.rel));
    // Listed here on its own, not through shippedSources, so a narrower scan can't pass by agreeing with itself.
    const runnable = (readdirSync(join(APP, "public"), { recursive: true }) as string[])
      .filter((n) => /\.(m?js|cjs|html?)$/.test(n))
      .map((n) => join("public", n));
    expect([...runnable, "index.html"].filter((f) => !scanned.has(f))).toEqual([]);
  });

  it("finds the requests (the scan works)", () => {
    expect(sites.size).toBeGreaterThan(20);
    expect([...sites.keys()]).toContain("src/lib/gateway-base.ts :: fetch(resolved.url");
  });

  it("classifies every request in the shipped code", () => {
    const unlisted = [...sites.keys()].filter((k) => !(k in INVENTORY));
    expect(unlisted, "requests to classify: does each one reach a gated /api route without the key?").toEqual([]);
  });

  it("lists no request that is gone, and counts each one", () => {
    const counted = Object.entries(INVENTORY).map(([k, e]) => [k, e.count ?? 1] as const);
    expect(counted.filter(([k, n]) => sites.get(k) !== n)).toEqual([]);
  });

  it("each public route is admitted by a rule the gate still has", () => {
    const missing = Object.entries(INVENTORY).filter(([, e]) => e.kind === "public" && !(e.gate && GATE.includes(e.gate)));
    expect(missing.map(([k]) => k)).toEqual([]);
  });

  it(`the requests that pass only on a session cookie don't grow (at most ${MAX_RESIDUALS})`, () => {
    const residuals = Object.values(INVENTORY).filter((e) => e.kind === "residual");
    expect(residuals.length).toBeLessThanOrEqual(MAX_RESIDUALS);
  });
});

describe("the scan (self-test)", () => {
  const scan = (src: string) => [...sitesIn([{ rel: "x.ts", src }]).keys()];

  it("finds each kind of request, however the global is reached", () => {
    const src = [
      'fetch("/api/a");',
      'window.fetch("/api/b");',
      'globalThis.fetch("/api/c");',
      'const es = new EventSource("/api/d");',
      'navigator.sendBeacon("/api/e", body);',
      'const ws = new WebSocket("wss://h/api/f");',
      "const x = new XMLHttpRequest();",
      'deps.fetchFn("/api/g", init);',
    ].join("\n");
    expect(scan(src)).toEqual([
      'x.ts :: fetch("/api/a"',
      'x.ts :: fetch("/api/b"',
      'x.ts :: fetch("/api/c"',
      'x.ts :: EventSource("/api/d"',
      'x.ts :: sendBeacon("/api/e"',
      'x.ts :: WebSocket("wss://h/api/f"',
      "x.ts :: XMLHttpRequest(",
      'x.ts :: fetchFn("/api/g"',
    ]);
  });

  it("reads the whole first argument: across lines, and past commas inside calls and template holes", () => {
    const src = 'await fetch(\n  `${base}/api/x/${pick(a, b)}?q=${[1, 2].join(",")}`,\n  { method: "POST" },\n);';
    expect(scan(src)).toEqual(['x.ts :: fetch(`${base}/api/x/${pick(a, b)}?q=${[1, 2].join(",")}`']);
  });

  it("skips comments, and the key's own helpers", () => {
    const src = [
      '// fetch("/api/a")',
      ' * fetch("/api/b")',
      '/* fetch("/api/c") */',
      'authorizedFetch("/api/d");',
      'fetchWithKey("/api/e", key, init);',
      'prefetch("/api/f");',
    ].join("\n");
    expect(scan(src)).toEqual([]);
  });
});
