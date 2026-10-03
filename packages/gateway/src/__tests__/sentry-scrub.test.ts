/**
 * Cross-family review r3 of #441 (rm-px7-441-r3-01ed0dac), CRITICAL: request credentials must never
 * reach Sentry. The installed SDK's request-data integration copies every request header into an
 * error event (@sentry/core integrations/requestdata.js: include.headers defaults to true; only
 * cookies and IP headers are ever removed), so an error in an authenticated request would send its
 * X-Verifier-Key, X-Admin-Key, Authorization and cookies. The baseline test shows that SDK
 * behaviour; the next one shows the gateway's own options removing them before anything is sent.
 */
import { describe, it, expect } from "vitest";
import * as Sentry from "@sentry/node";
import { sentryOptions } from "../sentry.js";

// Credentials are built at runtime, so no literal in this file looks like a secret.
const VERIFIER = ["verifier", "key", "r4", "0123456789abcdef0123456789"].join("-");
const ADMIN = ["admin", "key", "r4", "fedcba9876543210"].join("-");
const BEARER = ["api", "key", "r4", "0f1e2d3c4b5a"].join("-");
const SESSION = ["session", "r4", "cookie"].join("-");
const SIWE = ["siwe", "token", "r4"].join("-");
const DSN = "https://public@o0.ingest.sentry.io/0";

/** Sends one error under a request that carries every credential, and returns what the transport got. */
async function sendErrorWith(options: Record<string, unknown>): Promise<string> {
  const sent: string[] = [];
  Sentry.init({
    dsn: DSN,
    defaultIntegrations: false,
    integrations: [Sentry.requestDataIntegration()],
    tracesSampleRate: 0,
    ...options,
    transport: (transportOptions) =>
      Sentry.createTransport(transportOptions, async (request) => {
        sent.push(typeof request.body === "string" ? request.body : Buffer.from(request.body).toString("utf8"));
        return { statusCode: 200 };
      }),
  });
  Sentry.withIsolationScope((scope) => {
    scope.setSDKProcessingMetadata({
      normalizedRequest: {
        method: "GET",
        url: `https://gateway.test/api/evidence/sha256:${"ab".repeat(32)}?token=${SIWE}`,
        query_string: `token=${SIWE}`,
        headers: {
          "x-verifier-key": VERIFIER,
          "x-admin-key": ADMIN,
          authorization: `Bearer ${BEARER}`,
          cookie: `pcc_session=${SESSION}`,
          "user-agent": "PCC-Oracle/1.0",
        },
      },
    });
    Sentry.captureException(new Error("findEventsByBundle failed"));
  });
  await Sentry.flush(2000);
  return sent.join("\n");
}

describe("CRITICAL (review r3 of #441): request credentials never reach Sentry", () => {
  it("baseline: the installed SDK, unconfigured, sends every request header it was given", async () => {
    const sent = await sendErrorWith({});
    expect(sent).toContain("findEventsByBundle failed");
    expect(sent).toContain(VERIFIER);
  });

  it("the gateway's options redact the verifier key, the admin key, the bearer key, the session cookie and the query token", async () => {
    const { dsn: _dsn, tracesSampleRate: _t, profilesSampleRate: _p, ...gatewayOptions } = sentryOptions(DSN);
    const sent = await sendErrorWith(gatewayOptions);
    expect(sent).toContain("findEventsByBundle failed");
    for (const secret of [VERIFIER, ADMIN, BEARER, SESSION, SIWE]) expect(sent, secret).not.toContain(secret);
    // What is not a credential stays, so the event is still useful.
    expect(sent).toContain("PCC-Oracle/1.0");
    expect(sent).toContain("/api/evidence/sha256:");
  });
});

// Cross-family review r4 of #441 (rm-px7-441-r4-3c6783bc), MEDIUM 2: the scrub looked only at an
// error event's request, by header name. Signature headers are not credential-named, a transaction
// carries the request's headers and URL as span attributes, breadcrumbs carry outgoing URLs and
// headers, and the SDK attaches the request body (httpServerIntegration: maxRequestBodySize
// defaults to "medium"; requestDataIntegration: include.data defaults to true).
const PAYMENT_SIG = ["payment", "sig", "r5", "a1b2c3d4"].join("-");
const HMAC_SIG = ["hmac", "sig", "r5", "e5f6a7b8"].join("-");
const LOB_SIG = ["lob", "sig", "r5", "c9d0e1f2"].join("-");
const URL_TOKEN = ["url", "token", "r5", "3a4b5c"].join("-");
const BODY_SECRET = ["body", "password", "r5", "6d7e8f"].join("-");

/** Sends a transaction, then an error with a breadcrumb, under a request with a body; returns what the transport got. */
async function sendTransactionAndBreadcrumbs(options: Record<string, unknown>): Promise<string> {
  const sent: string[] = [];
  Sentry.init({
    dsn: DSN,
    defaultIntegrations: false,
    integrations: [Sentry.requestDataIntegration()],
    tracesSampleRate: 1,
    ...options,
    transport: (transportOptions) =>
      Sentry.createTransport(transportOptions, async (request) => {
        sent.push(typeof request.body === "string" ? request.body : Buffer.from(request.body).toString("utf8"));
        return { statusCode: 200 };
      }),
  });
  // A transaction as the HTTP server instrumentation records one (observability-redaction.test.ts
  // shows the real one): the request's headers and URL as span attributes. Built as an event, so
  // the test does not depend on which client the OpenTelemetry provider of an earlier init holds.
  const now = Date.now() / 1000;
  const trace = { trace_id: "a".repeat(32), span_id: "b".repeat(16) };
  Sentry.captureEvent({
    type: "transaction",
    transaction: "GET /api/evidence/:hash",
    start_timestamp: now - 1,
    timestamp: now,
    contexts: {
      trace: { ...trace, op: "http.server", data: { "http.request.header.payment_signature": PAYMENT_SIG, "url.query": `?token=${URL_TOKEN}` } },
    },
    spans: [
      {
        ...trace, span_id: "c".repeat(16), parent_span_id: trace.span_id, start_timestamp: now - 1, timestamp: now,
        description: "evidence read", data: { "http.request.header.x_hmac_signature": HMAC_SIG },
      },
    ],
  } as never);
  Sentry.addBreadcrumb({
    category: "http",
    type: "http",
    message: `GET https://carrier.test/v1/track?api_key=${URL_TOKEN}`,
    data: {
      url: `https://carrier.test/v1/track?access_token=${URL_TOKEN}`,
      "http.query": `sig=${URL_TOKEN}`,
      headers: { "payment-signature": PAYMENT_SIG, "x-hmac-signature": HMAC_SIG, "lob-signature": LOB_SIG },
    },
  });
  Sentry.withIsolationScope((scope) => {
    scope.setSDKProcessingMetadata({
      normalizedRequest: {
        method: "POST",
        url: "https://gateway.test/api/webhooks/lob",
        headers: { "payment-signature": PAYMENT_SIG, "x-hmac-signature": HMAC_SIG, "lob-signature": LOB_SIG, "content-type": "application/json" },
        data: JSON.stringify({ email: "r5@example.test", password: BODY_SECRET }),
      },
    });
    Sentry.captureException(new Error("lob webhook failed"));
  });
  await Sentry.flush(2000);
  return sent.join("\n");
}

describe("MEDIUM 2 (review r4 of #441): transactions, breadcrumbs, signature headers and bodies are scrubbed too", () => {
  it("baseline: the installed SDK, unconfigured, sends the signature headers, the URL credential and the body", async () => {
    const sent = await sendTransactionAndBreadcrumbs({});
    for (const secret of [PAYMENT_SIG, HMAC_SIG, LOB_SIG, URL_TOKEN, BODY_SECRET]) expect(sent, secret).toContain(secret);
  });

  it("the gateway's options remove them from the transaction, the breadcrumbs, the request headers and the body", async () => {
    const { dsn: _dsn, tracesSampleRate: _t, profilesSampleRate: _p, ...gatewayOptions } = sentryOptions(DSN);
    const sent = await sendTransactionAndBreadcrumbs(gatewayOptions);
    expect(sent).toContain("lob webhook failed");
    expect(sent).toContain("GET /api/evidence/:hash");
    for (const secret of [PAYMENT_SIG, HMAC_SIG, LOB_SIG, URL_TOKEN, BODY_SECRET]) expect(sent, secret).not.toContain(secret);
    // The hosts and the paths stay. The body goes whole (value-free rule, review r5 of #441), so
    // even its non-secret field is not sent.
    expect(sent).toContain("carrier.test/v1/track");
    expect(sent).not.toContain("r5@example.test");
  });
});
