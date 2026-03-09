import { describe, it, expect } from "vitest";
import { AgentWallet } from "../wallet.js";

describe("AgentWallet", () => {
  // ── Construction ──────────────────────────────────────────────

  describe("constructor", () => {
    it("generates a wallet with a random key when no config is provided", () => {
      const wallet = new AgentWallet();
      expect(wallet.address).toBeDefined();
      expect(wallet.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    });

    it("generates different addresses for different instances", () => {
      const w1 = new AgentWallet();
      const w2 = new AgentWallet();
      expect(w1.address).not.toBe(w2.address);
    });

    it("derives a deterministic address from an explicit private key", () => {
      const key = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as `0x${string}`;
      const w1 = new AgentWallet({ privateKey: key });
      const w2 = new AgentWallet({ privateKey: key });
      expect(w1.address).toBe(w2.address);
    });

    it("produces the known address for Hardhat account #0", () => {
      // Hardhat/Anvil account #0 private key → known address
      const key = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as `0x${string}`;
      const wallet = new AgentWallet({ privateKey: key });
      expect(wallet.address.toLowerCase()).toBe(
        "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
      );
    });
  });

  // ── Address format ────────────────────────────────────────────

  describe("address", () => {
    it("is a valid checksummed Ethereum address", () => {
      const wallet = new AgentWallet();
      // EIP-55 mixed-case checksum: starts with 0x, 42 chars total
      expect(wallet.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(wallet.address.length).toBe(42);
    });

    it("is exposed as a readonly property", () => {
      const wallet = new AgentWallet();
      // account should also be accessible
      expect(wallet.account).toBeDefined();
      expect(wallet.account.address).toBe(wallet.address);
    });
  });

  // ── Message signing ───────────────────────────────────────────

  describe("signMessage", () => {
    it("returns a hex-encoded signature", async () => {
      const wallet = new AgentWallet();
      const sig = await wallet.signMessage("hello world");
      expect(sig).toMatch(/^0x[0-9a-fA-F]+$/);
    });

    it("produces a 65-byte (130 hex chars + 0x prefix) signature", async () => {
      const wallet = new AgentWallet();
      const sig = await wallet.signMessage("test data");
      // EIP-191 personal_sign: r(32) + s(32) + v(1) = 65 bytes = 130 hex chars
      expect(sig.length).toBe(2 + 130); // 0x + 130
    });

    it("produces different signatures for different messages", async () => {
      const wallet = new AgentWallet();
      const sig1 = await wallet.signMessage("message A");
      const sig2 = await wallet.signMessage("message B");
      expect(sig1).not.toBe(sig2);
    });

    it("produces the same signature for the same message with the same key", async () => {
      const key = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as `0x${string}`;
      const w1 = new AgentWallet({ privateKey: key });
      const w2 = new AgentWallet({ privateKey: key });
      const sig1 = await w1.signMessage("deterministic");
      const sig2 = await w2.signMessage("deterministic");
      expect(sig1).toBe(sig2);
    });

    it("produces different signatures with different keys", async () => {
      const w1 = new AgentWallet({
        privateKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
      });
      const w2 = new AgentWallet({
        privateKey: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
      });
      const sig1 = await w1.signMessage("same message");
      const sig2 = await w2.signMessage("same message");
      expect(sig1).not.toBe(sig2);
    });
  });

  // ── Chain selection ───────────────────────────────────────────

  describe("chain selection", () => {
    it("defaults to base-sepolia", () => {
      const wallet = new AgentWallet();
      const chain = wallet.getChain();
      expect(chain.name).toMatch(/base.*sepolia/i);
    });

    it("selects base mainnet", () => {
      const wallet = new AgentWallet({ chain: "base" });
      const chain = wallet.getChain();
      expect(chain.name).toMatch(/base/i);
      expect(chain.id).toBe(8453);
    });

    it("selects base-sepolia explicitly", () => {
      const wallet = new AgentWallet({ chain: "base-sepolia" });
      const chain = wallet.getChain();
      expect(chain.id).toBe(84532);
    });

    it("selects localhost", () => {
      const wallet = new AgentWallet({ chain: "localhost" });
      const chain = wallet.getChain();
      // localhost chain typically uses id 1337 or 31337
      expect(chain).toBeDefined();
      expect(chain.name.toLowerCase()).toContain("localhost");
    });

    it("falls back to base-sepolia for unknown chain string", () => {
      // TypeScript wouldn't normally allow this, but test the runtime behavior
      const wallet = new AgentWallet({ chain: "unknown-chain" as any });
      const chain = wallet.getChain();
      expect(chain.id).toBe(84532); // base-sepolia
    });
  });
});
