import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";
import { bindPolicyRouteSources, reviewedRouteSource, listQueryLabel } from "../mcp/dashboard-ir.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const kitSrc = readFileSync(path.resolve(here, "../../../../apps/dashboard/public/ui-kit/v1/pcc-ui.js"), "utf8");
type Route = { template: string; query: string[] };
type Node = { className: string; setAttribute: (name: string, value: string) => void };
function kitRoutes() {
  const m = kitSrc.match(/\/\/ <read-routes v1>[^\n]*\n([\s\S]*?)\/\/ <\/read-routes v1>/);
  expect(m).not.toBeNull();
  const ctx: Record<string, unknown> = {};
  vm.runInNewContext(kitSrc.slice(kitSrc.indexOf("  function dataAt("), kitSrc.indexOf("  function dot(")) + m![1] + "\nthis.routes = READ_ROUTES; this.match = readRouteMatch; this.stamp = stampSource;", ctx);
  return { routes: ctx.routes as Route[], match: ctx.match as (template: string, path: string) => boolean, stamp: ctx.stamp as (node: Node, token: string) => Node };
}

describe("the kit's read routes match the closed IR's bind policy", () => {
  it("the kit's route templates compile to exactly the bind policy's routes", () => {
    const { routes } = kitRoutes();
    expect([...new Set(routes.map((r) => reviewedRouteSource(r.template)))].sort()).toEqual(bindPolicyRouteSources());
  });

  it("the kit's matcher agrees with the IR's compiled routes on every probe path", () => {
    const { routes, match } = kitRoutes();
    const probes = ["/api/jobs", "/api/jobs/", "/api/jobsx", "/API/jobs", "/api/jobs/j1", "/api/jobs/j1/status", "/api/jobs/j1/statusx", "/api/jobs/j1/status/x", "/api/jobs/j-1.2~x_y", "/api/jobs/in-progress", "/api/jobs/abc1", "/api/kernels/marketplace", "/api/capabilities/search", "/api/capabilities/graph-x", "/api/capabilities/cap-1", "/sse/stream/job/j1", ""];
    for (const { template } of routes) for (const p of probes) {
      expect(match(template, p), template + " " + p).toBe(new RegExp(reviewedRouteSource(template)).test(p));
    }
  });

  it("every query key the kit allows is one the IR allows on that route", () => {
    const { routes } = kitRoutes();
    for (const { template, query } of routes) for (const key of query) expect(listQueryLabel(template, key)).toBe(key);
    for (const key of ["token", "asOf", "select", "apiKey"]) expect(routes.some((r) => r.query.includes(key))).toBe(false);
  });

  it("stampSource writes only its three tokens and unconfirmed", () => {
    const { stamp } = kitRoutes();
    const attrs: Record<string, string> = {};
    const node = { className: "pcc-win pcc-src-proposed pcc-src-ephemeral", setAttribute: (name: string, value: string) => { attrs[name] = value; } };
    for (const token of ["fixed", "authoritative", "proposed", "ephemeral", "unconfirmed"]) {
      expect(stamp(node, token)).toBe(node);
      const want = token === "fixed" ? "unconfirmed" : token;
      expect(attrs["data-source"]).toBe(want);
      expect(node.className.split(" ")).toEqual(["pcc-win", "pcc-src-" + want]);
    }
  });
});
