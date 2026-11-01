import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { beforeAll, describe, expect, it } from "vitest";
import { LIST_PROFILES } from "../mcp/dashboard-ir.js";
import { listFieldLabel, UNAVAILABLE } from "../mcp/dashboard-ir-renderer.js";
import { lintTextSinks } from "../../../spec/src/__tests__/ui-kit-text-sinks-lint.js";

import {
  mutationAudits,
  mutationLines,
  GUARD_SHARDS,
  GUARD_TIMEOUT_MS,
  initializeGuard,
} from "./ir-kit-text-brand-guard.js";
const MUTATIONS = GUARD_SHARDS[2]!;
beforeAll(async () => { await initializeGuard(MUTATIONS, 2); }, GUARD_TIMEOUT_MS);

describe("IR text guard Program shard 2", () => {
  it.each(MUTATIONS)("reports injected $name on its own source line", ({ name }) => {
    const expected = mutationLines.get(name)!;
    expect(mutationAudits.get(name)!.findings.filter((f) => f.file === expected.file && f.line === expected.line && f.rule === expected.rule), name).not.toEqual([]);
  });
});
