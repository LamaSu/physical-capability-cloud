import { beforeAll, describe, expect, it } from "vitest";

import {
  mutationAudits,
  mutationLines,
  GUARD_SHARDS,
  GUARD_TIMEOUT_MS,
  initializeGuard,
} from "./ir-kit-text-brand-guard.js";
const MUTATIONS = GUARD_SHARDS[3]!;
beforeAll(async () => { await initializeGuard(MUTATIONS, 3); }, GUARD_TIMEOUT_MS);

describe("IR text guard Program shard 3", () => {
  it.each(MUTATIONS)("reports injected $name on its own source line", ({ name }) => {
    const expected = mutationLines.get(name)!;
    expect(mutationAudits.get(name)!.findings.filter((f) => f.file === expected.file && f.line === expected.line && f.rule === expected.rule), name).not.toEqual([]);
  });
});
