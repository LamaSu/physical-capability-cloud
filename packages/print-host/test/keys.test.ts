import { randomBytes, createPrivateKey, createPublicKey } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeKernelEd25519Signer } from "../src/kernel-signer.js";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { KeyFileError, loadDeviceKey, loadOperatorKey, type KeyFileErrorCode } from "../src/keys.js";
import type * as secretFile from "../src/secret-file.js";

const mocks = vi.hoisted(() => ({
  fileBuffers: [] as Buffer[],
  acceptAnyScalar: false,
  publicAccount: undefined as ReturnType<typeof privateKeyToAccount> | undefined,
  captureDeviceBuffers: false,
  deviceSeeds: [] as Uint8Array[],
  deviceSecretKeys: [] as Uint8Array[],
}));
vi.mock("../src/kernel-signer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/kernel-signer.js")>();
  return { ...actual, makeKernelEd25519Signer: vi.fn((...args: Parameters<typeof actual.makeKernelEd25519Signer>) => {
    const signer = actual.makeKernelEd25519Signer(...args);
    if (mocks.captureDeviceBuffers) {
      mocks.deviceSeeds.push(args[0]!);
      mocks.deviceSecretKeys.push(signer.secretKey);
    }
    return signer;
  }) };
});
vi.mock("../src/secret-file.js", async (importOriginal) => {
  const actual = await importOriginal<typeof secretFile>();
  return { ...actual, readSecretFile: vi.fn(async (...args: Parameters<typeof actual.readSecretFile>) => {
    const bytes = await actual.readSecretFile(...args);
    mocks.fileBuffers.push(bytes);
    return bytes;
  }) };
});
vi.mock("viem/accounts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem/accounts")>();
  return { ...actual, privateKeyToAccount: vi.fn((...args: Parameters<typeof actual.privateKeyToAccount>) =>
    mocks.acceptAnyScalar ? mocks.publicAccount! : actual.privateKeyToAccount(...args)) };
});

type Document = Record<string, unknown>;
let directory: string;
const now = new Date("2026-10-10T12:00:00.000Z");

beforeEach(async () => {
  mocks.fileBuffers = [];
  mocks.acceptAnyScalar = false;
  mocks.publicAccount = undefined;
  mocks.captureDeviceBuffers = false;
  mocks.deviceSeeds = [];
  mocks.deviceSecretKeys = [];
  vi.mocked(privateKeyToAccount).mockClear();
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
  const output = [String(value), `${value}`, JSON.stringify(value) ?? "", inspect(value, { depth: 5, showHidden: true }),
    inspect(value, { customInspect: false, showHidden: true, depth: 5 })];
  if (value instanceof Error) output.push(value.message);
  for (const raw of secrets) {
    const hex = raw.replace(/^0x/, "");
    for (let index = 0; index <= hex.length - 12; index++) {
      const fragment = hex.slice(index, index + 12);
      expect(output.some((rendered) => rendered.includes(fragment)), "secret fragment was exposed").toBe(false);
    }
  }
}
function assertNoOwnedSecretMaterial(value: unknown, depth = 5, seen = new WeakSet<object>()): void {
  expect(typeof value === "bigint", "own value contains a scalar").toBe(false);
  expect(value instanceof Uint8Array || Buffer.isBuffer(value) || value instanceof ArrayBuffer,
    "own value contains secret bytes").toBe(false);
  if (value === null || (typeof value !== "object" && typeof value !== "function") || depth === 0 || seen.has(value)) return;
  seen.add(value);
  for (const name of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name)!;
    if (Object.hasOwn(descriptor, "value")) assertNoOwnedSecretMaterial(descriptor.value, depth - 1, seen);
  }
}
function assertClosedError(error: KeyFileError): void {
  expect(Object.hasOwn(error, "cause")).toBe(false);
  expect(Object.keys(error).every((name) => ["name", "code", "path", "field"].includes(name)),
    "error contains an untrusted enumerable property").toBe(true);
}
async function writeDocument(document: Document | string, name = "key.json"): Promise<string> {
  const path = join(directory, name);
  await writeFile(path, typeof document === "string" ? document : JSON.stringify(document), { mode: 0o600 });
  return path;
}
async function refused(document: Document | string, type: "device" | "operator", code: KeyFileErrorCode, secrets: string[]): Promise<void> {
  const path = await writeDocument(document);
  let error: unknown;
  try {
    await (type === "device" ? loadDeviceKey(path, { now }) : loadOperatorKey(path, 84532, { now }));
  }
  catch (caught) { error = caught; }
  expect(error instanceof KeyFileError).toBe(true);
  expect((error as KeyFileError).code).toBe(code);
  assertClosedError(error as KeyFileError);
  if (code === "bad_json") expect((error as KeyFileError).message === `bad_json: ${path}`,
    "bad_json uses only its closed message").toBe(true);
  assertNoLeak(error, secrets);
}

describe("host key loading and redaction", () => {
  it("device public key derives from the recorded seed without exposing a general signer", async () => {
    const document = deviceDocument();
    const key = await loadDeviceKey(await writeDocument(document), { now });
    assertNoLeak(key, [secret(document)]);
    expect(Reflect.ownKeys(key).sort()).toEqual(["publicKeyHex", "signingPublicKey", "signDelegation", "signD2"].sort());
    assertNoOwnedSecretMaterial(key);
    expect(Object.hasOwn(key, "secretKey")).toBe(false);
    expect(Object.hasOwn(key, "seed")).toBe(false);
    const encoded = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(String(document.seed), "hex")]);
    try {
      const privateKey = createPrivateKey({ key: encoded, format: "der", type: "pkcs8" });
      const publicKey = createPublicKey(privateKey).export({ format: "der", type: "spki" }).subarray(-32);
      expect(key.publicKeyHex === publicKey.toString("hex")).toBe(true);
    } finally { encoded.fill(0); }
    expect(key.signingPublicKey === document.publicKey).toBe(true);
  });

  for (const mismatch of [false, true]) {
    it(`device zeroes the seed and derived secretKey on ${mismatch ? "public_mismatch" : "successful load"}`, async () => {
      const document = deviceDocument();
      if (mismatch) document.publicKey = deviceDocument().publicKey;
      const path = await writeDocument(document);
      mocks.captureDeviceBuffers = true;
      if (mismatch) await expect(loadDeviceKey(path, { now })).rejects.toMatchObject({ code: "public_mismatch" });
      else await loadDeviceKey(path, { now });
      expect(mocks.deviceSeeds.length).toBe(1);
      expect(mocks.deviceSecretKeys.length).toBe(1);
      expect(mocks.deviceSeeds[0].length).toBe(32);
      expect(mocks.deviceSecretKeys[0].length).toBe(64);
      expect(mocks.deviceSeeds[0].every((byte) => byte === 0), "device seed was retained").toBe(true);
      expect(mocks.deviceSecretKeys[0].every((byte) => byte === 0), "derived secretKey was retained").toBe(true);
    });
  }

  it("operator exposes only its public address and narrow signing closures", async () => {
    const document = operatorDocument();
    const key = await loadOperatorKey(await writeDocument(document), 84532, { now });
    assertNoLeak(key, [secret(document)]);
    expect(Reflect.ownKeys(key).sort()).toEqual(["address", "signD1", "signSubmitEvidenceTx", "signJobPolicyAcceptance"].sort());
    assertNoOwnedSecretMaterial(key);
    expect(key.address === document.address).toBe(true);
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
      let raw = randomBytes(32).toString("hex");
      while (!/^[a-f]/.test(raw)) raw = randomBytes(32).toString("hex");
      await refused(`${raw} invalid JSON`, type, "bad_json", [raw]);
    });
    it(`${type} zeroes the file buffer after a successful load`, async () => {
      const path = await writeDocument(build());
      await (type === "device" ? loadDeviceKey(path, { now }) : loadOperatorKey(path, 84532, { now }));
      expect(mocks.fileBuffers.length).toBe(1);
      expect(mocks.fileBuffers[0].length > 0).toBe(true);
      expect(mocks.fileBuffers[0].every((byte) => byte === 0), "loaded file bytes were retained").toBe(true);
    });
    it(`${type} zeroes the file buffer after a failed load`, async () => {
      const document = build();
      document.kind = secret(document);
      await refused(document, type, "wrong_kind", [secret(document)]);
      expect(mocks.fileBuffers.length).toBe(1);
      expect(mocks.fileBuffers[0].length > 0).toBe(true);
      expect(mocks.fileBuffers[0].every((byte) => byte === 0), "rejected file bytes were retained").toBe(true);
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
      try { await (type === "device" ? loadDeviceKey(path) : loadOperatorKey(path, 84532)); }
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
    it(`operator explicitly refuses the ${label} scalar even when viem accepts it`, async () => {
      const document = operatorDocument();
      const previousSecret = secret(document);
      mocks.publicAccount = privateKeyToAccount(String(document.privateKey) as `0x${string}`);
      mocks.acceptAnyScalar = true;
      vi.mocked(privateKeyToAccount).mockClear();
      document.privateKey = `0x${scalar.toString(16).padStart(64, "0")}`;
      await refused(document, "operator", "bad_key", [previousSecret, secret(document)]);
      expect(vi.mocked(privateKeyToAccount).mock.calls.length === 0,
        "the explicit range guard runs before viem").toBe(true);
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
    const loadedOperator = await loadOperatorKey(await writeDocument(operator, "operator.json"), 84532, { now });
    assertNoLeak(loadedDevice, [secret(device)]);
    assertNoLeak(loadedOperator, [secret(operator)]);
    expect(spies.every((spy) => spy.mock.calls.length === 0)).toBe(true);
    // Reading a document is confined to runtime fixtures; no fixture is serialized to diagnostics.
    const content = await readFile(join(directory, "device.json"));
    content.fill(0);
  });
});
