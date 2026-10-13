import { inspect } from "node:util";
import { createPrivateKey, sign } from "node:crypto";
import { makeKernelEd25519Signer } from "./kernel-signer.js";
import { getAddress, type Address, type Hex, type LocalAccount } from "viem";
import type { SessionKey } from "@pcc/spec";
import { privateKeyToAccount } from "viem/accounts";
import {
  DeviceSigningError, delegationParent, prepareDelegation, prepareD2,
  type DelegationInput, type DeviceDelegationBinding,
} from "./device-signing.js";
export { DeviceSigningError } from "./device-signing.js";
export type { DelegationInput, DeviceDelegationBinding, DeviceSigningErrorCode } from "./device-signing.js";
import {
  OperatorSigningError, prepareD1, prepareSubmitEvidenceTx,
  type D1Input, type OperatorChainId, type SubmitEvidenceTxInput,
} from "./operator-signing.js";
export { OperatorSigningError } from "./operator-signing.js";
export type { D1Input, OperatorChainId, OperatorSigningErrorCode, SubmitEvidenceTxInput } from "./operator-signing.js";
import {
  readSecretFile,
  SecretFileError,
  type SecretFileErrorCode,
  type SecretFileOptions,
} from "./secret-file.js";

export type KeyFileErrorCode = SecretFileErrorCode | "bad_json" | "bad_schema" |
  "wrong_kind" | "public_mismatch" | "bad_key" | "expired" | "bad_chain";

type KeyField = "object" | "unknown_field" | "kind" | "version" | "algorithm" |
  "purpose" | "createdAt" | "notAfter" | "publicKey" | "seed" | "address" | "privateKey";

/** Contains only trusted labels, never parser errors, values, or causes. */
export class KeyFileError extends Error {
  readonly code: KeyFileErrorCode;
  readonly path: string;
  readonly field?: KeyField;

  constructor(code: KeyFileErrorCode, path: string, field?: KeyField) {
    super(`${code}: ${path}${code === "bad_schema" && field !== undefined ? ` (${field})` : ""}`);
    this.name = "KeyFileError";
    this.code = code;
    this.path = path;
    this.field = field;
  }
}

export interface KeyLoadOptions extends SecretFileOptions {
  now?: Date;
}

export interface DeviceKeyLoadOptions extends KeyLoadOptions {
  /** Omit for public-identity checks; delegation signing then fails closed. */
  delegationBinding?: DeviceDelegationBinding;
}

/** Public identity, delegation signing and guarded raw32 signing; private material stays in closures. */
export interface DeviceKey {
  readonly publicKeyHex: string;
  readonly signingPublicKey: string;
  readonly signDelegation: (input: DelegationInput) => Promise<Hex>;
  readonly signD2: (packageBodyHash: Uint8Array | string) => Promise<Hex>;
  toJSON(): { kind: "pcc-printhost.device-key"; publicKey: string };
  toString(): string;
  [inspect.custom](): string;
}

const deviceKeyPrototype = Object.freeze(Object.assign(Object.create(null), {
  toJSON(this: DeviceKey) { return { kind: "pcc-printhost.device-key", publicKey: this.signingPublicKey }; },
  toString(this: DeviceKey) { return `[DeviceKey ${this.signingPublicKey}]`; },
  [inspect.custom](this: DeviceKey) { return this.toString(); },
}));

function deviceKey(seed: Buffer, publicKeyHex: string, signingPublicKey: string,
  parent: SessionKey["parentAgentId"] | undefined): DeviceKey {
  // RFC 8410 PKCS#8 prefix for a raw Ed25519 seed; this temporary copy is erased.
  const encoded = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
  let privateKey;
  try { privateKey = createPrivateKey({ key: encoded, format: "der", type: "pkcs8" }); }
  finally { encoded.fill(0); }
  return Object.freeze(Object.assign(Object.create(deviceKeyPrototype), {
    publicKeyHex, signingPublicKey,
    async signDelegation(input: DelegationInput): Promise<Hex> {
      const preimage = prepareDelegation(input, parent, publicKeyHex);
      try { return `0x${sign(null, preimage, privateKey).toString("hex")}`; }
      catch { throw new DeviceSigningError("signing_failed"); }
    },
    async signD2(packageBodyHash: Uint8Array | string): Promise<Hex> {
      const preimage = prepareD2(packageBodyHash);
      try { return `0x${sign(null, preimage, privateKey).toString("hex")}`; }
      catch { throw new DeviceSigningError("signing_failed"); }
    },
  })) as DeviceKey;
}

/** D1 and submitEvidence live here; #620 adds JobPolicy acceptance. WP-A remains open. */
export interface OperatorKey {
  readonly address: Address;
  readonly signD1: (input: D1Input) => Promise<Hex>;
  readonly signSubmitEvidenceTx: (input: SubmitEvidenceTxInput) => Promise<Hex>;
  toJSON(): { kind: "pcc-printhost.operator-key"; address: Address };
  toString(): string;
  [inspect.custom](): string;
}

// No inherited constructor function or mutable prototype can expose a wider API.
const operatorKeyPrototype = Object.freeze(Object.assign(Object.create(null), {
  toJSON(this: OperatorKey) { return { kind: "pcc-printhost.operator-key", address: this.address }; },
  toString(this: OperatorKey) { return `[OperatorKey ${this.address}]`; },
  [inspect.custom](this: OperatorKey) { return this.toString(); },
}));

function operatorKey(account: LocalAccount, chainId: OperatorChainId): OperatorKey {
  return Object.freeze(Object.assign(Object.create(operatorKeyPrototype), {
    address: account.address,
    async signD1(input: D1Input): Promise<Hex> {
      const typedData = prepareD1(input, chainId);
      try { return await account.signTypedData(typedData); }
      catch { throw new OperatorSigningError("signing_failed"); }
    },
    async signSubmitEvidenceTx(input: SubmitEvidenceTxInput): Promise<Hex> {
      const transaction = prepareSubmitEvidenceTx(input, chainId);
      try { return await account.signTransaction(transaction); }
      catch { throw new OperatorSigningError("signing_failed"); }
    },
  })) as OperatorKey;
}

/** UTC timestamps with seconds; rejects Date.parse's normalization of invalid days. */
export function isUtcTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)) return false;
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) && timestamp.toISOString().slice(0, 19) === value.slice(0, 19);
}

const commonFields = ["kind", "version", "algorithm", "purpose", "createdAt", "notAfter"];

function schemaError(path: string, field: KeyField): never {
  throw new KeyFileError("bad_schema", path, field);
}

function parseObject(bytes: Buffer, path: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")); }
  catch { throw new KeyFileError("bad_json", path); }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) schemaError(path, "object");
  return parsed as Record<string, unknown>;
}

function checkCommon(record: Record<string, unknown>, path: string, kind: string,
  algorithm: string, extraFields: string[], now: Date): void {
  if (record.kind !== kind) throw new KeyFileError("wrong_kind", path);
  const allowed = new Set([...commonFields, ...extraFields]);
  if (Object.keys(record).some((key) => !allowed.has(key))) schemaError(path, "unknown_field");
  if (record.version !== 1) schemaError(path, "version");
  if (record.algorithm !== algorithm) schemaError(path, "algorithm");
  if (typeof record.purpose !== "string" || record.purpose.length === 0) schemaError(path, "purpose");
  if (!isUtcTimestamp(record.createdAt)) schemaError(path, "createdAt");
  if (Object.hasOwn(record, "notAfter")) {
    if (!isUtcTimestamp(record.notAfter)) schemaError(path, "notAfter");
    if (now.getTime() > new Date(record.notAfter).getTime()) throw new KeyFileError("expired", path);
  }
  if (!Number.isFinite(now.getTime())) throw new KeyFileError("bad_key", path);
}

async function keyBytes(path: string, options: KeyLoadOptions): Promise<Buffer> {
  try { return await readSecretFile(path, options); }
  catch (error) {
    if (error instanceof SecretFileError) throw new KeyFileError(error.code, path);
    throw new KeyFileError("read_failed", path);
  }
}

export async function loadDeviceKey(path: string, options: DeviceKeyLoadOptions = {}): Promise<DeviceKey> {
  const parent = delegationParent(options.delegationBinding);
  const bytes = await keyBytes(path, options);
  let seed: Buffer | undefined;
  try {
    const record = parseObject(bytes, path);
    checkCommon(record, path, "pcc-printhost.device-key", "ed25519", ["publicKey", "seed"], options.now ?? new Date());
    if (typeof record.publicKey !== "string" || !/^0x[0-9a-f]{64}$/.test(record.publicKey)) schemaError(path, "publicKey");
    if (typeof record.seed !== "string" || !/^[0-9a-f]{64}$/.test(record.seed)) schemaError(path, "seed");
    seed = Buffer.from(record.seed, "hex");
    // Never retain the kernel signer object: its secretKey property is inspectable.
    const { publicKeyHex, signingPublicKey, secretKey } = makeKernelEd25519Signer(seed);
    try {
      if (signingPublicKey !== record.publicKey) throw new KeyFileError("public_mismatch", path);
      return deviceKey(seed, publicKeyHex, signingPublicKey, parent);
    } finally { secretKey.fill(0); }
  } catch (error) {
    if (error instanceof KeyFileError) throw error;
    throw new KeyFileError("bad_key", path);
  } finally {
    seed?.fill(0);
    bytes.fill(0);
  }
}

// The public secp256k1 order, expressed without a key-shaped literal.
const secp256k1Order = (1n << 256n) - BigInt("0x14551231950b75fc4402da1732fc9bebf");

export async function loadOperatorKey(path: string, chainId: OperatorChainId, options: KeyLoadOptions = {}): Promise<OperatorKey> {
  if (chainId !== 84532 && chainId !== 31337) throw new KeyFileError("bad_chain", path);
  const bytes = await keyBytes(path, options);
  try {
    const record = parseObject(bytes, path);
    checkCommon(record, path, "pcc-printhost.operator-key", "secp256k1", ["address", "privateKey"], options.now ?? new Date());
    if (typeof record.address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(record.address)) schemaError(path, "address");
    try {
      if (getAddress(record.address) !== record.address) schemaError(path, "address");
    } catch { schemaError(path, "address"); }
    if (typeof record.privateKey !== "string" || !/^0x[0-9a-f]{64}$/.test(record.privateKey)) schemaError(path, "privateKey");
    const scalar = BigInt(record.privateKey);
    if (scalar <= 0n || scalar >= secp256k1Order) throw new KeyFileError("bad_key", path);
    const account = privateKeyToAccount(record.privateKey as `0x${string}`);
    if (account.address.toLowerCase() !== record.address.toLowerCase()) throw new KeyFileError("public_mismatch", path);
    return operatorKey(account, chainId);
  } catch (error) {
    if (error instanceof KeyFileError) throw error;
    throw new KeyFileError("bad_key", path);
  } finally {
    bytes.fill(0);
  }
}
