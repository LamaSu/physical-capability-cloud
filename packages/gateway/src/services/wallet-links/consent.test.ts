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
    expect(CONSENT_SHA256).toBe("b67a22ec99407e127574c4171d26e808dcdc0741c135fa7f2c51e156c4473675");
    expect(createHash("sha256").update(CONSENT_TEMPLATE, "utf8").digest("hex")).toBe(CONSENT_SHA256);
    expect(CONSENT_TEMPLATE).toBe(Object.values(CONSENT_TEMPLATES).join("\n\n"));
    expect(CONSENT_TEMPLATES.hosted).toContain("operates the machine that holds the key");
    expect(CONSENT_TEMPLATE).not.toContain("**");
  });

  it("renders the agent terms with the exported W2 funding amounts", () => {
    const text = renderConsent(request, "Test account");
    expect(text).toContain("Code BCDF-GHJK.");
    expect(text).toContain("cli@laptop (an agent, on the computer where the command ran; client pcc-cli 0.3.0)");
    expect(text).toContain("Requested 2026-10-14T18:02:11.000Z from 203.0.113.x");
    expect(text).toContain("Base Sepolia (test network, chain 84532)");
    expect(text).toContain(`send this wallet ${TESTNET_FUNDING.agent.eth} test ETH (for fees) and ${TESTNET_FUNDING.agent.usdc} test USDC`);
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
    expect(text).toContain(`send this wallet ${TESTNET_FUNDING.device.eth} test ETH (for fees).`);
    expect(text).not.toContain("test USDC");
    expect(text).toContain("How long: until unlinked.");
    expect(TESTNET_FUNDING.device.usdc).toBeNull();
    expect(text).not.toMatch(/\{[a-zA-Z][a-zA-Z0-9]*\}/);
  });
});
