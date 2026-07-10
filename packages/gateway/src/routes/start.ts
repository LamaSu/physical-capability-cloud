/**
 * /start — three-card landing for Claude Max users.
 *
 * The Claude Max front-door reframe (owner ask, 2026-06-19): "people
 * should be able to use their max accounts and just feed claude the
 * agent package". This route is the visual entry — a plain HTML page
 * with three cards (Claude Code / Claude Desktop / Claude.ai web) and
 * a one-line copy-paste for each surface.
 *
 * Sister docs:
 *   docs/quickstart/README.md
 *   docs/quickstart/claude-code.md
 *   docs/quickstart/claude-desktop.md
 *   docs/quickstart/claude-web.md
 *
 * PUBLIC. No auth.
 */

import type { FastifyInstance } from "fastify";

const START_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>PCC - Get Started in Claude</title>
  <meta name="description" content="Use Physical Capability Cloud through Claude Max. Three surfaces, one agent-package, transact in plain English." />
  <style>
    :root {
      --bg: #0b0f17;
      --fg: #e6edf3;
      --muted: #8b949e;
      --card: #161b22;
      --border: #30363d;
      --accent: #58a6ff;
      --accent-soft: rgba(88, 166, 255, 0.1);
      --code-bg: #0d1117;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: var(--bg);
      color: var(--fg);
      line-height: 1.6;
      min-height: 100vh;
    }
    .container {
      max-width: 1100px;
      margin: 0 auto;
      padding: 64px 24px;
    }
    .hero {
      text-align: center;
      margin-bottom: 64px;
    }
    .hero h1 {
      font-size: 2.5rem;
      margin: 0 0 16px;
      font-weight: 600;
    }
    .hero p {
      font-size: 1.15rem;
      color: var(--muted);
      max-width: 680px;
      margin: 0 auto;
    }
    .hero a { color: var(--accent); text-decoration: none; }
    .hero a:hover { text-decoration: underline; }
    .cards {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
      gap: 24px;
      margin-bottom: 48px;
    }
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 28px;
      display: flex;
      flex-direction: column;
    }
    .card-tag {
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--accent);
      background: var(--accent-soft);
      padding: 4px 10px;
      border-radius: 4px;
      display: inline-block;
      margin-bottom: 12px;
      width: fit-content;
    }
    .card h2 {
      font-size: 1.35rem;
      margin: 0 0 8px;
      font-weight: 600;
    }
    .card-summary {
      color: var(--muted);
      margin-bottom: 16px;
      flex-grow: 1;
    }
    .card-code {
      background: var(--code-bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 12px;
      font-family: "SFMono-Regular", Consolas, monospace;
      font-size: 0.85rem;
      color: var(--fg);
      overflow-x: auto;
      margin-bottom: 16px;
      white-space: pre;
    }
    .card-link {
      color: var(--accent);
      text-decoration: none;
      font-size: 0.9rem;
      font-weight: 500;
    }
    .card-link:hover { text-decoration: underline; }
    .footer {
      text-align: center;
      color: var(--muted);
      font-size: 0.9rem;
      margin-top: 48px;
    }
    .footer a { color: var(--accent); text-decoration: none; }
    .footer a:hover { text-decoration: underline; }
    .ascii-art {
      font-family: monospace;
      color: var(--accent);
      white-space: pre;
      text-align: center;
      margin-bottom: 24px;
      font-size: 0.8rem;
      opacity: 0.6;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="hero">
      <div class="ascii-art">PCC | Physical Capability Cloud</div>
      <h1>Use PCC through Claude</h1>
      <p>
        PCC is open infrastructure for agents to buy and sell from each other - anything,
        not just digital goods. Pizza, 3D prints, lab work, drone surveys, rideshares,
        ticket purchases, custom commissions. Pick your Claude surface below; transact in plain English.
      </p>
    </div>

    <div class="cards">
      <div class="card">
        <span class="card-tag">Recommended</span>
        <h2>Claude Code</h2>
        <p class="card-summary">
          Install the PCC skill once. Then in any Claude Code session, ask for what you want -
          Claude routes through PCC.
        </p>
        <div class="card-code">/skills install https://capability.network/skills/pcc.md</div>
        <a class="card-link" href="/quickstart/claude-code">Full walkthrough -></a>
      </div>

      <div class="card">
        <span class="card-tag">63 tools</span>
        <h2>Claude Desktop</h2>
        <p class="card-summary">
          Add the PCC MCP server. Claude Desktop picks up 63 tools spanning kernels, jobs,
          escrow, fiat ramps, the whole stack.
        </p>
        <div class="card-code">{
  "mcpServers": {
    "pcc": {
      "command": "node",
      "args": ["packages/mcp-server/dist/index.js"],
      "env": {"PCC_URL": "https://capability.network"}
    }
  }
}</div>
        <a class="card-link" href="/quickstart/claude-desktop">Full walkthrough -></a>
      </div>

      <div class="card">
        <span class="card-tag">No install</span>
        <h2>Claude.ai (web)</h2>
        <p class="card-summary">
          Paste the agent-package URL into a Claude.ai conversation. Claude reads the system
          prompt and uses WebFetch to transact.
        </p>
        <div class="card-code">Use this spec for real-world transactions:
https://capability.network/agent-package.json

Then: order me a pizza for delivery to ...</div>
        <a class="card-link" href="/quickstart/claude-web">Full walkthrough -></a>
      </div>
    </div>

    <div class="footer">
      <p>
        <a href="/agent-package.json">agent-package.json</a> &middot;
        <a href="/skills/pcc.md">skill source</a> &middot;
        <a href="/.well-known/agent-card.json">A2A card</a> &middot;
        <a href="https://capability.network">capability.network</a>
      </p>
      <p>
        New: your agent can generate a live dashboard mid-task - it emits a
        <a href="/ui-kit/v1/manifest.schema.json">manifest</a>, saves it, and shares a
        live <code>/a/&lt;slug&gt;</code> page rendered by the
        <a href="/ui-kit/v1/pcc-ui.js">pcc-ui kit</a>. Ask it to "keep me posted" on any order.
      </p>
      <p>
        Building programmatically? See
        <a href="https://www.npmjs.com/package/@pcc/decompose-skill">@pcc/decompose-skill</a>,
        <a href="https://www.npmjs.com/package/@pcc/operator-agent-runtime">@pcc/operator-agent-runtime</a>,
        <a href="https://www.npmjs.com/package/@pcc/evidence-judge">@pcc/evidence-judge</a>.
      </p>
    </div>
  </div>
</body>
</html>
`;

export async function startRoutes(app: FastifyInstance): Promise<void> {
  // /start — the visual three-card landing.
  app.get("/start", async (_req, reply) => {
    reply
      .header("content-type", "text/html; charset=utf-8")
      .header("access-control-allow-origin", "*")
      .header("cache-control", "public, max-age=300, s-maxage=300");
    return START_HTML;
  });

  // /quickstart/* — server-side redirects to the docs in the repo. These
  // are served as plain markdown via GitHub (or via the dashboard if it
  // chooses to host them); the redirect keeps the URL short.
  const quickstartRedirects: Record<string, string> = {
    "/quickstart": "https://github.com/LamaSu/physical-capability-cloud/blob/master/docs/quickstart/README.md",
    "/quickstart/claude-code": "https://github.com/LamaSu/physical-capability-cloud/blob/master/docs/quickstart/claude-code.md",
    "/quickstart/claude-desktop": "https://github.com/LamaSu/physical-capability-cloud/blob/master/docs/quickstart/claude-desktop.md",
    "/quickstart/claude-web": "https://github.com/LamaSu/physical-capability-cloud/blob/master/docs/quickstart/claude-web.md",
  };

  for (const [path, target] of Object.entries(quickstartRedirects)) {
    app.get(path, async (_req, reply) => {
      reply
        .header("access-control-allow-origin", "*")
        .header("cache-control", "public, max-age=300, s-maxage=300");
      return reply.redirect(target, 302);
    });
  }
}
