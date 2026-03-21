import type { FastifyInstance } from "fastify";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Serve project documentation as raw markdown or simple HTML.
 *
 * GET /docs/whitepaper     — PCC technical whitepaper
 * GET /docs/agent-guide    — Agent instructions for onboarding
 * GET /docs/csd-spec       — Capability StructureDefinition design spec
 * GET /docs/setup-spec     — Setup agent technical specification
 * GET /docs/story-plan     — Story Protocol integration plan
 */

function loadDoc(relativePath: string): string | null {
  // Try from project root (works in dev and Docker)
  for (const base of [
    resolve(process.cwd()),
    resolve(process.cwd(), ".."),
    resolve(process.cwd(), "../.."),
  ]) {
    const full = resolve(base, relativePath);
    if (existsSync(full)) {
      return readFileSync(full, "utf-8");
    }
  }
  return null;
}

function wrapHtml(title: string, markdown: string): string {
  // Simple markdown-to-html: headers, bold, code blocks, links, lists
  let html = markdown
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    // Code blocks (``` ... ```)
    .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code class="language-$1">$2</code></pre>')
    // Inline code
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    // Headers
    .replace(/^#### (.+)$/gm, "<h4>$1</h4>")
    .replace(/^### (.+)$/gm, "<h3>$1</h3>")
    .replace(/^## (.+)$/gm, "<h2>$1</h2>")
    .replace(/^# (.+)$/gm, "<h1>$1</h1>")
    // Bold
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    // Italic
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    // Horizontal rules
    .replace(/^---$/gm, "<hr>")
    // Line breaks → paragraphs
    .replace(/\n\n/g, "</p><p>")
    .replace(/\n/g, "<br>");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} — PCC</title>
  <style>
    :root { --bg: #0a0e1a; --fg: #e0e6ed; --accent: #4ade80; --card: #111827; --border: #1e293b; --code-bg: #1e293b; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Inter', -apple-system, sans-serif; background: var(--bg); color: var(--fg); line-height: 1.7; padding: 2rem; max-width: 900px; margin: 0 auto; }
    h1 { color: var(--accent); font-size: 2rem; margin: 2rem 0 1rem; border-bottom: 1px solid var(--border); padding-bottom: 0.5rem; }
    h2 { color: var(--accent); font-size: 1.5rem; margin: 1.8rem 0 0.8rem; }
    h3 { color: #94a3b8; font-size: 1.2rem; margin: 1.5rem 0 0.5rem; }
    h4 { color: #94a3b8; font-size: 1rem; margin: 1.2rem 0 0.4rem; }
    p { margin: 0.8rem 0; }
    a { color: var(--accent); }
    code { background: var(--code-bg); padding: 0.15em 0.4em; border-radius: 4px; font-size: 0.9em; }
    pre { background: var(--code-bg); padding: 1rem; border-radius: 8px; overflow-x: auto; margin: 1rem 0; }
    pre code { background: none; padding: 0; }
    strong { color: #f8fafc; }
    hr { border: none; border-top: 1px solid var(--border); margin: 2rem 0; }
    table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
    th, td { border: 1px solid var(--border); padding: 0.5rem 0.8rem; text-align: left; }
    th { background: var(--code-bg); color: var(--accent); }
    .nav { display: flex; gap: 1rem; margin-bottom: 2rem; flex-wrap: wrap; }
    .nav a { background: var(--card); border: 1px solid var(--border); padding: 0.5rem 1rem; border-radius: 6px; text-decoration: none; font-size: 0.85rem; }
    .nav a:hover { border-color: var(--accent); }
    .copy-btn { background: var(--accent); color: var(--bg); border: none; padding: 0.4rem 1rem; border-radius: 6px; cursor: pointer; font-size: 0.85rem; font-weight: 600; }
    .copy-btn:hover { opacity: 0.9; }
    .hero { text-align: center; margin: 2rem 0 3rem; }
    .hero h1 { border: none; font-size: 2.5rem; }
    .hero p { font-size: 1.1rem; color: #94a3b8; }
  </style>
</head>
<body>
  <nav class="nav">
    <a href="/docs/whitepaper">Whitepaper</a>
    <a href="/docs/agent-guide">Agent Guide</a>
    <a href="/docs/csd-spec">CSD Spec</a>
    <a href="/docs/setup-spec">Setup Spec</a>
    <a href="/docs/story-plan">Story Protocol</a>
    <a href="/docs/whitepaper?format=md">Raw MD</a>
  </nav>
  <article>
    <p>${html}</p>
  </article>
  <script>
    // Add copy buttons to code blocks
    document.querySelectorAll('pre').forEach(pre => {
      const btn = document.createElement('button');
      btn.className = 'copy-btn';
      btn.textContent = 'Copy';
      btn.onclick = () => { navigator.clipboard.writeText(pre.textContent); btn.textContent = 'Copied!'; setTimeout(() => btn.textContent = 'Copy', 2000); };
      pre.style.position = 'relative';
      btn.style.position = 'absolute';
      btn.style.top = '0.5rem';
      btn.style.right = '0.5rem';
      pre.appendChild(btn);
    });
  </script>
</body>
</html>`;
}

const DOCS: Record<string, { title: string; path: string }> = {
  whitepaper: { title: "Technical Whitepaper", path: "docs/WHITEPAPER.md" },
  "agent-guide": { title: "Agent Onboarding Guide", path: "packages/onboard-kit/AGENT_INSTRUCTIONS.md" },
  "csd-spec": { title: "Capability StructureDefinitions", path: "docs/CAPABILITY_PROFILES.md" },
  "setup-spec": { title: "Setup Agent Specification", path: "docs/SETUP_AGENT_SPEC.md" },
  "story-plan": { title: "Story Protocol Integration", path: "docs/STORY_PROTOCOL_INTEGRATION_PLAN.md" },
};

export async function docRoutes(app: FastifyInstance) {
  // Index page
  app.get("/docs", async (_req, reply) => {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>PCC Documentation</title>
  <style>
    :root { --bg: #0a0e1a; --fg: #e0e6ed; --accent: #4ade80; --card: #111827; --border: #1e293b; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Inter', -apple-system, sans-serif; background: var(--bg); color: var(--fg); padding: 2rem; max-width: 900px; margin: 0 auto; }
    .hero { text-align: center; margin: 3rem 0; }
    .hero h1 { color: var(--accent); font-size: 2.5rem; margin-bottom: 0.5rem; }
    .hero p { color: #94a3b8; font-size: 1.1rem; }
    .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 1rem; margin: 2rem 0; }
    .card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 1.5rem; text-decoration: none; color: var(--fg); transition: border-color 0.2s; }
    .card:hover { border-color: var(--accent); }
    .card h3 { color: var(--accent); margin-bottom: 0.5rem; }
    .card p { color: #94a3b8; font-size: 0.9rem; line-height: 1.5; }
    .agent-box { background: var(--card); border: 2px solid var(--accent); border-radius: 12px; padding: 1.5rem; margin: 2rem 0; }
    .agent-box h3 { color: var(--accent); margin-bottom: 0.5rem; }
    .agent-box p { color: #94a3b8; font-size: 0.9rem; margin-bottom: 1rem; }
    .copy-btn { background: var(--accent); color: var(--bg); border: none; padding: 0.6rem 1.5rem; border-radius: 8px; cursor: pointer; font-weight: 600; font-size: 0.9rem; }
    .copy-btn:hover { opacity: 0.9; }
    pre { background: #1e293b; padding: 1rem; border-radius: 8px; overflow-x: auto; margin: 0.5rem 0; font-size: 0.8rem; color: #e0e6ed; }
    a { color: var(--accent); }
  </style>
</head>
<body>
  <div class="hero">
    <h1>Physical Capability Cloud</h1>
    <p>AWS for the physical world — documentation &amp; specs</p>
  </div>

  <div class="agent-box">
    <h3>Hand This to Your Agent</h3>
    <p>Copy the agent onboarding guide and give it to any Claude Code / Cursor / LLM agent. It will walk through setting up a physical device on the PCC network.</p>
    <button class="copy-btn" id="copy-agent" onclick="copyAgentGuide()">Copy Agent Guide to Clipboard</button>
    <span id="copy-status" style="margin-left: 1rem; color: #94a3b8; font-size: 0.85rem;"></span>
    <br><br>
    <small><a href="/docs/agent-guide?format=md">View raw markdown</a> · <a href="/docs/agent-guide">View formatted</a></small>
  </div>

  <div class="cards">
    <a href="/docs/whitepaper" class="card">
      <h3>Technical Whitepaper</h3>
      <p>Full architecture: CSDs, agents, sovereign infrastructure, Story Protocol IP layer, economic model. The complete vision.</p>
    </a>
    <a href="/docs/csd-spec" class="card">
      <h3>Capability StructureDefinitions</h3>
      <p>FHIR for physical capabilities. Self-describing machines, auto-discovery, constraint propagation, URI-based registry.</p>
    </a>
    <a href="/docs/story-plan" class="card">
      <h3>Story Protocol Integration</h3>
      <p>IP ownership for physical work. Royalty flows, derivative chains, collaborative labor equity, revenue-generating NFTs.</p>
    </a>
    <a href="/docs/setup-spec" class="card">
      <h3>Setup Agent Spec</h3>
      <p>29 MCP tools, 6 A2A intents, SetupAgent class. The blueprint for zero-config device onboarding.</p>
    </a>
    <a href="/docs/agent-guide" class="card">
      <h3>Agent Onboarding Guide</h3>
      <p>12-step machine-readable guide. Hand to any LLM agent to onboard a device onto PCC.</p>
    </a>
  </div>

  <div style="text-align: center; margin: 3rem 0; color: #64748b;">
    <p><a href="/">← Back to Dashboard</a> · <a href="/.well-known/agent-registration.json">Agent Registration</a> · <a href="/.well-known/agent-card.json">Agent Card</a></p>
  </div>

  <script>
    async function copyAgentGuide() {
      try {
        const res = await fetch('/docs/agent-guide?format=md');
        const text = await res.text();
        await navigator.clipboard.writeText(text);
        document.getElementById('copy-status').textContent = 'Copied! Paste into your agent.';
        setTimeout(() => document.getElementById('copy-status').textContent = '', 3000);
      } catch(e) {
        document.getElementById('copy-status').textContent = 'Failed to copy — try the link instead.';
      }
    }
  </script>
</body>
</html>`;
    return reply.type("text/html").send(html);
  });

  // Individual doc routes
  for (const [slug, meta] of Object.entries(DOCS)) {
    app.get(`/docs/${slug}`, async (req, reply) => {
      const content = loadDoc(meta.path);
      if (!content) {
        return reply.status(404).send({ error: "doc_not_found", path: meta.path });
      }

      // Raw markdown if ?format=md
      const query = req.query as Record<string, string>;
      if (query.format === "md") {
        return reply.type("text/markdown; charset=utf-8").send(content);
      }

      // Rendered HTML
      return reply.type("text/html").send(wrapHtml(meta.title, content));
    });
  }
}
