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
/** Own-property presence check for a dotted field path (test-local; mirrors the production
 * own-property traversal dashboard-ir-renderer.ts uses internally): is `field` present and
 * non-null on `row`? Used to prove a profile field is actually exercised by a real producer row
 * (astra r5 F5), not merely that whichever fields happen to be present never fail closed. */
function isPresent(row: unknown, field: string): boolean {
  let cur: unknown = row;
  for (const seg of field.split(".")) {
    if (cur === null || typeof cur !== "object" || Array.isArray(cur)) return false;
    if (!Object.prototype.hasOwnProperty.call(cur, seg)) return false;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur !== undefined && cur !== null;
}

let app: FastifyInstance;
/** GET /api/jobs lists only what the caller may read (#403, F3): this test reads it as an admin. */
const ADMIN = "ir-producers-admin";
const headersFor = (path: string) => (path === "/api/jobs" ? { "x-admin-key": ADMIN } : {});
beforeAll(async () => {
  process.env.PCC_ADMIN_KEY = ADMIN;
  initStore({ seed: true });
  app = Fastify({ logger: false });
  await app.register(cookie);
  await app.register(capabilityRoutes);
  await app.register(kernelRoutes);
  await app.register(jobRoutes);
  await app.ready();
});
afterAll(async () => { await app.close(); closeStore(); delete process.env.PCC_ADMIN_KEY; });

describe("#344 r5 typed list fields accept the REAL producers' rows (seeded store, route inject)", () => {
  for (const [path, prof] of Object.entries(LIST_PROFILES)) {
    it(`${path}: every profile field of every real row passes its kind (no row fails closed)`, async () => {
      const res = await app.inject({ method: "GET", url: path, headers: headersFor(path) });
      expect(res.statusCode).toBe(200);
      const data = res.json() as unknown;
      // The browser binder's own row extraction (dashboard-ir-browser-entry.ts uses listRowsOf).
      const rows = listRowsOf(path, data);
      expect(rows, `${path}: listRowsOf must find this route's own collection`).not.toBeNull(); // null = no collection, distinct from a real empty one (astra 28e H1)
      expect(rows!.length, `${path} returned no rows the binder can read`).toBeGreaterThan(0);
      for (const title of prof.title) {
        const listEl = fdoc.createElement("div");
        const props: Record<string, unknown> = { rowTitle: title, rowMeta: [...prof.meta] };
        if (prof.status.length) props.statusFrom = prof.status[0];
        bindListRows(fdoc, listEl, { type: "list", id: "n1", props, bind: { path } } as unknown as IrNode, rows!);
        expect((listEl.children as RElement[]).length, `${path} title=${title}: no rows rendered`).toBeGreaterThan(0);
        expect(leaves(listEl), `${path} title=${title}: a real row failed closed`).not.toContain(UNAVAILABLE);
      }
    });

    // astra r5 F5: the test above proves "no field that IS present ever fails closed" over
    // whichever fields happen to be present in the seeded rows; it does NOT prove every profile
    // field (title/meta/status) is actually exercised by a real producer. readListField treats
    // an absent field as "simply not shown" (never a failure), so a field that were NEVER present
    // in any real row would pass the test above silently. genui measured by route inject: jobs'
    // updatedAt is present in only 1/5 real rows (only the one completed job has a completedAt);
    // every other declared field is present in every real row of its route.
    it(`${path}: every profile field is present, non-null, in at least one real row`, async () => {
      const res = await app.inject({ method: "GET", url: path, headers: headersFor(path) });
      expect(res.statusCode).toBe(200);
      const rows = listRowsOf(path, res.json() as unknown);
      expect(rows, `${path}: listRowsOf must find this route's own collection`).not.toBeNull(); // null = no collection, distinct from a real empty one (astra 28e H1)
      expect(rows!.length, `${path} returned no rows`).toBeGreaterThan(0);
      const fields = new Set<string>([...prof.title, ...prof.meta, ...prof.status]);
      for (const field of fields) {
        const presentCount = rows!.filter((row) => isPresent(row, field)).length;
        expect(presentCount, `${path} field "${field}" is present in 0/${rows!.length} real rows (dead profile surface)`).toBeGreaterThan(0);
      }
    });
  }
});

describe("listRowsOf reads only the route's own rows key", () => {
  it("own key only, never a prototype key; a bare array (or any other shape) gives no rows", () => {
    expect(listRowsOf("/api/jobs", { jobs: [1, 2] })).toEqual([1, 2]);
    expect(listRowsOf("/api/jobs", { items: [1] })).toBeNull(); // another route's key — null = no collection, distinct from a real empty one (astra 28e H1)
    expect(listRowsOf("/api/kernels", Object.create({ kernels: [1] }))).toBeNull(); // inherited — null = no collection, distinct from a real empty one (astra 28e H1)
    // astra r5 F3: a bare array is no longer accepted as-is — only the route's own envelope key
    // is read; rows from anywhere else (including a top-level array) give no rows.
    expect(listRowsOf("/api/capabilities", [3])).toBeNull(); // bare array — null = no collection, distinct from a real empty one (astra 28e H1)
    expect(listRowsOf("/api/unknown", { items: [1] })).toBeNull(); // unknown path — null = no collection, distinct from a real empty one (astra 28e H1)
    expect(listRowsOf("/api/jobs", { jobs: "x" })).toBeNull(); // mistyped {jobs:"x"} — null = no collection, distinct from a real empty one (astra 28e H1)
    expect(listRowsOf("/api/jobs", { jobs: [] })).toEqual([]); // a real empty collection is still [] — the source explicitly returned it
  });
});
