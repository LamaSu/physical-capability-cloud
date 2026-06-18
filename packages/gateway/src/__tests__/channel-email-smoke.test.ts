/**
 * channel-email-smoke — verifies the email transport behaves honestly.
 *
 * Three behaviours that must hold:
 *
 *   1. With RESEND_API_KEY set + Resend client returning ok: the channel
 *      service calls Resend exactly once with the right envelope and returns
 *      `delivered: true, status: "queued"`.
 *
 *   2. When the Resend client returns an error: the result is
 *      `delivered: false, status: "bounced"` with an explanatory error.
 *      Never `delivered: true` on transport failure.
 *
 *   3. When RESEND_API_KEY is missing: the result is
 *      `delivered: false, status: "skipped"` with a `ref:noconfig:...`
 *      sentinel. This is the B5 fix: the substrate must not lie when no
 *      transport is configured.
 *
 * We test the email service (`sendEmail`) directly with an injected fake
 * client — no network IO, no real keys, no flakiness.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  sendEmail,
  type EmailEnvelope,
  type ResendClient,
} from "../services/channel-email.js";

function fakeOk(idOverride?: string): ResendClient {
  return {
    send: vi.fn(async () => ({
      ok: true,
      status: 200,
      id: idOverride ?? "fake-resend-id-1234",
    })),
  };
}

function fakeBounce(status = 422): ResendClient {
  return {
    send: vi.fn(async () => ({
      ok: false,
      status,
      errorBody: '{"message":"Invalid `to` field"}',
    })),
  };
}

function fakeThrow(): ResendClient {
  return {
    send: vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }),
  };
}

const envelope: EmailEnvelope = {
  to: "operator@example.com",
  subject: "[PCC test] new job",
  body: "Job payload here.",
};

describe("channel-email service", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it("sends one Resend call with the right envelope on success", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_fake_test_key");
    const client = fakeOk("real-uuid-xyz");

    const result = await sendEmail(envelope, client);

    expect(client.send).toHaveBeenCalledTimes(1);
    expect(client.send).toHaveBeenCalledWith(
      "re_fake_test_key",
      expect.objectContaining({
        to: "operator@example.com",
        subject: "[PCC test] new job",
      }),
    );
    expect(result.delivered).toBe(true);
    expect(result.status).toBe("queued");
    expect(result.ref).toBe("real-uuid-xyz");
    expect(result.error).toBeUndefined();
  });

  it("returns delivered:false status:bounced when Resend returns an error", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_fake_test_key");
    const client = fakeBounce(422);

    const result = await sendEmail(envelope, client);

    expect(result.delivered).toBe(false);
    expect(result.status).toBe("bounced");
    expect(result.ref).toBe("ref:error:resend-http-422");
    expect(result.error).toContain("Invalid");
  });

  it("returns delivered:false status:bounced when the client throws", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_fake_test_key");
    const client = fakeThrow();

    const result = await sendEmail(envelope, client);

    expect(result.delivered).toBe(false);
    expect(result.status).toBe("bounced");
    expect(result.ref).toBe("ref:error:exception");
    expect(result.error).toBe("ECONNREFUSED");
  });

  it("returns delivered:false status:skipped when RESEND_API_KEY is missing", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    // also handle the truly-undefined case
    delete process.env.RESEND_API_KEY;
    const client = fakeOk();

    const result = await sendEmail(envelope, client);

    // The B5 fix: do NOT call the client when no key is configured, and
    // explicitly return `skipped` with a noconfig ref. Never `delivered:true`.
    expect(client.send).not.toHaveBeenCalled();
    expect(result.delivered).toBe(false);
    expect(result.status).toBe("skipped");
    expect(result.ref).toBe("ref:noconfig:RESEND_API_KEY_missing");
    expect(result.error).toContain("RESEND_API_KEY");
  });

  it("returns delivered:false status:bounced when envelope is malformed", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_fake_test_key");
    const client = fakeOk();

    const result = await sendEmail(
      { to: "", subject: "", body: "x" },
      client,
    );

    expect(client.send).not.toHaveBeenCalled();
    expect(result.delivered).toBe(false);
    expect(result.status).toBe("bounced");
    expect(result.ref).toBe("ref:error:missing-envelope-fields");
  });
});

describe("channel-email integration with operator-channels dispatch", () => {
  // Verifies the email branch of dispatchToChannels actually uses the email
  // service (rather than the old logged-stub path). We attach an email
  // channel, dispatch a synthetic job, and assert the fake Resend client
  // sees the wire-shaped envelope.

  it("dispatches via the email transport when attached", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_fake_test_key");
    const client = fakeOk("op-channel-send-id");

    const {
      attachChannel,
      dispatchToChannels,
      _clearOperatorChannelsForTests,
    } = await import("../routes/operator-channels.js");

    _clearOperatorChannelsForTests();
    attachChannel("test-op-bravo", {
      label: "Operator inbox",
      transport: "email",
      describe: "Email the owner whenever a job lands; reply with Y/N",
      endpoint: { address: "operator@example.com" },
    });

    const results = await dispatchToChannels(
      "test-op-bravo",
      {
        jobId: "job_test_123",
        contextRef: "ctx_abc",
        summary: "Test dispatch via email transport",
      },
      { emailClient: client },
    );

    expect(client.send).toHaveBeenCalledTimes(1);
    const sendCall = (client.send as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(sendCall[0]).toBe("re_fake_test_key");
    expect(sendCall[1].to).toBe("operator@example.com");
    expect(sendCall[1].subject).toContain("job_test_123");
    expect(sendCall[1].body).toContain("Test dispatch via email transport");
    expect(sendCall[1].body).toContain("Email the owner whenever");

    expect(results).toHaveLength(1);
    expect(results[0]!.transport).toBe("email");
    expect(results[0]!.delivered).toBe(true);
    expect(results[0]!.status).toBe("queued");
    expect(results[0]!.ref).toBe("op-channel-send-id");
  });

  it("returns bounced result when the email endpoint lacks an address", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_fake_test_key");
    const client = fakeOk();

    const {
      attachChannel,
      dispatchToChannels,
      _clearOperatorChannelsForTests,
    } = await import("../routes/operator-channels.js");

    _clearOperatorChannelsForTests();
    attachChannel("test-op-charlie", {
      label: "Misconfigured email",
      transport: "email",
      describe: "Operator forgot to fill in the address slot",
      endpoint: {},
    });

    const results = await dispatchToChannels(
      "test-op-charlie",
      { jobId: "j_2", contextRef: "ctx", summary: "noop" },
      { emailClient: client },
    );

    expect(client.send).not.toHaveBeenCalled();
    expect(results[0]!.delivered).toBe(false);
    expect(results[0]!.status).toBe("bounced");
    expect(results[0]!.ref).toBe("ref:error:no-endpoint-address");
  });
});
