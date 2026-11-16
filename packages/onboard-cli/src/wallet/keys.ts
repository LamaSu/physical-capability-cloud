import {
  createPrivateKey, createPublicKey, generateKeyPairSync, sign, timingSafeEqual,
  type KeyObject,
} from "node:crypto";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { WalletError } from "./errors.js";
import type { KeyType, WalletRecord } from "./keystore.js";

const PRIVATE_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const PUBLIC_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
type KeyMaterial = Pick<WalletRecord, "address" | "publicKey" | "privateKey" | "seed">;

function ed25519PrivateKey(seed: string | undefined): KeyObject {
  if (typeof seed !== "string" || !/^[0-9a-f]{64}$/.test(seed)) throw new WalletError("invalid_wallet_key");
  return createPrivateKey({
    key: Buffer.concat([PRIVATE_PREFIX, Buffer.from(seed, "hex")]),
    format: "der", type: "pkcs8",
  });
}

function publicHex(key: KeyObject): string {
  const der = createPublicKey(key).export({ format: "der", type: "spki" });
  if (der.length !== PUBLIC_PREFIX.length + 32 || !der.subarray(0, PUBLIC_PREFIX.length).equals(PUBLIC_PREFIX)) {
    throw new WalletError("invalid_wallet_key");
  }
  return der.subarray(PUBLIC_PREFIX.length).toString("hex");
}

export function generateWalletKeys(keyType: KeyType): KeyMaterial {
  try {
    if (keyType === "secp256k1") {
      const privateKey = generatePrivateKey();
      return { privateKey, address: privateKeyToAccount(privateKey).address };
    }
    if (keyType !== "ed25519") throw new WalletError("unsupported_key_type");
    const { privateKey } = generateKeyPairSync("ed25519");
    const der = privateKey.export({ format: "der", type: "pkcs8" });
    if (der.length !== PRIVATE_PREFIX.length + 32 || !der.subarray(0, PRIVATE_PREFIX.length).equals(PRIVATE_PREFIX)) {
      throw new WalletError("key_generation_failed");
    }
    return { seed: der.subarray(PRIVATE_PREFIX.length).toString("hex"), publicKey: publicHex(privateKey) };
  } catch {
    throw new WalletError("key_generation_failed");
  }
}

/** Check that disk's public identity belongs to disk's secret before using it. */
export function validateWalletKeys(wallet: WalletRecord): void {
  try {
    if (wallet.keyType === "secp256k1") {
      if (typeof wallet.privateKey !== "string" || !/^0x[0-9a-f]{64}$/.test(wallet.privateKey)
        || wallet.seed !== undefined || wallet.publicKey !== undefined) throw new WalletError("invalid_wallet_key");
      if (privateKeyToAccount(wallet.privateKey).address !== wallet.address) throw new WalletError("invalid_wallet_key");
      return;
    }
    if (wallet.keyType !== "ed25519" || typeof wallet.publicKey !== "string"
      || !/^[0-9a-f]{64}$/.test(wallet.publicKey) || wallet.privateKey !== undefined
      || wallet.address !== undefined) throw new WalletError("invalid_wallet_key");
    const derived = Buffer.from(publicHex(ed25519PrivateKey(wallet.seed)), "hex");
    if (!timingSafeEqual(derived, Buffer.from(wallet.publicKey, "hex"))) throw new WalletError("invalid_wallet_key");
  } catch {
    throw new WalletError("invalid_wallet_key");
  }
}

export async function signWalletMessage(wallet: WalletRecord, message: string): Promise<string> {
  try {
    validateWalletKeys(wallet);
    if (wallet.keyType === "secp256k1") {
      return await privateKeyToAccount(wallet.privateKey!).signMessage({ message });
    }
    return sign(null, Buffer.from(message, "utf8"), ed25519PrivateKey(wallet.seed)).toString("hex");
  } catch {
    throw new WalletError("wallet_signing_failed");
  }
}
