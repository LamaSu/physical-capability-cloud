import { describe, expect, it } from "vitest";
import { createSiweMessage } from "viem/siwe";
import { canonicalizeFlat, validateProofMessage } from "../wallet/proof.js";
import type { WalletRecord } from "../wallet/keystore.js";

const now = Date.parse("2026-10-13T12:00:00.000Z");
const requestId = "lr_0123456789ABCDEFGHJKLMNPQR";
const consentHash = "b".repeat(64);
const address = "0x52908400098527886E0F7030069857D2E4169EE7";
const gatewayOrigin = "http://127.0.0.1:3200";
const secpWallet = {
  kind: "pcc-wallet", version: 1, label: "participant-agent", role: "agent",
  keyType: "secp256k1", address, chainId: 84532, gatewayOrigin,
  createdAt: new Date(now).toISOString(), link: {},
} as WalletRecord;
const edWallet = {
  ...secpWallet, label: "participant-device", role: "device", keyType: "ed25519",
  publicKey: "a".repeat(64),
} as WalletRecord;
const statement = 'Link this key to PCC as an agent ("participant-agent"). PCC never holds this key. Consent: wallet-link v1.';
const resources = [
  `urn:pcc:link-request:${requestId}`, "urn:pcc:env:test",
  "urn:pcc:role:agent", `urn:pcc:consent:wallet-link-v1:sha256:${consentHash}`,
];

function siwe(overrides: Record<string, unknown> = {}): string {
  return createSiweMessage({
    domain: "127.0.0.1:3200", address, statement, uri: `${gatewayOrigin}/link`,
    version: "1", chainId: 84532, nonce: "ABCDEFGHIJKLMNOP", requestId,
    issuedAt: new Date(now), expirationTime: new Date(now + 600_000), resources,
    ...overrides,
  });
}

function edFields(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    chainId: 84532, consent: `wallet-link-v1:sha256:${consentHash}`,
    domain: "127.0.0.1:3200", env: "test", expirationTime: new Date(now + 600_000).toISOString(),
    issuedAt: new Date(now).toISOString(), label: edWallet.label, nonce: "ABCDEFGHIJKLMNOP",
    publicKey: edWallet.publicKey, requestId, role: "device", uri: `${gatewayOrigin}/link`,
    ...overrides,
  };
}

function independentCanonical(value: Record<string, unknown>): string {
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${JSON.stringify(value[key])}`).join(",")}}`;
}

function edMessage(overrides: Record<string, unknown> = {}): string {
  return `PCC-LINK-V1\n${independentCanonical(edFields(overrides))}`;
}

describe("wallet flat RFC 8785 canonicalization", () => {
  it("orders property names by UTF-16 code units using the RFC 8785 sorting vector", () => {
    const input = { "\u20ac": "Euro Sign", "\r": "Carriage Return", "\ufb33": "Hebrew Letter Dalet With Dagesh", "1": "One", "\ud83d\ude00": "Emoji: Grinning Face", "\u0080": "Control", "\u00f6": "Latin Small Letter O With Diaeresis" };
    expect(canonicalizeFlat(input)).toBe('{"\\r":"Carriage Return","1":"One","\u0080":"Control","\u00f6":"Latin Small Letter O With Diaeresis","\u20ac":"Euro Sign","\ud83d\ude00":"Emoji: Grinning Face","\ufb33":"Hebrew Letter Dalet With Dagesh"}');
  });

  it("uses RFC 8785 string escapes and safe integer serialization", () => {
    expect(canonicalizeFlat({ text: "\u0000\b\t\n\f\r\"\\/\u000f", zero: -0, max: Number.MAX_SAFE_INTEGER, min: Number.MIN_SAFE_INTEGER }))
      .toBe('{"max":9007199254740991,"min":-9007199254740991,"text":"\\u0000\\b\\t\\n\\f\\r\\\"\\\\/\\u000f","zero":0}');
  });

  it.each([null, [], { nested: {} }, { nested: [] }, { flag: true }, { nil: null }, { integer: Number.MAX_SAFE_INTEGER + 1 }, { number: 1.5 }, { number: NaN }, { number: Infinity }, { text: "\ud800" }, { "\udfff": "value" }, { missing: undefined }])("refuses non-flat or non-canonical input %#", (value) => {
    expect(() => canonicalizeFlat(value)).toThrow();
  });
});

describe("wallet secp256k1 proof checks", () => {
  it("accepts the exact W1 message for the configured wallet and gateway", () => {
    expect(() => validateProofMessage(siwe(), secpWallet, requestId, now)).not.toThrow();
  });

  it.each([
    ["domain", { domain: "evil.example" }],
    ["uri", { uri: "https://evil.example/link" }],
    ["chainId", { chainId: 8453 }],
    ["address", { address: "0x0000000000000000000000000000000000000001" }],
    ["requestId", { requestId: "lr_other" }],
    ["statement", { statement: "Approve an unrelated payment." }],
    ["expirationTime", { expirationTime: new Date(now - 1) }],
    ["issuedAt", { issuedAt: new Date(now - 600_001) }],
    ["issuedAt", { issuedAt: new Date(now + 300_001) }],
    ["resources", { resources: resources.filter((item) => !item.startsWith("urn:pcc:link-request:")) }],
    ["resources", { resources: resources.filter((item) => !item.startsWith("urn:pcc:role:")) }],
    ["consent", { resources: resources.slice(0, 3) }],
    ["consent", { resources: [...resources, resources[3]] }],
    ["consent", { resources: [...resources.slice(0, 3), "urn:pcc:consent:wallet-link-v1:sha256:wrong"] }],
  ] as const)("refuses a %s mismatch", (field, overrides) => {
    expect(() => validateProofMessage(siwe(overrides), secpWallet, requestId, now))
      .toThrow(`refusing to sign: ${field} mismatch`);
  });

  it("requires the EIP-55 address exactly", () => {
    const message = siwe().replace(address, address.toLowerCase());
    expect(() => validateProofMessage(message, secpWallet, requestId, now)).toThrow("refusing to sign: address mismatch");
  });

  it.each([
    ["version", (message: string) => message.replace("Version: 1", "Version: 2")],
    ["issuedAt", (message: string) => message.replace(new Date(now).toISOString(), "not-a-date")],
    ["expirationTime", (message: string) => message.replace(new Date(now + 600_000).toISOString(), "not-a-date")],
    ["expirationTime", (message: string) => message.replace(`\nExpiration Time: ${new Date(now + 600_000).toISOString()}`, "")],
  ] as const)("refuses malformed or missing %s", (field, transform) => {
    expect(() => validateProofMessage(transform(siwe()), secpWallet, requestId, now)).toThrow(`refusing to sign: ${field} mismatch`);
  });

  it.each([
    ["an unparsed line", () => siwe().replace("\nResources:", "\nUnvalidated: approve an unrelated payment\nResources:")],
    ["a duplicated URI field", () => siwe().replace("\nResources:", "\nURI: https://evil.example/payment\nResources:")],
    ["an unsupported scheme", () => siwe({ scheme: "https" })],
    ["an unsupported Not Before field", () => siwe({ notBefore: new Date(now) })],
  ] as const)("refuses SIWE content outside W1's message template: %s", (_reason, message) => {
    expect(() => validateProofMessage(message(), secpWallet, requestId, now)).toThrow("refusing to sign: message mismatch");
  });

  it("requires W1's nonce length of at least 16 alphanumeric characters", () => {
    expect(() => validateProofMessage(siwe({ nonce: "ABCDEFGHIJKLMNO" }), secpWallet, requestId, now)).toThrow("refusing to sign: nonce mismatch");
  });
});

describe("wallet ed25519 proof checks", () => {
  it("accepts canonical W1 bytes with the configured wallet fields", () => {
    expect(() => validateProofMessage(edMessage(), edWallet, requestId, now)).not.toThrow();
  });

  it.each([
    ["domain", { domain: "evil.example" }], ["uri", { uri: "https://evil.example/link" }],
    ["chainId", { chainId: 8453 }], ["publicKey", { publicKey: "c".repeat(64) }],
    ["requestId", { requestId: "lr_other" }], ["role", { role: "agent" }], ["label", { label: "another-device" }],
    ["consent", { consent: "wallet-link-v1:sha256:invalid" }],
    ["expirationTime", { expirationTime: new Date(now - 1).toISOString() }],
    ["expirationTime", { expirationTime: "invalid" }],
    ["issuedAt", { issuedAt: new Date(now - 600_001).toISOString() }],
    ["issuedAt", { issuedAt: new Date(now + 300_001).toISOString() }],
  ] as const)("refuses a %s mismatch", (field, overrides) => {
    expect(() => validateProofMessage(edMessage(overrides), edWallet, requestId, now)).toThrow(`refusing to sign: ${field} mismatch`);
  });

  it.each([
    ["whitespace", () => `PCC-LINK-V1\n${JSON.stringify(edFields(), null, 2)}`],
    ["duplicate property", () => edMessage().replace('{"chainId":84532,', '{"chainId":84532,"chainId":84532,')],
    ["reordered keys", () => `PCC-LINK-V1\n${JSON.stringify(Object.fromEntries(Object.entries(edFields()).reverse()))}`],
    ["nested value", () => edMessage({ nested: {} })],
    ["unsafe integer", () => edMessage({ extra: Number.MAX_SAFE_INTEGER + 1 })],
  ] as const)("refuses non-canonical JSON with %s", (_reason, message) => {
    expect(() => validateProofMessage(message(), edWallet, requestId, now)).toThrow("refusing to sign: canonical JSON mismatch");
  });

  it("requires the PCC-LINK-V1 prefix", () => {
    expect(() => validateProofMessage(edMessage().replace("PCC-LINK-V1", "PCC-LINK-V2"), edWallet, requestId, now)).toThrow("refusing to sign: prefix mismatch");
  });

  it("sanitizes parser errors without echoing the provided message", () => {
    const untrusted = 'PCC-LINK-V1\n{"sensitive_input":"must-never-be-echoed"';
    try {
      validateProofMessage(untrusted, edWallet, requestId, now);
      expect.fail("message should be refused");
    } catch (error) {
      expect(String(error)).toBe("WalletError: refusing to sign: canonical JSON mismatch");
    }
  });
});
