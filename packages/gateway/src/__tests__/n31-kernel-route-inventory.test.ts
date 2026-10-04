/**
 * Board N31, #575 r2: the route inventory the steward asked for (#6493 (2), #6508 (1)). It reads
 * every production source file under packages/gateway/src with the TypeScript parser and checks:
 *
 *   A. Every write (insert, update or delete) of operator_policies or pending_approvals sits
 *      inside a route handler that calls the ONE kernel-ownership guard (auth/kernel-authority.ts).
 *      No such write exists outside a route.
 *   B. Every mutating route (POST, PUT, PATCH, DELETE) whose path names a :kernelId is guarded:
 *      its handler calls the guard (refuseKernelAction, or a same-file helper that does), or its
 *      plugin installs a preHandler hook that calls it before its first route. The rest must be
 *      EXACTLY the KNOWN_UNGUARDED list below (no more, no fewer), or one closed classification
 *      with an executable witness. A new unguarded kernel route fails CI; guarding one fails CI
 *      until it leaves the list. The stacked PR after #575 guards the KNOWN_UNGUARDED routes and
 *      empties the list.
 *
 * A probe source pins that the scanner sees each form it must (A and B, guarded and not).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import ts from "typescript";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// packages/gateway/src/__tests__ -> packages/gateway/src
const SRC_ROOT = path.join(__dirname, "..");
const MUTATING = new Set(["post", "put", "patch", "delete"]);
/**
 * The guards: auth/kernel-authority.ts's refuseKernelAction, and master's #400 relayAccessGuard
 * (routes/device-relay.ts: the relay plugin's preHandler, a default-deny per-route table over the
 * kernel's recorded operator). Unifying #400's ownership check into kernel-authority.ts is a
 * tracked follow-up.
 */
const GUARD_NAMES = new Set(["refuseKernelAction", "refuseKernelRequest", "relayAccessGuard"]);
const GUARDED_TABLES = new Set(["operatorPolicies", "pendingApprovals"]);

/**
 * Kernel routes with no ownership check yet, found by this inventory (bus #6505). The stacked PR
 * on #575 guards each and removes it from this list. Keys are "METHOD path".
 */
// The device relay is guarded on master by #400's relayAccessGuard (merged after #575 opened).
const KNOWN_UNGUARDED = new Set([
  "POST /api/kernels/:kernelId/heartbeat",
  "POST /api/kernels/:kernelId/capabilities",
  // The digital-kernel manifest's verify (kernel-marketplace.ts isAdminAuthorized) accepts a
  // builder "self-auth" from an x-agent-id header that any caller can send.
  "POST /api/kernels/:kernelId/verify",
]);

/**
 * Kernel-path routes that do not act on a shop kernel's operator controls, each with its own
 * check and an executable witness below. A closed set: adding one needs a witness test here.
 */
const CLASSIFIED: Record<string, { category: "digital_manifest_admin_only"; cite: string }> = {
  "POST /api/kernels/:kernelId/suspend": {
    category: "digital_manifest_admin_only",
    cite: "routes/kernel-marketplace.ts:401",
  },
};

interface RouteSite {
  key: string;
  file: string;
  line: number;
  guarded: boolean;
}

interface Scan {
  routes: RouteSite[];
  /** Writes of the guarded tables: where, and the route that encloses them (null: none). */
  writes: Array<{ file: string; line: number; route: RouteSite | null }>;
}

function isRouteCall(node: ts.Node): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    MUTATING.has(node.expression.name.text) &&
    node.arguments.length >= 2 &&
    ts.isStringLiteralLike(node.arguments[0]!)
  );
}

function callsAny(node: ts.Node, names: Set<string>): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && names.has(n.expression.text)) found = true;
    else ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

function scanSource(fileName: string, text: string): Scan {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

  // Same-file helpers that call the guard count as the guard (e.g. kernels.ts refuseOperate).
  const guards = new Set(GUARD_NAMES);
  let grew = true;
  while (grew) {
    grew = false;
    const visit = (n: ts.Node): void => {
      if (ts.isFunctionDeclaration(n) && n.name && !guards.has(n.name.text) && n.body && callsAny(n.body, guards)) {
        guards.add(n.name.text);
        grew = true;
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }

  // A plugin function whose preHandler hook calls the guard guards the routes registered after it.
  const hookStarts = new Map<ts.Node, number>();
  const findHooks = (n: ts.Node): void => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === "addHook" &&
      n.arguments.length >= 2 &&
      ts.isStringLiteralLike(n.arguments[0]!) &&
      n.arguments[0]!.text === "preHandler" &&
      (callsAny(n.arguments[1]!, guards) || (ts.isIdentifier(n.arguments[1]!) && guards.has(n.arguments[1]!.text)))
    ) {
      let fn: ts.Node | undefined = n.parent;
      while (fn && !ts.isFunctionLike(fn)) fn = fn.parent;
      if (fn && !hookStarts.has(fn)) hookStarts.set(fn, n.getStart(sf));
    }
    ts.forEachChild(n, findHooks);
  };
  findHooks(sf);

  const routes: RouteSite[] = [];
  const routeOf = new Map<ts.Node, RouteSite>();
  const findRoutes = (n: ts.Node): void => {
    if (isRouteCall(n)) {
      const method = (n.expression as ts.PropertyAccessExpression).name.text.toUpperCase();
      const url = (n.arguments[0] as ts.StringLiteralLike).text;
      const handler = n.arguments[n.arguments.length - 1]!;
      let fn: ts.Node | undefined = n.parent;
      while (fn && !ts.isFunctionLike(fn)) fn = fn.parent;
      const hookAt = fn ? hookStarts.get(fn) : undefined;
      const site: RouteSite = {
        key: `${method} ${url}`,
        file: fileName,
        line: lineOf(n),
        guarded: callsAny(handler, guards) || (hookAt !== undefined && hookAt < n.getStart(sf)),
      };
      routes.push(site);
      routeOf.set(n, site);
    }
    ts.forEachChild(n, findRoutes);
  };
  findRoutes(sf);

  const writes: Scan["writes"] = [];
  const findWrites = (n: ts.Node): void => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      ["insert", "update", "delete"].includes(n.expression.name.text) &&
      n.arguments.length >= 1
    ) {
      const target = n.arguments[0]!;
      const name = ts.isIdentifier(target) ? target.text : ts.isPropertyAccessExpression(target) ? target.name.text : null;
      if (name && GUARDED_TABLES.has(name)) {
        let route: RouteSite | null = null;
        for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
          const site = routeOf.get(p);
          if (site) {
            route = site;
            break;
          }
        }
        writes.push({ file: fileName, line: lineOf(n), route });
      }
    }
    ts.forEachChild(n, findWrites);
  };
  findWrites(sf);
  return { routes, writes };
}

function productionFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "__tests__" && entry.name !== "node_modules") out.push(...productionFiles(p));
    } else if (p.endsWith(".ts") && !p.endsWith(".test.ts") && !p.endsWith(".d.ts")) {
      out.push(p);
    }
  }
  return out;
}

function scanGateway(): Scan {
  const all: Scan = { routes: [], writes: [] };
  for (const file of productionFiles(SRC_ROOT)) {
    const s = scanSource(path.relative(SRC_ROOT, file), fs.readFileSync(file, "utf8"));
    all.routes.push(...s.routes);
    all.writes.push(...s.writes);
  }
  return all;
}

describe("N31 route inventory: the scanner sees what it must (probe)", () => {
  const probe = scanSource(
    "probe.ts",
    [
      'import { refuseKernelAction } from "../auth/kernel-authority.js";',
      "function refuseHelper(req: any, k: string) { return refuseKernelAction(req, {} as any, k, 'operate'); }",
      "export async function plain(app: any) {",
      '  app.post("/api/probe/:kernelId/open", async (req: any) => { db.insert(operatorPolicies).values({}); });',
      '  app.put<{ Params: { kernelId: string } }>(\n    "/api/probe/:kernelId/direct",\n    async (req: any) => { if (refuseKernelAction(req, {} as any, "k", "decide")) return; db.update(schema.pendingApprovals).set({}); },\n  );',
      '  app.patch("/api/probe/:kernelId/helper", async (req: any) => { if (refuseHelper(req, "k")) return; });',
      "}",
      "async function namedGuard(req: any) { refuseKernelAction(req, {} as any, 'k', 'operate'); }",
      "export async function byName(app: any) {",
      '  app.addHook("preHandler", namedGuard);',
      '  app.post("/api/probe/:kernelId/named-hook", async () => {});',
      "}",
      "export async function hooked(app: any) {",
      '  app.post("/api/probe/:kernelId/before-hook", async () => {});',
      '  app.addHook("preHandler", async (req: any) => { refuseKernelAction(req, {} as any, "k", "operate"); });',
      '  app.delete("/api/probe/:kernelId/after-hook", async () => {});',
      "}",
      "function loose() { db.delete(operatorPolicies); }",
    ].join("\n"),
  );
  const byKey = new Map(probe.routes.map((r) => [r.key, r.guarded]));

  it("tells guarded routes from unguarded ones, by handler, helper and plugin hook", () => {
    expect(Object.fromEntries(byKey)).toEqual({
      "POST /api/probe/:kernelId/open": false,
      "PUT /api/probe/:kernelId/direct": true,
      "PATCH /api/probe/:kernelId/helper": true,
      "POST /api/probe/:kernelId/named-hook": true,
      "POST /api/probe/:kernelId/before-hook": false,
      "DELETE /api/probe/:kernelId/after-hook": true,
    });
  });

  it("finds every write of the guarded tables, with its enclosing route or none", () => {
    expect(probe.writes.map((w) => [w.line, w.route?.key ?? null, w.route?.guarded ?? null])).toEqual([
      [4, "POST /api/probe/:kernelId/open", false],
      [7, "PUT /api/probe/:kernelId/direct", true],
      [21, null, null],
    ]);
  });
});

describe("N31 route inventory: packages/gateway/src", () => {
  const scan = scanGateway();

  it("found the gateway's routes (the scan is not empty)", () => {
    expect(scan.routes.length).toBeGreaterThan(300);
  });

  it("A: every write of operator_policies or pending_approvals is inside a guarded route", () => {
    expect(scan.writes.length).toBeGreaterThanOrEqual(8);
    const bad = scan.writes
      .filter((w) => !w.route || !w.route.guarded)
      .map((w) => `${w.file}:${w.line} (${w.route ? w.route.key : "outside any route"})`);
    expect(bad).toEqual([]);
  });

  it("B: every mutating :kernelId route is guarded, or exactly one of KNOWN_UNGUARDED or CLASSIFIED", () => {
    const kernelRoutes = scan.routes.filter((r) => r.key.includes(":kernelId"));
    const unguarded = kernelRoutes.filter((r) => !r.guarded && !(r.key in CLASSIFIED)).map((r) => r.key).sort();
    expect(unguarded).toEqual([...KNOWN_UNGUARDED].sort());
    for (const key of Object.keys(CLASSIFIED)) {
      const site = kernelRoutes.find((r) => r.key === key);
      expect(site, `${key} is still a route`).toBeDefined();
      expect(site!.guarded, `${key} is guarded now: drop it from CLASSIFIED`).toBe(false);
    }
    expect(kernelRoutes.filter((r) => r.guarded).map((r) => r.key).sort()).toEqual([
      "PATCH /api/operator/policy/:kernelId",
      "POST /api/relay/:kernelId/camera/frame",
      "POST /api/relay/:kernelId/chat",
      "POST /api/relay/:kernelId/chat/respond",
      "POST /api/relay/:kernelId/scope",
      "POST /api/relay/:kernelId/scope/:scopeId/revoke",
      "POST /api/relay/:kernelId/tool-call",
      "POST /api/relay/:kernelId/tool-call/:callId/start",
      "POST /api/relay/:kernelId/tool-result",
      "PUT /api/kernels/:kernelId/agent-package/configure",
      "PUT /api/operator/policy/:kernelId",
    ]);
  });
});

describe("N31 route inventory: the CLASSIFIED witnesses", () => {
  // digital_manifest_admin_only: suspend acts on the in-memory digital-kernel manifest registry,
  // not a shop kernel, and its own check requires X-Admin-Key whenever PCC_ADMIN_KEY is set.
  const PREV_ADMIN = process.env.PCC_ADMIN_KEY;
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.PCC_ADMIN_KEY = "n31-inventory-admin";
    const { kernelMarketplaceRoutes } = await import("../routes/kernel-marketplace.js");
    app = Fastify({ logger: false });
    await app.register(kernelMarketplaceRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    if (PREV_ADMIN === undefined) delete process.env.PCC_ADMIN_KEY;
    else process.env.PCC_ADMIN_KEY = PREV_ADMIN;
  });

  it("POST /api/kernels/:kernelId/suspend refuses a caller without the admin key", async () => {
    const reg = await app.inject({
      method: "POST",
      url: "/api/kernels/register",
      payload: {
        kernelId: "kernel-n31-inventory-manifest",
        name: "N31 inventory manifest",
        builder: { agentId: "builder-n31", name: "b" },
        endpoint: "https://example.invalid/n31",
        capabilities: ["n31.test"],
      },
    });
    const id = reg.statusCode === 201 ? "kernel-n31-inventory-manifest" : null;
    const res = await app.inject({ method: "POST", url: `/api/kernels/${id ?? "kernel-n31-inventory-missing"}/suspend`, payload: {} });
    expect([401, 404]).toContain(res.statusCode);
    if (id) expect(res.statusCode).toBe(401);
  });
});
