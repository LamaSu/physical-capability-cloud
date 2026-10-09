import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";

const root = new URL("../../../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
const json = (path: string) => JSON.parse(read(path));
const artifactPath = "apps/dashboard/public/.well-known/agent.md";
const regenerate = "From packages/gateway run node --import tsx scripts/generate-agent-md.ts";

describe("generated agent golden path", () => {
  it("serves the committed bytes publicly with markdown and sibling cache headers", async () => {
    const { wellKnownAgentRoutes } = await import("../routes/well-known-agent.js");
    const app = Fastify({ logger: false });
    try {
      await app.register(wellKnownAgentRoutes);
      const response = await app.inject("/.well-known/agent.md");
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toBe("text/markdown; charset=utf-8");
      expect(response.headers["cache-control"]).toBe("public, max-age=300");
      expect(response.headers["access-control-allow-origin"]).toBe("*");
      expect(response.body).toBe(read(artifactPath));
    } finally {
      await app.close();
    }
  });

  it("registers the route plugin in server.ts as a statement, not a comment", () => {
    // Registration order does not decide publicness: every root hook, apiGate's included, reaches
    // the route (Fastify 4 adds root hooks to existing children). well-known-agent.gateway.test.ts
    // pins the behaviour through createGateway (Opus r1 F4).
    const server = read("packages/gateway/src/server.ts");
    expect(server).toMatch(/^ {2}await app\.register\(wellKnownAgentRoutes\);$/m);
    expect(server.endsWith("\n\n")).toBe(true);
  });

  it("serves agent.md alongside the production static registration without duplicate routes", async () => {
    const { default: staticPlugin } = await import("@fastify/static");
    const { wellKnownAgentRoutes } = await import("../routes/well-known-agent.js");
    const app = Fastify({ logger: false });
    const staticRoutes: string[] = [];
    app.addHook("onRoute", (route) => { staticRoutes.push(route.url); });
    try {
      await app.register(staticPlugin, {
        root: fileURLToPath(new URL("apps/dashboard/public/", root)),
        wildcard: false, index: false,
      });
      expect(staticRoutes.some((route) => route.startsWith("/.well-known/"))).toBe(false);
      await app.register(wellKnownAgentRoutes);
      const response = await app.inject("/.well-known/agent.md");
      expect(response.statusCode).toBe(200);
      expect(response.body).toBe(read(artifactPath));
      expect(read("packages/gateway/scripts/generate-agent-md.ts")).toContain(artifactPath);
    } finally {
      await app.close();
    }
  });

  it("advertises agent.md in the 404 body for an unknown /.well-known path", async () => {
    const { unimplementedWellKnownBody } = await import("../routes/well-known.js");
    expect(unimplementedWellKnownBody("/.well-known/nope.json")!.available).toContain("/.well-known/agent.md");
  });

  it("has no drift from the current committed sources", async () => {
    const { renderAgentMd } = await import("../docs/render-agent-md.js");
    const sources = {
      runbook: json("starter/runbook/runbook.json"),
      index: json("starter/runbook/index.json"),
      buyer: json("starter/buyer/buyer-path.json"),
      agentPackage: json("apps/dashboard/public/agent-package.json"),
    };
    expect(read(artifactPath), regenerate).toBe(renderAgentMd(sources));
    const changed = structuredClone(sources);
    changed.runbook.phases[0].goal = "test-phase-goal";
    changed.index.events["prerequisites.test"] = {
      ...changed.index.events["prerequisites.no-gateway"], do: "test-recovery",
    };
    changed.buyer.steps[0].goal = "test-buyer-goal";
    const rendered = renderAgentMd(changed);
    for (const value of ["test-phase-goal", "test-recovery", "test-buyer-goal"])
      expect(rendered).toContain(value);
    expect(rendered).not.toBe(read(artifactPath));
  });

  /**
   * The prose of a Markdown text outside fenced blocks and code spans. Spans are found by the renderer's own rule
   * (splitCodeSpans), so a malformed delimiter run throws here instead of being stripped (ChatGPT r1 L4).
   */
  const outsideCode = async (markdown: string) => {
    const { splitCodeSpans } = await import("../docs/render-agent-md.js");
    const prose: string[] = [];
    let fenced = false;
    for (const line of markdown.split("\n")) {
      if (line.startsWith("```")) fenced = !fenced;
      else if (!fenced) prose.push(splitCodeSpans(line).filter((_, index) => index % 2 === 0).join(""));
    }
    return prose.join("\n");
  };

  it("keeps every angle-bracket placeholder inside code, where rendered Markdown shows it", async () => {
    expect(await outsideCode(read(artifactPath))).not.toMatch(/<[^>\n]+>/);
  });

  it("finds code spans by the renderer's rule, so a malformed run fails instead of hiding a placeholder (ChatGPT r1 L4)", async () => {
    // ChatGPT r1 L4's second counterexample as 8d147b82 rendered it: a 3-backtick run, the placeholder, a 1-backtick
    // run. Stripping /`[^`\n]+`/ removed "`<phase>`"; CommonMark pairs neither run, so <phase> renders as a raw tag.
    await expect(outsideCode("See ```<phase>`")).rejects.toThrow(/run of backticks/);
    await expect(outsideCode("Then ``GET /api/x`` here.")).rejects.toThrow(/run of backticks/);
    await expect(outsideCode("Use \\`<phase>\\` here.")).rejects.toThrow(/escaped backtick/);
    await expect(outsideCode("Run `curl <base> once.")).rejects.toThrow(/Unbalanced backticks/);
    expect(await outsideCode("Keys `<phase>` and `GET /api/x/<id>`.")).toBe("Keys  and .");
    expect(await outsideCode("Keys <phase> here.")).toMatch(/<[^>\n]+>/);
    expect(await outsideCode(["```bash", "echo `<x>` ``", "```", "ok"].join("\n"))).toBe("ok");
  });

  it("wraps prose placeholders in code without splitting a route's code span", async () => {
    const { renderAgentMd } = await import("../docs/render-agent-md.js");
    const index = json("starter/runbook/index.json");
    // The route is not sentence-final: http() keeps a trailing period inside its code span.
    index.about = "Keys are <phase>.<event>; see GET /api/x/<id> first.";
    const rendered = renderAgentMd({
      runbook: json("starter/runbook/runbook.json"), index,
      buyer: json("starter/buyer/buyer-path.json"), agentPackage: json("apps/dashboard/public/agent-package.json"),
    });
    expect(rendered).toContain("`<phase>`.`<event>`");
    expect(rendered).toContain("`GET /api/x/<id>`");
  });

  describe("escapes every prose field the same way (Opus r1 F5)", () => {
    const render = async (edit: (sources: Record<string, any>) => void) => {
      const { renderAgentMd } = await import("../docs/render-agent-md.js");
      const sources: Record<string, any> = {
        runbook: json("starter/runbook/runbook.json"), index: json("starter/runbook/index.json"),
        buyer: json("starter/buyer/buyer-path.json"), agentPackage: json("apps/dashboard/public/agent-package.json"),
      };
      edit(sources);
      return renderAgentMd(sources as never);
    };

    it("keeps an existing code span whole, and wraps a bare route and placeholder in request and auth", async () => {
      const rendered = await render(({ buyer }) => {
        buyer.steps[0].actions[1].request = "Run `curl -H @.pcc/auth.header <base>/api/auth/validate` once. Then DELETE /api/auth/keys/<id> to revoke it.";
        buyer.steps[0].actions[1].auth = "send Bearer <key> to GET /api/auth/validate";
        buyer.steps[0].actions[1].response = "Then read GET /api/compose/<id> back.";
      });
      expect(rendered).toContain("Request: Run `curl -H @.pcc/auth.header <base>/api/auth/validate` once. Then `DELETE /api/auth/keys/<id>` to revoke it.");
      expect(rendered).toContain("Auth: send Bearer `<key>` to `GET /api/auth/validate`.");
      expect(rendered).toContain("Read response fields: valid, operatorId. Then read `GET /api/compose/<id>` back.");
    });

    it("never doubles a route already in a code span, and leaves a sentence-final period outside the span", async () => {
      const rendered = await render(({ buyer }) => {
        buyer.events["buyer.invalid-key"].do = "Call `GET /api/auth/validate` first.";
        buyer.steps[0].doneWhen[0] = "count < 5 and size > 3, then GET /api/auth/validate.";
      });
      const row = rendered.split("\n").find((line) => line.startsWith("| buyer.invalid-key |"));
      expect(row).toContain("| Call `GET /api/auth/validate` first. |");
      expect(row).not.toContain("``");
      expect(rendered).toContain("- count < 5 and size > 3, then `GET /api/auth/validate`.");
    });

    it("escapes a pipe in a report phase so the table row keeps three cells", async () => {
      const rendered = await render(({ index }) => {
        index.events["prerequisites.pipe-test"] = { trigger: "t", do: "d", report: { phase: "pha|se", outcome: "blocked" } };
      });
      const row = rendered.split("\n").find((line) => line.startsWith("| prerequisites.pipe-test |"));
      expect(row).toBe("| prerequisites.pipe-test | t | d Report pha\\|se blocked. |");
      expect(row?.replace(/\\\|/g, "").split("|")).toHaveLength(5);
    });

    it("refuses unbalanced backticks instead of rendering a broken span", async () => {
      await expect(render(({ buyer }) => { buyer.steps[0].actions[0].request = "Run `curl once."; }))
        .rejects.toThrow(/Unbalanced backticks/);
    });

    it("keeps an already formatted route whole, its placeholder included (ChatGPT r1 L4)", async () => {
      const rendered = await render(({ index }) => { index.about = "See `GET /api/x/<id>` first."; });
      expect(rendered).toContain("\nSee `GET /api/x/<id>` first.\n");
    });

    it("refuses backtick runs, escaped backticks and spans that would touch, which CommonMark reads differently (ChatGPT r1 L4)", async () => {
      const about = (text: string) => render(({ index }) => { index.about = text; });
      // ChatGPT r1 L4's counterexample: a double run read as an empty span rendered as "See ```<phase>`".
      await expect(about("See ``<phase>")).rejects.toThrow(/run of backticks/);
      // Matching runs make a valid CommonMark span and mismatched runs do not; the source contract allows neither.
      await expect(about("See ``GET /api/x`` first.")).rejects.toThrow(/run of backticks/);
      await expect(about("See ``code` here.")).rejects.toThrow(/run of backticks/);
      // An escaped backtick is a literal one in Markdown, never a delimiter.
      await expect(about("Use \\`GET /api/x\\` literally.")).rejects.toThrow(/escaped backtick/);
      // A placeholder or route wrapped right next to an existing span would render a double run.
      await expect(about("Keys <id>`code` here.")).rejects.toThrow(/run of backticks/);
      await expect(about("Call GET /api/x`code` here.")).rejects.toThrow(/run of backticks/);
    });
  });

  it("depends only on attempt_reporting from the agent package", async () => {
    const { renderAgentMd } = await import("../docs/render-agent-md.js");
    const sources = {
      runbook: json("starter/runbook/runbook.json"),
      index: json("starter/runbook/index.json"),
      buyer: json("starter/buyer/buyer-path.json"),
      agentPackage: json("apps/dashboard/public/agent-package.json"),
    };
    const original = renderAgentMd(sources);
    const changed = structuredClone(sources);
    changed.agentPackage.version = "unrelated-version";
    changed.agentPackage.tools.push({ name: "unrelated-tool" });
    changed.agentPackage.toolCount += 1;
    expect(renderAgentMd(changed)).toBe(original);
    expect(original).not.toMatch(/REST tool package version|\d+ tool definitions/);

    changed.agentPackage.attempt_reporting.tool = "changed_reporting_tool";
    changed.agentPackage.attempt_reporting.endpoint = { method: "PUT", path: "/reporting-test" };
    expect(renderAgentMd(changed)).toContain("Tool: `changed_reporting_tool` → `PUT /reporting-test`");
    expect(renderAgentMd(changed)).not.toBe(original);

    const isolated = { ...sources, agentPackage: { attempt_reporting: sources.agentPackage.attempt_reporting } };
    isolated.buyer = structuredClone(sources.buyer);
    isolated.buyer.reporting.route = "/buyer-only-report";
    isolated.runbook = structuredClone(sources.runbook);
    isolated.runbook.reporting.tool = "runbook-only-tool";
    expect(renderAgentMd(isolated)).toContain(
      `Tool: \`${sources.agentPackage.attempt_reporting.tool}\` → \`${sources.agentPackage.attempt_reporting.endpoint.method} ${sources.agentPackage.attempt_reporting.endpoint.path}\``,
    );
    expect(renderAgentMd(isolated)).not.toContain("Tool: `runbook-only-tool`");
  });

  it("describes blocked supply phases using their source checks without naming current phases", () => {
    const doc = read(artifactPath);
    expect(doc).toContain("When a phase's doneWhen says it reports blocked, report it blocked and continue to its next phase; later phases and the final session report still run.");
    expect(doc).not.toContain("verify and operate currently report blocked");
  });

  it("cites existing repo files without line anchors", () => {
    const buyer = json("starter/buyer/buyer-path.json");
    for (const action of [...buyer.steps.flatMap((step: { actions: unknown[] }) => step.actions), buyer.reporting]) {
      for (const path of action.sources) {
        expect(path, "Sources must be repo-relative file paths").not.toMatch(/^(?:\/|https?:)|#L/);
        expect(existsSync(new URL(path, root)), `Missing source file: ${path}`).toBe(true);
      }
    }
  });

  it("deduplicates each action's citations", async () => {
    const { renderAgentMd } = await import("../docs/render-agent-md.js");
    const buyer = json("starter/buyer/buyer-path.json");
    buyer.steps = [buyer.steps[0]];
    buyer.steps[0].actions = [{ ...buyer.steps[0].actions[0], sources: [
      "packages/gateway/src/routes/provision.ts", "packages/gateway/src/routes/provision.ts",
    ] }];
    const rendered = renderAgentMd({
      runbook: json("starter/runbook/runbook.json"), index: json("starter/runbook/index.json"),
      buyer, agentPackage: json("apps/dashboard/public/agent-package.json"),
    });
    const citations = rendered.split("\n").find((line) => line.startsWith("Gateway source:"));
    expect(citations?.match(/\[provision\.ts\]/g)).toHaveLength(1);
    expect(rendered).not.toMatch(/blob\/master\/[^)\s]+#L\d+/);
  });

  it("prescribes a short path with verification, no production default, and a spending stop", () => {
    const doc = read(artifactPath);
    const runbook = json("starter/runbook/runbook.json");
    expect(doc.split("\n").length).toBeLessThan(400);
    expect(doc).toContain(runbook.askingRule);
    expect(doc).toContain(runbook.target.rule);
    expect(doc).toMatch(/Never claim success until.*verified/);
    expect(doc).toMatch(/explicit.*approval/i);
    expect(doc).toContain("This composed plan carries no binding quote.");
    expect(doc).toContain("starter/bin/pcc-report");
    for (const phase of runbook.phases) expect(doc).toContain(`starter/runbook/${phase.file}`);
    for (const id of Object.keys(json("starter/runbook/index.json").events)) expect(doc).toContain(id);
    const buyer = json("starter/buyer/buyer-path.json");
    expect(buyer.steps.map((step: { id: string }) => step.id)).toEqual([
      "get-key", "discover", "compose", "read-plan", "handoff",
    ]);
    expect(buyer.steps.at(-1).terminal).toBe(true);
    expect(doc).toContain("STOP — handoff");
    expect(doc).not.toContain("STOP — stop");
    for (const event of Object.values(buyer.events) as Array<{ phase: string }>)
      expect(event.phase).not.toBe("stop");
    expect(buyer.steps.flatMap((step: { actions: unknown[] }) => step.actions))
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ tool: "execute_composition" })]));
  });

  it("cites only tools in the agent package and pairs every buyer tool with its real endpoint", () => {
    const doc = read(artifactPath);
    const pack = json("apps/dashboard/public/agent-package.json");
    const tools = new Map(pack.tools.map((tool: { name: string; endpoint: { method: string; path: string } }) => [tool.name, tool]));
    const cited = [...doc.matchAll(/Tool: `([^`]+)`/g)].map((match) => match[1]);
    expect(cited.length).toBeGreaterThan(5);
    for (const tool of cited) expect(tools.has(tool), `Missing tool ${tool}`).toBe(true);
    const buyer = json("starter/buyer/buyer-path.json");
    for (const step of buyer.steps) {
      expect(step.goal && step.doneWhen.length).toBeTruthy();
      expect(Array.isArray(step.asksHuman)).toBe(true);
      for (const action of step.actions) {
        if (!action.tool) continue; // Direct HTTP: /ask, validate, and provisioning (no tool may return its secrets).
        const tool = tools.get(action.tool) as { endpoint: { method: string; path: string } };
        expect(tool, action.tool).toBeDefined();
        expect({ method: action.method, path: action.route }).toEqual(tool.endpoint);
      }
    }
  });

  it("documents optional provisioning publicKey and once-only private-key handling", () => {
    const provision = json("starter/buyer/buyer-path.json").steps[0].actions[0];
    expect(provision.request).toMatch(/locally generated Ed25519 publicKey.*64 hex.*optional 0x/);
    expect(provision.request).toContain("publicKey is optional");
    expect(provision.request).toContain("ed25519.private_key once");
    expect(provision.request).toContain("private 0600 file and never print it");
    expect(provision.storeOnlyFields).toContain("ed25519.private_key (only when publicKey was omitted)");
    expect(provision.responseFields.join(" ")).not.toContain("private_key");
  });

  it("renders an action's recipe as a bash block and its store-only fields on their own line", async () => {
    const { renderAgentMd } = await import("../docs/render-agent-md.js");
    const buyer = json("starter/buyer/buyer-path.json");
    buyer.steps = [buyer.steps[0]];
    buyer.steps[0].actions = [
      { ...buyer.steps[0].actions[0], request: "Send it.", recipe: ["first line", "second line"],
        responseFields: ["visible"], storeOnlyFields: ["secret_a", "secret_b (when present)"] },
      { ...buyer.steps[0].actions[1], recipe: undefined, storeOnlyFields: undefined },
    ];
    const rendered = renderAgentMd({
      runbook: json("starter/runbook/runbook.json"), index: json("starter/runbook/index.json"),
      buyer, agentPackage: json("apps/dashboard/public/agent-package.json"),
    });
    expect(rendered).toContain([
      "Request: Send it.", "", "```bash", "first line", "second line", "```", "",
      "Read response fields: visible.", "Store only, never read into the conversation: secret_a, secret_b (when present).",
    ].join("\n"));
    // An action without a recipe or store-only fields renders exactly as before.
    const validate = rendered.slice(rendered.indexOf("Direct HTTP → `GET /api/auth/validate`"));
    expect(validate.split("\n").slice(0, 4).join("\n")).not.toMatch(/```|Store only/);
  });

  it("uses pcc_report's canonical request and accepts deduplicated feedback without an id", () => {
    const buyer = json("starter/buyer/buyer-path.json");
    const tool = json("apps/dashboard/public/agent-package.json").tools
      .find((tool: { name: string }) => tool.name === "pcc_report");
    expect(buyer.reporting.tool).toBe(tool.name);
    expect({ method: buyer.reporting.method, path: buyer.reporting.route }).toEqual(tool.endpoint);
    for (const field of ["type", "summary", "endpoint", "method", "status", "errorCode", "traceId"]) {
      expect(tool.input_schema.properties).toHaveProperty(field);
      expect(buyer.reporting.request).toContain(field);
      expect(buyer.events["buyer.server-failure"].do).toContain(field);
    }
    expect(buyer.reporting.request).toContain('type: "bug"');
    expect(buyer.reporting.response).toContain("HTTP 200 {status, submitted: false, deduped: true, message} with no id");
    expect(buyer.reporting.request).not.toContain("message:");
  });

  it("scopes quotes and estimates to the composed plan and preserves the approval handoff", () => {
    const buyer = json("starter/buyer/buyer-path.json");
    const scope = "This composed plan carries no binding quote. A per-capability negotiated quote exists outside this path; committing it creates a job and escrow, so it needs the human's approval.";
    expect(buyer.quoteLimit).toContain(scope);
    expect(buyer.steps.find((step: { id: string }) => step.id === "compose").doneWhen.join(" ")).toContain(scope);
    expect(buyer.steps.at(-1).doneWhen.join(" ")).toContain(scope);
    // Opus r1 I2: without the compose facade any key holder can add candidates, so the handoff
    // says the assignments, not only the prices, are unverified.
    expect(buyer.steps.at(-1).doneWhen.join(" "))
      .toContain("the capability assignments and prices come from this gateway's candidate pool and are not verified");
    for (const fact of ["maximum base cost per job", "Per-unit charges are ignored", "estimate can be high or low", "this gateway's capability candidates", "not verified prices", "without currency conversion"])
      expect(buyer.quoteLimit).toContain(fact);
    expect(buyer.quoteLimit).not.toMatch(/\/api\/dev|\/api\/test|\b[A-Z][A-Z0-9]+_[A-Z0-9_]+\b/);
    expect(buyer.steps.flatMap((step: { actions: Array<{ route: string }> }) => step.actions)
      .some((action: { route: string }) => action.route.startsWith("/api/negotiate"))).toBe(false);
  });

  it("describes discovered composition steps and unresolved operator bindings accurately", () => {
    const action = json("starter/buyer/buyer-path.json").steps
      .find((step: { id: string }) => step.id === "compose").actions[0];
    expect(action.request).toContain("Build steps from discovered capability types");
    expect(action.request).toContain("outcomeType alone must itself be a capability type");
    expect(action.request).toContain("outcomeChain plans only its last entry");
    expect(action.response).toContain("Graph-derived steps always have an empty operatorAddress");
    expect(action.response).toContain("catalog steps can too when the kernel lookup fails");
  });

  it("handles throttling and any-route failures and limits public search to 20 results", () => {
    const buyer = json("starter/buyer/buyer-path.json");
    expect(buyer.events["buyer.key-limit"].do).toContain("retry_after_seconds or the Retry-After header");
    expect(buyer.events["buyer.key-limit"].do).toContain("limit counts rejected (400) attempts too");
    const failure = buyer.events["buyer.server-failure"];
    expect(failure.phase).toBe("any");
    for (const code of ["provision_failed", "INTERNAL_ERROR", "internal_error"])
      expect(failure.trigger).toContain(code);
    expect(failure.do).toContain("If the body has report_hint, send the report it describes once through pcc_report");
    expect(buyer.events["buyer.payment-required"].phase).toBe("any");
    expect(buyer.events["buyer.payment-required"].trigger).toBe("If any route answers 402");
    const search = buyer.steps.flatMap((step: { actions: Array<{ route: string }> }) => step.actions)
      .find((action: { route: string }) => action.route === "/ask");
    expect(search.response).toContain("at most 20 results");
  });

  it("cites only HTTP routes registered by the gateway", async () => {
    // Register real route plugins, never invoke their physical or payment handlers.
    const names = {
      provision: "provisionRoutes", capabilities: "capabilityRoutes", compose: "composeRoutes",
      feedback: "feedbackRoutes", health: "healthRoutes", kernels: "kernelRoutes",
      "identify-device": "identifyDeviceRoutes", setup: "setupRoutes", operator: "operatorRoutes",
      "operator-status": "operatorStatusRoutes", "operator-relay": "operatorRelayRoutes",
      "paid-job-flow": "paidJobFlowRoutes", "well-known-aeo": "wellKnownAeoRoutes",
      "job-submit": "jobSubmitRoutes", "well-known-agent": "wellKnownAgentRoutes",
    };
    const app = Fastify({ logger: false });
    const routes = new Set<string>();
    const normalized = (path: string) => path.split("?")[0]
      .replace(/<[^>]+>|\{[^}]+\}|:[\w]+/g, ":param");
    app.addHook("onRoute", (route) => {
      for (const method of [route.method].flat()) routes.add(`${method} ${normalized(route.url)}`);
    });
    try {
      const server = read("packages/gateway/src/server.ts");
      for (const [file, name] of Object.entries(names)) {
        expect(server).toContain(`await app.register(${name})`);
        const modulePath = fileURLToPath(new URL(`../routes/${file}.ts`, import.meta.url));
        const module = await import(/* @vite-ignore */ modulePath);
        await app.register(module[name]);
      }
      await app.ready();
      const doc = read(artifactPath);
      const cited = [...doc.matchAll(/\b(GET|POST|PUT|PATCH|DELETE)\s+(?:\$PCC_BASE|<gateway>)?(\/[^\s`"|,;)]+)/g)];
      expect(cited.length).toBeGreaterThan(10);
      for (const [, method, path] of cited)
        expect(routes.has(`${method} ${normalized(path)}`), `Unregistered route: ${method} ${path}`).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("guards agent.md and the integration reference in the Docker asset-presence list", () => {
    const assets = read("Dockerfile").match(/RUN set -e;\s*\\\s*for f in\s*\\([\s\S]*?); do/)?.[1];
    expect(assets).toBeDefined();
    expect(assets).toContain("apps/dashboard/public/.well-known/agent.md");
    expect(assets).toContain("docs/AGENT_INTEGRATION.md");
  });

  it("has no Docker ignore line that excludes the agent.md artifact", () => {
    const patterns = read(".dockerignore").split("\n").map((line) => line.trim());
    for (const pattern of patterns) {
      expect(pattern).not.toMatch(/^(?:\*\*\/\*\.md\*?|apps\/?|apps\/dashboard.*|\*\*\/\.well-known.*)$/);
      expect(pattern).not.toBe("apps/dashboard/public/.well-known/agent.md");
    }
  });
});
