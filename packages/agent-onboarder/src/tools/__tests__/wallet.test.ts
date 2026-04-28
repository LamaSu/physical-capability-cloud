import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isAddress } from "viem";

// Importing the module multiple times under different env flags requires
// vi.resetModules — but for the simple scope here we just disable the MOCK
// path before import by setting env first.

describe("createAgentWallet (viem-only)", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    // Force the real (non-mock) viem code path. The module reads MOCK_CDP at
    // import time, so we set it here and reset module cache.
    process.env.MOCK_CDP = "false";
    // Explicitly clear the (now unused) CDP env vars to confirm no env
    // gating remains.
    delete process.env.CDP_API_KEY_ID;
    delete process.env.CDP_API_KEY_SECRET;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("returns a valid 0x... Ethereum address on base-sepolia", async () => {
    // Re-import after env mutation to pick up the new MOCK flag.
    const { createAgentWallet } = await import("../wallet.js");
    const w = await createAgentWallet({ enterprise_id: "test-enterprise-1" });

    expect(w.address.startsWith("0x")).toBe(true);
    expect(isAddress(w.address)).toBe(true);
    expect(w.chain).toBe("base-sepolia");
    expect(w.private_key_redacted).toMatch(/^0x[0-9a-f]+\*\*\*[0-9a-f]+$/);
  });

  it("returns a different address across calls (entropy check)", async () => {
    const { createAgentWallet } = await import("../wallet.js");
    const a = await createAgentWallet({ enterprise_id: "test-1" });
    const b = await createAgentWallet({ enterprise_id: "test-2" });
    const c = await createAgentWallet({ enterprise_id: "test-3" });

    // All three must be distinct — viem's generatePrivateKey uses CSPRNG.
    expect(a.address).not.toBe(b.address);
    expect(b.address).not.toBe(c.address);
    expect(a.address).not.toBe(c.address);
  });

  it("does not throw or gate on missing CDP_API_KEY_ID / CDP_API_KEY_SECRET", async () => {
    // The new module must NOT reference CDP env vars at all. We've already
    // deleted them in beforeEach; this call should succeed cleanly.
    expect(process.env.CDP_API_KEY_ID).toBeUndefined();
    expect(process.env.CDP_API_KEY_SECRET).toBeUndefined();

    const { createAgentWallet } = await import("../wallet.js");
    const w = await createAgentWallet({ enterprise_id: "no-cdp-keys" });
    expect(isAddress(w.address)).toBe(true);
    // funded is always false now — CDP faucet path is removed.
    expect(w.funded).toBe(false);
  });
});
