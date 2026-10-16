import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { parseSiweMessage } from "viem/siwe";
import { canonicalize } from "@pcc/spec";
import { CONSENT_SHA256, CONSENT_VERSION } from "./consent.js";
import { composeProofMessage, verifyProofMessage } from "./message.js";
import type { WalletLinkMessageRequest } from "./message.js";

const now = Date.parse("2026-10-14T18:02:11.000Z");
const config = {
  publicOrigin: "https://capability.network",
  domain: "capability.network",
  uri: "https://capability.network/link",
  env: "staging",
  allowedChainIds: [84532],
};

function request(key_type: "secp256k1" | "ed25519", address_or_pubkey: string): WalletLinkMessageRequest {
  return {
    id: "lr_0123456789abcdefghijklmnop",
    key_type,
    address_or_pubkey,
    role: "agent",
    label: "cli@laptop",
    kernel_id: null,
    chain_id: 84532,
    env: config.env,
    domain: config.domain,
    nonce: "ABCDEFGH12345678",
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + 600_000).toISOString(),
    consent_version: CONSENT_VERSION,
    consent_sha256: CONSENT_SHA256,
  };
}

describe("wallet-link proof messages", () => {
  it("composes the exact EIP-4361 resources and verifies EIP-191 EOA signatures", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const row = request("secp256k1", account.address);
    const message = composeProofMessage(row, config);
    const parsed = parseSiweMessage(message);
    expect(parsed.statement).toBe('Link this key to PCC as an agent ("cli@laptop"). PCC never holds this key. Consent: wallet-link v1.');
    expect(parsed).toMatchObject({ domain: config.domain, address: account.address, uri: config.uri, version: "1", chainId: 84532, nonce: row.nonce, requestId: row.id });
    expect(parsed.resources).toEqual([
      `urn:pcc:link-request:${row.id}`,
      "urn:pcc:env:staging",
      "urn:pcc:role:agent",
      `urn:pcc:consent:wallet-link-v1:sha256:${CONSENT_SHA256}`,
    ]);
    const signature = await account.signMessage({ message });
    expect(await verifyProofMessage({ ...row, message }, signature, config, now)).toBe(true);
    const other = privateKeyToAccount(generatePrivateKey());
    expect(await verifyProofMessage({ ...row, message }, await other.signMessage({ message }), config, now)).toBe(false);
  });

  it("composes canonical Ed25519 UTF-8 bytes including the device kernel", async () => {
    const pair = generateKeyPairSync("ed25519");
    const publicHex = pair.publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("hex");
    const row = { ...request("ed25519", publicHex), role: "device" as const, kernel_id: "kernel_test_device" };
    const message = composeProofMessage(row, config);
    expect(message).toBe("PCC-LINK-V1\n" + canonicalize({
      chainId: 84532,
      consent: `wallet-link-v1:sha256:${CONSENT_SHA256}`,
      domain: config.domain,
      env: config.env,
      expirationTime: row.expires_at,
      issuedAt: row.created_at,
      kernelId: row.kernel_id,
      label: row.label,
      nonce: row.nonce,
      publicKey: publicHex,
      requestId: row.id,
      role: "device",
      uri: config.uri,
    }));
    const signature = sign(null, Buffer.from(message, "utf8"), pair.privateKey).toString("hex");
    expect(await verifyProofMessage({ ...row, message }, signature, config, now)).toBe(true);
    expect(await verifyProofMessage({ ...row, message: message + "\n" }, signature, config, now)).toBe(false);
    expect(await verifyProofMessage({ ...row, message }, signature.slice(2), config, now)).toBe(false);
  });

  it.each(["agent", "device"] as const)("pins the exact Ed25519 %s message JSON key set", role => {
    const pair = generateKeyPairSync("ed25519");
    const publicHex = pair.publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("hex");
    const row = { ...request("ed25519", publicHex), role, kernel_id: role === "device" ? "kernel_test_device" : null };
    const message = composeProofMessage(row, config);
    expect(message.startsWith("PCC-LINK-V1\n")).toBe(true);
    expect(Object.keys(JSON.parse(message.slice("PCC-LINK-V1\n".length))).sort()).toEqual([
      "chainId", "consent", "domain", "env", "expirationTime", "issuedAt",
      ...(role === "device" ? ["kernelId"] : []),
      "label", "nonce", "publicKey", "requestId", "role", "uri",
    ]);
  });

  it.each([
    ["env", { env: "prod" }],
    ["domain", { domain: "other.example", publicOrigin: "https://other.example", uri: "https://other.example/link" }],
    ["URI", { uri: "https://capability.network/other" }],
    ["chain allowlist", { allowedChainIds: [] }],
  ])("rejects current server %s mismatches", async (_name, overrides) => {
    const account = privateKeyToAccount(generatePrivateKey());
    const row = request("secp256k1", account.address);
    const message = composeProofMessage(row, config);
    const signature = await account.signMessage({ message });
    expect(await verifyProofMessage({ ...row, message }, signature, { ...config, ...overrides }, now)).toBe(false);
  });

  it("rejects stale consent, old or future issued-at, expired messages and mutated exact bytes", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const row = request("secp256k1", account.address);
    const message = composeProofMessage(row, config);
    const signature = await account.signMessage({ message });
    for (const changed of [
      { consent_sha256: "0".repeat(64) },
      { consent_version: "wallet-link-v0" },
      { created_at: new Date(now - 600_001).toISOString() },
      { created_at: new Date(now + 1).toISOString() },
      { expires_at: new Date(now).toISOString() },
      { message: message + " " },
    ]) {
      expect(await verifyProofMessage({ ...row, message, ...changed }, signature, config, now)).toBe(false);
    }
  });
});
