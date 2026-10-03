/**
 * The shared observability redaction (observability-redact.ts; cross-family review r4 of #441), one
 * mechanism at a time: parameters in any string, headers by allowlist in every shape a record
 * carries them, span header attributes, credential-named keys, JSON bodies, records left unaltered,
 * and the logger options end to end (a url field and a message that no serializer touches).
 */
import { describe, it, expect } from "vitest";
import { Writable } from "node:stream";
import Fastify from "fastify";
import { REDACTED, gatewayLoggerOptions, redactCredentials, redactUrl } from "../observability-redact.js";

// Built at runtime, so no literal here looks like a secret.
const secret = (name: string) => ["r5", name, "9b8c7d6e"].join("-");

describe("redactUrl: every credential-named parameter, wherever it sits", () => {
  it("query, fragment, matrix and form parameters; an encoded name; other parameters kept", () => {
    const s = secret("q");
    expect(redactUrl(`/api/x?token=${s}&page=2`)).toBe(`/api/x?token=${REDACTED}&page=2`);
    expect(redactUrl(`https://h.test/p?a=1&api_key=${s}#access_token=${s}`)).toBe(`https://h.test/p?a=1&api_key=${REDACTED}#access_token=${REDACTED}`);
    // A credential's value runs to the next & ; # or space: a "?" inside it is redacted with it.
    expect(redactUrl(`/p;jsessionid=${s}?x=1`)).toBe(`/p;jsessionid=${REDACTED}`);
    expect(redactUrl(`/p?%74oken=${s}`)).toBe(`/p?%74oken=${REDACTED}`);
    expect(redactUrl(`email=a%40b.test&password=${s}`)).toBe(`email=a%40b.test&password=${REDACTED}`);
    expect(redactUrl(`GET /p?X-Amz-Signature=${s} failed`)).toBe(`GET /p?X-Amz-Signature=${REDACTED} failed`);
    expect(redactUrl("/api/evidence/sha256:abc?format=json")).toBe("/api/evidence/sha256:abc?format=json");
  });
});

describe("redactCredentials: the whole record", () => {
  it("headers keep a value only on the allowlist, as an object, as pairs and as raw lines", () => {
    const s = secret("h");
    const out = redactCredentials({
      request: { headers: { "user-agent": "PCC-Oracle/1.0", "payment-signature": s, "X-Vendor-Proof": s, Authorization: `Bearer ${s}` } },
      breadcrumb: { headers: [["content-type", "application/json"], ["lob-signature", s]] },
      raw: { headers: `Content-Type: application/json\r\nX-Hmac-Signature: ${s}` },
    });
    expect(JSON.stringify(out)).not.toContain(s);
    expect(out.request.headers["user-agent"]).toBe("PCC-Oracle/1.0");
    expect(out.request.headers["X-Vendor-Proof"]).toBe(REDACTED);
    expect(out.breadcrumb.headers).toEqual([["content-type", "application/json"], ["lob-signature", REDACTED]]);
    expect(out.raw.headers).toBe(`Content-Type: application/json\r\nX-Hmac-Signature: ${REDACTED}`);
  });

  it("span header attributes by the same allowlist; credential-named keys; a non-string query_string", () => {
    const s = secret("a");
    const out = redactCredentials({
      data: { "http.request.header.user_agent": "ua", "http.request.header.payment_signature": s, "http.response.header.set_cookie": s },
      extra: { password: s, nested: { apiKey: s, page: 2 } },
      request: { query_string: [["token", s]] },
    });
    expect(JSON.stringify(out)).not.toContain(s);
    expect(out.data["http.request.header.user_agent"]).toBe("ua");
    expect(out.extra.nested.page).toBe(2);
  });

  it("a JSON body is parsed, redacted and written back; its other fields are kept", () => {
    const s = secret("b");
    const out = redactCredentials({ request: { data: JSON.stringify({ email: "r5@example.test", password: s, next: `/x?token=${s}` }) } });
    expect(out.request.data).not.toContain(s);
    expect(JSON.parse(out.request.data)).toEqual({ email: "r5@example.test", password: REDACTED, next: `/x?token=${REDACTED}` });
  });

  it("leaves the record it was given unaltered, and an Error keeps its name with its message redacted", () => {
    const s = secret("m");
    const input = { arguments: [{ apiKey: s }, `/x?token=${s}`], headers: { "lob-signature": s } };
    const before = JSON.stringify(input);
    const out = redactCredentials({ ...input, error: new Error(`failed at /y?api_key=${s}`) });
    expect(JSON.stringify(input)).toBe(before);
    expect(JSON.stringify(out)).not.toContain(s);
    expect(out.error).toMatchObject({ name: "Error", message: `failed at /y?api_key=${REDACTED}` });
  });

  it("a value nested past the depth limit, or on a cycle, is redacted whole", () => {
    const s = secret("d");
    let deep: Record<string, unknown> = { leaf: `/x?token=${s}`, plain: s };
    for (let i = 0; i < 40; i++) deep = { child: deep };
    const cyclic: Record<string, unknown> = { plain: s };
    cyclic.self = cyclic;
    expect(JSON.stringify(redactCredentials(deep))).not.toContain(s);
    expect(() => redactCredentials(cyclic)).not.toThrow();
  });
});

describe("gatewayLoggerOptions: every line, whatever logged it", () => {
  it("a url field and a message that no serializer touches, an error's message and stack", () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, done) {
        lines.push(String(chunk));
        done();
      },
    });
    const app = Fastify({ logger: { ...gatewayLoggerOptions(), stream } });
    const s = secret("l");
    app.log.warn({ msg: "ATTACK_DETECTED", url: `/api/x?token=${s}`, nested: { apiKey: s } });
    app.log.info(`proxying GET https://carrier.test/v1?access_token=${s}`);
    app.log.error(new Error(`upstream refused /v2?sig=${s}`));
    const logged = lines.join("");
    expect(logged).toContain("ATTACK_DETECTED");
    expect(logged).toContain("carrier.test/v1?access_token=");
    expect(logged).toContain("upstream refused /v2?sig=");
    expect(logged).not.toContain(s);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  });
});
