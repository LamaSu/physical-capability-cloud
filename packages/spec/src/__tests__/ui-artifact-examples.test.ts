/**
 * On-Ramp Wave 2 — the shipped example manifests double as tests + LLM
 * few-shots. This suite parses each canonical example at
 * apps/dashboard/public/ui-kit/v1/example-manifests/ against the real
 * DashboardManifestSchema, and pins the negative invariants the schema exists
 * to enforce:
 *   - a manifest carrying a pcc_live_/pcc_test_ substring anywhere is REJECTED
 *     (the no-key refine — a shared artifact travels with its contents);
 *   - Action.confirm has no "none" (a human click is the confirm step);
 *   - the served JSON-Schema mirror (manifest.schema.json) still lists every
 *     window kind the Zod union defines (it must not silently rot).
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { DashboardManifestSchema, DASHBOARD_CSD_URL } from "../types/ui-artifact.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const kitDir = path.resolve(here, "../../../../apps/dashboard/public/ui-kit/v1");
const examplesDir = path.join(kitDir, "example-manifests");

function readJson(p: string): unknown {
  return JSON.parse(readFileSync(p, "utf8"));
}

const EXAMPLE_FILES = ["job-watch.json", "chain.json", "operator.json"];

describe("ui-kit example manifests validate against DashboardManifestSchema", () => {
  for (const file of EXAMPLE_FILES) {
    it(`${file} is a valid manifest`, () => {
      const manifest = readJson(path.join(examplesDir, file));
      const result = DashboardManifestSchema.safeParse(manifest);
      if (!result.success) {
        throw new Error(`${file} failed: ${JSON.stringify(result.error.flatten(), null, 2)}`);
      }
      expect(result.success).toBe(true);
    });
  }

  it("every *.json in example-manifests/ parses as a valid manifest (no stragglers)", () => {
    const jsons = readdirSync(examplesDir).filter((f) => f.endsWith(".json"));
    expect(jsons.sort()).toEqual([...EXAMPLE_FILES].sort());
    for (const f of jsons) {
      const r = DashboardManifestSchema.safeParse(readJson(path.join(examplesDir, f)));
      expect(r.success, `${f} should validate`).toBe(true);
    }
  });

  it("job-watch exercises metric+run+receipt; chain exercises the chain window; operator exercises list+metric", () => {
    const kinds = (file: string) =>
      new Set(
        (readJson(path.join(examplesDir, file)) as { sections: { windows: { kind: string }[] }[] }).sections.flatMap(
          (s) => s.windows.map((w) => w.kind),
        ),
      );
    const jw = kinds("job-watch.json");
    expect(jw.has("metric") && jw.has("run") && jw.has("receipt")).toBe(true);
    expect(kinds("chain.json").has("chain")).toBe(true);
    const op = kinds("operator.json");
    expect(op.has("list") && op.has("metric")).toBe(true);
  });
});

describe("DashboardManifestSchema negative invariants", () => {
  it("rejects a manifest containing a pcc_live_ substring ANYWHERE (no-key refine)", () => {
    const bad = {
      csd: DASHBOARD_CSD_URL,
      title: "Leaky dashboard",
      sections: [
        { windows: [{ kind: "note", text: "here is my key pcc_live_deadbeefcafe do not do this" }] },
      ],
    };
    const r = DashboardManifestSchema.safeParse(bad);
    expect(r.success).toBe(false);
  });

  it("rejects a pcc_test_ substring in a binding path too", () => {
    const bad = {
      csd: DASHBOARD_CSD_URL,
      title: "Leaky binding",
      sections: [
        {
          windows: [
            { kind: "metric", label: "x", binding: { path: "/api/x?token=pcc_test_abc123" }, format: "int" },
          ],
        },
      ],
    };
    expect(DashboardManifestSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects Action.confirm = "none" (no auto-fire path exists)', () => {
    const bad = {
      csd: DASHBOARD_CSD_URL,
      title: "Auto-fire",
      sections: [
        {
          windows: [
            {
              kind: "actions",
              actions: [
                {
                  id: "a1",
                  label: "Fund",
                  kind: "post",
                  path: "/api/escrow/fund",
                  confirm: "none",
                  intentText: "pcc: fund",
                },
              ],
            },
          ],
        },
      ],
    };
    expect(DashboardManifestSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects an unknown window kind (the union is closed)", () => {
    const bad = {
      csd: DASHBOARD_CSD_URL,
      title: "Unknown kind",
      sections: [{ windows: [{ kind: "iframe", src: "https://evil.example" }] }],
    };
    expect(DashboardManifestSchema.safeParse(bad).success).toBe(false);
  });
});

describe("served JSON-Schema mirror stays in sync", () => {
  it("manifest.schema.json is valid JSON and lists every window kind the Zod union defines", () => {
    const mirror = readJson(path.join(kitDir, "manifest.schema.json")) as {
      definitions: { Window: { oneOf: { properties: { kind: { const: string } } }[] } };
    };
    const mirrorKinds = new Set(mirror.definitions.Window.oneOf.map((o) => o.properties.kind.const));
    const zodKinds = new Set([
      "note",
      "metric",
      "capability",
      "list",
      "form",
      "run",
      "approval",
      "receipt",
      "chain",
      "actions",
    ]);
    expect(mirrorKinds).toEqual(zodKinds);
  });
});
