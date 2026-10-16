import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CONSENT_SHA256,
  CONSENT_TEMPLATE,
  CONSENT_TEMPLATES,
  CONSENT_VERSION,
  TESTNET_FUNDING,
  renderConsent,
} from "./consent.js";

const request = {
  user_code: "BCDFGHJK",
  address_or_pubkey: "0x0000000000000000000000000000000000000001",
  role: "agent" as const,
  label: "cli@laptop",
  client_info: JSON.stringify({ name: "pcc-cli", version: "0.3.0" }),
  kernel_id: null,
  chain_id: 84532,
  created_at: "2026-10-14T18:02:11.000Z",
  requester_ip_class: "203.0.113.x",
};

describe("wallet-link consent", () => {
  it("pins the exact UTF-8 template hash and all three plain-text variants", () => {
    expect(CONSENT_VERSION).toBe("wallet-link-v1");
    expect(CONSENT_SHA256).toBe("24480b7fd41e13804038619c248b398cd247d009729a8ff69d98b486c8b0dc19");
    expect(createHash("sha256").update(CONSENT_TEMPLATE, "utf8").digest("hex")).toBe(CONSENT_SHA256);
    expect(CONSENT_TEMPLATE).toBe(Object.values(CONSENT_TEMPLATES).join("\n\n"));
    expect(CONSENT_TEMPLATES.hosted).toContain("operates the machine that holds the key");
    expect(CONSENT_TEMPLATE).not.toContain("**");
  });

  it("renders the agent terms with the literal W2 funding amounts", () => {
    const text = renderConsent(request, "Test account");
    expect(text).toContain("Code BCDF-GHJK.");
    expect(text).toContain("cli@laptop (an agent, on the computer where the command ran; client pcc-cli 0.3.0)");
    expect(text).toContain("Requested 2026-10-14T18:02:11.000Z from 203.0.113.x");
    expect(text).toContain("Base Sepolia (test network, chain 84532)");
    expect(text).toContain("after you approve, PCC will ask Coinbase's test faucet to send this wallet 0.0005 test ETH (for fees) and 1 test USDC if it is an EVM (secp256k1) key and PCC's daily faucet limits allow. If only the faucet's daily test-USDC allowance is used up, it sends the test ETH only. Ed25519 keys get no test funds.");
    expect(text).toContain("for your account Test account:");
    expect(text).toContain("How long: 30 days after approval, or until you unlink it.");
    expect(text).toContain(CONSENT_SHA256);
    expect(text).not.toMatch(/\{[a-zA-Z][a-zA-Z0-9]*\}/);
  });

  it("renders the device terms with no spending and ETH-only funding", () => {
    const text = renderConsent({
      ...request,
      role: "device",
      kernel_id: "kernel_test_device",
      address_or_pubkey: "a".repeat(64),
    }, "Test account");
    expect(text).toContain("Device kernel_test_device will sign evidence");
    expect(text).toContain("It cannot spend");
    expect(text).toContain("after you approve, PCC will ask Coinbase's test faucet to send this wallet 0.0005 test ETH (for fees) if it is an EVM (secp256k1) key and PCC's daily faucet limits allow. Ed25519 device keys get no test funds.");
    expect(text).not.toContain("test USDC");
    expect(text).toContain("How long: until unlinked.");
    expect(TESTNET_FUNDING.device.usdc).toBeNull();
    expect(text).not.toMatch(/\{[a-zA-Z][a-zA-Z0-9]*\}/);
  });
});
