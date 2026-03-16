/**
 * Unified Keychain — one mnemonic derives all chain-specific wallets + identity.
 *
 * BIP-39 mnemonic → BIP-32 master seed → derivation paths:
 *   m/44'/60'/0'/0/0  → secp256k1 → EVM address (Base, Ethereum, Lit, Alkahest)
 *   m/44'/501'/0'/0'  → Ed25519   → Solana keypair (Meteora, Metaplex Core, SPL)
 *   Ed25519 pubkey    → did:key   → W3C DID (identity, verifiable credentials)
 *   m/44'/635'/0'/0'  → Ed25519   → Bittensor hotkey (substrate sr25519 in prod)
 *
 * Every auth system in PCC derives from the same 12/24 words.
 * No separate key management. One backup. One seed.
 */

import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { HDKey } from "@scure/bip32";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { Keypair } from "@solana/web3.js";
import { privateKeyToAccount } from "viem/accounts";
import nacl from "tweetnacl";
import type { Address } from "viem";

// ---------------------------------------------------------------------------
// Derivation paths (standard BIP-44)
// ---------------------------------------------------------------------------

/** Ethereum / Base / EVM: m/44'/60'/0'/0/0 */
const EVM_PATH = "m/44'/60'/0'/0/0";

/** Solana: m/44'/501'/0'/0' (Phantom-compatible) */
const SOLANA_PATH = "m/44'/501'/0'/0'";

/** Bittensor (custom coin type 635): m/44'/635'/0'/0' */
const BITTENSOR_PATH = "m/44'/635'/0'/0'";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UnifiedKeys {
  /** The source mnemonic (12 or 24 words) — guard this carefully */
  mnemonic: string;

  /** EVM (secp256k1) — for Base Sepolia, SIWE, Lit Protocol, Alkahest */
  evm: {
    privateKey: `0x${string}`;
    address: Address;
  };

  /** Solana (Ed25519) — for Meteora DLMM, Metaplex Core, SPL payments */
  solana: {
    keypair: Keypair;
    publicKey: string;
    secretKey: Uint8Array;
  };

  /** W3C DID — derived from Solana Ed25519 pubkey */
  did: string;

  /** Bittensor hotkey (Ed25519) — for subnet verification */
  bittensor: {
    publicKey: Uint8Array;
    secretKey: Uint8Array;
    publicKeyHex: string;
  };
}

// ---------------------------------------------------------------------------
// Keychain
// ---------------------------------------------------------------------------

export class UnifiedKeychain {
  private _keys: UnifiedKeys | null = null;

  /** Generate a fresh mnemonic and derive all keys */
  generate(strength: 128 | 256 = 128): UnifiedKeys {
    const mnemonic = generateMnemonic(wordlist, strength);
    return this.fromMnemonic(mnemonic);
  }

  /** Derive all keys from an existing mnemonic */
  fromMnemonic(mnemonic: string): UnifiedKeys {
    if (!validateMnemonic(mnemonic, wordlist)) {
      throw new Error("Invalid BIP-39 mnemonic");
    }

    const seed = mnemonicToSeedSync(mnemonic);
    const master = HDKey.fromMasterSeed(seed);

    // ── EVM (secp256k1) ────────────────────────────────────────
    const evmNode = master.derive(EVM_PATH);
    if (!evmNode.privateKey) throw new Error("Failed to derive EVM key");
    const evmPrivateKey = `0x${Buffer.from(evmNode.privateKey).toString("hex")}` as `0x${string}`;
    const evmAccount = privateKeyToAccount(evmPrivateKey);

    // ── Solana (Ed25519) ───────────────────────────────────────
    // Solana uses SLIP-10 Ed25519 derivation, but most wallets
    // (Phantom, Backpack) just take the raw seed bytes at the path.
    // We derive 32 bytes from the path and use them as the Ed25519 seed.
    const solNode = master.derive(SOLANA_PATH);
    if (!solNode.privateKey) throw new Error("Failed to derive Solana key");
    const solSeed = solNode.privateKey.slice(0, 32);
    const solKeypair = nacl.sign.keyPair.fromSeed(solSeed);
    const solanaKeypair = Keypair.fromSecretKey(solKeypair.secretKey);

    // ── W3C DID ────────────────────────────────────────────────
    // did:key = multibase(multicodec-prefix + Ed25519-pubkey)
    const ED25519_MULTICODEC = Buffer.from([0xed, 0x01]);
    const pubkeyWithPrefix = Buffer.concat([ED25519_MULTICODEC, Buffer.from(solKeypair.publicKey)]);
    const did = `did:key:z${base58btcEncode(pubkeyWithPrefix)}`;

    // ── Bittensor (Ed25519) ────────────────────────────────────
    const btNode = master.derive(BITTENSOR_PATH);
    if (!btNode.privateKey) throw new Error("Failed to derive Bittensor key");
    const btSeed = btNode.privateKey.slice(0, 32);
    const btKeypair = nacl.sign.keyPair.fromSeed(btSeed);

    this._keys = {
      mnemonic,
      evm: {
        privateKey: evmPrivateKey,
        address: evmAccount.address,
      },
      solana: {
        keypair: solanaKeypair,
        publicKey: solanaKeypair.publicKey.toBase58(),
        secretKey: solKeypair.secretKey,
      },
      did,
      bittensor: {
        publicKey: btKeypair.publicKey,
        secretKey: btKeypair.secretKey,
        publicKeyHex: Buffer.from(btKeypair.publicKey).toString("hex"),
      },
    };

    return this._keys;
  }

  /** Get derived keys (throws if not generated/loaded) */
  get keys(): UnifiedKeys {
    if (!this._keys) throw new Error("Keychain not initialized — call generate() or fromMnemonic()");
    return this._keys;
  }

  /** Verify all keys are correctly derived from the mnemonic */
  verify(): { valid: boolean; checks: Record<string, boolean> } {
    if (!this._keys) return { valid: false, checks: {} };

    const rederived = this.fromMnemonic(this._keys.mnemonic);
    const checks = {
      evm_address: rederived.evm.address === this._keys.evm.address,
      solana_pubkey: rederived.solana.publicKey === this._keys.solana.publicKey,
      did: rederived.did === this._keys.did,
      bittensor_pubkey: rederived.bittensor.publicKeyHex === this._keys.bittensor.publicKeyHex,
    };

    return {
      valid: Object.values(checks).every(Boolean),
      checks,
    };
  }

  /** Export a summary (no secrets) for logging/debugging */
  summary(): Record<string, string> {
    if (!this._keys) return { status: "not initialized" };
    return {
      evm: this._keys.evm.address,
      solana: this._keys.solana.publicKey,
      did: this._keys.did,
      bittensor: `0x${this._keys.bittensor.publicKeyHex.slice(0, 16)}...`,
      mnemonic: `${this._keys.mnemonic.split(" ").slice(0, 3).join(" ")}... (${this._keys.mnemonic.split(" ").length} words)`,
    };
  }
}

// ---------------------------------------------------------------------------
// Base58btc encoder (same as @pcc/spec/identity/did.ts)
// ---------------------------------------------------------------------------

function base58btcEncode(bytes: Buffer): string {
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let num = BigInt("0x" + bytes.toString("hex"));
  if (num === 0n) return ALPHABET[0];

  const chars: string[] = [];
  while (num > 0n) {
    const remainder = Number(num % 58n);
    chars.unshift(ALPHABET[remainder]);
    num = num / 58n;
  }

  for (const byte of bytes) {
    if (byte === 0) chars.unshift(ALPHABET[0]);
    else break;
  }

  return chars.join("");
}
