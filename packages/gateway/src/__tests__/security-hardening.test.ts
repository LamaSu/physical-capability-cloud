import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import { JSDOM } from "jsdom";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { INLINE_SCRIPT_HTML_PATHS, securityHeaders } from "../middleware/security-hardening.js";

let app: FastifyInstance;

async function buildApp(rootStaticPath = "/landing.html"): Promise<FastifyInstance> {
  const instance = Fastify({ logger: false });
  await securityHeaders(instance);
  instance.get("/", { config: { cspStaticHtmlPath: rootStaticPath } }, async (req, reply) => {
    if (req.url === "/?mode=agent") return { ok: true };
    return reply.type("text/html").send("<!doctype html><html><body>Home</body></html>");
  });
  instance.get("/route-csp", async (_req, reply) => {
    return reply.header("Content-Security-Policy", "default-src *; frame-ancestors *")
      .type("text/html").send("<!doctype html><title>Route policy fixture</title>");
  });
  instance.get("/*", async (req, reply) => {
    if (req.url.startsWith("/api/")) return { ok: true };
    return reply.type("text/html").send("<!doctype html><html><body>Dashboard</body></html>");
  });
  await instance.ready();
  return instance;
}

describe("security headers on isolated routes", () => {
  beforeEach(async () => {
    vi.stubEnv("NODE_ENV", "production");
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
    vi.unstubAllEnvs();
  });

  async function scriptSource(url: string): Promise<string> {
    const res = await app.inject({ method: "GET", url });
    expect(res.statusCode, url).toBe(200);
    return String(res.headers["content-security-policy"])
      .split("; ").find((directive) => directive.startsWith("script-src "))!;
  }

  describe("production script CSP", () => {
    it("uses only self on the SPA shell and SPA routes", async () => {
      for (const url of ["/index.html", "/dashboard", "/operator", "/unknown-spa-route"]) {
        expect(await scriptSource(url), url).toBe("script-src 'self'");
      }
    });

    it("uses only self on API and agent JSON responses", async () => {
      for (const url of ["/api/health", "/?mode=agent"]) {
        expect(await scriptSource(url), url).toBe("script-src 'self'");
      }
    });

    it("preserves inline scripts when the root serves the landing page", async () => {
      expect(await scriptSource("/")).toBe("script-src 'self' 'unsafe-inline'");
    });

    it("uses only self when the root falls back to the SPA shell", async () => {
      await app.close();
      app = await buildApp("/index.html");
      expect(await scriptSource("/")).toBe("script-src 'self'");
    });

    it("preserves inline script permission on explicitly listed static pages", async () => {
      for (const url of [
        "/commentary.html", "/driver-capture.html", "/driver.html", "/install.html",
        "/landing.html", "/onboard.html", "/operator-capture.html", "/operator-status.html",
        "/operator.html", "/order.html", "/pizza-llm-agent-prompt.html", "/pizza-llm-bootstrap.html",
        "/pizza-observability.html", "/pizza-onboard-driver.html", "/pizza-onboard-shop.html",
        "/pizza-onboard-user.html",
      ]) {
        expect(await scriptSource(url), url).toBe("script-src 'self' 'unsafe-inline'");
      }
    });

    it("preserves the UI kit static pages' inline script wiring", async () => {
      for (const url of ["/ui-kit/v1/shell.html", "/ui-kit/v1/example-manifests/demo-snapshot.html"]) {
        expect(await scriptSource(url), url).toBe("script-src 'self' 'unsafe-inline'");
      }
    });

    it("matches the exact static path after removing the query string", async () => {
      expect(await scriptSource("/operator.html?shop=example")).toBe("script-src 'self' 'unsafe-inline'");
      for (const url of ["/visualizer.html", "/pizza-demo-index.html", "/operator.html/", "/operator.html.json"]) {
        expect(await scriptSource(url), url).toBe("script-src 'self'");
      }
    });
  });

  it("keeps the existing script policy outside production", async () => {
    vi.stubEnv("NODE_ENV", "development");
    for (const url of ["/dashboard", "/api/health", "/operator.html"]) {
      expect(await scriptSource(url), url).toBe("script-src 'self' 'unsafe-inline'");
    }
  });

  it.each(["production", "development"])("overrides a route's own CSP without an explicit opt-in in %s", async (environment) => {
    vi.stubEnv("NODE_ENV", environment);
    const response = await app.inject({ method: "GET", url: "/route-csp" });
    const defaultResponse = await app.inject({ method: "GET", url: "/dashboard" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-security-policy"]).toBe(defaultResponse.headers["content-security-policy"]);
    expect(response.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  });
});

const PUBLIC_HTML_ROOT = fileURLToPath(new URL("../../../../apps/dashboard/public/", import.meta.url));

// HTML's JavaScript MIME types include the historical aliases as well as module.
// Parse the DOM without executing anything, so comments and quoted attributes do
// not turn into false positives and JSON data blocks never require unsafe-inline.
const JAVASCRIPT_TYPES = new Set([
  "application/ecmascript", "application/javascript", "application/x-ecmascript", "application/x-javascript",
  "text/ecmascript", "text/javascript", "text/javascript1.0", "text/javascript1.1", "text/javascript1.2",
  "text/javascript1.3", "text/javascript1.4", "text/javascript1.5", "text/jscript", "text/livescript",
  "text/x-ecmascript", "text/x-javascript",
]);

function hasExecutableInlineScript(html: string): boolean {
  const dom = new JSDOM(html);
  try {
    const document = dom.window.document;
    const executableScript = Array.from(document.querySelectorAll("script:not([src])")).some((script) => {
      const type = (script.getAttribute("type") ?? "").trim().toLowerCase();
      return type === "" || type === "module" || JAVASCRIPT_TYPES.has(type.split(";")[0]!.trim());
    });
    return executableScript || Array.from(document.querySelectorAll("*")).some((element) =>
      Array.from(element.attributes).some((attribute) =>
        /^on/i.test(attribute.name) || /^\s*javascript:/i.test(attribute.value.replace(/[\t\n\r]/g, "")),
      ),
    );
  } finally {
    dom.window.close();
  }
}

function publicHtmlFiles(directory = PUBLIC_HTML_ROOT): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? publicHtmlFiles(path) : entry.isFile() && entry.name.endsWith(".html") ? [path] : [];
  });
}

function cspScriptSource(header: unknown): string | undefined {
  return String(header).split(/;\s*/).find((directive) => directive.startsWith("script-src "));
}

describe("static HTML inline script CSP ratchet", () => {
  it("lists every public HTML file with executable inline script, including nested files", () => {
    const inlinePaths = publicHtmlFiles()
      .filter((path) => hasExecutableInlineScript(readFileSync(path, "utf8")))
      .map((path) => `/${relative(PUBLIC_HTML_ROOT, path).split(sep).join("/")}`)
      .sort();
    expect([...INLINE_SCRIPT_HTML_PATHS].sort()).toEqual(inlinePaths);
  });

  it.each([...INLINE_SCRIPT_HTML_PATHS])("listed path %s exists and has executable inline script", (path) => {
    const file = join(PUBLIC_HTML_ROOT, path.slice(1));
    expect(existsSync(file), path).toBe(true);
    expect(hasExecutableInlineScript(readFileSync(file, "utf8")), path).toBe(true);
  });

  it("recognizes classic and module scripts, but excludes data blocks and external scripts", () => {
    for (const type of [undefined, "", "module", "text/javascript", "application/javascript", "text/ecmascript", "text/javascript1.5"]) {
      const attribute = type === undefined ? "" : ` type="${type}"`;
      expect(hasExecutableInlineScript(`<script${attribute}>window.example = true;</script>`), String(type)).toBe(true);
    }
    for (const html of [
      '<script type="application/json">{"a":1}</script>',
      '<script type="application/ld+json">{"@type":"Thing"}</script>',
      '<script type="text/plain">window.example = true;</script>',
      '<script src="/example.js">window.example = true;</script>',
      '<!-- <script>window.example = true;</script> -->',
    ]) {
      expect(hasExecutableInlineScript(html), html).toBe(false);
    }
  });

  it("flags a fixture page whose only executable script is an event handler", () => {
    const fixturePage = '<!doctype html><title>Handler fixture</title><button onclick="window.example = true">Run</button>';
    expect(hasExecutableInlineScript(fixturePage)).toBe(true);
  });

  it("flags javascript URLs, including HTML-decoded and whitespace-normalized schemes", () => {
    for (const html of [
      '<a href="javascript:window.example = true">Run</a>',
      '<a href=" JAVASCRIPT:window.example = true">Run</a>',
      '<a href="java&#115;cript:window.example = true">Run</a>',
      '<a href="java&#10;script:window.example = true">Run</a>',
    ]) {
      expect(hasExecutableInlineScript(html)).toBe(true);
    }
  });
});

describe.each(["production", "development"] as const)("CSP through createGateway in %s", (environment) => {
  let gatewayApp: FastifyInstance | undefined;
  let dashboardPath: string | undefined;

  beforeAll(async () => {
    for (const [key, value] of Object.entries({
      NODE_ENV: environment,
      DATABASE_URL: ":memory:",
      PCC_DB_PATH: ":memory:",
      WORKFLOW_DB_PATH: ":memory:",
      PCC_SEED_DATA: "false",
      SERVE_DASHBOARD: "true",
      ENABLE_MOCK_STREAMING: "false",
      SETTLEMENT_KEEPER_ENABLED: "false",
      ERC8004_SWEEPER_DISABLED: "true",
      LIT_PROTOCOL_REAL: "false",
      SENTRY_DSN: "",
      VITE_SENTRY_DSN: "",
      POSTHOG_API_KEY: "",
      VITE_POSTHOG_KEY: "",
      COOKIE_SECRET: "n176r2-csp-test-cookie-secret-0123456789",
      PCC_MCP_APP_DOMAIN: "https://pcc-csp-mirror.example",
    })) vi.stubEnv(key, value);
    dashboardPath = mkdtempSync(join(tmpdir(), "pcc-n176r2-csp-"));
    // The shell's JSON-LD is a data block. Its actual executable script is external.
    writeFileSync(join(dashboardPath, "index.html"), '<!doctype html><title>CSP SPA fixture</title><script type="application/ld+json">{"@type":"Thing"}</script><script src="/assets/index.js"></script>');
    writeFileSync(join(dashboardPath, "landing.html"), readFileSync(join(PUBLIC_HTML_ROOT, "landing.html"), "utf8"));
    vi.stubEnv("DASHBOARD_PATH", dashboardPath);
    const { createGateway } = await import("../server.js");
    gatewayApp = (await createGateway(0)).app;
    await gatewayApp.ready();
  }, 120_000);

  afterAll(async () => {
    try {
      await gatewayApp?.close();
      const { stopDemandSnapshotCron } = await import("../routes/admin-demand.js");
      const { stopJobOffersSweeper } = await import("../services/job-offers-sweeper.js");
      const { resetKernelService } = await import("../services/kernel-service.js");
      stopDemandSnapshotCron();
      stopJobOffersSweeper();
      resetKernelService();
    } finally {
      vi.unstubAllEnvs();
      if (dashboardPath) rmSync(dashboardPath, { recursive: true, force: true });
    }
  });

  it.each(["/docs", "/docs/whitepaper", "/summit", "/docs/api/static/oauth2-redirect.html?state=n176r2"])("allows the executable inline scripts on %s", async (url) => {
    const response = await gatewayApp!.inject({ method: "GET", url });
    expect(response.statusCode, url).toBe(200);
    expect(response.headers["content-type"], url).toContain("text/html");
    expect(hasExecutableInlineScript(response.body), url).toBe(true);
    expect(cspScriptSource(response.headers["content-security-policy"]), url).toBe("script-src 'self' 'unsafe-inline'");
  });

  it("preserves the MCP mirror's nonce policy, matching its HTML and frame ancestors", async () => {
    const response = await gatewayApp!.inject({
      method: "GET", url: "/mcp-apps/ui/dashboard", headers: { host: "pcc-csp-mirror.example" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    const dom = new JSDOM(response.body);
    try {
      const nonce = dom.window.document.querySelector("script[nonce]")?.getAttribute("nonce");
      expect(nonce).toMatch(/^[A-Za-z0-9+/=_-]+$/);
      const { buildMcpAppCsp, MCP_APP_FRAME_ANCESTORS } = await import("../mcp/mcp-app-view.js");
      const ownPolicy = buildMcpAppCsp(nonce!);
      expect(dom.window.document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content")).toBe(ownPolicy);
      expect(response.headers["content-security-policy"]).toBe(`${ownPolicy}; frame-ancestors ${MCP_APP_FRAME_ANCESTORS}`);
      expect(cspScriptSource(response.headers["content-security-policy"])).toBe(`script-src 'nonce-${nonce}' 'strict-dynamic'`);
      // The global headers still apply; CSP frame-ancestors takes precedence
      // over XFO in browsers that support it.
      expect(response.headers["x-frame-options"]).toBe("DENY");
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.headers["x-xss-protection"]).toBe("1; mode=block");
      expect(response.headers["strict-transport-security"]).toBe(environment === "production" ? "max-age=31536000; includeSubDomains; preload" : undefined);
    } finally {
      dom.window.close();
    }
  });

  it.each(["/api/health", "/dashboard", "/index.html", "/?mode=agent", "/docs/whitepaper?format=md", "/docs/api/"])("keeps the environment's default script policy on %s", async (url) => {
    const response = await gatewayApp!.inject({ method: "GET", url });
    expect(response.statusCode, url).toBe(200);
    expect(cspScriptSource(response.headers["content-security-policy"]), url).toBe(environment === "production" ? "script-src 'self'" : "script-src 'self' 'unsafe-inline'");
    if (url === "/dashboard" || url === "/index.html") {
      expect(response.body, url).toContain("CSP SPA fixture");
      expect(hasExecutableInlineScript(response.body), url).toBe(false);
    }
  });

  it("preserves inline permission for the root landing alias", async () => {
    const response = await gatewayApp!.inject({ method: "GET", url: "/" });
    expect(response.statusCode).toBe(200);
    expect(hasExecutableInlineScript(response.body)).toBe(true);
    expect(cspScriptSource(response.headers["content-security-policy"])).toBe("script-src 'self' 'unsafe-inline'");
  });
});
