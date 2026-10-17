import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CsdSchema, type CSD } from "../csd/schema.js";
import { EVIDENCE_PRIMITIVES, getPrimitive } from "../evidence/primitives.js";
import { compileTierLadder } from "../evidence/tier-ladder.js";

function csd(id: string, params?: Record<string, unknown>): CSD {
  return CsdSchema.parse({
    url: "pcc://capabilities/closed-empty-test/v1", version: "1.0.0", status: "active",
    name: "Closed-empty params test", description: "Compile-only fixture", kind: "base",
    baseDefinition: null, adapter: { type: "liquid-handler" }, parameters: [], constraints: [],
    pricing: { basePrice: "1.00", currency: "USD" },
    evidence: {
      tier0: { description: "Declaration", required: [] },
      tier1: { description: "Loaded input", required: ["method_loaded"], primitives: [{ id, bind: "method_loaded", ...(params === undefined ? {} : { params }) }] },
    },
  });
}

const closedEmpty = EVIDENCE_PRIMITIVES.filter((def) =>
  def.paramsSchema.additionalProperties === false &&
  (def.paramsSchema.properties === undefined ||
    (def.paramsSchema.properties !== null && typeof def.paramsSchema.properties === "object" && Object.keys(def.paramsSchema.properties).length === 0)),
);

describe("closed-empty primitive params at tier compilation", () => {
  it.each(closedEmpty)("$id refuses every non-empty params record", async ({ id }) => {
    for (const params of [{ field: "otherField" }, { role: "supporting" }, { unused: null }]) {
      await expect(compileTierLadder(csd(id, params))).rejects.toMatchObject({ code: "primitive-params-not-allowed" });
    }
    await expect(compileTierLadder(csd(id))).resolves.toHaveProperty("version", 1);
    await expect(compileTierLadder(csd(id, {}))).resolves.toHaveProperty("version", 1);
  });

  it("preflights every shipped CSD against the closed-empty rule without changing its existing compile result", async () => {
    const dir = new URL("../csds/", import.meta.url);
    const files = readdirSync(dir).filter((f) => f.endsWith(".csd.json")).sort();
    expect(files).toHaveLength(10);
    for (const file of files) {
      const shipped = CsdSchema.parse(JSON.parse(readFileSync(new URL(file, dir), "utf8")));
      for (const tier of Object.values(shipped.evidence ?? {})) {
        for (const ref of tier.primitives ?? []) {
          const schema = getPrimitive(ref.id)?.paramsSchema;
          if (schema?.additionalProperties === false && (schema.properties === undefined ||
            (schema.properties !== null && typeof schema.properties === "object" && Object.keys(schema.properties).length === 0))) {
            expect(Object.keys(ref.params ?? {}), `${file}: ${ref.id}`).toEqual([]);
          }
        }
      }
      if (file === "document-print-and-mail.csd.json" || file === "document-print-leg.csd.json") {
        await expect(compileTierLadder(shipped)).resolves.toHaveProperty("version", 1);
      } else {
        await expect(compileTierLadder(shipped)).rejects.toMatchObject({ code: "tier-adds-no-event-type" });
      }
    }
  });
});
