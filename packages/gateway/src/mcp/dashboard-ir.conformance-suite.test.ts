/**
 * Runs the four standalone closed-IR conformance proofs under vitest, so CI executes them.
 *
 * Each proof asserts with node:assert and throws on its first failure, so importing it runs it
 * and any failed check fails the test. Before this file, nothing ran them: vitest only collects
 * *.test.ts, and their documented `node --experimental-strip-types` invocation broke when the
 * modules moved to NodeNext `.js` import specifiers (Node's strip-types mode cannot map those
 * back to `.ts`). Run one by hand with `npx tsx <file>`.
 */
import { describe, it } from "vitest";

describe("closed-IR conformance proofs (run in CI)", () => {
  it("dashboard-ir: closed catalog, strict rejection, governed bindings", async () => {
    await import("./dashboard-ir.conformance.js");
  });
  it("renderer: frozen dispatch, textContent-only sinks, own-property binds", async () => {
    await import("./dashboard-ir-renderer.conformance.js");
  });
  it("binder: GET-only, fixed-origin, one-in-flight, teardown", async () => {
    await import("./dashboard-ir-binder.conformance.js");
  });
  it("route-inventory: every static sibling of a bindable id template is rejected (scans the REAL routes)", async () => {
    await import("./dashboard-ir.route-inventory.conformance.js");
  });
});
