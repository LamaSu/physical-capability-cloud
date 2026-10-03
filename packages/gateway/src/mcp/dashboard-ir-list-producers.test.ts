import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { capabilityRoutes } from "../routes/capabilities.js";
import { kernelRoutes } from "../routes/kernels.js";
import { jobRoutes } from "../routes/jobs.js";
import { initStore, closeStore } from "../db.js";
import { LIST_PROFILES, listRowsOf } from "./dashboard-ir.js";
import type { IrNode } from "./dashboard-ir.js";
import { bindListRows, UNAVAILABLE } from "./dashboard-ir-renderer.js";
import type { RDocument, RElement } from "./dashboard-ir-renderer.js";

// genui review of #344 r5 (typed list fields): a mistyped field fails the WHOLE row closed, so the
// closed types must accept what the REAL producers return, or a real list silently blanks. Fixtures
// come from the live routes over the seeded store (route inject), never hand-written shapes.
type FakeEl = RElement & { attrs: Record<string, string> };
const fdoc: RDocument = { createElement(): RElement {
  const e: FakeEl = { textContent: "", className: "", children: [], attrs: {}, setAttr(n, v) { e.attrs[n] = v; }, appendChild(c) { e.children.push(c); return c; } };
  return e;
} };
const leaves = (e: RElement): string[] => [e.textContent, ...(e.children as RElement[]).flatMap(leaves)].filter((t) => t !== "");

let app: FastifyInstance;
beforeAll(async () => {
  initStore({ seed: true });
  app = Fastify({ logger: false });
  await app.register(cookie);
  await app.register(capabilityRoutes);
  await app.register(kernelRoutes);
  await app.register(jobRoutes);
  await app.ready();
});
afterAll(async () => { await app.close(); closeStore(); });

describe("#344 r5 typed list fields accept the REAL producers' rows (seeded store, route inject)", () => {
  for (const [path, prof] of Object.entries(LIST_PROFILES)) {
    it(`${path}: every profile field of every real row passes its kind (no row fails closed)`, async () => {
      const res = await app.inject({ method: "GET", url: path });
      expect(res.statusCode).toBe(200);
      const data = res.json() as unknown;
      // The browser binder's own row extraction (dashboard-ir-browser-entry.ts uses listRowsOf).
      const rows = listRowsOf(path, data);
      expect(rows.length, `${path} returned no rows the binder can read`).toBeGreaterThan(0);
      for (const title of prof.title) {
        const listEl = fdoc.createElement("div");
        const props: Record<string, unknown> = { rowTitle: title, rowMeta: [...prof.meta] };
        if (prof.status.length) props.statusFrom = prof.status[0];
        bindListRows(fdoc, listEl, { type: "list", id: "n1", props, bind: { path } } as unknown as IrNode, rows);
        expect((listEl.children as RElement[]).length, `${path} title=${title}: no rows rendered`).toBeGreaterThan(0);
        expect(leaves(listEl), `${path} title=${title}: a real row failed closed`).not.toContain(UNAVAILABLE);
      }
    });
  }
});

describe("listRowsOf reads only the route's own rows key", () => {
  it("own key only, never a prototype key; a bare array as is; anything else gives no rows", () => {
    expect(listRowsOf("/api/jobs", { jobs: [1, 2] })).toEqual([1, 2]);
    expect(listRowsOf("/api/jobs", { items: [1] })).toEqual([]); // another route's key
    expect(listRowsOf("/api/kernels", Object.create({ kernels: [1] }))).toEqual([]); // inherited
    expect(listRowsOf("/api/capabilities", [3])).toEqual([3]);
    expect(listRowsOf("/api/unknown", { items: [1] })).toEqual([]);
    expect(listRowsOf("/api/jobs", { jobs: "x" })).toEqual([]);
  });
});
