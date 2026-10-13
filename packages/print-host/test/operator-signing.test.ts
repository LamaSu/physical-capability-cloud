import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  decodeFunctionData,
  getAddress,
  parseTransaction,
  recoverTransactionAddress,
  recoverTypedDataAddress,
  zeroAddress,
  type Address,
  type Hex,
  type TransactionSerializedEIP1559,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { KeyFileError, loadOperatorKey, OperatorSigningError, type OperatorKey } from "../src/keys.js";
import { submitEvidenceAbiItem } from "../src/operator-signing.js";

const signerFailure = vi.hoisted(() => ({ enabled: false }));
vi.mock("viem/accounts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem/accounts")>();
  return { ...actual, privateKeyToAccount: (...args: Parameters<typeof actual.privateKeyToAccount>) => {
    const account = actual.privateKeyToAccount(...args);
    function failWhenEnabled(): void {
      if (signerFailure.enabled) throw new Error(args[0], { cause: { secret: args[0] } });
    }
    return { ...account,
      async signTypedData(input: Parameters<typeof account.signTypedData>[0]) {
        failWhenEnabled();
        return account.signTypedData(input);
      },
      async signTransaction(input: Parameters<typeof account.signTransaction>[0]) {
        failWhenEnabled();
        return account.signTransaction(input);
      },
    };
  } };
});

// This restates the gateway's ratified wire contract independently of the host's implementation.
const ratifiedTypes = {
  FinalMilestonePackageV2: [
    { name: "chainId", type: "uint256" },
    { name: "escrow", type: "address" },
    { name: "settlementUnitId", type: "bytes32" },
    { name: "jobIdHash", type: "bytes32" },
    { name: "milestoneIndex", type: "uint256" },
    { name: "stepId", type: "bytes32" },
    { name: "compositionRoot", type: "bytes32" },
    { name: "acceptedEnvelopeHash", type: "bytes32" },
    { name: "packageBodyHash", type: "bytes32" },
  ],
} as const;
const chainIds = [84532, 31337] as const;
const secp256k1Order = (1n << 256n) - BigInt("0x14551231950b75fc4402da1732fc9bebf");
const uint256Max = (1n << 256n) - 1n;
const now = new Date("2026-10-10T12:00:00.000Z");
let directory: string;
let privateKey: Hex;
let keyPath: string;
let key: OperatorKey;

beforeEach(async () => {
  signerFailure.enabled = false;
  directory = await mkdtemp(join(tmpdir(), "ph3-signing-"));
  await chmod(directory, 0o700);
  privateKey = generatePrivateKey();
  keyPath = join(directory, "operator.json");
  await writeFile(keyPath, JSON.stringify({
    kind: "pcc-printhost.operator-key", version: 1, algorithm: "secp256k1", purpose: "runtime test",
    createdAt: now.toISOString(), address: privateKeyToAccount(privateKey).address, privateKey,
  }), { mode: 0o600 });
  key = await loadOperatorKey(keyPath, 84532, { now });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

function word(label: string): Hex {
  return `0x${createHash("sha256").update(label).digest("hex")}`;
}
function d1Input() {
  return {
    escrow: getAddress(`0x${"ab".repeat(20)}`),
    settlementUnitId: word("unit"), jobIdHash: word("job"), milestoneIndex: 3n,
    stepId: word("step"), compositionRoot: word("composition"),
    acceptedEnvelopeHash: word("envelope"), packageBodyHash: word("package"),
  };
}
function txInput() {
  return {
    escrow: getAddress(`0x${"ab".repeat(20)}`), unitId: word("unit"), packageDigest: word("package"),
    nonce: 4, gas: 120_000n, maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n,
  };
}
function noLeak(value: unknown, secret: Hex): void {
  const renderings = [String(value), `${value}`, JSON.stringify(value) ?? "",
    inspect(value, { depth: 5, showHidden: true }),
    inspect(value, { customInspect: false, showHidden: true, depth: 5 })];
  const hex = secret.slice(2);
  for (let index = 0; index <= hex.length - 12; index++) {
    expect(renderings.some((rendering) => rendering.includes(hex.slice(index, index + 12))),
      "private key fragment is reachable in a rendering").toBe(false);
  }
}
async function closedRefusal(operation: () => Promise<unknown>, code: string): Promise<void> {
  let caught: unknown;
  try { await operation(); } catch (error) { caught = error; }
  expect(caught instanceof OperatorSigningError, "signer must refuse with its closed error class").toBe(true);
  const error = caught as OperatorSigningError;
  expect(error.code).toBe(code);
  expect(error.message).toBe(code);
  expect(Object.hasOwn(error, "cause")).toBe(false);
  expect(Object.keys(error).every((property) => ["name", "code"].includes(property))).toBe(true);
  noLeak(error, privateKey);
}
function levels(object: object): object[] {
  const result: object[] = [];
  for (let current: object | null = object; current !== null && current !== Object.prototype;
    current = Object.getPrototypeOf(current) as object | null) result.push(current);
  return result;
}
function assertNarrowSurface(operator: OperatorKey): void {
  const allowed = new Set<PropertyKey>(["signD1", "signSubmitEvidenceTx", "signJobPolicyAcceptance", "toJSON", "toString", inspect.custom]);
  const found = new Set<PropertyKey>();
  for (const level of levels(operator)) {
    for (const name of Reflect.ownKeys(level)) {
      const descriptor = Object.getOwnPropertyDescriptor(level, name)!;
      expect(descriptor.get === undefined && descriptor.set === undefined,
        "operator surface has a reachable accessor").toBe(true);
      if (typeof descriptor.value === "function") {
        expect(allowed.has(name), "operator surface has an unexpected callable property").toBe(true);
        found.add(name);
      } else {
        expect(name === "address", "operator surface has an unexpected property").toBe(true);
      }
    }
  }
  expect(found).toEqual(allowed);
}
function assertNoGeneralSigner(root: unknown): void {
  const banned = new Set(["signTransaction", "sign", "signMessage", "signTypedData", "signAuthorization"]);
  const seen = new Set<object>();
  const pending: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  const maxDepth = 12;
  const maxNodes = 4096;
  while (pending.length > 0) {
    const { value, depth } = pending.shift()!;
    if (value === null || (typeof value !== "object" && typeof value !== "function") || seen.has(value)) continue;
    expect(seen.size < maxNodes, "reachable property walk exhausted its object bound").toBe(true);
    seen.add(value);
    for (const name of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, name)!;
      expect(!(typeof name === "string" && banned.has(name) && typeof descriptor.value === "function"),
        "general signing function is reachable through a property").toBe(true);
      for (const child of [descriptor.value, descriptor.get, descriptor.set]) {
        if (child !== undefined) {
          expect(depth < maxDepth || (typeof child !== "object" && typeof child !== "function"),
            "reachable property walk exhausted its depth bound").toBe(true);
          if (depth < maxDepth) pending.push({ value: child, depth: depth + 1 });
        }
      }
    }
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== null && prototype !== Object.prototype) {
      expect(depth < maxDepth, "reachable prototype walk exhausted its depth bound").toBe(true);
      pending.push({ value: prototype, depth: depth + 1 });
    }
  }
}

// A variable-path relative import keeps this runtime-only dependency outside the test tsc rootDir.
// The gateway module imports its other gateway interfaces with `import type` only.
interface GatewayVerifier {
  verifyOperatorSignature(input: {
    unitBinding: Record<string, string>; packageBodyHash: Hex;
    operatorPrincipalId: string; signer: string; sig: Hex;
  }): Promise<boolean>;
}
async function gatewayVerifier(address: Address): Promise<GatewayVerifier> {
  const modulePath = "../../gateway/src/settlement/operator-signature-verifier.ts";
  const gateway = await import(modulePath) as {
    createEip712OperatorVerifier(deps: { operatorForUnit: () => string }): GatewayVerifier;
  };
  return gateway.createEip712OperatorVerifier({ operatorForUnit: () => address });
}
async function assertD1(operator: OperatorKey, chainId: number,
  input: ReturnType<typeof d1Input>): Promise<void> {
  const signature = await operator.signD1(input);
  expect(signature).toMatch(/^0x[0-9a-f]{130}$/);
  const s = BigInt(`0x${signature.slice(66, 130)}`);
  expect(s > 0n && s <= secp256k1Order / 2n).toBe(true);
  expect([27, 28]).toContain(Number.parseInt(signature.slice(130), 16));
  const recovered = await recoverTypedDataAddress({
    domain: { name: "PCC FinalMilestonePackage", version: "2", chainId, verifyingContract: input.escrow },
    types: ratifiedTypes, primaryType: "FinalMilestonePackageV2",
    message: { ...input, chainId: BigInt(chainId), milestoneIndex: BigInt(input.milestoneIndex) },
    signature,
  });
  expect(recovered).toBe(operator.address);
  const verifier = await gatewayVerifier(operator.address);
  const { packageBodyHash, ...binding } = input;
  const unitBinding = Object.fromEntries(Object.entries(binding).map(([field, value]) => [field, String(value)]));
  unitBinding.chainId = String(chainId);
  unitBinding.escrow = input.escrow.toLowerCase();
  await expect(verifier.verifyOperatorSignature({
    unitBinding, packageBodyHash, sig: signature, signer: operator.address.toLowerCase(),
    operatorPrincipalId: `eip155:${chainId}:${operator.address.toLowerCase()}`,
  })).resolves.toBe(true);
}
async function assertTx(operator: OperatorKey, chainId: number,
  input: ReturnType<typeof txInput>): Promise<void> {
  const serialized = await operator.signSubmitEvidenceTx(input);
  const transaction = parseTransaction(serialized);
  expect(transaction.type).toBe("eip1559");
  expect(getAddress(transaction.to!)).toBe(input.escrow);
  // viem omits canonical RLP empty integers; those encode zero, including this fixed value.
  expect(transaction.value ?? 0n).toBe(0n);
  expect(transaction.chainId).toBe(chainId);
  expect(transaction.nonce).toBe(Number(input.nonce));
  expect(transaction.gas ?? 0n).toBe(BigInt(input.gas));
  expect(transaction.maxFeePerGas ?? 0n).toBe(BigInt(input.maxFeePerGas));
  expect(transaction.maxPriorityFeePerGas ?? 0n).toBe(BigInt(input.maxPriorityFeePerGas));
  const decoded = decodeFunctionData({ abi: [submitEvidenceAbiItem], data: transaction.data! });
  expect(decoded.functionName).toBe("submitEvidence");
  expect(decoded.args).toEqual([input.unitId, input.packageDigest]);
  expect(serialized.startsWith("0x02")).toBe(true);
  expect(await recoverTransactionAddress({
    serializedTransaction: serialized as TransactionSerializedEIP1559,
  })).toBe(operator.address);
}

describe("operator key only exposes the three authorized signatures", () => {
  it("walks every own and inherited string and symbol property and admits only the narrow surface", () => {
    assertNarrowSurface(key);
    expect(Reflect.ownKeys(key)).toEqual(["address", "signD1", "signSubmitEvidenceTx", "signJobPolicyAcceptance"]);
    expect(Object.isFrozen(key)).toBe(true);
    const prototype = Object.getPrototypeOf(key) as object;
    expect(Object.isFrozen(prototype)).toBe(true);
    expect(Object.getPrototypeOf(prototype)).toBe(null);
  });
  it("walks every reachable property value without finding a general signer", () => {
    assertNoGeneralSigner(key);
  });
  it("keeps secret hex out of normal and bypassed custom inspection", () => {
    noLeak(key, privateKey);
    expect(key.toJSON()).toEqual({ kind: "pcc-printhost.operator-key", address: key.address });
    expect(key.toString()).toBe(`[OperatorKey ${key.address}]`);
    expect(inspect(key)).toBe(key.toString());
  });

  for (const chainId of chainIds) {
    it(`D1 recovers under the fixed ratified domain and gateway verifier on chain ${chainId}`, async () => {
      const bound = await loadOperatorKey(keyPath, chainId, { now });
      await assertD1(bound, chainId, d1Input());
    });
    it(`submitEvidence transaction fixes destination, calldata, zero value and chain ${chainId}`, async () => {
      const bound = await loadOperatorKey(keyPath, chainId, { now });
      await assertTx(bound, chainId, txInput());
    });
  }
  it("D1 uint256 milestoneIndex admits its upper boundary without changing the ratified field type", async () => {
    await assertD1(key, 84532, { ...d1Input(), milestoneIndex: uint256Max });
  });
  it("D1 admits a non-negative safe integer milestoneIndex", async () => {
    const input = { ...d1Input(), milestoneIndex: Number.MAX_SAFE_INTEGER };
    await assertD1(key, 84532, input as unknown as ReturnType<typeof d1Input>);
  });
  it("transaction integer inputs admit zero and non-negative safe integer values", async () => {
    const input = { ...txInput(), nonce: 0, gas: 0, maxFeePerGas: 0, maxPriorityFeePerGas: 0 };
    await assertTx(key, 84532, input as unknown as ReturnType<typeof txInput>);
  });
  it("transaction nonce admits bigint through MAX_SAFE_INTEGER and uint256 gas and fee boundaries", async () => {
    const input = { ...txInput(), nonce: BigInt(Number.MAX_SAFE_INTEGER), gas: uint256Max,
      maxFeePerGas: uint256Max, maxPriorityFeePerGas: uint256Max };
    await assertTx(key, 84532, input as unknown as ReturnType<typeof txInput>);
  });
  it("transaction nonce accepts Number.MAX_SAFE_INTEGER and preserves it in the parsed transaction", async () => {
    await assertTx(key, 84532, { ...txInput(), nonce: Number.MAX_SAFE_INTEGER });
  });
});

describe("operator signing rejects caller control of fixed signing fields", () => {
  for (const [field, value] of [
    ["domain", { name: "Caller domain", verifyingContract: getAddress(`0x${"cd".repeat(20)}`) }],
    ["name", "Caller domain"], ["version", "3"],
    ["verifyingContract", getAddress(`0x${"cd".repeat(20)}`)],
    ["types", { WrongType: [] }], ["primaryType", "WrongType"], ["chainId", 31337],
  ] as const) {
    it(`D1 refuses caller-supplied ${field}`, async () => {
      await closedRefusal(() => key.signD1({ ...d1Input(), [field]: value } as never), "bad_input");
    });
  }
  for (const [field, value] of [
    ["to", getAddress(`0x${"cd".repeat(20)}`)], ["data", "0x1234"], ["value", 1n],
    ["chainId", 31337], ["type", "legacy"], ["accessList", []], ["gasPrice", 1n],
  ] as const) {
    it(`transaction refuses caller-supplied ${field}`, async () => {
      await closedRefusal(() => key.signSubmitEvidenceTx({ ...txInput(), [field]: value } as never), "bad_input");
    });
  }
  for (const method of ["signD1", "signSubmitEvidenceTx"] as const) {
    const input = method === "signD1" ? d1Input : txInput;
    it(`${method} refuses symbol fields`, async () => {
      await closedRefusal(() => key[method]({ ...input(), [Symbol("caller control")]: privateKey } as never), "bad_input");
    });
    it(`${method} refuses inherited fields`, async () => {
      const inherited = Object.assign(Object.create({ forbidden: privateKey }), input());
      await closedRefusal(() => key[method](inherited), "bad_input");
    });
    it(`${method} refuses accessor fields without executing their getters`, async () => {
      const getter = vi.fn(() => { throw new Error(privateKey); });
      const candidate = { ...input() };
      Object.defineProperty(candidate, "escrow", { enumerable: true, get: getter });
      await closedRefusal(() => key[method](candidate as never), "bad_input");
      expect(getter).not.toHaveBeenCalled();
    });
    it(`${method} refuses missing and non-enumerable fields`, async () => {
      const missing = { ...input() } as Record<string, unknown>;
      delete missing.escrow;
      await closedRefusal(() => key[method](missing as never), "bad_input");
      const nonEnumerable = { ...input() };
      Object.defineProperty(nonEnumerable, "escrow", { value: nonEnumerable.escrow, enumerable: false });
      await closedRefusal(() => key[method](nonEnumerable as never), "bad_input");
    });
    it(`${method} refuses non-object inputs`, async () => {
      for (const candidate of [null, undefined, [], privateKey, 1, true]) {
        await closedRefusal(() => key[method](candidate as never), "bad_input");
      }
    });
  }
});

describe("operator signing validates every authorized field with closed errors", () => {
  for (const method of ["signD1", "signSubmitEvidenceTx"] as const) {
    const input = method === "signD1" ? d1Input : txInput;
    it(`${method} refuses the zero escrow address before signing`, async () => {
      await closedRefusal(() => key[method]({ ...input(), escrow: zeroAddress } as never), "bad_escrow");
    });
    it(`${method} requires the escrow's checksum and exact address shape`, async () => {
      const checksum = input().escrow;
      expect(checksum).not.toBe(checksum.toLowerCase());
      for (const escrow of [checksum.toLowerCase(), checksum.toUpperCase(), `${checksum} `,
        "0x", `0x${"gg".repeat(20)}`, privateKey, null, 1]) {
        await closedRefusal(() => key[method]({ ...input(), escrow } as never), "bad_escrow");
      }
    });
  }
  for (const field of ["settlementUnitId", "jobIdHash", "stepId", "compositionRoot", "acceptedEnvelopeHash", "packageBodyHash"] as const) {
    it(`D1 validates ${field} as exactly lowercase bytes32`, async () => {
      const original = d1Input()[field];
      for (const malformed of [`0x${original.slice(2).toUpperCase()}`, original.slice(0, -2),
        `${original}00`, `0X${original.slice(2)}`, `0x${"gg".repeat(32)}`, null, 1]) {
        await closedRefusal(() => key.signD1({ ...d1Input(), [field]: malformed } as never), "bad_bytes32");
      }
    });
  }
  for (const field of ["unitId", "packageDigest"] as const) {
    it(`transaction validates ${field} as exactly lowercase bytes32`, async () => {
      const original = txInput()[field];
      for (const malformed of [`0x${original.slice(2).toUpperCase()}`, original.slice(0, -2),
        `${original}00`, `0X${original.slice(2)}`, `0x${"gg".repeat(32)}`, null, 1]) {
        await closedRefusal(() => key.signSubmitEvidenceTx({ ...txInput(), [field]: malformed } as never), "bad_bytes32");
      }
    });
  }
  it("transaction refuses the zero package digest before signing", async () => {
    await closedRefusal(() => key.signSubmitEvidenceTx({ ...txInput(), packageDigest: `0x${"00".repeat(32)}` }),
      "zero_package_digest");
  });
  const invalidIntegers = [-1, -1n, 1.5, Number.NaN, Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1, "1", null, undefined, true, uint256Max + 1n];
  it("D1 milestoneIndex refuses unsafe, negative, non-integer and over-uint256 values", async () => {
    for (const milestoneIndex of invalidIntegers) {
      await closedRefusal(() => key.signD1({ ...d1Input(), milestoneIndex } as never), "bad_integer");
    }
  });
  for (const field of ["nonce", "gas", "maxFeePerGas", "maxPriorityFeePerGas"] as const) {
    it(`transaction ${field} refuses unsafe, negative, non-integer and out-of-range values`, async () => {
      for (const malformed of invalidIntegers) {
        await closedRefusal(() => key.signSubmitEvidenceTx({ ...txInput(), [field]: malformed } as never), "bad_integer");
      }
    });
  }
  it("transaction nonce refuses 2**53 as a number with bad_integer", async () => {
    await closedRefusal(() => key.signSubmitEvidenceTx({ ...txInput(), nonce: 2 ** 53 }), "bad_integer");
  });
  it("transaction nonce refuses 2n**53n as a bigint with bad_integer", async () => {
    await closedRefusal(() => key.signSubmitEvidenceTx({ ...txInput(), nonce: 2n ** 53n }), "bad_integer");
  });
  it("load binds only the two supported host chains", async () => {
    for (const chainId of [0, 1, -1, 84532n, "84532", Number.NaN, undefined, null]) {
      let caught: unknown;
      try { await loadOperatorKey(keyPath, chainId as never, { now }); } catch (error) { caught = error; }
      expect(caught instanceof KeyFileError).toBe(true);
      const error = caught as KeyFileError;
      expect(error.code).toBe("bad_chain");
      expect(error.message).toBe(`bad_chain: ${keyPath}`);
      expect(Object.hasOwn(error, "cause")).toBe(false);
      noLeak(error, privateKey);
    }
  });
  it("errors and logs expose no key material, input values or causes", async () => {
    const logging = ["log", "info", "warn", "error", "debug"] as const;
    const spies = logging.map((method) => vi.spyOn(console, method).mockImplementation(() => {}));
    await closedRefusal(() => key.signD1({ ...d1Input(), escrow: privateKey }), "bad_escrow");
    await closedRefusal(() => key.signSubmitEvidenceTx({ ...txInput(), nonce: privateKey } as never), "bad_integer");
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
  it("library signing failures discard untrusted messages and causes without logging", async () => {
    const logging = ["log", "info", "warn", "error", "debug"] as const;
    const spies = logging.map((method) => vi.spyOn(console, method).mockImplementation(() => {}));
    signerFailure.enabled = true;
    await closedRefusal(() => key.signD1(d1Input()), "signing_failed");
    await closedRefusal(() => key.signSubmitEvidenceTx(txInput()), "signing_failed");
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});
