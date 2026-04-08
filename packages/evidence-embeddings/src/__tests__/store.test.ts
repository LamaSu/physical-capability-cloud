import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryEmbeddingStore } from "../store.js";
import { MockBackend } from "../embedder.js";
import { buildFeatureURI } from "../feature-uri.js";
import type { EvidenceEmbedding, EmbedInput } from "../types.js";

describe("InMemoryEmbeddingStore", () => {
  let store: InMemoryEmbeddingStore;
  let backend: MockBackend;
  const featureUri = buildFeatureURI("clip", "v1", "embedding");

  beforeEach(() => {
    store = new InMemoryEmbeddingStore();
    backend = new MockBackend(64);
  });

  async function makeEmbedding(
    overrides: Partial<EvidenceEmbedding> & { inputData?: string } = {},
  ): Promise<EvidenceEmbedding> {
    const input: EmbedInput = {
      type: "text",
      data: overrides.inputData ?? `data-${Math.random()}`,
    };
    const generatedEmbedding = await backend.embed(input);
    const base: EvidenceEmbedding = {
      cid: `bafytest${Math.random().toString(36).slice(2, 10)}`,
      jobId: "job_001",
      featureUri,
      embedding: generatedEmbedding,
      metadata: {},
      createdAt: new Date(),
    };
    return { ...base, ...overrides };
  }

  // ── store ─────────────────────────────────────────────────────────

  it("stores and reports correct size", async () => {
    expect(store.size).toBe(0);
    await store.store(await makeEmbedding());
    expect(store.size).toBe(1);
    await store.store(await makeEmbedding());
    expect(store.size).toBe(2);
  });

  // ── getByJob ──────────────────────────────────────────────────────

  it("retrieves embeddings by job ID", async () => {
    await store.store(await makeEmbedding({ jobId: "job_A" }));
    await store.store(await makeEmbedding({ jobId: "job_A" }));
    await store.store(await makeEmbedding({ jobId: "job_B" }));

    const results = await store.getByJob("job_A");
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.jobId === "job_A")).toBe(true);
  });

  it("returns empty array for unknown job", async () => {
    const results = await store.getByJob("nonexistent");
    expect(results).toEqual([]);
  });

  // ── getByCid ──────────────────────────────────────────────────────

  it("retrieves embeddings by CID", async () => {
    const cid = "bafyfixed123";
    await store.store(await makeEmbedding({ cid }));
    await store.store(await makeEmbedding({ cid: "bafyother" }));

    const results = await store.getByCid(cid);
    expect(results).toHaveLength(1);
    expect(results[0].cid).toBe(cid);
  });

  // ── search ────────────────────────────────────────────────────────

  it("finds the most similar embedding", async () => {
    // Store an embedding for a known input
    const targetInput: EmbedInput = { type: "text", data: "target content" };
    const targetEmbedding = await backend.embed(targetInput);

    await store.store(
      await makeEmbedding({
        cid: "bafy_target",
        embedding: targetEmbedding,
        inputData: "target content",
      }),
    );

    // Store some other embeddings
    await store.store(await makeEmbedding({ cid: "bafy_other1" }));
    await store.store(await makeEmbedding({ cid: "bafy_other2" }));

    // Search with the exact same input should return the target first
    const query = await backend.embed(targetInput);
    const results = await store.search(query, { topK: 3 });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].cid).toBe("bafy_target");
    expect(results[0].score).toBeCloseTo(1.0, 3);
  });

  it("respects topK limit", async () => {
    for (let i = 0; i < 10; i++) {
      await store.store(await makeEmbedding());
    }

    const query = await backend.embed({ type: "text", data: "query" });
    const results = await store.search(query, { topK: 3 });
    expect(results).toHaveLength(3);
  });

  it("filters by featureUri", async () => {
    const clipUri = buildFeatureURI("clip", "v1", "embedding");
    const phashUri = buildFeatureURI("phash", "v1", "similarity");

    await store.store(await makeEmbedding({ featureUri: clipUri }));
    await store.store(await makeEmbedding({ featureUri: phashUri }));

    const query = await backend.embed({ type: "text", data: "query" });
    const results = await store.search(query, {
      topK: 10,
      featureUri: phashUri,
    });

    expect(results).toHaveLength(1);
    expect(results[0].featureUri).toBe(phashUri);
  });

  it("filters by jobId", async () => {
    await store.store(await makeEmbedding({ jobId: "job_X" }));
    await store.store(await makeEmbedding({ jobId: "job_Y" }));

    const query = await backend.embed({ type: "text", data: "query" });
    const results = await store.search(query, { topK: 10, jobId: "job_X" });

    expect(results).toHaveLength(1);
    expect(results[0].jobId).toBe("job_X");
  });

  it("applies similarity threshold", async () => {
    // Store an embedding
    const input: EmbedInput = { type: "text", data: "threshold test" };
    const emb = await backend.embed(input);
    await store.store(await makeEmbedding({ embedding: emb }));

    // Search with exact same query (score ~1.0) should pass high threshold
    const results = await store.search(emb, { topK: 10, threshold: 0.99 });
    expect(results).toHaveLength(1);

    // Store a different embedding and search for it with high threshold
    const otherEmb = await backend.embed({ type: "text", data: "very different" });
    await store.store(await makeEmbedding({ embedding: otherEmb }));

    // The "very different" embedding should have a lower similarity to the original query
    const filteredResults = await store.search(emb, {
      topK: 10,
      threshold: 0.999,
    });
    // Only the exact match should pass
    expect(filteredResults).toHaveLength(1);
  });

  it("returns results sorted by score descending", async () => {
    for (let i = 0; i < 5; i++) {
      await store.store(await makeEmbedding());
    }

    const query = await backend.embed({ type: "text", data: "sort test" });
    const results = await store.search(query, { topK: 5 });

    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });

  it("returns empty array when store is empty", async () => {
    const query = new Float32Array(64).fill(0.1);
    const results = await store.search(query, { topK: 5 });
    expect(results).toEqual([]);
  });

  // ── clear ─────────────────────────────────────────────────────────

  it("clears all embeddings", async () => {
    await store.store(await makeEmbedding());
    await store.store(await makeEmbedding());
    expect(store.size).toBe(2);

    store.clear();
    expect(store.size).toBe(0);
  });

  // ── round-trip: embed + store + search ────────────────────────────

  describe("end-to-end round-trip", () => {
    it("embeds, stores, and retrieves evidence by semantic similarity", async () => {
      const backend256 = new MockBackend(256);
      const uri = buildFeatureURI("clip", "v1", "embedding");

      // Simulate 3 evidence items
      const items = [
        { cid: "bafy_photo1", jobId: "job_print", type: "image" as const, data: "photo of 3d print layer 1" },
        { cid: "bafy_photo2", jobId: "job_print", type: "image" as const, data: "photo of 3d print layer 2" },
        { cid: "bafy_doc", jobId: "job_cnc", type: "text" as const, data: "CNC machining report for titanium bracket" },
      ];

      for (const item of items) {
        const embedding = await backend256.embed({ type: item.type, data: item.data });
        await store.store({
          cid: item.cid,
          jobId: item.jobId,
          featureUri: uri,
          embedding,
          metadata: { originalData: item.data },
          createdAt: new Date(),
        });
      }

      expect(store.size).toBe(3);

      // Search for the first photo — should match itself perfectly
      const queryEmb = await backend256.embed({ type: "image", data: "photo of 3d print layer 1" });
      const results = await store.search(queryEmb, { topK: 1 });

      expect(results).toHaveLength(1);
      expect(results[0].cid).toBe("bafy_photo1");
      expect(results[0].score).toBeCloseTo(1.0, 3);

      // Filter by job
      const jobResults = await store.search(queryEmb, {
        topK: 10,
        jobId: "job_print",
      });
      expect(jobResults.every((r) => r.jobId === "job_print")).toBe(true);
    });
  });
});
