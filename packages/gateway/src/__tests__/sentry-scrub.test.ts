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
