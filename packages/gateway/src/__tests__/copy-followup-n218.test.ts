import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeStore, getRepos } from "../db.js";
import { provisionApiKey } from "../auth/api-key-auth.js";
import { suggestTools } from "../services/tool-suggestions.js";

// Use the real gateway, including auth and async response hooks, without start()/listen().
describe("gateway copy follow-up", () => {
  let app: FastifyInstance;
  let dashboardPath: string;
  let adminKey: string;

  beforeAll(async () => {
    for (const [key, value] of Object.entries({
      NODE_ENV: "test",
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
      COOKIE_SECRET: "copy-followup-test-cookie-secret-0123456789",
    })) vi.stubEnv(key, value);
    dashboardPath = mkdtempSync(join(tmpdir(), "pcc-copy-followup-"));
    writeFileSync(join(dashboardPath, "index.html"), "<!doctype html><title>PCC test</title>");
    vi.stubEnv("DASHBOARD_PATH", dashboardPath);
    closeStore();
    const { createGateway } = await import("../server.js");
    ({ app } = await createGateway(0));
    await app.ready();
    adminKey = provisionApiKey({ operatorId: "copy-followup-admin", name: "copy-followup", scopes: ["admin"] }).rawKey;
  }, 120_000);

  afterAll(async () => {
    try {
      await app?.close();
      const { stopDemandSnapshotCron } = await import("../routes/admin-demand.js");
      const { stopJobOffersSweeper } = await import("../services/job-offers-sweeper.js");
      const { resetKernelService } = await import("../services/kernel-service.js");
      stopDemandSnapshotCron();
      stopJobOffersSweeper();
      resetKernelService();
      closeStore();
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      if (dashboardPath) rmSync(dashboardPath, { recursive: true, force: true });
    }
  });

  it("T1: serves the type-template description and an optional unused query", async () => {
    const response = await app.inject({ method: "GET", url: "/api/agent/tools", headers: { authorization: `Bearer ${adminKey}` } });
    expect(response.statusCode).toBe(200);
    const { tools } = response.json();
    const search = tools.find((tool: { name: string }) => tool.name === "search_capabilities");
    expect(search.description).toBe(SEARCH_TEXT);
    expect(search.input_schema.required).toEqual([]);
    expect(search.input_schema.properties.query.description).toBe(QUERY_TEXT);
    expect(response.body).not.toContain("Search capability templates by type or keyword.");
    expect(tools.map((tool: { name: string }) => tool.name)).not.toContain("get_depin_stats");
  });

  it("T2: describes ot_list_protocols as fixed example templates with an unused filter", () => {
    const tool = suggestTools(["opentrons"], [], false).tools.find((tool) => tool.name === "ot_list_protocols");
    expect(tool).toBeDefined();
    expect(tool!.description).toBe(PROTOCOL_TEXT);
    expect(tool!.inputSchema.properties.capabilityType.description).toBe(CAPABILITY_TEXT);
  });

  it("T3: serves all 22 complete cells and the two role lines without reward promises", async () => {
    const response = await app.inject({ method: "GET", url: "/agent-context-pack" });
    expect(response.statusCode).toBe(200);
    for (const [method, path, oldText, newText] of CONTEXT_CELLS) {
      expect(response.body, `${method} ${path}`).toContain(`| ${newText} |`);
      expect(response.body, `${method} ${path}`).not.toContain(`| ${oldText} |`);
      expect(response.body.split("\n")).toContain(`| ${method} | ${path} | ${newText} |`);
    }
    const lines = response.body.split("\n");
    expect(lines).toContain("- **Operator Agent**: Help them onboard equipment, configure kernels, manage jobs");
    expect(lines).toContain("- **Verifier Agent**: Help them verify evidence bundles, stake reputation");
    expect(response.body).not.toContain("earn rewards");
    expect(response.body).not.toContain("earn verification rewards");
  });

  it("T4: omits both toolCount keys and keeps discovery urls", async () => {
    const response = await app.inject({ method: "GET", url: "/?mode=agent" });
    expect(response.statusCode).toBe(200);
    const { agentPackage, mcp } = response.json().discovery;
    expect(agentPackage).not.toHaveProperty("toolCount");
    expect(mcp).not.toHaveProperty("toolCount");
    expect(agentPackage.url).toBe("https://capability.network/agent-package.json");
    expect(mcp.transport).toBe("stdio");
    expect(mcp.discovery).toBe("https://capability.network/.well-known/mcp");
    expect(mcp.serverCard).toBe("https://capability.network/.well-known/mcp/server-card.json");
  });

  it("T7: serves an unavailable balance with the per-unit payment sentence", async () => {
    const response = await app.inject({ method: "GET", url: "/api/treasury/summary", headers: { authorization: `Bearer ${adminKey}` } });
    expect(response.statusCode).toBe(501);
    expect(response.json().error).toBe("not_available");
    // The generic 5xx report_hint contains /api/feedback; check the route-owned body.
    const { report_hint, ...body } = response.json();
    expect(report_hint.how).toBe("POST /api/feedback");
    expect(JSON.stringify(body)).not.toMatch(/fee/i);
    expect(response.json().message).toContain("Real payment state is per settlement unit, in the escrow.");
  });

  it("T9: serves the settlement examples and admin scope without reward epochs", async () => {
    const response = await app.inject({ method: "GET", url: "/.well-known/agent-card.json" });
    expect(response.statusCode).toBe(200);
    const card = response.json();
    const settle = card.skills.find((skill: { id: string }) => skill.id === "pcc-settle");
    expect(settle.examples).not.toContain("Check DePIN reward epoch and claim operator rewards");
    expect(settle.examples).toEqual([
      "Fund escrow for contract cap_xyz with 50 USDC on Base Sepolia",
      "Release milestone payment after verified evidence",
    ]);
    expect(settle.description).not.toContain("DePIN reward epochs");
    expect(card.securitySchemes.siwe.flows.authorizationCode.scopes.admin).toBe("Admin-level access (slash bonds)");
    expect(response.body).not.toMatch(/reward epoch/i);
  });

  it("T10: serves exactly the 25 retained tool names in their original order", async () => {
    const response = await app.inject({ method: "GET", url: "/api/agent/tools", headers: { authorization: `Bearer ${adminKey}` } });
    expect(response.statusCode).toBe(200);
    const names = response.json().tools.map((tool: { name: string }) => tool.name);
    for (const retired of ["list_protocols", "get_depin_stats", "get_marketplace_overview", "get_logistics_overview"]) {
      expect(names).not.toContain(retired);
    }
    expect(names).toEqual([
      "list_capability_types",
      "search_capabilities",
      "get_build_options",
      "calculate_price",
      "build_contract",
      "list_jobs",
      "get_job",
      "list_kernels",
      "get_kernel",
      "list_escrows",
      "get_escrow",
      "get_operator_dashboard",
      "list_batches",
      "list_evidence",
      "get_subnet_status",
      "get_wallet_balance",
      "get_funding_options",
      "create_onramp_session",
      "get_provider_rates",
      "get_withdraw_channels",
      "submit_withdrawal",
      "get_ramp_activity",
      "get_credit_balance",
      "buy_credits",
      "send_enterprise_payout",
    ]);
  });
  it.each(["options", "price", "contract"])("T5: build/%s sends one missing-capability 404 without a second send or rejection", async (route) => {
    const warnings: unknown[][] = [];
    const rejections: unknown[] = [];
    const observed = new Set<FastifyInstance["log"]>();
    const spies: Array<{ mockRestore(): void }> = [];
    // Fastify requests use child loggers: capture warn on the root AND every child.
    const capture = (logger: FastifyInstance["log"]) => {
      if (observed.has(logger)) return;
      observed.add(logger);
      spies.push(vi.spyOn(logger, "warn").mockImplementation((...args: unknown[]) => { warnings.push(args); }));
      const child = logger.child.bind(logger);
      spies.push(vi.spyOn(logger, "child").mockImplementation((...args: Parameters<typeof child>) => {
        const result = child(...args);
        capture(result);
        return result;
      }));
    };
    capture(app.log);
    const onRejection = (reason: unknown) => { rejections.push(reason); };
    process.on("unhandledRejection", onRejection);
    try {
      const response = await app.inject({
        method: "POST",
        url: `/api/build/${route}`,
        headers: { authorization: `Bearer ${adminKey}` },
        payload: { type: "copy-followup-unknown-type", selections: {}, ...(route === "contract" ? { assuranceTier: 0 } : {}) },
      });
      // The base's rejection is emitted AFTER inject resolves.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(response.statusCode).toBe(404);
      expect(response.json().error).toBe("capability_not_buildable");
      expect(response.json().message).toEqual(expect.any(String));
      expect(warnings).toEqual([]);
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
      for (const spy of spies.reverse()) spy.mockRestore();
    }
  });

  it("T8: lists a stored escrow without inventing a jobId", async () => {
    const now = new Date().toISOString();
    const row = getRepos().escrows.insert({
      id: "copy-followup-escrow",
      cwmId: "copy-followup-cwm",
      contractAddress: "0x1111111111111111111111111111111111111111",
      payer: "0x2222222222222222222222222222222222222222",
      totalAmount: "1000000",
      currency: "USDC",
      status: "created",
      createdAt: now,
      deadline: new Date(Date.now() + 86_400_000).toISOString(),
    });
    expect(row).toBeDefined();
    expect(row).not.toHaveProperty("jobId");
    const response = await app.inject({
      method: "GET",
      url: "/api/escrow",
      headers: { authorization: `Bearer ${adminKey}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().escrows).toHaveLength(1);
    const escrow = response.json().escrows[0];
    expect(escrow.id).toBe("copy-followup-escrow");
    expect(escrow).not.toHaveProperty("jobId");
  });

});

const SEARCH_TEXT = "List the built-in capability type templates: each type's name, version, description, parameter count, parameter group names and a base price hint. NOTE: these describe types, not operators' offerings, and carry no assurance tiers or availability. The gateway does not read the query, so it never narrows the list. Registered capabilities of a type are listed by GET /api/capabilities?type=<type>.";

const QUERY_TEXT = "Optional and not used: the gateway returns the full list whatever you send.";

const PROTOCOL_TEXT = "List protocol templates. NOTE: the gateway currently serves only a fixed set of built-in example templates; templates sent to create_protocol are not stored, so they do not appear here";

const CAPABILITY_TEXT = "Optional and not used: the gateway returns its built-in example list whatever you send.";

const CONTEXT_CELLS = [
  [
    "GET",
    "/api/protocols/:id",
    "Get protocol template",
    "Get a protocol template by id: its steps, transfers and parameters. NOTE: the gateway currently knows only its built-in example templates"
  ],
  [
    "POST",
    "/api/protocols",
    "Create a new protocol template",
    "Create a protocol template draft. NOTE: the gateway currently stores no template; an id in its reply is not found by any protocol route"
  ],
  [
    "PUT",
    "/api/protocols/:id",
    "Update a protocol template",
    "Update a protocol template. NOTE: the gateway currently stores no change, and it knows only its built-in example templates"
  ],
  [
    "POST",
    "/api/protocols/:id/publish",
    "Publish a protocol",
    "Publish a protocol template. NOTE: the gateway currently stores no change, so nothing becomes visible to anyone"
  ],
  [
    "POST",
    "/api/protocols/:id/fork",
    "Fork a protocol",
    "Fork a protocol template. NOTE: the gateway currently stores no fork; no protocol route accepts the forkId in its reply"
  ],
  [
    "GET",
    "/api/protocols/:id/forks",
    "List forks of a protocol",
    "List forks of a protocol template. NOTE: the gateway currently serves a fixed built-in example list of forks, not anyone's real fork"
  ],
  [
    "GET",
    "/api/protocols/:id/runs",
    "List runs of a protocol",
    "List protocol runs. NOTE: the gateway currently serves only a fixed built-in example list of runs; runs from create_protocol_run are not stored, so they do not appear"
  ],
  [
    "POST",
    "/api/protocols/:id/runs",
    "Start a new protocol run",
    "Request a run of a protocol template. NOTE: the gateway currently stores no run and sends nothing to any kernel: a runId in its reply is not found by get_protocol_run or any other run tool. It knows only its built-in example templates."
  ],
  [
    "POST",
    "/api/protocols/:id/validate",
    "Validate a protocol",
    "Check a built-in example protocol template against a fixed list of capability types. NOTE: the gateway currently does not look at any kernel: kernelId is only echoed back, so the result says nothing about whether a real kernel can run the template. Ids from create_protocol are not found."
  ],
  [
    "GET",
    "/api/protocol-runs/:runId",
    "Get protocol run details",
    "Get a protocol run by id. NOTE: the gateway currently knows only a fixed built-in example list of runs, whose step progress and evidence hashes are example values, not a record of real work. Run ids from create_protocol_run are not found."
  ],
  [
    "POST",
    "/api/protocol-runs/:runId/start",
    "Start a protocol run",
    "Start a protocol run. NOTE: the gateway currently knows only a fixed built-in example run, which it already shows as running, so that run cannot be started; any other id, including a runId from create_protocol_run, is unknown to it. Nothing starts on any kernel."
  ],
  [
    "POST",
    "/api/protocol-runs/:runId/pause",
    "Pause a protocol run",
    "Pause a protocol run. NOTE: the gateway currently stores no change: for its built-in example run the reply says paused, but get_protocol_run still shows it running and resume_protocol_run refuses it. Any other id is unknown to it. Nothing is paused on any kernel."
  ],
  [
    "POST",
    "/api/protocol-runs/:runId/resume",
    "Resume a protocol run",
    "Resume a paused protocol run. NOTE: the gateway currently stores no change, so no run is ever paused: its built-in example run stays shown as running and is refused, and any other id is unknown to it."
  ],
  [
    "POST",
    "/api/protocol-runs/:runId/cancel",
    "Cancel a protocol run",
    "Cancel a protocol run. NOTE: the gateway currently stores no change: for its built-in example run the reply says cancelled, but get_protocol_run still shows it running, and the same call answers the same way again. Any other id is unknown to it. Nothing stops on any kernel."
  ],
  [
    "GET",
    "/api/orchestrator/graphs",
    "List transfer graphs",
    "List transfer graphs. NOTE: the gateway currently serves one fixed example lab graph, not a real kernel's"
  ],
  [
    "GET",
    "/api/orchestrator/graphs/:kernelId",
    "Get kernel transfer graph",
    "Get a kernel's transfer graph. NOTE: the gateway currently knows only its one example lab kernel"
  ],
  [
    "GET",
    "/api/orchestrator/samples/:sampleId",
    "Get sample routing info",
    "Get sample routing info. NOTE: the gateway currently serves only fixed example samples"
  ],
  [
    "GET",
    "/api/orchestrator/claims",
    "List orchestrator claims",
    "List resource claims. NOTE: the gateway currently serves only fixed example claims"
  ],
  [
    "POST",
    "/api/orchestrator/workflows",
    "Create an orchestration workflow",
    "Request an orchestration workflow. NOTE: the gateway currently stores no workflow; GET /api/orchestrator/workflows/:workflowId never finds the id in its reply"
  ],
  [
    "GET",
    "/api/orchestrator/workflows/:workflowId",
    "Get workflow details",
    "Get workflow details. NOTE: the gateway currently knows only its fixed example workflows"
  ],
  [
    "GET",
    "/api/treasury/summary",
    "Treasury balance and allocation",
    "Not implemented (501): no treasury balance is read"
  ],
  [
    "POST",
    "/api/rewards/claims",
    "Claim DePIN rewards",
    "Not implemented (501): no reward claims are recorded"
  ]
] as const;
