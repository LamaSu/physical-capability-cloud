import { describe, it, expect, vi, beforeEach } from "vitest";
import { Keypair, PublicKey, Connection } from "@solana/web3.js";
import { SolanaAgentWallet, SOLANA_DEVNET_USDC_MINT, SOLANA_MAINNET_USDC_MINT } from "../solana-wallet.js";

// ── Tests ──────────────────────────────────────────────────────────

describe("SolanaAgentWallet", () => {
  // ── Construction ──────────────────────────────────────────────

  describe("constructor", () => {
    it("generates a wallet with a random keypair when no config is provided", () => {
      const wallet = new SolanaAgentWallet();
      expect(wallet.address).toBeDefined();
      expect(typeof wallet.address).toBe("string");
      // Solana base58 addresses are 32-44 chars
      expect(wallet.address.length).toBeGreaterThanOrEqual(32);
      expect(wallet.address.length).toBeLessThanOrEqual(44);
    });

    it("generates different addresses for different instances", () => {
      const w1 = new SolanaAgentWallet();
      const w2 = new SolanaAgentWallet();
      expect(w1.address).not.toBe(w2.address);
    });

    it("derives a deterministic address from an explicit secret key (Uint8Array)", () => {
      const kp = Keypair.generate();
      const w1 = new SolanaAgentWallet({ secretKey: kp.secretKey });
      const w2 = new SolanaAgentWallet({ secretKey: kp.secretKey });
      expect(w1.address).toBe(w2.address);
      expect(w1.address).toBe(kp.publicKey.toBase58());
    });

    it("derives a deterministic address from a JSON array string", () => {
      const kp = Keypair.generate();
      const jsonKey = JSON.stringify(Array.from(kp.secretKey));
      const wallet = new SolanaAgentWallet({ secretKey: jsonKey });
      expect(wallet.address).toBe(kp.publicKey.toBase58());
    });

    it("uses custom RPC URL when provided", () => {
      const wallet = new SolanaAgentWallet({
        rpcUrl: "https://my-custom-rpc.example.com",
      });
      // Wallet should still be created successfully
      expect(wallet.address).toBeDefined();
    });
  });

  // ── Address / PublicKey ─────────────────────────────────────────

  describe("address and publicKey", () => {
    it("publicKey is a valid Solana PublicKey", () => {
      const wallet = new SolanaAgentWallet();
      expect(wallet.publicKey).toBeInstanceOf(PublicKey);
    });

    it("address matches publicKey.toBase58()", () => {
      const wallet = new SolanaAgentWallet();
      expect(wallet.address).toBe(wallet.publicKey.toBase58());
    });

    it("exposes the raw keypair", () => {
      const wallet = new SolanaAgentWallet();
      expect(wallet.rawKeypair).toBeInstanceOf(Keypair);
      expect(wallet.rawKeypair.publicKey.toBase58()).toBe(wallet.address);
    });

    it("exposes the underlying Connection", () => {
      const wallet = new SolanaAgentWallet();
      expect(wallet.rpcConnection).toBeInstanceOf(Connection);
    });
  });

  // ── Message signing ───────────────────────────────────────────

  describe("signMessage", () => {
    it("returns a hex-encoded signature", () => {
      const wallet = new SolanaAgentWallet();
      const message = new TextEncoder().encode("hello world");
      const sig = wallet.signMessage(message);
      expect(sig).toMatch(/^[0-9a-f]+$/);
    });

    it("produces a 64-byte (128 hex chars) signature", () => {
      const wallet = new SolanaAgentWallet();
      const message = new TextEncoder().encode("test data");
      const sig = wallet.signMessage(message);
      // Ed25519 signature = 64 bytes = 128 hex chars
      expect(sig.length).toBe(128);
    });

    it("produces different signatures for different messages", () => {
      const wallet = new SolanaAgentWallet();
      const sig1 = wallet.signMessage(new TextEncoder().encode("message A"));
      const sig2 = wallet.signMessage(new TextEncoder().encode("message B"));
      expect(sig1).not.toBe(sig2);
    });

    it("produces the same signature for the same message with the same key", () => {
      const kp = Keypair.generate();
      const w1 = new SolanaAgentWallet({ secretKey: kp.secretKey });
      const w2 = new SolanaAgentWallet({ secretKey: kp.secretKey });
      const msg = new TextEncoder().encode("deterministic");
      expect(w1.signMessage(msg)).toBe(w2.signMessage(msg));
    });

    it("signatures can be verified with verifyMessage", () => {
      const wallet = new SolanaAgentWallet();
      const message = new TextEncoder().encode("verify me");
      const sig = wallet.signMessage(message);

      expect(
        SolanaAgentWallet.verifyMessage(message, sig, wallet.address),
      ).toBe(true);
    });

    it("verification fails with wrong message", () => {
      const wallet = new SolanaAgentWallet();
      const sig = wallet.signMessage(new TextEncoder().encode("original"));

      expect(
        SolanaAgentWallet.verifyMessage(
          new TextEncoder().encode("tampered"),
          sig,
          wallet.address,
        ),
      ).toBe(false);
    });

    it("verification fails with wrong key", () => {
      const wallet = new SolanaAgentWallet();
      const other = new SolanaAgentWallet();
      const message = new TextEncoder().encode("signed by wallet");
      const sig = wallet.signMessage(message);

      expect(
        SolanaAgentWallet.verifyMessage(message, sig, other.address),
      ).toBe(false);
    });
  });

  // ── Balance queries (mocked) ──────────────────────────────────

  describe("getBalance (mocked)", () => {
    it("calls connection.getBalance with the correct public key", async () => {
      const wallet = new SolanaAgentWallet();
      const mockBalance = 5_000_000_000; // 5 SOL in lamports

      // Mock the connection
      vi.spyOn(wallet.rpcConnection, "getBalance").mockResolvedValue(mockBalance);

      const balance = await wallet.getBalance();
      expect(balance).toBe(mockBalance);
      expect(wallet.rpcConnection.getBalance).toHaveBeenCalledWith(
        wallet.publicKey,
      );
    });

    it("getBalanceSol converts lamports to SOL", async () => {
      const wallet = new SolanaAgentWallet();
      vi.spyOn(wallet.rpcConnection, "getBalance").mockResolvedValue(
        2_500_000_000,
      );

      const sol = await wallet.getBalanceSol();
      expect(sol).toBe(2.5);
    });
  });

  // ── Constants ─────────────────────────────────────────────────

  describe("constants", () => {
    it("exports the devnet USDC mint address", () => {
      expect(SOLANA_DEVNET_USDC_MINT).toBe(
        "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      );
    });

    it("exports the mainnet USDC mint address", () => {
      expect(SOLANA_MAINNET_USDC_MINT).toBe(
        "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      );
    });

    it("USDC mint addresses are valid Solana public keys", () => {
      expect(() => new PublicKey(SOLANA_DEVNET_USDC_MINT)).not.toThrow();
      expect(() => new PublicKey(SOLANA_MAINNET_USDC_MINT)).not.toThrow();
    });
  });
});
