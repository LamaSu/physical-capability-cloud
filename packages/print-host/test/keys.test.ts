import { randomBytes, createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeKernelEd25519Signer } from "@pcc/kernel";
import { verifyBundleSignature } from "@pcc/kernel-sdk";
import type { EvidenceBundle } from "@pcc/spec";
import { recoverTypedDataAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { KeyFileError, loadDeviceKey, loadOperatorKey, type KeyFileErrorCode } from "../src/keys.js";

type Document = Record<string, unknown>;
let directory: string;
const now = new Date("2026-10-10T12:00:00.000Z");

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "ph2-keys-"));
  await chmod(directory, 0o700);
});
afterEach(async () => { vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true }); });

function deviceDocument(): Document {
  const bytes = randomBytes(32);
  const signer = makeKernelEd25519Signer(bytes);
  const result = {
    kind: "pcc-printhost.device-key", version: 1, algorithm: "ed25519", purpose: "runtime test",
    createdAt: now.toISOString(), publicKey: signer.signingPublicKey, seed: bytes.toString("hex"),
  };
  signer.secretKey.fill(0);
  bytes.fill(0);
  return result;
}
function operatorDocument(): Document {
  const privateKey = generatePrivateKey();
  return {
    kind: "pcc-printhost.operator-key", version: 1, algorithm: "secp256k1", purpose: "runtime test",
    createdAt: now.toISOString(), address: privateKeyToAccount(privateKey).address, privateKey,
  };
}
function secret(document: Document): string {
  return String(document.seed ?? document.privateKey).replace(/^0x/, "");
}
function assertNoLeak(value: unknown, secrets: string[]): void {
  const output = [String(value), `${value}`, JSON.stringify(value) ?? "", inspect(value, { depth: 5, showHidden: true })];
  if (value instanceof Error) output.push(value.message);
  for (const raw of secrets) {
    const hex = raw.replace(/^0x/, "");
    for (let index = 0; index <= hex.length - 12; index++) {
      const fragment = hex.slice(index, index + 12);
      expect(output.some((rendered) => rendered.includes(fragment)), "secret fragment was exposed").toBe(false);
    }
  }
}
async function writeDocument(document: Document | string, name = "key.json"): Promise<string> {
  const path = join(directory, name);
  await writeFile(path, typeof document === "string" ? document : JSON.stringify(document), { mode: 0o600 });
  return path;
}
async function refused(document: Document | string, type: "device" | "operator", code: KeyFileErrorCode, secrets: string[]): Promise<void> {
  const path = await writeDocument(document);
  let error: unknown;
  try { await (type === "device" ? loadDeviceKey : loadOperatorKey)(path, { now }); }
  catch (caught) { error = caught; }
  expect(error instanceof KeyFileError).toBe(true);
  expect((error as KeyFileError).code).toBe(code);
  assertNoLeak(error, secrets);
}

describe("host key loading and redaction", () => {
  it("device signFn produces the existing bundle signature format", async () => {
    const document = deviceDocument();
    const key = await loadDeviceKey(await writeDocument(document), { now });
    assertNoLeak(key, [secret(document)]);
    expect(Object.hasOwn(key, "secretKey")).toBe(false);
    expect(Object.hasOwn(key, "seed")).toBe(false);
    const digest = createHash("sha256").update("runtime bundle probe").digest("hex");
    const bundleHash = `sha256:${digest}` as EvidenceBundle["bundleHash"];
    const bundle: EvidenceBundle = {
      id: "bundle-runtime", jobId: "job-runtime", stepId: "step-runtime", kernelId: "kernel-runtime",
      assuranceTier: 0, events: [], bundleHash, kernelSignature: await key.signFn(bundleHash),
      createdAt: now.toISOString(),
    };
    expect(verifyBundleSignature(bundle, Buffer.from(key.publicKeyHex, "hex"))).toBe(true);
    expect(key.signingPublicKey === document.publicKey).toBe(true);
  });

  it("operator account signs typed data and recovers its public address", async () => {
    const document = operatorDocument();
    const key = await loadOperatorKey(await writeDocument(document), { now });
    assertNoLeak(key, [secret(document)]);
    assertNoLeak(key.account, [secret(document)]);
    const typedData = {
      domain: { name: "Print host loader test", version: "1", chainId: 84532 },
      types: { LoaderProbe: [{ name: "sequence", type: "uint256" }] },
      primaryType: "LoaderProbe" as const, message: { sequence: 1n },
    };
    const signature = await key.account.signTypedData(typedData);
    const recovered = await recoverTypedDataAddress({ ...typedData, signature });
    expect(recovered.toLowerCase() === key.address.toLowerCase()).toBe(true);
  });

  for (const type of ["device", "operator"] as const) {
    const build = type === "device" ? deviceDocument : operatorDocument;
    const secretField = type === "device" ? "seed" : "privateKey";
    it(`${type} refuses a mismatched public half without exposing the secret`, async () => {
      const document = build();
      const other = build();
      document[type === "device" ? "publicKey" : "address"] = other[type === "device" ? "publicKey" : "address"];
      await refused(document, type, "public_mismatch", [secret(document)]);
    });
    it(`${type} refuses the wrong kind without exposing its value`, async () => {
      const document = build();
      const raw = secret(document);
      document.kind = raw;
      await refused(document, type, "wrong_kind", [raw]);
    });
    it(`${type} refuses unknown names, even names containing secret material`, async () => {
      const document = build();
      document[secret(document)] = secret(document);
      await refused(document, type, "bad_schema", [secret(document)]);
    });
    for (const variant of ["nonhex", "short", "uppercase"] as const) {
      it(`${type} refuses ${variant} secret hex without echoing any of it`, async () => {
        let document = build();
        while (!/[a-f]/.test(secret(document))) document = build();
        const raw = secret(document);
        const prefix = type === "operator" ? "0x" : "";
        const malformed = variant === "nonhex" ? `${raw.slice(0, -1)}g`
          : variant === "short" ? raw.slice(0, -2) : raw.toUpperCase();
        document[secretField] = `${prefix}${malformed}`;
        await refused(document, type, "bad_schema", [raw, malformed]);
      });
    }
    it(`${type} refuses expired keys with value-free errors`, async () => {
      const document = build();
      document.notAfter = "2026-10-09T12:00:00.000Z";
      await refused(document, type, "expired", [secret(document)]);
    });
    it(`${type} rejects invalid JSON without the JSON.parse message or cause`, async () => {
      const document = build();
      const raw = secret(document);
      await refused(`${raw} invalid JSON`, type, "bad_json", [raw]);
    });
    it(`${type} uses only a field label for malformed metadata`, async () => {
      const document = build();
      const raw = secret(document);
      document.createdAt = raw;
      await refused(document, type, "bad_schema", [raw]);
    });
    for (const field of ["version", "algorithm", "purpose", "createdAt", "notAfter"] as const) {
      it(`${type} refuses malformed ${field} using only the trusted field name`, async () => {
        const document = build();
        const raw = secret(document);
        document[field] = field === "purpose" ? { nested: raw } : raw;
        await refused(document, type, "bad_schema", [raw]);
      });
    }
    it(`${type} refuses invalid UTC metadata and timezone offsets`, async () => {
      const document = build();
      const raw = secret(document);
      for (const createdAt of ["2026-02-30T12:00:00Z", "2026-10-10T12:00:00+00:00"]) {
        document.createdAt = createdAt;
        await refused(document, type, "bad_schema", [raw]);
      }
    });
    it(`${type} converts secret-file failures to safe KeyFileError`, async () => {
      const document = build();
      const path = await writeDocument(document);
      await chmod(path, 0o644);
      let error: unknown;
      try { await (type === "device" ? loadDeviceKey : loadOperatorKey)(path); }
      catch (caught) { error = caught; }
      expect(error instanceof KeyFileError).toBe(true);
      expect((error as KeyFileError).code).toBe("bad_mode");
      assertNoLeak(error, [secret(document)]);
    });
  }

  for (const variant of ["nonhex", "short", "uppercase"] as const) {
    it(`device refuses ${variant} public-key hex with no seed leak`, async () => {
      let document = deviceDocument();
      while (!/[a-f]/.test(String(document.publicKey).slice(2))) document = deviceDocument();
      const publicHex = String(document.publicKey).slice(2);
      const malformed = variant === "nonhex" ? `${publicHex.slice(0, -1)}g`
        : variant === "short" ? publicHex.slice(0, -2) : publicHex.toUpperCase();
      document.publicKey = `0x${malformed}`;
      await refused(document, "device", "bad_schema", [secret(document)]);
    });
  }

  const order = (1n << 256n) - BigInt("0x14551231950b75fc4402da1732fc9bebf");
  for (const [label, scalar] of [["zero", 0n], ["order", order], ["over-order", order + 1n]] as const) {
    it(`operator explicitly refuses the ${label} scalar`, async () => {
      const document = operatorDocument();
      const previousSecret = secret(document);
      document.privateKey = `0x${scalar.toString(16).padStart(64, "0")}`;
      await refused(document, "operator", "bad_key", [previousSecret, secret(document)]);
    });
  }

  it("requires the recorded EIP-55 checksum", async () => {
    let document = operatorDocument();
    while (document.address === String(document.address).toLowerCase()) document = operatorDocument();
    document.address = String(document.address).toLowerCase();
    await refused(document, "operator", "bad_schema", [secret(document)]);
  });

  it("accepts notAfter equality and UTC fractional seconds", async () => {
    const document = deviceDocument();
    document.notAfter = now.toISOString();
    const key = await loadDeviceKey(await writeDocument(document), { now });
    assertNoLeak(key, [secret(document)]);
  });

  it("loading either key makes no console calls", async () => {
    const spies = ["log", "info", "warn", "error", "debug", "trace", "dir"]
      .map((method) => vi.spyOn(console, method as "log").mockImplementation(() => {}));
    const device = deviceDocument();
    const operator = operatorDocument();
    const loadedDevice = await loadDeviceKey(await writeDocument(device, "device.json"), { now });
    const loadedOperator = await loadOperatorKey(await writeDocument(operator, "operator.json"), { now });
    assertNoLeak(loadedDevice, [secret(device)]);
    assertNoLeak(loadedOperator, [secret(operator)]);
    expect(spies.every((spy) => spy.mock.calls.length === 0)).toBe(true);
    // Reading a document is confined to runtime fixtures; no fixture is serialized to diagnostics.
    const content = await readFile(join(directory, "device.json"));
    content.fill(0);
  });
});
