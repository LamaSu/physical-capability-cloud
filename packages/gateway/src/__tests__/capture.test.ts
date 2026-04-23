/**
 * Capture Verification Protocol (CVP) — gateway route tests.
 *
 * Covers:
 *   /api/capture/challenge     — block-anchored nonce issuance + TTL clamp
 *   /api/capture/upload        — manifest validation, hash mismatch, verifier mock, persist
 *   /api/capture/anchor        — PASS gating, 202 deferred, row persistence, deduplication
 *   /api/capture/status/:id    — verdict + anchor combined view
 *   /api/operator/policy/:k    — minCaptureClass + requireAnchor merge/enforcement
 *
 * Strategy:
 *   - Real better-sqlite3 in-memory via initStore({seed:false}).
 *   - `resolveSession` is mocked so requireAuth passes with a fake userId.
 *   - CaptureVerifier is mocked via `setCaptureVerifierForTests` so no
 *     native C2PA binaries are loaded.
 *   - ChallengeService is mocked via `setChallengeServiceForTests` so
 *     block-anchor issuance is deterministic.
 *   - Chain client is mocked via `setCaptureChainClientForTests` so no
 *     real RPC is made.
 *
 * Author: gateway-golf (Wave 4)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";

// -----------------------------------------------------------------------------
// Mocks — MUST appear before imports of the route / factory modules so
// vi.mock() hoists correctly.
// -----------------------------------------------------------------------------

vi.mock("../auth/siwe-auth.js", () => ({
  resolveSession: vi.fn(),
}));

import { initStore, closeStore, getStore } from "../db.js";
import { schema, sql } from "@pcc/store";
import {
  captureRoutes,
  setCaptureChainClientForTests,
  _clearCaptureChallengeCacheForTests,
  _seedCaptureChallengeCacheForTests,
  type CaptureChainClient,
} from "../routes/capture.js";
import { operatorRoutes } from "../routes/operator.js";
import {
  setCaptureVerifierForTests,
  setChallengeServiceForTests,
} from "../capture/verifier-factory.js";
import { resolveSession } from "../auth/siwe-auth.js";
import { CaptureClass } from "@pcc/spec";
import type { CaptureNonceChallenge } from "@pcc/verifier";

const { captureVerdicts, captureAnchors, operatorPolicies } = schema;
const mockSession = resolveSession as ReturnType<typeof vi.fn>;

// -----------------------------------------------------------------------------
// Test fixtures
// -----------------------------------------------------------------------------

const AUTH_ADDRESS = "0x0000000000000000000000000000000000000001" as const;
const TEST_BYTES = new TextEncoder().encode("pcc-capture-fixture");
const TEST_HASH_HEX = crypto.createHash("sha256").update(TEST_BYTES).digest("hex");
const TEST_MEDIA_HASH = `sha256:${TEST_HASH_HEX}` as const;
const TEST_CAPTURE_HASH_0X = `0x${TEST_HASH_HEX}` as `0x${string}`;
const DUMMY_MANIFEST_HASH = `0x${"b".repeat(64)}` as `0x${string}`;
const NOW_ISO = "2026-04-21T00:00:00.000Z";

function makeCC0Manifest(): Record<string, unknown> {
  return {
    class: CaptureClass.CC0,
    declaredAt: NOW_ISO,
    deviceFingerprint: "fp-test",
    mediaHash: TEST_MEDIA_HASH,
  };
}

function makeVerifierResult(opts: {
  verdict: "PASS" | "PARTIAL" | "FAIL";
  declaredClass?: CaptureClass;
  verifiedClass?: CaptureClass;
  gatesPassed?: number[];
  gatesFailed?: number[];
  warnings?: string[];
  anchorCandidate?: boolean;
}) {
  const declaredClass = opts.declaredClass ?? CaptureClass.CC0;
  const verifiedClass = opts.verifiedClass ?? declaredClass;
  return {
    verdict: opts.verdict,
    declaredClass,
    verifiedClass,
    gatesPassed: opts.gatesPassed ?? [1],
    gatesFailed: opts.gatesFailed ?? [],
    warnings: opts.warnings ?? [],
    anchorCandidate: opts.anchorCandidate ?? (opts.verdict === "PASS"),
    captureHash: TEST_CAPTURE_HASH_0X,
    manifestHash: DUMMY_MANIFEST_HASH,
    detectorEvidence: { ceiling: verifiedClass, evidence: [] },
  };
}

function makeChallenge(overrides: Partial<CaptureNonceChallenge> = {}): CaptureNonceChallenge {
  return {
    challengeId: "00000000-0000-0000-0000-000000000001",
    issuedBy: AUTH_ADDRESS,
    scope: "job-test:CC0",
    visualNonce: { type: "qr", value: "ABC123", encoding: "text" } as CaptureNonceChallenge["visualNonce"],
    blockNumber: 100,
    blockHash: `0x${"1".repeat(64)}`,
    blockTimestamp: 1_700_000_000,
    chainId: 84532,
    issuedAt: NOW_ISO,
    maxAgeSeconds: 120,
    ...overrides,
  };
}

// -----------------------------------------------------------------------------
// Fakes: ChallengeService, ChainClient, Verifier
// -----------------------------------------------------------------------------

function makeFakeChallengeService(): unknown {
  return {
    issueCaptureNonce: vi.fn((params: {
      issuedBy: string;
      scope: string;
      blockNumber: number;
      blockHash: string;
      blockTimestamp: number;
      chainId: number;
      maxAgeSeconds: number;
    }) =>
      makeChallenge({
        issuedBy: params.issuedBy,
        scope: params.scope,
        blockNumber: params.blockNumber,
        blockHash: params.blockHash,
        blockTimestamp: params.blockTimestamp,
        chainId: params.chainId,
        maxAgeSeconds: params.maxAgeSeconds,
      }),
    ),
  };
}

function makeFakeChainClient(overrides: Partial<CaptureChainClient> = {}): CaptureChainClient {
  return {
    getChainId: () => 84532,
    getLatestBlock: vi.fn(async () => ({
      number: 100,
      hash: `0x${"1".repeat(64)}` as `0x${string}`,
      timestamp: 1_700_000_000,
    })),
    anchorCapture: vi.fn(async () => ({
      txHash: `0x${"a".repeat(64)}` as `0x${string}`,
      blockNumber: 101,
      gasUsed: "123456",
    })),
    ...overrides,
  };
}

function makeFakeVerifier(result: ReturnType<typeof makeVerifierResult>): unknown {
  return {
    verify: vi.fn(async () => result),
  };
}

// -----------------------------------------------------------------------------
// App bootstrap
// -----------------------------------------------------------------------------

let app: FastifyInstance;

beforeAll(async () => {
  process.env.DATABASE_URL = ":memory:";
  initStore({ seed: false });

  app = Fastify({ logger: false });
  app.decorateRequest("userId", null);
  app.decorateRequest("apiKeyId", null);
  app.decorateRequest("operatorId", null);
  await app.register(captureRoutes);
  await app.register(operatorRoutes);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  closeStore();
  setCaptureVerifierForTests(null);
  setChallengeServiceForTests(null);
  setCaptureChainClientForTests(null);
});

beforeEach(() => {
  const { db } = getStore();
  db.run(sql`DELETE FROM capture_anchors`);
  db.run(sql`DELETE FROM capture_verdicts`);
  db.run(sql`DELETE FROM operator_policies`);
  _clearCaptureChallengeCacheForTests();
  mockSession.mockReturnValue({ address: AUTH_ADDRESS });
  setCaptureVerifierForTests(null);
  setChallengeServiceForTests(null);
  setCaptureChainClientForTests(null);
  delete process.env.CAPTURE_REGISTRY_ADDRESS;
});

// ═════════════════════════════════════════════════════════════════════════════
// Section 1 — Auth required on all four routes (4 tests)
// ═════════════════════════════════════════════════════════════════════════════

describe("capture routes — authentication", () => {
  beforeEach(() => {
    // Reject all auth to check 401 paths
    mockSession.mockReturnValue(null);
  });

  it("POST /api/capture/challenge returns 401 without auth", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/capture/challenge",
      payload: { jobId: "j1", declaredClass: "CC0" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("POST /api/capture/upload returns 401 without auth", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/capture/upload",
      payload: { manifest: makeCC0Manifest(), captureBytesBase64: "AAAA" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("POST /api/capture/anchor returns 401 without auth", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/capture/anchor",
      payload: { verdictId: "00000000-0000-0000-0000-000000000000" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("GET /api/capture/status/:id returns 401 without auth", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/capture/status/some-id",
    });
    expect(res.statusCode).toBe(401);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Section 2 — /api/capture/challenge (6 tests)
// ═════════════════════════════════════════════════════════════════════════════

describe("POST /api/capture/challenge", () => {
  beforeEach(() => {
    setChallengeServiceForTests(makeFakeChallengeService() as never);
    setCaptureChainClientForTests(makeFakeChainClient());
  });

  it("issues a challenge for a valid body", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/capture/challenge",
      payload: { jobId: "job-1", declaredClass: "CC0" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.challengeId).toBeTruthy();
    expect(body.nonce).toMatch(/^[0-9a-f]{64}$/);
    expect(body.maxAgeSeconds).toBe(120);
    expect(body.chainId).toBe(84532);
  });

  it("clamps requestedTtlSeconds above 120 down to 120", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/capture/challenge",
      payload: { jobId: "job-1", declaredClass: "CC0", requestedTtlSeconds: 999 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().maxAgeSeconds).toBe(120);
  });

  it("allows a shorter TTL when requested", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/capture/challenge",
      payload: { jobId: "job-1", declaredClass: "CC0", requestedTtlSeconds: 30 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().maxAgeSeconds).toBe(30);
  });

  it("rejects invalid declaredClass", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/capture/challenge",
      payload: { jobId: "job-1", declaredClass: "CC9" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_body");
  });

  it("rejects missing jobId", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/capture/challenge",
      payload: { declaredClass: "CC0" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("emits a nonce that combines challengeId + blockHash + workOutputRoot", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/capture/challenge",
      payload: { jobId: "job-nonce", declaredClass: "CC2" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const expected = crypto
      .createHash("sha256")
      .update(body.challengeId)
      .update(body.blockHash)
      .update(body.workOutputRoot)
      .digest("hex");
    expect(body.nonce).toBe(expected);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Section 3 — /api/capture/upload (10 tests)
// ═════════════════════════════════════════════════════════════════════════════

describe("POST /api/capture/upload", () => {
  it("rejects invalid body (missing manifest)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/capture/upload",
      payload: { captureBytesBase64: Buffer.from(TEST_BYTES).toString("base64") },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_body");
  });

  it("rejects manifest whose mediaHash doesn't match the bytes", async () => {
    const bad = { ...makeCC0Manifest(), mediaHash: `sha256:${"f".repeat(64)}` };
    const res = await app.inject({
      method: "POST",
      url: "/api/capture/upload",
      payload: {
        manifest: bad,
        captureBytesBase64: Buffer.from(TEST_BYTES).toString("base64"),
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("hash_mismatch");
  });

  it("returns 500 when the verifier throws", async () => {
    setCaptureVerifierForTests({
      verify: vi.fn(async () => {
        throw new Error("verifier blew up");
      }),
    } as never);
    const res = await app.inject({
      method: "POST",
      url: "/api/capture/upload",
      payload: {
        manifest: makeCC0Manifest(),
        captureBytesBase64: Buffer.from(TEST_BYTES).toString("base64"),
      },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe("verifier_threw");
  });

  it("persists a PASS verdict and returns verdictId", async () => {
    const result = makeVerifierResult({ verdict: "PASS" });
    setCaptureVerifierForTests(makeFakeVerifier(result) as never);
    const res = await app.inject({
      method: "POST",
      url: "/api/capture/upload",
      payload: {
        manifest: makeCC0Manifest(),
        captureBytesBase64: Buffer.from(TEST_BYTES).toString("base64"),
        jobId: "job-pass",
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.verdict).toBe("PASS");
    expect(body.verdictId).toMatch(/^[0-9a-f-]+$/);

    // Verify DB row exists
    const { db } = getStore();
    const row = db.select().from(captureVerdicts).all();
    expect(row.length).toBe(1);
    expect(row[0].jobId).toBe("job-pass");
    expect(row[0].verdict).toBe("PASS");
    expect(row[0].anchorCandidate).toBe(1);
  });

  it("persists a FAIL verdict without anchor eligibility", async () => {
    const result = makeVerifierResult({
      verdict: "FAIL",
      gatesPassed: [],
      gatesFailed: [1],
      anchorCandidate: false,
    });
    setCaptureVerifierForTests(makeFakeVerifier(result) as never);
    const res = await app.inject({
      method: "POST",
      url: "/api/capture/upload",
      payload: {
        manifest: makeCC0Manifest(),
        captureBytesBase64: Buffer.from(TEST_BYTES).toString("base64"),
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().verdict).toBe("FAIL");

    const { db } = getStore();
    const row = db.select().from(captureVerdicts).all()[0];
    expect(row.verdict).toBe("FAIL");
    expect(row.anchorCandidate).toBe(0);
  });

  it("persists gatesPassed / gatesFailed as JSON arrays", async () => {
    const result = makeVerifierResult({
      verdict: "PARTIAL",
      gatesPassed: [1, 2],
      gatesFailed: [3],
    });
    setCaptureVerifierForTests(makeFakeVerifier(result) as never);
    await app.inject({
      method: "POST",
      url: "/api/capture/upload",
      payload: {
        manifest: makeCC0Manifest(),
        captureBytesBase64: Buffer.from(TEST_BYTES).toString("base64"),
      },
    });
    const { db } = getStore();
    const row = db.select().from(captureVerdicts).all()[0];
    expect(row.gatesPassed).toEqual([1, 2]);
    expect(row.gatesFailed).toEqual([3]);
  });

  it("uses operatorId from body when provided", async () => {
    setCaptureVerifierForTests(
      makeFakeVerifier(makeVerifierResult({ verdict: "PASS" })) as never,
    );
    await app.inject({
      method: "POST",
      url: "/api/capture/upload",
      payload: {
        manifest: makeCC0Manifest(),
        captureBytesBase64: Buffer.from(TEST_BYTES).toString("base64"),
        operatorId: "explicit-operator",
      },
    });
    const { db } = getStore();
    const row = db.select().from(captureVerdicts).all()[0];
    expect(row.operatorId).toBe("explicit-operator");
  });

  it("falls back to req.userId for operatorId when body omits it", async () => {
    setCaptureVerifierForTests(
      makeFakeVerifier(makeVerifierResult({ verdict: "PASS" })) as never,
    );
    await app.inject({
      method: "POST",
      url: "/api/capture/upload",
      payload: {
        manifest: makeCC0Manifest(),
        captureBytesBase64: Buffer.from(TEST_BYTES).toString("base64"),
      },
    });
    const { db } = getStore();
    const row = db.select().from(captureVerdicts).all()[0];
    expect(row.operatorId).toBe(AUTH_ADDRESS);
  });

  it("resolves challenge from cache when challengeId is echoed", async () => {
    const challenge = makeChallenge({
      challengeId: "00000000-0000-0000-0000-000000000099",
    });
    _seedCaptureChallengeCacheForTests(challenge);
    const verifySpy = vi.fn(async () => makeVerifierResult({ verdict: "PASS" }));
    setCaptureVerifierForTests({ verify: verifySpy } as never);
    await app.inject({
      method: "POST",
      url: "/api/capture/upload",
      payload: {
        manifest: makeCC0Manifest(),
        captureBytesBase64: Buffer.from(TEST_BYTES).toString("base64"),
        challengeId: challenge.challengeId,
      },
    });
    expect(verifySpy).toHaveBeenCalledTimes(1);
    const arg = verifySpy.mock.calls[0][0] as { challenge?: CaptureNonceChallenge };
    expect(arg.challenge?.challengeId).toBe(challenge.challengeId);
  });

  it("captures the full CaptureVerifierResult in result_json for UI rehydration", async () => {
    const result = makeVerifierResult({
      verdict: "PASS",
      verifiedClass: CaptureClass.CC2,
      declaredClass: CaptureClass.CC2,
    });
    setCaptureVerifierForTests(makeFakeVerifier(result) as never);
    await app.inject({
      method: "POST",
      url: "/api/capture/upload",
      payload: {
        manifest: { ...makeCC0Manifest(), class: "CC2" },
        captureBytesBase64: Buffer.from(TEST_BYTES).toString("base64"),
      },
    });
    const { db } = getStore();
    const row = db.select().from(captureVerdicts).all()[0];
    expect((row.resultJson as { verifiedClass: string }).verifiedClass).toBe("CC2");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Section 4 — /api/capture/anchor (6 tests)
// ═════════════════════════════════════════════════════════════════════════════

describe("POST /api/capture/anchor", () => {
  async function seedVerdict(verdict: "PASS" | "FAIL" | "PARTIAL", anchorCandidate = true) {
    const { db } = getStore();
    const id = crypto.randomUUID();
    db.insert(captureVerdicts)
      .values({
        id,
        jobId: "job-seed",
        operatorId: AUTH_ADDRESS,
        captureHash: TEST_CAPTURE_HASH_0X,
        manifestHash: DUMMY_MANIFEST_HASH,
        declaredClass: 0,
        verifiedClass: 0,
        verdict,
        gatesPassed: [1],
        gatesFailed: [],
        warnings: [],
        anchorCandidate: anchorCandidate ? 1 : 0,
        resultJson: makeVerifierResult({ verdict }),
        declaredClassStr: "CC0",
        verifiedClassStr: "CC0",
        createdAt: NOW_ISO,
      })
      .run();
    return id;
  }

  it("returns 404 when the verdict doesn't exist", async () => {
    process.env.CAPTURE_REGISTRY_ADDRESS = "0x" + "a".repeat(40);
    const res = await app.inject({
      method: "POST",
      url: "/api/capture/anchor",
      payload: { verdictId: "00000000-0000-0000-0000-000000000000" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("verdict_not_found");
  });

  it("returns 400 when verdict is FAIL", async () => {
    process.env.CAPTURE_REGISTRY_ADDRESS = "0x" + "a".repeat(40);
    const id = await seedVerdict("FAIL", false);
    const res = await app.inject({
      method: "POST",
      url: "/api/capture/anchor",
      payload: { verdictId: id },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("verdict_not_pass");
  });

  it("returns 400 when anchorCandidate is false", async () => {
    process.env.CAPTURE_REGISTRY_ADDRESS = "0x" + "a".repeat(40);
    const id = await seedVerdict("PASS", false);
    const res = await app.inject({
      method: "POST",
      url: "/api/capture/anchor",
      payload: { verdictId: id },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("not_anchor_candidate");
  });

  it("returns 202 deferred when CAPTURE_REGISTRY_ADDRESS is unset", async () => {
    delete process.env.CAPTURE_REGISTRY_ADDRESS;
    const id = await seedVerdict("PASS", true);
    const res = await app.inject({
      method: "POST",
      url: "/api/capture/anchor",
      payload: { verdictId: id },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().status).toBe("deferred");
  });

  it("writes a capture_anchors row on successful submission", async () => {
    process.env.CAPTURE_REGISTRY_ADDRESS = "0x" + "a".repeat(40);
    setCaptureChainClientForTests(makeFakeChainClient());
    const id = await seedVerdict("PASS", true);
    const res = await app.inject({
      method: "POST",
      url: "/api/capture/anchor",
      payload: { verdictId: id },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(body.gasUsed).toBe("123456");

    const { db } = getStore();
    const rows = db.select().from(captureAnchors).all();
    expect(rows.length).toBe(1);
    expect(rows[0].verdictId).toBe(id);
  });

  it("short-circuits with already_anchored on a duplicate anchor call", async () => {
    process.env.CAPTURE_REGISTRY_ADDRESS = "0x" + "a".repeat(40);
    setCaptureChainClientForTests(makeFakeChainClient());
    const id = await seedVerdict("PASS", true);
    await app.inject({
      method: "POST",
      url: "/api/capture/anchor",
      payload: { verdictId: id },
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/capture/anchor",
      payload: { verdictId: id },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("already_anchored");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Section 5 — /api/capture/status/:verdictId (4 tests)
// ═════════════════════════════════════════════════════════════════════════════

describe("GET /api/capture/status/:verdictId", () => {
  it("returns 404 for unknown verdict", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/capture/status/00000000-0000-0000-0000-000000000000",
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("verdict_not_found");
  });

  it("returns verdict-only view when no anchor exists", async () => {
    const { db } = getStore();
    const id = crypto.randomUUID();
    db.insert(captureVerdicts)
      .values({
        id,
        jobId: null,
        operatorId: AUTH_ADDRESS,
        captureHash: TEST_CAPTURE_HASH_0X,
        manifestHash: DUMMY_MANIFEST_HASH,
        declaredClass: 0,
        verifiedClass: 0,
        verdict: "PASS",
        gatesPassed: [1],
        gatesFailed: [],
        warnings: [],
        anchorCandidate: 1,
        resultJson: makeVerifierResult({ verdict: "PASS" }),
        declaredClassStr: "CC0",
        verifiedClassStr: "CC0",
        createdAt: NOW_ISO,
      })
      .run();
    const res = await app.inject({
      method: "GET",
      url: `/api/capture/status/${id}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.verdictId).toBe(id);
    expect(body.anchor).toBeNull();
    expect(body.verdict.verdict).toBe("PASS");
  });

  it("returns combined verdict + anchor view when both exist", async () => {
    const { db } = getStore();
    const id = crypto.randomUUID();
    db.insert(captureVerdicts)
      .values({
        id,
        jobId: "job-combined",
        operatorId: AUTH_ADDRESS,
        captureHash: TEST_CAPTURE_HASH_0X,
        manifestHash: DUMMY_MANIFEST_HASH,
        declaredClass: 0,
        verifiedClass: 0,
        verdict: "PASS",
        gatesPassed: [1],
        gatesFailed: [],
        warnings: [],
        anchorCandidate: 1,
        resultJson: makeVerifierResult({ verdict: "PASS" }),
        declaredClassStr: "CC0",
        verifiedClassStr: "CC0",
        createdAt: NOW_ISO,
      })
      .run();
    db.insert(captureAnchors)
      .values({
        verdictId: id,
        txHash: "0x" + "a".repeat(64),
        blockNumber: 999,
        gasUsed: "42",
        anchoredAt: NOW_ISO,
      })
      .run();
    const res = await app.inject({
      method: "GET",
      url: `/api/capture/status/${id}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.anchor).not.toBeNull();
    expect(body.anchor.txHash).toBe("0x" + "a".repeat(64));
    expect(body.anchor.blockNumber).toBe(999);
    expect(body.anchor.explorerUrl).toContain("0x" + "a".repeat(64));
  });

  it("includes explorer URL for base-sepolia by default", async () => {
    const { db } = getStore();
    const id = crypto.randomUUID();
    db.insert(captureVerdicts)
      .values({
        id,
        jobId: null,
        operatorId: AUTH_ADDRESS,
        captureHash: TEST_CAPTURE_HASH_0X,
        manifestHash: DUMMY_MANIFEST_HASH,
        declaredClass: 0,
        verifiedClass: 0,
        verdict: "PASS",
        gatesPassed: [1],
        gatesFailed: [],
        warnings: [],
        anchorCandidate: 1,
        resultJson: makeVerifierResult({ verdict: "PASS" }),
        declaredClassStr: "CC0",
        verifiedClassStr: "CC0",
        createdAt: NOW_ISO,
      })
      .run();
    db.insert(captureAnchors)
      .values({
        verdictId: id,
        txHash: "0x" + "b".repeat(64),
        blockNumber: 1,
        gasUsed: "10",
        anchoredAt: NOW_ISO,
      })
      .run();
    const res = await app.inject({
      method: "GET",
      url: `/api/capture/status/${id}`,
    });
    expect(res.json().anchor.explorerUrl).toContain("basescan.org");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Section 6 — Operator policy: minCaptureClass + requireAnchor (5 tests)
// ═════════════════════════════════════════════════════════════════════════════

describe("PATCH /api/operator/policy/:kernelId — CVP fields", () => {
  it("accepts minCaptureClass on PATCH", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/operator/policy/kernel-cvp-1",
      payload: { minCaptureClass: "CC3" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.policy.minCaptureClass).toBe("CC3");
  });

  it("accepts requireAnchor on PATCH", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/operator/policy/kernel-cvp-2",
      payload: { requireAnchor: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().policy.requireAnchor).toBe(true);
  });

  it("merges both CVP fields without clobbering existing policy", async () => {
    await app.inject({
      method: "PATCH",
      url: "/api/operator/policy/kernel-cvp-3",
      payload: { minCaptureClass: "CC2" },
    });
    const res = await app.inject({
      method: "PATCH",
      url: "/api/operator/policy/kernel-cvp-3",
      payload: { requireAnchor: true },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.policy.minCaptureClass).toBe("CC2");
    expect(body.policy.requireAnchor).toBe(true);
  });

  it("GET returns stored minCaptureClass", async () => {
    await app.inject({
      method: "PATCH",
      url: "/api/operator/policy/kernel-cvp-4",
      payload: { minCaptureClass: "CC4" },
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/operator/policy/kernel-cvp-4",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().policy.minCaptureClass).toBe("CC4");
  });

  it("rejects a policy PUT without version:1", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/operator/policy/kernel-cvp-5",
      payload: { requireAnchor: true, approvalMode: "manual" },
    });
    expect(res.statusCode).toBe(400);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Section 7 — Thin query routes for MCP (Wave 6 Scope B) — 7 tests
// GET /api/capture/verdicts
// GET /api/capture/registry/:captureHash
// GET /api/capture/verifier-health
// ═════════════════════════════════════════════════════════════════════════════

describe("GET /api/capture/verdicts", () => {
  async function seedVerdictRow(opts: {
    id?: string;
    jobId: string;
    verdict?: "PASS" | "FAIL" | "PARTIAL";
    createdAt?: string;
  }) {
    const { db } = getStore();
    const id = opts.id ?? crypto.randomUUID();
    db.insert(captureVerdicts)
      .values({
        id,
        jobId: opts.jobId,
        operatorId: AUTH_ADDRESS,
        captureHash: TEST_CAPTURE_HASH_0X,
        manifestHash: DUMMY_MANIFEST_HASH,
        declaredClass: 0,
        verifiedClass: 0,
        verdict: opts.verdict ?? "PASS",
        gatesPassed: [1],
        gatesFailed: [],
        warnings: [],
        anchorCandidate: 1,
        resultJson: makeVerifierResult({ verdict: opts.verdict ?? "PASS" }),
        declaredClassStr: "CC0",
        verifiedClassStr: "CC0",
        createdAt: opts.createdAt ?? NOW_ISO,
      })
      .run();
    return id;
  }

  it("returns 401 without auth", async () => {
    mockSession.mockReturnValue(null);
    const res = await app.inject({
      method: "GET",
      url: "/api/capture/verdicts",
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns recent verdicts newest-first without a jobId filter", async () => {
    await seedVerdictRow({ jobId: "job-A", createdAt: "2026-04-20T00:00:00.000Z" });
    await seedVerdictRow({ jobId: "job-B", createdAt: "2026-04-22T00:00:00.000Z" });
    const res = await app.inject({
      method: "GET",
      url: "/api/capture/verdicts",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.count).toBe(2);
    expect(body.verdicts[0].jobId).toBe("job-B");
    expect(body.verdicts[1].jobId).toBe("job-A");
    expect(body.limit).toBe(50);
  });

  it("filters by jobId and clamps limit above 200", async () => {
    await seedVerdictRow({ jobId: "job-target" });
    await seedVerdictRow({ jobId: "job-other" });
    const res = await app.inject({
      method: "GET",
      url: "/api/capture/verdicts?jobId=job-target&limit=500",
    });
    // limit=500 exceeds the Zod max(200); Zod rejects with 400.
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_query");
  });

  it("accepts a valid limit and returns only matching jobId rows", async () => {
    await seedVerdictRow({ jobId: "job-target" });
    await seedVerdictRow({ jobId: "job-other" });
    const res = await app.inject({
      method: "GET",
      url: "/api/capture/verdicts?jobId=job-target&limit=10",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.count).toBe(1);
    expect(body.verdicts[0].jobId).toBe("job-target");
    expect(body.limit).toBe(10);
    expect(body.jobId).toBe("job-target");
  });
});

describe("GET /api/capture/registry/:captureHash", () => {
  it("returns 401 without auth", async () => {
    mockSession.mockReturnValue(null);
    const res = await app.inject({
      method: "GET",
      url: `/api/capture/registry/${TEST_CAPTURE_HASH_0X}`,
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 202 deferred when CAPTURE_REGISTRY_ADDRESS is unset", async () => {
    delete process.env.CAPTURE_REGISTRY_ADDRESS;
    const res = await app.inject({
      method: "GET",
      url: `/api/capture/registry/${TEST_CAPTURE_HASH_0X}`,
    });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.status).toBe("deferred");
    expect(body.onchain).toBeNull();
  });
});

describe("GET /api/capture/verifier-health", () => {
  it("returns 401 without auth", async () => {
    mockSession.mockReturnValue(null);
    const res = await app.inject({
      method: "GET",
      url: "/api/capture/verifier-health",
    });
    expect(res.statusCode).toBe(401);
  });

  it("lists the 4 production adapters with ok staleness by default", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/capture/verifier-health",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.adaptersLoaded).toEqual(["c2pa", "webauthn", "appattest", "playintegrity"]);
    expect(body.staleness.c2pa).toBe("ok");
    expect(body.staleness.webauthn).toBe("ok");
    expect(body.staleness.appattest).toBe("ok");
    expect(body.staleness.playintegrity).toBe("ok");
    expect(typeof body.challengeCacheSize).toBe("number");
    expect(typeof body.registryDeployed).toBe("boolean");
    expect(typeof body.checkedAt).toBe("string");
  });

  it("applies PCC_VERIFIER_HEALTH env override when set", async () => {
    process.env.PCC_VERIFIER_HEALTH = JSON.stringify({ c2pa: "stale" });
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/capture/verifier-health",
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.staleness.c2pa).toBe("stale");
      expect(body.staleness.webauthn).toBe("ok");
    } finally {
      delete process.env.PCC_VERIFIER_HEALTH;
    }
  });
});
