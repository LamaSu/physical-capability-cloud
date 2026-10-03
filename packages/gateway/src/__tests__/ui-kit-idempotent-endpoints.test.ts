/**
 * Pins the kit's closed DURABLY_IDEMPOTENT_MONEY_WRITES list (apps/dashboard/public/ui-kit/v1/pcc-ui.js)
 * to the gateway's own IDEMPOTENCY_ROUTES set (packages/gateway/src/middleware/idempotency.ts).
 *
 * astra r4 F1 on #342: after an unresolved money outcome, the kit refuses every further money
 * request from the view, INCLUDING an identical retry -- except on an endpoint it believes the
 * gateway dedupes on its own. If the two lists ever drift (the kit trusting a route the gateway no
 * longer covers, or the gateway covering a route the kit has not yet allowlisted), the kit's
 * fail-closed guarantee silently weakens in one direction or needlessly over-blocks in the other.
 * This test has no opinion on what the list SHOULD contain; it only proves the two sources agree.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { IDEMPOTENCY_ROUTES } from "../middleware/idempotency.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const kitSrc = readFileSync(path.resolve(here, "../../../../apps/dashboard/public/ui-kit/v1/pcc-ui.js"), "utf8");
const DURABLE_LITERAL = /var DURABLY_IDEMPOTENT_MONEY_WRITES = \[([\s\S]*?)\];/;

function kitDurableRoutes(): string[] {
  const m = DURABLE_LITERAL.exec(kitSrc);
  if (!m) return [];
  return Array.from(m[1]!.matchAll(/'(POST|PATCH) ([^']+)'/g)).map((x) => `${x[1]} ${x[2]}`);
}

describe("ui-kit <-> gateway: DURABLY_IDEMPOTENT_MONEY_WRITES == IDEMPOTENCY_ROUTES (astra r4 F1 on #342)", () => {
  it("the kit's closed durable-retry list is a real array literal naming at least one route", () => {
    expect(DURABLE_LITERAL.test(kitSrc), "DURABLY_IDEMPOTENT_MONEY_WRITES literal not found in pcc-ui.js").toBe(true);
    const entries = kitDurableRoutes();
    expect(entries.length).toBeGreaterThan(0);
  });

  it("equals the gateway's IDEMPOTENCY_ROUTES set EXACTLY (same members, no more, no fewer)", () => {
    const kitRoutes = kitDurableRoutes();
    const gatewayRoutes = Array.from(IDEMPOTENCY_ROUTES);
    expect(new Set(kitRoutes)).toEqual(new Set(gatewayRoutes));
    // Also catch an accidental duplicate in the kit's own literal: it would pass the Set compare
    // above but silently mean the kit's list is not what its source visually claims.
    expect(kitRoutes.length, "duplicate entry in the kit's DURABLY_IDEMPOTENT_MONEY_WRITES literal").toBe(new Set(kitRoutes).size);
  });
});
