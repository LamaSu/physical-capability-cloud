/**
 * Lob route tests — create-a-letter, idempotent re-create, and the webhook
 * receiver's full signature-verification + committed-letter-match + evidence-
 * event path. The webhook signature is computed with real HMAC-SHA256 over
 * `${timestamp}.${body}` in this file (not stubbed), exactly as Lob's
 * Integration Guide specifies, so this exercises the exact bytes-on-the-wire
 * path a genuine Lob delivery would take.
 *
 * Also asserts the HONEST asymmetry is surfaced (operator self-report, no
 * independent carrier scan) rather than hidden.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createHmac } from "node:crypto";
import { verifyEventHash } from "@pcc/spec";
import { lobRoutes } from "../routes/lob.js";
import { LobClient, _setLobClientForTests } from "../services/lob-client.js";
import { _resetLobLetterStoreForTests, getLobLetterStore } from "../services/lob-letter-store.js";

const WEBHOOK_SECRET = "whsec_test_lob_suite";

// Lob signature: HMAC-SHA256 over `${Lob-Signature-Timestamp}.${rawBody}`, hex.
function signHeaders(body: string, timestamp = Date.now().toString()) {
  const signature = createHmac("sha256", WEBHOOK_SECRET).update(`${timestamp}.${body}`, "utf8").digest("hex");
  return {
    "content-type": "application/json",
    "lob-signature": signature,
    "lob-signature-timestamp": timestamp,
  };
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(lobRoutes);
  await app.ready();
  return app;
}

const validBody = {
  jobId: "job-print-mail-1",
  kernelId: "kernel-hp-printer",
  to: { name: "Court Clerk", addressLine1: "60 Centre St", addressCity: "New York", addressState: "NY", addressZip: "10007" },
  from: { name: "PCC Operator", addressLine1: "1 Shop Way", addressCity: "San Francisco", addressState: "CA", addressZip: "94103" },
  file: "<html><body>Official document</body></html>",
};

beforeEach(() => {
  _resetLobLetterStoreForTests();
  _setLobClientForTests(undefined);
});

afterEach(() => {
  _resetLobLetterStoreForTests();
  _setLobClientForTests(undefined);
});

// Builds a Lob Event webhook body for a given letter id + event type.
function eventBody(lobLetterId: string, eventType: string, id: string, occurredAt = "2026-08-27T14:22:00Z") {
  return JSON.stringify({
    id,
    event_type: { id: eventType, resource: "letters", object: "event_type" },
    reference_id: lobLetterId,
    date_created: occurredAt,
    body: { id: lobLetterId, carrier: "USPS", tracking_number: null, expected_delivery_date: "2026-09-02", object: "letter" },
    object: "event",
  });
}

describe("GET /api/lob/healthz", () => {
  it("reports mock mode, no webhook secret, and the assurance tier by default", async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({ method: "GET", url: "/api/lob/healthz" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ok).toBe(true);
      expect(body.mock).toBe(true);
      expect(body.webhookConfigured).toBe(false);
      expect(body.assuranceTier).toBe("operator_self_report");
    } finally {
      await app.close();
    }
  });
});

describe("POST /api/lob/letters", () => {
  it("rejects missing required fields with 400 + details", async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({ method: "POST", url: "/api/lob/letters", payload: {} });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("missing_fields");
      expect(res.json().details.length).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });

  it("creates a (mock) letter, returns a commitment, and surfaces the honest assurance tier", async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({ method: "POST", url: "/api/lob/letters", payload: validBody });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.jobId).toBe("job-print-mail-1");
      expect(body.simulated).toBe(true);
      expect(body.status).toBe("created");
      expect(body.lobLetterId).toMatch(/^ltr_mock_/);
      expect(body.commitment.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(body.commitment.jobId).toBe("job-print-mail-1");
      // Asymmetry surfaced, not hidden.
      expect(body.assurance.tier).toBe("operator_self_report");
      expect(body.assurance.independentCarrierScan).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("is idempotent per jobId — a second call returns the SAME letter, not a new create", async () => {
    const app = await buildApp();
    try {
      const first = await app.inject({ method: "POST", url: "/api/lob/letters", payload: validBody });
      const second = await app.inject({ method: "POST", url: "/api/lob/letters", payload: validBody });
      expect(first.statusCode).toBe(201);
      expect(second.statusCode).toBe(200);
      expect(second.json().lobLetterId).toBe(first.json().lobLetterId);
      expect(getLobLetterStore().size()).toBe(1);
    } finally {
      await app.close();
    }
  });
});

describe("GET /api/lob/letters/:jobId", () => {
  it("404s for an unknown job", async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({ method: "GET", url: "/api/lob/letters/does-not-exist" });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("returns the record after a letter is created", async () => {
    const app = await buildApp();
    try {
      await app.inject({ method: "POST", url: "/api/lob/letters", payload: validBody });
      const res = await app.inject({ method: "GET", url: "/api/lob/letters/job-print-mail-1" });
      expect(res.statusCode).toBe(200);
      expect(res.json().jobId).toBe("job-print-mail-1");
    } finally {
      await app.close();
    }
  });
});

describe("POST /api/lob/webhook", () => {
  it("503s when no webhook secret is configured (default client) — fails closed", async () => {
    const app = await buildApp();
    try {
      const payload = eventBody("ltr_x", "letter.mailed", "evt_1");
      const res = await app.inject({
        method: "POST",
        url: "/api/lob/webhook",
        payload,
        headers: { "content-type": "application/json", "lob-signature": "irrelevant", "lob-signature-timestamp": "1" },
      });
      expect(res.statusCode).toBe(503);
    } finally {
      await app.close();
    }
  });

  it("401s on an invalid signature once a secret IS configured", async () => {
    _setLobClientForTests(new LobClient({ webhookSecret: WEBHOOK_SECRET }));
    const app = await buildApp();
    try {
      const payload = eventBody("ltr_x", "letter.mailed", "evt_1");
      const res = await app.inject({
        method: "POST",
        url: "/api/lob/webhook",
        payload,
        headers: { "content-type": "application/json", "lob-signature": "deadbeef", "lob-signature-timestamp": Date.now().toString() },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe("invalid_signature");
    } finally {
      await app.close();
    }
  });

  it("401s on a stale timestamp (replay), even with a valid signature", async () => {
    _setLobClientForTests(new LobClient({ webhookSecret: WEBHOOK_SECRET }));
    const app = await buildApp();
    try {
      const payload = eventBody("ltr_x", "letter.mailed", "evt_1");
      const staleTs = (Date.now() - 30 * 60 * 1000).toString(); // 30 min old
      const res = await app.inject({ method: "POST", url: "/api/lob/webhook", payload, headers: signHeaders(payload, staleTs) });
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe("stale_timestamp");
    } finally {
      await app.close();
    }
  });

  it("accepts a correctly-signed letter.mailed and emits a byte-verifiable courier_pickup_confirmed", async () => {
    _setLobClientForTests(new LobClient({ webhookSecret: WEBHOOK_SECRET }));
    const app = await buildApp();
    try {
      const created = await app.inject({ method: "POST", url: "/api/lob/letters", payload: validBody });
      const { lobLetterId } = created.json();

      const payload = eventBody(lobLetterId, "letter.mailed", "evt_mailed_1");
      const res = await app.inject({ method: "POST", url: "/api/lob/webhook", payload, headers: signHeaders(payload) });

      expect(res.statusCode).toBe(200);
      expect(res.json().matched).toBe(true);
      expect(res.json().status).toBe("mailed");

      const record = getLobLetterStore().getByJobId("job-print-mail-1")!;
      expect(record.status).toBe("mailed");
      expect(record.events).toHaveLength(1);
      const event = record.events[0]!;
      expect(event.type).toBe("courier_pickup_confirmed");
      expect(event.source.deviceType).toBe("courier_api");
      expect(event.source.kernelId).toBe("kernel-hp-printer");
      expect(event.source.simulated).toBe(true); // mock-mode letter -> flagged non-authentic
      expect(event.timestamp).toBe("2026-08-27T14:22:00Z");
      // Payload is exactly the contracted shape {jobId, lobLetterId, carrier, commitmentHash}
      // (trackingNumber omitted — standard Lob letter has none).
      expect(event.payload.jobId).toBe("job-print-mail-1");
      expect(event.payload.lobLetterId).toBe(lobLetterId);
      expect(event.payload.carrier).toBe("USPS");
      expect(event.payload.commitmentHash).toBe(record.commitment.hash);
      expect(event.payload.trackingNumber).toBeUndefined();

      // The hash is the SAME canonical hash @pcc/spec would recompute and check.
      expect(await verifyEventHash(event)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("is idempotent on Lob's event id — a retried delivery does not duplicate the EvidenceEvent", async () => {
    _setLobClientForTests(new LobClient({ webhookSecret: WEBHOOK_SECRET }));
    const app = await buildApp();
    try {
      const created = await app.inject({ method: "POST", url: "/api/lob/letters", payload: validBody });
      const { lobLetterId } = created.json();
      const payload = eventBody(lobLetterId, "letter.mailed", "evt_retry_1");
      const headers = signHeaders(payload);

      const first = await app.inject({ method: "POST", url: "/api/lob/webhook", payload, headers });
      const second = await app.inject({ method: "POST", url: "/api/lob/webhook", payload, headers });

      expect(first.json().deduped).toBe(false);
      expect(second.json().deduped).toBe(true);
      expect(getLobLetterStore().getByJobId("job-print-mail-1")!.events).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it("does not treat an event for an uncommitted letter id as evidence for any job", async () => {
    _setLobClientForTests(new LobClient({ webhookSecret: WEBHOOK_SECRET }));
    const app = await buildApp();
    try {
      const payload = eventBody("ltr_never_committed", "letter.mailed", "evt_stray_1");
      const res = await app.inject({ method: "POST", url: "/api/lob/webhook", payload, headers: signHeaders(payload) });
      expect(res.statusCode).toBe(200);
      expect(res.json().matched).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("ignores non-letter events without error (2xx, ignored)", async () => {
    _setLobClientForTests(new LobClient({ webhookSecret: WEBHOOK_SECRET }));
    const app = await buildApp();
    try {
      const payload = JSON.stringify({ id: "evt_pc", event_type: { id: "postcard.created" }, reference_id: "psc_1", object: "event" });
      const res = await app.inject({ method: "POST", url: "/api/lob/webhook", payload, headers: signHeaders(payload) });
      expect(res.statusCode).toBe(200);
      expect(res.json().ignored).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("emits courier_delivery_confirmed on a delivered transition (after mailed)", async () => {
    _setLobClientForTests(new LobClient({ webhookSecret: WEBHOOK_SECRET }));
    const app = await buildApp();
    try {
      const created = await app.inject({ method: "POST", url: "/api/lob/letters", payload: validBody });
      const { lobLetterId } = created.json();

      const mailed = eventBody(lobLetterId, "letter.mailed", "evt_a", "2026-08-27T14:22:00Z");
      await app.inject({ method: "POST", url: "/api/lob/webhook", payload: mailed, headers: signHeaders(mailed) });

      const delivered = eventBody(lobLetterId, "letter.delivered", "evt_b", "2026-09-02T09:00:00Z");
      const res2 = await app.inject({ method: "POST", url: "/api/lob/webhook", payload: delivered, headers: signHeaders(delivered) });

      expect(res2.json().status).toBe("delivered");
      const record = getLobLetterStore().getByJobId("job-print-mail-1")!;
      expect(record.events).toHaveLength(2);
      expect(record.events[1]!.type).toBe("courier_delivery_confirmed");
    } finally {
      await app.close();
    }
  });

  it("does not emit an EvidenceEvent for lifecycle-only events (created/rendered/in_transit)", async () => {
    _setLobClientForTests(new LobClient({ webhookSecret: WEBHOOK_SECRET }));
    const app = await buildApp();
    try {
      const created = await app.inject({ method: "POST", url: "/api/lob/letters", payload: validBody });
      const { lobLetterId } = created.json();

      const rendered = eventBody(lobLetterId, "letter.rendered_pdf", "evt_r");
      await app.inject({ method: "POST", url: "/api/lob/webhook", payload: rendered, headers: signHeaders(rendered) });
      const inTransit = eventBody(lobLetterId, "letter.in_transit", "evt_t");
      const res = await app.inject({ method: "POST", url: "/api/lob/webhook", payload: inTransit, headers: signHeaders(inTransit) });

      expect(res.json().matched).toBe(true);
      expect(res.json().status).toBe("in_transit");
      // Status advanced, but no courier_* evidence for these lifecycle-only events.
      expect(getLobLetterStore().getByJobId("job-print-mail-1")!.events).toHaveLength(0);
    } finally {
      await app.close();
    }
  });
});
