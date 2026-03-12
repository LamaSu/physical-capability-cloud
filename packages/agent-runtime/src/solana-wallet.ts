/**
 * Solana Agent Wallet — SPL token transfers for agent-to-agent payments.
 *
 * Sits alongside the existing EVM AgentWallet. Each agent can have both
 * an EVM wallet (for Base/Ethereum settlement) and a Solana wallet
 * (for Solana devnet/mainnet USDC payments).
 *
 * Uses @solana/web3.js v1 (stable) and @solana/spl-token.
 */

import {
  Keypair,
  Connection,
  PublicKey,
  Transaction,
  SystemProgram,
} from "@solana/web3.js";
import {
  getOrCreateAssociatedTokenAccount,
  createTransferInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import nacl from "tweetnacl";

/** Well-known Solana devnet USDC mint (Circle) */
export const SOLANA_DEVNET_USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

/** Well-known Solana mainnet USDC mint (Circle) */
export const SOLANA_MAINNET_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export interface SolanaWalletConfig {
  /** Solana RPC URL. Defaults to devnet. */
  rpcUrl?: string;
  /**
   * Private key as a Uint8Array (64 bytes) or JSON array string "[1,2,3,...]".
   * If omitted, generates a new keypair.
   */
  secretKey?: Uint8Array | string;
}

export class SolanaAgentWallet {
  private readonly keypair: Keypair;
  private readonly connection: Connection;

  constructor(config?: SolanaWalletConfig) {
    if (config?.secretKey) {
      if (typeof config.secretKey === "string") {
        // Parse JSON array format: "[1,2,3,...]"
        const arr = JSON.parse(config.secretKey) as number[];
        this.keypair = Keypair.fromSecretKey(Uint8Array.from(arr));
      } else {
        this.keypair = Keypair.fromSecretKey(config.secretKey);
      }
    } else {
      this.keypair = Keypair.generate();
    }

    this.connection = new Connection(
      config?.rpcUrl ?? "https://api.devnet.solana.com",
      "confirmed",
    );
  }

  /** The wallet's public key */
  get publicKey(): PublicKey {
    return this.keypair.publicKey;
  }

  /** Base58 address string */
  get address(): string {
    return this.keypair.publicKey.toBase58();
  }

  /** The underlying Connection (for advanced usage / testing) */
  get rpcConnection(): Connection {
    return this.connection;
  }

  /** The raw keypair (for signing transactions) */
  get rawKeypair(): Keypair {
    return this.keypair;
  }

  // ── Balance queries ───────────────────────────────────────────

  /** Get native SOL balance in lamports */
  async getBalance(): Promise<number> {
    return this.connection.getBalance(this.keypair.publicKey);
  }

  /** Get SOL balance in SOL (not lamports) */
  async getBalanceSol(): Promise<number> {
    const lamports = await this.getBalance();
    return lamports / 1e9;
  }

  /**
   * Get SPL token balance for a given mint.
   * Returns the token amount with decimals applied (assumes 6 decimals for USDC).
   * Returns 0 if the associated token account does not exist.
   */
  async getSplBalance(mintAddress: string): Promise<number> {
    try {
      const mint = new PublicKey(mintAddress);
      const ata = getAssociatedTokenAddressSync(mint, this.keypair.publicKey);
      const account = await getAccount(this.connection, ata);
      // USDC has 6 decimals on Solana
      return Number(account.amount) / 1e6;
    } catch {
      // Account doesn't exist or other error — balance is 0
      return 0;
    }
  }

  // ── Transfers ─────────────────────────────────────────────────

  /**
   * Transfer SPL tokens (e.g. USDC) to a recipient.
   *
   * @param mintAddress - The token mint (e.g. USDC mint)
   * @param recipient   - Recipient's base58 public key
   * @param amount      - Amount in token units (e.g., 10.5 for 10.5 USDC)
   * @returns Transaction signature (base58)
   */
  async transferSpl(
    mintAddress: string,
    recipient: string,
    amount: number,
  ): Promise<string> {
    const mint = new PublicKey(mintAddress);
    const recipientPubkey = new PublicKey(recipient);

    // Get or create sender's ATA
    const senderAta = await getOrCreateAssociatedTokenAccount(
      this.connection,
      this.keypair, // payer
      mint,
      this.keypair.publicKey, // owner
    );

    // Get or create recipient's ATA
    const recipientAta = await getOrCreateAssociatedTokenAccount(
      this.connection,
      this.keypair, // payer (we pay for ATA creation if needed)
      mint,
      recipientPubkey,
    );

    // Convert to atomic units (6 decimals for USDC)
    const atomicAmount = BigInt(Math.round(amount * 1e6));

    const instruction = createTransferInstruction(
      senderAta.address,
      recipientAta.address,
      this.keypair.publicKey,
      atomicAmount,
    );

    const transaction = new Transaction().add(instruction);

    const { blockhash } = await this.connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = this.keypair.publicKey;
    transaction.sign(this.keypair);

    const signature = await this.connection.sendRawTransaction(
      transaction.serialize(),
    );

    await this.connection.confirmTransaction(signature, "confirmed");
    return signature;
  }

  /**
   * Transfer native SOL to a recipient.
   *
   * @param recipient - Recipient's base58 public key
   * @param lamports  - Amount in lamports (1 SOL = 1e9 lamports)
   * @returns Transaction signature
   */
  async transferSol(recipient: string, lamports: number): Promise<string> {
    const recipientPubkey = new PublicKey(recipient);

    const transaction = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: this.keypair.publicKey,
        toPubkey: recipientPubkey,
        lamports,
      }),
    );

    const { blockhash } = await this.connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = this.keypair.publicKey;
    transaction.sign(this.keypair);

    const signature = await this.connection.sendRawTransaction(
      transaction.serialize(),
    );

    await this.connection.confirmTransaction(signature, "confirmed");
    return signature;
  }

  // ── Devnet utilities ──────────────────────────────────────────

  /**
   * Request a SOL airdrop on devnet.
   * @param lamports Amount in lamports (default 1 SOL = 1e9)
   * @returns Airdrop transaction signature
   */
  async requestAirdrop(lamports?: number): Promise<string> {
    const sig = await this.connection.requestAirdrop(
      this.keypair.publicKey,
      lamports ?? 1_000_000_000,
    );
    await this.connection.confirmTransaction(sig, "confirmed");
    return sig;
  }

  // ── Signing ───────────────────────────────────────────────────

  /**
   * Sign an arbitrary message (for A2A authentication).
   * Returns the signature as a hex string.
   */
  signMessage(message: Uint8Array): string {
    const sig = nacl.sign.detached(message, this.keypair.secretKey);
    return Buffer.from(sig).toString("hex");
  }

  /**
   * Verify a message signature.
   */
  static verifyMessage(
    message: Uint8Array,
    signature: string,
    publicKey: string,
  ): boolean {
    const sigBytes = Buffer.from(signature, "hex");
    const pk = new PublicKey(publicKey);
    return nacl.sign.detached.verify(message, sigBytes, pk.toBytes());
  }

  /**
   * Sign a transaction (without sending).
   */
  signTransaction(transaction: Transaction): Transaction {
    transaction.sign(this.keypair);
    return transaction;
  }
}
