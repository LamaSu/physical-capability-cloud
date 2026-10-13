import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import type { ReceiptSigner } from "./gateway-receipt.js";

export interface ConfiguredReceiptSigner {
  signer: ReceiptSigner;
  publicKey: string;
  kid: string;
  validFrom: number;
}

type ReceiptSignerEnvironment = Record<string, string | undefined>;

/** RFC 7638 canonical JWK member order, with RFC 8037's Ed25519 representation. */
function keyThumbprint(publicBytes: Buffer): string {
  const canonical = JSON.stringify({ crv: "Ed25519", kty: "OKP", x: publicBytes.toString("base64url") });
  return createHash("sha256").update(canonical, "utf8").digest("base64url");
}

/** Derive a dedicated receipt key without exposing its seed in results or errors. */
export function receiptSignerFromSeed(seed: string, validFrom = 0): ConfiguredReceiptSigner | null {
  if (typeof seed !== "string" || !/^(?:0x)?[0-9a-f]{64}$/i.test(seed)) return null;
  try {
    const rawSeed = Buffer.from(seed.replace(/^0x/i, ""), "hex");
    const privateKey = createPrivateKey({
      key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), rawSeed]),
      format: "der",
      type: "pkcs8",
    });
    const publicDer = createPublicKey(privateKey).export({ format: "der", type: "spki" });
    const publicBytes = publicDer.subarray(-32);
    return {
      signer: (digestBytes) => {
        if (digestBytes.byteLength !== 32) return null;
        try {
          return `0x${sign(null, digestBytes, privateKey).toString("hex")}`;
        } catch {
          return null;
        }
      },
      publicKey: `0x${publicBytes.toString("hex")}`,
      kid: keyThumbprint(publicBytes),
      validFrom,
    };
  } catch {
    return null;
  }
}

/** Load at request time so unavailable or not-yet-valid configuration fails closed. */
export function loadReceiptSigner(
  receivedAt = Math.floor(Date.now() / 1000),
  env: ReceiptSignerEnvironment = process.env,
): ConfiguredReceiptSigner | null {
  const validFromText = env.PCC_GATEWAY_RECEIPT_VALID_FROM;
  if (typeof validFromText !== "string" || !/^\d+$/.test(validFromText)) return null;
  const validFrom = Number(validFromText);
  if (!Number.isSafeInteger(validFrom) || validFrom < 0 || !Number.isSafeInteger(receivedAt) || receivedAt < validFrom) return null;
  return receiptSignerFromSeed(env.PCC_GATEWAY_RECEIPT_SEED!, validFrom);
}
