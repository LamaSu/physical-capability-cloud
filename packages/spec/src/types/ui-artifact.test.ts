/**
 * containsApiKey — hardened SHARE-boundary key guard (audit directive 9).
 *
 * The manifest is defense-in-depth only (the architectural guarantee is that a
 * manifest is NOT a credential transport — Round 1). This suite pins the
 * hardening the audit asked for: canonical prefix set, case-insensitivity,
 * percent-encoding, nested-location coverage, recursive credential-named-field
 * rejection — AND false-positive safety on benign strings/schemas.
 */

import { describe, expect, it } from "vitest";
import {
  containsApiKey,
  PCC_API_KEY_LIVE_PREFIX,
  PCC_API_KEY_TEST_PREFIX,
  PCC_API_KEY_PREFIXES,
  DASHBOARD_CSD_URL,
} from "./ui-artifact.js";

describe("containsApiKey — canonical prefix set", () => {
  it("exposes the canonical prefixes as the single source of truth", () => {
    expect(PCC_API_KEY_LIVE_PREFIX).toBe("pcc_live_");
    expect(PCC_API_KEY_TEST_PREFIX).toBe("pcc_test_");
    expect([...PCC_API_KEY_PREFIXES]).toEqual(["pcc_live_", "pcc_test_"]);
  });

  it("flags both live and test prefixes anywhere in a value", () => {
    expect(containsApiKey("pcc_live_abc123")).toBe(true);
    expect(containsApiKey("pcc_test_abc123")).toBe(true);
    expect(containsApiKey({ note: "prefix pcc_live_deadbeef here" })).toBe(true);
    expect(containsApiKey(["ok", "ok", "pcc_test_zzz"])).toBe(true);
  });
});

describe("containsApiKey — case + percent-encoding tolerance", () => {
  it("is case-insensitive (PCC_LIVE_, Pcc_Test_)", () => {
    expect(containsApiKey("PCC_LIVE_ABC")).toBe(true);
    expect(containsApiKey("Pcc_Test_Abc")).toBe(true);
    expect(containsApiKey({ x: "prefix PCC_LIVE_XYZ" })).toBe(true);
  });

  it("defeats percent-encoded prefixes (single + fully encoded + double)", () => {
    // underscores encoded
    expect(containsApiKey("pcc%5Flive%5Fabc")).toBe(true);
    expect(containsApiKey("PCC%5FLIVE%5Fabc")).toBe(true);
    // whole prefix encoded
    expect(containsApiKey("%70%63%63_live_abc")).toBe(true);
    // double-encoded (%255F -> %5F -> _)
    expect(containsApiKey("pcc%255Flive%255Fabc")).toBe(true);
    // encoded inside a URL binding path
    expect(
      containsApiKey({ binding: { path: "/api/x?k=pcc%5Flive%5Fsecret" } }),
    ).toBe(true);
  });

  it("does not throw on malformed percent sequences (fails open, still scans)", () => {
    expect(() => containsApiKey("100%broken% pcc_live_yes")).not.toThrow();
    expect(containsApiKey("100%broken% pcc_live_yes")).toBe(true);
    expect(containsApiKey("just 50% off, nothing here")).toBe(false);
  });
});

describe("containsApiKey — every nested location", () => {
  it("inspects URLs, query, action paths, defaults, labels, descriptions, snapshots, composeRefs", () => {
    expect(containsApiKey({ description: "key is pcc_live_1" })).toBe(true);
    expect(containsApiKey({ sections: [{ windows: [{ label: "pcc_test_2" }] }] })).toBe(true);
    expect(containsApiKey({ action: { path: "/api/pay?k=pcc_live_3" } })).toBe(true);
    expect(containsApiKey({ query: { auth: "pcc_live_4" } })).toBe(true);
    expect(containsApiKey({ schema: { properties: { x: { default: "pcc_test_5" } } } })).toBe(true);
    expect(containsApiKey({ snapshot: { "/api/jobs": { key: "pcc_live_6" } } })).toBe(true);
    expect(containsApiKey({ composeRefs: [{ note: "pcc_live_7" }] })).toBe(true);
  });
});

describe("containsApiKey — recursive credential-named-field rejection", () => {
  it("rejects a credential-named field carrying a concrete scalar value (baked secret)", () => {
    expect(containsApiKey({ token: "anything-non-empty" })).toBe(true);
    expect(containsApiKey({ apiKey: "abc" })).toBe(true);
    expect(containsApiKey({ api_key: "abc" })).toBe(true);
    expect(containsApiKey({ "API-KEY": "abc" })).toBe(true);
    expect(containsApiKey({ authorization: "Bearer xyz" })).toBe(true);
    expect(containsApiKey({ bearer: "xyz" })).toBe(true);
    expect(containsApiKey({ secret: "xyz" })).toBe(true);
    expect(containsApiKey({ password: "hunter2" })).toBe(true);
    expect(containsApiKey({ privateKey: "0xabc" })).toBe(true);
    expect(containsApiKey({ private_key: "0xabc" })).toBe(true);
    // deeply nested baked cred inside an action body
    expect(
      containsApiKey({ sections: [{ windows: [{ submit: { body: { authorization: "s3cr3t" } } }] }] }),
    ).toBe(true);
    // numeric baked value under a credential name
    expect(containsApiKey({ token: 12345 })).toBe(true);
  });

  it("ALLOWS a credential-shaped NAME whose value is a schema/definition object (form field)", () => {
    // A JSON-Schema `properties.password` is a field DEFINITION (object value),
    // NOT a baked secret — must not be a false positive.
    const form = {
      kind: "form",
      schema: {
        type: "object",
        properties: {
          password: { type: "string", title: "OctoPrint password" },
          apiKey: { type: "string", title: "API Key" },
          token: { type: "string" },
        },
        required: ["apiKey", "password"],
      },
    };
    expect(containsApiKey(form)).toBe(false);
  });

  it("does not flag a credential name with an empty/whitespace scalar", () => {
    expect(containsApiKey({ token: "" })).toBe(false);
    expect(containsApiKey({ password: "   " })).toBe(false);
    expect(containsApiKey({ secret: null })).toBe(false);
  });
});

describe("containsApiKey — false-positive safety on benign content", () => {
  it("does NOT flag benign prose that merely mentions credential words as VALUES", () => {
    expect(containsApiKey({ text: "Paste your API key into the connect bar." })).toBe(false);
    expect(containsApiKey({ description: "This form asks for your password." })).toBe(false);
    expect(containsApiKey({ label: "Authorization required" })).toBe(false);
    expect(containsApiKey({ note: "bearer of good news; secret sauce recipe" })).toBe(false);
    expect(containsApiKey({ intentText: "pcc: approve offer 12" })).toBe(false); // "pcc:" != "pcc_live_"
  });

  it("does NOT flag benign non-PCC identifiers", () => {
    expect(containsApiKey({ id: "op_test", slug: "watch-pizza-8k3f" })).toBe(false);
    expect(containsApiKey({ apiBaseHint: "https://capability.network/api/jobs" })).toBe(false);
    expect(containsApiKey({ x: "my-app-key-42", y: "authorization-service" })).toBe(false);
  });

  it("passes a well-formed manifest with a device-setup form", () => {
    const manifest = {
      csd: DASHBOARD_CSD_URL,
      title: "Onboard my printer",
      description: "Enter your OctoPrint credentials to register.",
      sections: [
        {
          windows: [
            {
              kind: "form",
              schema: { type: "object", properties: { password: { type: "string" } } },
              submit: { id: "s", label: "Save", kind: "post", path: "/api/setup/register-device", confirm: "inline", intentText: "pcc: register device" },
            },
          ],
        },
      ],
    };
    expect(containsApiKey(manifest)).toBe(false);
  });
});

describe("containsApiKey — robustness", () => {
  it("handles null / undefined / primitives without throwing", () => {
    expect(containsApiKey(null)).toBe(false);
    expect(containsApiKey(undefined)).toBe(false);
    expect(containsApiKey(42)).toBe(false);
    expect(containsApiKey(true)).toBe(false);
    expect(containsApiKey("")).toBe(false);
  });

  it("does not hang or throw on a cyclic object", () => {
    const a: Record<string, unknown> = { name: "ok" };
    a.self = a;
    expect(() => containsApiKey(a)).not.toThrow();
    expect(containsApiKey(a)).toBe(false);
    a.leak = "pcc_live_cycle";
    expect(containsApiKey(a)).toBe(true);
  });
});
