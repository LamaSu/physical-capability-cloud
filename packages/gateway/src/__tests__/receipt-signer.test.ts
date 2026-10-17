import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyEd25519Signature } from "../auth/ed25519.js";
import { loadReceiptSigner } from "../settlement/receipt-signer.js";

const vectorSeed = Buffer.from("nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A", "base64url").toString("hex");
const vectorPublicKey = `0x${Buffer.from("11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo", "base64url").toString("hex")}`;
const vectorKid = "kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k";
const configured = { PCC_GATEWAY_RECEIPT_SEED: vectorSeed, PCC_GATEWAY_RECEIPT_VALID_FROM: "0" };

afterEach(() => vi.unstubAllEnvs());

describe("gateway receipt signer configuration", () => {
  it("matches the RFC 8037 Ed25519 public key and RFC 7638 thumbprint", () => {
    const key = loadReceiptSigner(0, configured)!;
    expect(key.publicKey).toBe(vectorPublicKey);
    expect(key.kid).toBe(vectorKid);
    expect(key.kid).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Object.keys(key).sort()).toEqual(["kid", "publicKey", "signer", "validFrom"]);
    expect(JSON.stringify(key)).not.toContain(vectorSeed);
  });

  it.each([vectorSeed, vectorSeed.toUpperCase(), `0x${vectorSeed}`, `0X${vectorSeed.toUpperCase()}`])(
    "accepts an optional case-insensitive hex prefix and hex digits (%#)", (seed) => {
      expect(loadReceiptSigner(0, { ...configured, PCC_GATEWAY_RECEIPT_SEED: seed })?.publicKey).toBe(vectorPublicKey);
    },
  );

  const invalidSeeds: unknown[] = [
    undefined, "", " ", ` ${vectorSeed}`, `${vectorSeed}\n`, `${vectorSeed}\t`,
    vectorSeed.slice(1), `${vectorSeed}0`, "0x", `0x${vectorSeed.slice(1)}`,
    `0x${vectorSeed}00`, `0x0x${vectorSeed}`, `+${vectorSeed}`, `-${vectorSeed}`,
    `${vectorSeed.slice(0, -1)}g`, "zz".repeat(32),
    Buffer.from(vectorSeed, "hex").toString("base64"),
    Buffer.from(vectorSeed, "hex").toString("base64url"), null, 123, {},
  ];
  it.each(invalidSeeds.map((value, index) => ({ value, index })))(
    "fails closed for invalid seed form $index without exposing it", ({ value }) => {
      expect(() => loadReceiptSigner(0, { ...configured, PCC_GATEWAY_RECEIPT_SEED: value as string })).not.toThrow();
      expect(loadReceiptSigner(0, { ...configured, PCC_GATEWAY_RECEIPT_SEED: value as string })).toBeNull();
    },
  );

  const invalidTimes: unknown[] = [
    undefined, "", " ", "-1", "-0", "+1", "1.0", "0.1", "1e3", "0x10",
    "NaN", "Infinity", " 0", "0\n", "9007199254740992", "9".repeat(400), null, 0,
  ];
  it.each(invalidTimes.map((value, index) => ({ value, index })))(
    "fails closed for invalid validFrom form $index", ({ value }) => {
      expect(loadReceiptSigner(10, { ...configured, PCC_GATEWAY_RECEIPT_VALID_FROM: value as string })).toBeNull();
    },
  );

  it.each(["0", "00001", "42", "9007199254740991"])("accepts safe decimal validFrom %s", (value) => {
    expect(loadReceiptSigner(Number(value), { ...configured, PCC_GATEWAY_RECEIPT_VALID_FROM: value })?.validFrom).toBe(Number(value));
  });

  it("refuses before validFrom and signs at validFrom", () => {
    const env = { ...configured, PCC_GATEWAY_RECEIPT_VALID_FROM: "100" };
    expect(loadReceiptSigner(99, env)).toBeNull();
    expect(loadReceiptSigner(100, env)).not.toBeNull();
  });

  it("signs exactly the raw 32 digest bytes with a lowercase prefixed signature", () => {
    const key = loadReceiptSigner(0, configured)!;
    const digest = Buffer.alloc(32, 0x42);
    const signature = key.signer(digest)!;
    expect(signature).toMatch(/^0x[0-9a-f]{128}$/);
    expect(verifyEd25519Signature(key.publicKey, digest, signature)).toBe(true);
    expect(verifyEd25519Signature(key.publicKey, Buffer.from(digest.toString("hex")), signature)).toBe(false);
    expect(key.signer(Buffer.alloc(31))).toBeNull();
    expect(key.signer(Buffer.alloc(33))).toBeNull();
  });

  it("reads the seed and validFrom at call time", () => {
    vi.stubEnv("PCC_GATEWAY_RECEIPT_SEED", vectorSeed);
    vi.stubEnv("PCC_GATEWAY_RECEIPT_VALID_FROM", "0");
    expect(loadReceiptSigner()?.kid).toBe(vectorKid);
    vi.stubEnv("PCC_GATEWAY_RECEIPT_SEED", "");
    expect(loadReceiptSigner()).toBeNull();
    vi.stubEnv("PCC_GATEWAY_RECEIPT_SEED", vectorSeed);
    vi.stubEnv("PCC_GATEWAY_RECEIPT_VALID_FROM", "9007199254740991");
    expect(loadReceiptSigner()).toBeNull();
  });
});
