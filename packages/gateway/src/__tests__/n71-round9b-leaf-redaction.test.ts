import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { randomBytes, randomUUID } from "node:crypto";
import { context, trace } from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import type { CaptureNonceChallenge } from "@pcc/verifier";
import { schema } from "@pcc/store";

const posthogCapture = vi.hoisted(() => vi.fn());
const posthogConstructed = vi.hoisted(() => vi.fn());
const analyticsInputs = vi.hoisted(() => vi.fn());
const auditLog = vi.hoisted(() => vi.fn());

vi.mock("../auth/siwe-auth.js", () => ({
  resolveSession: vi.fn(),
}));

vi.mock("../services/audit-service.js", () => ({
  auditService: {
    log: (...args: unknown[]) => auditLog(...args),
    query: vi.fn().mockReturnValue([]),
    stats: vi.fn().mockReturnValue([]),
  },
}));

vi.mock("posthog-node", () => ({
  PostHog: class {
    capture = posthogCapture;
    identify = vi.fn();
    shutdown = vi.fn().mockResolvedValue(undefined);

    constructor() {
      posthogConstructed();
    }
  },
}));

// Observe the route's analytics argument before the outbound policy processes it.
// The real service still forwards the event to the mocked PostHog client.
vi.mock("../services/posthog-service.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../services/posthog-service.js")>();
  return {
    ...original,
    trackServerEvent: (...args: Parameters<typeof original.trackServerEvent>) => {
      analyticsInputs(...args);
      original.trackServerEvent(...args);
    },
  };
});

import { initStore, closeStore, getStore } from "../db.js";
import { resolveSession } from "../auth/siwe-auth.js";
import { pipelineTelemetry } from "../telemetry.js";
import { traceIdPlugin } from "../middleware/trace-id.js";
import { setChallengeServiceForTests } from "../capture/verifier-factory.js";

const AUTH_ADDRESS = "0x0000000000000000000000000000000000000001" as const;

// Reuses an existing diagnostic sentinel; assertions never log its contents.
const privateText = "password=N71-SENTINEL";
const exporter = new InMemorySpanExporter();

let provider: NodeTracerProvider;
let app: FastifyInstance;
let captureModule: typeof import("../routes/capture.js");
let feedbackModule: typeof import("../routes/agent-feedback.js");
let simulatorModule: typeof import("../routes/capture-sim.js");
let posthogService: typeof import("../services/posthog-service.js");
let traceOverride: string | undefined;

type ChallengeArgs = {
  issuedBy: string;
  scope: string;
  blockNumber: number;
  blockHash: string;
  blockTimestamp: number;
  chainId: number;
  maxAgeSeconds: number;
};

function useChallengeId(challengeId: string): void {
  setChallengeServiceForTests({
    issueCaptureNonce: vi.fn((params: ChallengeArgs): CaptureNonceChallenge => ({
      challengeId,
      issuedBy: params.issuedBy,
      scope: params.scope,
      visualNonce: {
        type: "qr",
        value: "ABC123",
        encoding: "text",
      } as CaptureNonceChallenge["visualNonce"],
      blockNumber: params.blockNumber,
      blockHash: params.blockHash,
      blockTimestamp: params.blockTimestamp,
      chainId: params.chainId,
      issuedAt: new Date().toISOString(),
      maxAgeSeconds: params.maxAgeSeconds,
    })),
  } as never);

  captureModule.setCaptureChainClientForTests({
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
  });
}

beforeAll(async () => {
  vi.stubEnv("DATABASE_URL", ":memory:");
  vi.stubEnv("POSTHOG_API_KEY", "test");
  vi.stubEnv("NODE_ENV", "test");

  initStore({ seed: false });

  provider = new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  provider.register();

  // Import the report route after registering the tracer provider.
  captureModule = await import("../routes/capture.js");
  feedbackModule = await import("../routes/agent-feedback.js");
  simulatorModule = await import("../routes/capture-sim.js");
  posthogService = await import("../services/posthog-service.js");

  posthogService.initPostHog();
  await vi.waitFor(() => expect(posthogConstructed).toHaveBeenCalledOnce());

  app = Fastify({ logger: false });
  app.decorateRequest("userId", null);
  app.decorateRequest("apiKeyId", null);
  app.decorateRequest("operatorId", null);

  await app.register(traceIdPlugin);

  // Runs after the trace-id plugin, exercising request-decoration provenance
  // without weakening the public body's trace-id validation.
  app.addHook("onRequest", async (req) => {
    if (traceOverride !== undefined) req.traceId = traceOverride;
  });

  await app.register(captureModule.captureRoutes);
  await app.register(feedbackModule.agentFeedbackRoutes);
  await app.register(simulatorModule.captureSimRoutes);
  await app.ready();
});

beforeEach(() => {
  vi.mocked(resolveSession).mockReturnValue({ address: AUTH_ADDRESS } as never);

  captureModule._clearCaptureChallengeCacheForTests();
  captureModule.setCaptureChainClientForTests(null);
  setChallengeServiceForTests(null);
  simulatorModule.setGenesisSpawnerForTests(null);
  feedbackModule.__resetAgentReportRateLimit();

  traceOverride = undefined;
  exporter.reset();
  posthogCapture.mockClear();
  analyticsInputs.mockClear();
  auditLog.mockClear();
});

afterAll(async () => {
  await app?.close();
  captureModule?.setCaptureChainClientForTests(null);
  captureModule?._clearCaptureChallengeCacheForTests();
  setChallengeServiceForTests(null);
  simulatorModule?.setGenesisSpawnerForTests(null);
  closeStore();

  await posthogService?.shutdownPostHog();
  await provider?.shutdown();
  trace.disable();
  context.disable();
  vi.unstubAllEnvs();
});

async function challengeTelemetryFor(challengeId: string) {
  useChallengeId(challengeId);

  const jobId = `job-capture-${randomUUID()}`;
  const response = await app.inject({
    method: "POST",
    url: "/api/capture/challenge",
    payload: { jobId, declaredClass: "CC0" },
  });

  expect(response.statusCode).toBe(200);
  // The caller's challenge identifier remains unchanged in the response.
  expect(response.json().challengeId === challengeId).toBe(true);

  const events = pipelineTelemetry.getTimeline(jobId).filter(
    (event) => event.metadata.subphase === "capture_challenge",
  );
  expect(events).toHaveLength(1);
  return events[0];
}

type AnchorResult = {
  txHash: `0x${string}`;
  gasUsed: string;
  blockNumber: number;
};

function validAnchorResult(): AnchorResult {
  return {
    // Distinct 32-byte receipts prevent the shared test database's unique-hash
    // constraint from obscuring telemetry behavior in later anchor requests.
    txHash: `0x${randomBytes(32).toString("hex")}` as `0x${string}`,
    gasUsed: "123456",
    blockNumber: 101,
  };
}

async function anchorTelemetryFor(tx: AnchorResult, failure?: Error) {
  const jobId = `job-anchor-${randomUUID()}`;
  const verdictId = randomUUID();

  getStore().db.insert(schema.captureVerdicts).values({
    id: verdictId,
    jobId,
    operatorId: AUTH_ADDRESS,
    captureHash: `0x${"b".repeat(64)}`,
    manifestHash: `0x${"c".repeat(64)}`,
    declaredClass: 0,
    verifiedClass: 0,
    verdict: "PASS",
    gatesPassed: [1],
    gatesFailed: [],
    warnings: [],
    anchorCandidate: 1,
    resultJson: { verdict: "PASS" },
    declaredClassStr: "CC0",
    verifiedClassStr: "CC0",
    createdAt: new Date().toISOString(),
  }).run();

  captureModule.setCaptureChainClientForTests({
    getChainId: () => 84532,
    getLatestBlock: vi.fn(async () => ({
      number: 100,
      hash: `0x${"1".repeat(64)}` as `0x${string}`,
      timestamp: 1_700_000_000,
    })),
    anchorCapture: vi.fn(async () => {
      if (failure) throw failure;
      return tx;
    }),
  });

  vi.stubEnv("CAPTURE_REGISTRY_ADDRESS", `0x${"2".repeat(40)}`);
  const response = await app.inject({
    method: "POST",
    url: "/api/capture/anchor",
    payload: { verdictId },
  });
  expect(response.statusCode).toBe(failure ? 500 : 200);

  // Successful HTTP replies and persisted receipts keep the chain's real values.
  if (!failure) {
    expect(response.json()).toMatchObject(tx);
    const receipt = getStore().db.select().from(schema.captureAnchors).all()
      .find((row) => row.verdictId === verdictId);
    expect(receipt).toMatchObject(tx);
  }

  const events = pipelineTelemetry.getTimeline(jobId).filter(
    (event) => event.metadata.subphase === "capture_anchor" &&
      event.status === (failure ? "failed" : "completed"),
  );
  expect(events).toHaveLength(1);
  return events[0];
}

async function reportObservations(payload: {
  summary: string;
  trace_id?: string;
  agent_kind?: string;
  last_endpoint?: string;
  last_error_code?: string;
  confused_about?: string;
}) {
  const response = await app.inject({
    method: "POST",
    url: "/api/feedback/agent-report",
    payload,
  });
  expect(response.statusCode).toBe(201);

  const spans = exporter.getFinishedSpans().filter(
    (span) => span.name === "pcc.feedback.agent_report",
  );
  expect(spans).toHaveLength(1);

  const span = spans[0];
  const spanEvent = span?.events.find(
    (event) => event.name === "agent_report_received",
  );
  expect(spanEvent).toBeDefined();

  const forwarded = analyticsInputs.mock.calls.filter(
    ([event]) => event === "agent_report_filed",
  );
  expect(forwarded).toHaveLength(1);
  const analyticsProperties = forwarded[0]?.[1] as
    | Record<string, unknown>
    | undefined;

  const clientEvents = posthogCapture.mock.calls
    .map(([entry]) => entry)
    .filter((entry) => entry.event === "agent_report_filed");
  expect(clientEvents).toHaveLength(1);

  return {
    echoedTraceId: response.json().trace_id as string,
    spanAttributes: span?.attributes,
    spanEventAttributes: spanEvent?.attributes,
    forwardedAnalytics: analyticsProperties,
    sinkValues: [
      span?.attributes["pcc.trace_id"],
      analyticsProperties?.trace_id,
      spanEvent?.attributes?.["pcc.trace_id"],
    ],
    clientEvent: clientEvents[0] as
      | { event: string; properties?: Record<string, unknown> }
      | undefined,
  };
}

describe("route telemetry carries formatted ids", () => {
  it("preserves chain receipt transaction metadata at the telemetry sink", async () => {
    const tx = validAnchorResult();
    const event = await anchorTelemetryFor(tx);
    expect(event?.metadata).toMatchObject({ gasUsed: tx.gasUsed, blockNumber: tx.blockNumber });
    expect(event?.metadata).not.toHaveProperty("txHash");
  });

  it("uses a fixed diagnostic when a chain client fails to anchor", async () => {
    const event = await anchorTelemetryFor(validAnchorResult(), new Error(privateText));
    expect(event?.metadata.error).toBe("anchor_failed");
    expect(JSON.stringify(event).includes(privateText)).toBe(false);
  });

  it("formats a credential-shaped transaction hash at the capture-anchor sink", async () => {
    const event = await anchorTelemetryFor({
      ...validAnchorResult(),
      txHash: privateText as unknown as `0x${string}`,
    });
    expect(event?.metadata).not.toHaveProperty("txHash");
    expect(JSON.stringify(event).includes(privateText)).toBe(false);
  });

  it("formats credential-shaped gas usage at the capture-anchor sink", async () => {
    const event = await anchorTelemetryFor({
      ...validAnchorResult(),
      gasUsed: privateText,
    });
    expect(event?.metadata.gasUsed).toBe("[invalid id]");
    expect(JSON.stringify(event).includes(privateText)).toBe(false);
  });

  it("fails closed for an invalid block number at the capture-anchor sink", async () => {
    const event = await anchorTelemetryFor({
      ...validAnchorResult(),
      blockNumber: -1,
    });
    expect(event?.metadata.blockNumber).toBeNull();
  });

  it("formats a caller-supplied job id in the capture-challenge timeline key", async () => {
    const challengeId = randomUUID();
    useChallengeId(challengeId);
    const response = await app.inject({
      method: "POST",
      url: "/api/capture/challenge",
      payload: { jobId: privateText, declaredClass: "CC0", requestedTtlSeconds: 37 },
    });
    expect(response.statusCode).toBe(200);
    const events = pipelineTelemetry.getTimeline("[invalid id]").filter(
      (event) => event.metadata.subphase === "capture_challenge" &&
        event.metadata.challengeId === challengeId,
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.jobId).toBe("[invalid id]");
    expect(events[0]?.metadata.ttl).toBe(37);
    expect(JSON.stringify(events[0]).includes(privateText)).toBe(false);
  });

  it("formats a credential-shaped capture challenge id in telemetry", async () => {
    const event = await challengeTelemetryFor(privateText);

    expect(event?.metadata.challengeId === "[invalid id]").toBe(true);
    expect(JSON.stringify(event).includes(privateText)).toBe(false);
  });

  it("preserves a valid capture challenge id in telemetry", async () => {
    const challengeId = randomUUID();
    const event = await challengeTelemetryFor(challengeId);

    expect(event?.metadata.challengeId).toBe(challengeId);
  });

  it("preserves a valid agent trace id at every exported sink", async () => {
    const traceId = "tr_0123456789abcdef";
    const observed = await reportObservations({
      summary: "Valid trace correlation test",
      trace_id: traceId,
    });

    expect(observed.echoedTraceId).toBe(traceId);
    expect(observed.sinkValues).toEqual([traceId, traceId, traceId]);

    // The outbound analytics policy may independently filter properties.
    const emittedTraceId = observed.clientEvent?.properties?.trace_id;
    if (emittedTraceId !== undefined) {
      expect(emittedTraceId).toBe(traceId);
    }
  });

  it("formats a credential-shaped agent trace id at every exported sink", async () => {
    // A body-supplied malformed trace id is rejected. Override the request
    // decoration after middleware validation to exercise the fallback path.
    traceOverride = privateText;

    const observed = await reportObservations({
      summary: "Formatted trace correlation test",
    });

    // The reply intentionally retains the caller-visible correlation value.
    expect(observed.echoedTraceId === privateText).toBe(true);

    // These three checks independently kill reversions at setAttribute,
    // trackServerEvent and addEvent.
    expect(observed.sinkValues.every((value) => value === "[invalid id]")).toBe(true);
    expect(JSON.stringify(observed.sinkValues).includes(privateText)).toBe(false);
    expect(JSON.stringify(observed.clientEvent).includes(privateText)).toBe(false);

    const emittedTraceId = observed.clientEvent?.properties?.trace_id;
    if (emittedTraceId !== undefined) {
      expect(emittedTraceId === "[invalid id]").toBe(true);
    }
  });
  it("preserves an ordinary agent kind in its exported span attribute", async () => {
    const observed = await reportObservations({
      summary: "Valid agent category in telemetry",
      agent_kind: "gpt-4o",
    });
    expect(observed.spanAttributes?.["pcc.agent_kind"]).toBe("gpt-4o");
  });

  it("formats a credential-shaped agent kind in its exported span attribute", async () => {
    const observed = await reportObservations({
      summary: "Formatted agent category in telemetry",
      agent_kind: privateText,
    });
    expect(observed.spanAttributes?.["pcc.agent_kind"]).toBe("[invalid id]");
    expect(JSON.stringify(observed.spanAttributes).includes(privateText)).toBe(false);
  });

  it("formats every caller-supplied optional agent diagnostic at its exported sink", async () => {
    const observed = await reportObservations({
      summary: "Formatted optional report metadata",
      agent_kind: privateText,
      last_endpoint: privateText,
      last_error_code: privateText,
      confused_about: privateText,
    });
    expect(observed.spanAttributes).toMatchObject({
      "pcc.agent_kind": "[invalid id]",
      "pcc.last_endpoint": "[invalid id]",
      "pcc.last_error_code": "[invalid id]",
      "pcc.confused_about": "[invalid id]",
    });
    expect(observed.spanEventAttributes).toMatchObject({
      "pcc.summary_length": "Formatted optional report metadata".length,
    });
    expect(observed.forwardedAnalytics).toMatchObject({
      agent_kind: "[invalid id]",
      last_error_code: "[invalid id]",
      confused_about: "[invalid id]",
    });
    expect(JSON.stringify(observed.spanAttributes).includes(privateText)).toBe(false);
    expect(JSON.stringify(observed.forwardedAnalytics).includes(privateText)).toBe(false);
  });

  it("keeps safe agent diagnostic categories and drops unstructured paths at the span sink", async () => {
    const observed = await reportObservations({
      summary: "Typed categories remain reportable",
      agent_kind: "claude",
      last_error_code: "SERVICE_UNAVAILABLE",
      confused_about: "fund",
      last_endpoint: "/api/fiat-ramp/onramp/session",
    });
    expect(observed.spanAttributes).toMatchObject({
      "pcc.agent_kind": "claude",
      "pcc.last_error_code": "SERVICE_UNAVAILABLE",
      "pcc.confused_about": "fund",
      "pcc.last_endpoint": "[invalid id]",
    });
  });

  it("formats simulation job identifiers in both event keys and metadata", async () => {
    simulatorModule.setGenesisSpawnerForTests(vi.fn(async () => ({
      code: 42,
      stderr: "fixed diagnostic",
      stdout: "",
    })));
    const response = await app.inject({
      method: "POST",
      url: "/api/capture/sim",
      payload: {
        jobId: privateText,
        rolloutBytesBase64: Buffer.from("simulated rollout").toString("base64"),
      },
    });
    expect(response.statusCode).toBe(502);
    const events = pipelineTelemetry.getTimeline("[invalid id]").filter(
      (event) => event.metadata.subphase === "capture_sim" && event.status === "failed",
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.jobId).toBe("[invalid id]");
    expect(events[0]?.metadata.jobId).toBe("[invalid id]");
    expect(JSON.stringify(events[0]).includes(privateText)).toBe(false);
  });

  it("keeps adapter failure diagnostics free of dependency messages", async () => {
    const jobId = `job-sim-${randomUUID()}`;
    // A broken dependency may surface arbitrary diagnostic material rather
    // than its documented process-exit integer. The off-box sink still closes.
    simulatorModule.setGenesisSpawnerForTests(vi.fn(async () => ({
      code: privateText as unknown as number,
      stderr: privateText,
      stdout: "",
    })));

    const response = await app.inject({
      method: "POST",
      url: "/api/capture/sim",
      payload: {
        jobId,
        rolloutBytesBase64: Buffer.from("simulated rollout").toString("base64"),
      },
    });
    expect(response.statusCode).toBe(502);
    expect(response.json().error).toBe("runner_exit_nonzero");

    const events = pipelineTelemetry.getTimeline(jobId).filter(
      (event) => event.metadata.subphase === "capture_sim" && event.status === "failed",
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.metadata.error).toBe("runner_exit_nonzero");
    expect(events[0]?.metadata.message).toBe("adapter_failed");
    expect(JSON.stringify(events[0]).includes(privateText)).toBe(false);
  });
});
