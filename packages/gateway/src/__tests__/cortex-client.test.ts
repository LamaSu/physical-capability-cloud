import { describe, it, expect, afterAll } from "vitest";
import { cortexRemember, cortexAsk, closeCortexClient, CortexUnavailableError } from "../cortex-client.js";

// This suite deliberately hits the REAL Mitosis API — no mocks. When
// MITOSIS_API_KEY isn't set, the round-trip test skips (honestly) rather
// than faking a pass, and the missing-key error-path test runs instead.
const hasKey = Boolean(process.env.MITOSIS_API_KEY);

describe("cortex-client", () => {
  afterAll(async () => {
    await closeCortexClient();
  });

  it.skipIf(!hasKey)(
    "remembers a fact against the real Mitosis API and retrieves it back with a matching, citable universal_id",
    async () => {
      const marker = `pcc-gateway-test-${Date.now()}`;
      const remembered = await cortexRemember({
        text: `Integration test marker ${marker}: PCC gateway cortex-client round-trip check.`,
        kind: "task-outcome",
      });
      expect(remembered.status).toBe("ok");
      expect(remembered.universal_id).toBeTruthy();

      const asked = await cortexAsk(`What is integration test marker ${marker}?`);
      expect(asked.results.length).toBeGreaterThan(0);
      expect(asked.results[0].universal_id).toBe(remembered.universal_id);
      expect(asked.cited_graph_url).toBeTruthy();
    },
    20_000,
  );

  it.skipIf(hasKey)("surfaces CortexUnavailableError, not a crash, when MITOSIS_API_KEY is unset", async () => {
    await expect(cortexAsk("anything")).rejects.toBeInstanceOf(CortexUnavailableError);
  });
});
