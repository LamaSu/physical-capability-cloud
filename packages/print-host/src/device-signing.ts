import { sessionKeyDelegationPreimage, type SessionKey } from "@pcc/spec";
import { getAddress, type Address } from "viem";
import type { OperatorChainId } from "./operator-signing.js";

export type DeviceSigningErrorCode = "bad_input" | "bad_binding" | "bad_job" |
  "bad_session" | "bad_public_key" | "bad_scope" | "bad_time" |
  "bad_signature_count" | "bad_parent" | "bad_bytes32" | "forbidden_protocol" | "signing_failed";

/** Only a closed code survives a validation or crypto failure. */
export class DeviceSigningError extends Error {
  readonly code: DeviceSigningErrorCode;
  constructor(code: DeviceSigningErrorCode) {
    super(code);
    this.name = "DeviceSigningError";
    this.code = code;
  }
}

/** Host identity fixed at load time; callers cannot change it while signing. */
export interface DeviceDelegationBinding {
  chainId: OperatorChainId;
  operator: Address;
}

/** LO-EV-1 fields plus the funded unit's timing and finalized event count. Times are Unix seconds. */
export interface DelegationInput extends Omit<SessionKey, "parentSignature" | "derivationPath"> {
  jobId: string;
  fundedAt: number;
  reclaimAt: number;
  firstEventAt: number;
  eventCount: number;
}

function record(input: unknown, fields: readonly string[]): Record<string, unknown> {
  try {
    if (input === null || typeof input !== "object") throw new Error();
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== null && prototype !== Object.prototype) throw new Error();
    const names = Reflect.ownKeys(input);
    if (names.length !== fields.length || names.some((name) => typeof name !== "string" || !fields.includes(name))) throw new Error();
    const result: Record<string, unknown> = Object.create(null);
    for (const field of fields) {
      const descriptor = Object.getOwnPropertyDescriptor(input, field);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw new Error();
      result[field] = descriptor.value;
    }
    return result;
  } catch { throw new DeviceSigningError("bad_input"); }
}

function stringArray(input: unknown): string[] {
  try {
    if (!Array.isArray(input) || input.length > 2) throw new Error();
    const result: string[] = [];
    for (let index = 0; index < input.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
      if (!descriptor || !Object.hasOwn(descriptor, "value") || typeof descriptor.value !== "string") throw new Error();
      result.push(descriptor.value);
    }
    return result;
  } catch { throw new DeviceSigningError("bad_scope"); }
}

export function delegationParent(binding: DeviceDelegationBinding | undefined): SessionKey["parentAgentId"] | undefined {
  if (binding === undefined) return undefined;
  try {
    const checked = record(binding, ["chainId", "operator"]);
    if (checked.chainId !== 84532 && checked.chainId !== 31337) throw new Error();
    if (typeof checked.operator !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(checked.operator)) throw new Error();
    return `eip155:${checked.chainId}:${getAddress(checked.operator).toLowerCase()}` as SessionKey["parentAgentId"];
  } catch { throw new DeviceSigningError("bad_binding"); }
}

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function timestampInRange(value: number): boolean {
  return value >= 1_600_000_000 && value < 2 ** 32;
}

function seconds(value: unknown): value is number {
  return count(value) && timestampInRange(value);
}

const fieldPrime = (1n << 255n) - 19n;
function mod(value: bigint): bigint { return (value % fieldPrime + fieldPrime) % fieldPrime; }
function power(base: bigint, exponent: bigint): bigint {
  let result = 1n;
  for (; exponent > 0n; exponent >>= 1n, base = mod(base * base)) {
    if (exponent & 1n) result = mod(result * base);
  }
  return result;
}
const curveD = mod(-121665n * power(121666n, fieldPrime - 2n));
const sqrtMinusOne = power(2n, (fieldPrime - 1n) / 4n);

/** RFC 8032 compressed point: canonical y, an on-curve x, and no small-order key. */
function wellFormedPublicKey(bytes: Uint8Array): boolean {
  let encoded = 0n;
  for (let index = 31; index >= 0; index--) encoded = (encoded << 8n) | BigInt(bytes[index]);
  const signBit = encoded >> 255n;
  let y = encoded & ((1n << 255n) - 1n);
  if (y >= fieldPrime) return false;
  const ySquared = mod(y * y);
  const denominator = mod(curveD * ySquared + 1n);
  if (denominator === 0n) return false;
  const xSquared = mod((ySquared - 1n) * power(denominator, fieldPrime - 2n));
  let x = power(xSquared, (fieldPrime + 3n) / 8n);
  if (mod(x * x) !== xSquared) x = mod(x * sqrtMinusOne);
  if (mod(x * x) !== xSquared || (x === 0n && signBit === 1n)) return false;
  if ((x & 1n) !== signBit) x = mod(-x);
  // Three projective Edwards doublings test [8]P without inversions or secret inputs.
  let z = 1n;
  for (let count = 0; count < 3; count++) {
    const a = mod(x * x), b = mod(y * y), c = mod(2n * z * z), d = mod(-a);
    const e = mod((x + y) * (x + y) - a - b), g = mod(d + b), f = mod(g - c), h = mod(d - b);
    x = mod(e * f);
    y = mod(g * h);
    z = mod(f * g);
  }
  return !(x === 0n && mod(y - z) === 0n);
}

export function prepareDelegation(input: DelegationInput, parent: SessionKey["parentAgentId"] | undefined, devicePublicKeyHex: string): Uint8Array {
  if (parent === undefined) throw new DeviceSigningError("bad_binding");
  const checked = record(input, ["sessionId", "parentAgentId", "publicKey", "issuedAt", "expiresAt", "scope",
    "jobId", "fundedAt", "reclaimAt", "firstEventAt", "eventCount"]);
  if (typeof checked.jobId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(checked.jobId)) {
    throw new DeviceSigningError("bad_job");
  }
  if (typeof checked.sessionId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(checked.sessionId)) {
    throw new DeviceSigningError("bad_session");
  }
  if (checked.parentAgentId !== parent) throw new DeviceSigningError("bad_parent");
  let publicKey: Uint8Array;
  try {
    if (!(checked.publicKey instanceof Uint8Array)) throw new Error();
    publicKey = new Uint8Array(checked.publicKey);
    if (publicKey.length !== 32 || !wellFormedPublicKey(publicKey) ||
      Buffer.from(publicKey).toString("hex") === devicePublicKeyHex) throw new Error();
  } catch { throw new DeviceSigningError("bad_public_key"); }
  const scope = record(checked.scope, ["allowedActions", "contractIds", "maxSignatures"]);
  const contractIds = stringArray(scope.contractIds);
  if (contractIds.length !== 1 || contractIds[0] !== checked.jobId) throw new DeviceSigningError("bad_scope");
  const allowedActions = stringArray(scope.allowedActions);
  // The protocol set is fixed, even if another importer changes the spec's mutable defaults.
  if (allowedActions.length !== mvpActions.length || new Set(allowedActions).size !== mvpActions.length ||
    allowedActions.some((action) => !mvpActions.includes(action))) throw new DeviceSigningError("bad_scope");
  if (!seconds(checked.issuedAt) || !seconds(checked.fundedAt) || !seconds(checked.expiresAt) || !seconds(checked.reclaimAt) ||
    typeof checked.firstEventAt !== "number" || !Number.isFinite(checked.firstEventAt) || !timestampInRange(checked.firstEventAt) ||
    checked.fundedAt > checked.issuedAt || checked.issuedAt > checked.firstEventAt ||
    checked.expiresAt !== checked.reclaimAt || checked.expiresAt <= checked.issuedAt) throw new DeviceSigningError("bad_time");
  if (!count(scope.maxSignatures) || scope.maxSignatures < 1 || scope.maxSignatures > 1000 ||
    !count(checked.eventCount) || checked.eventCount !== scope.maxSignatures) throw new DeviceSigningError("bad_signature_count");
  try {
    return sessionKeyDelegationPreimage({
      sessionId: checked.sessionId, parentAgentId: parent, publicKey,
      issuedAt: checked.issuedAt, expiresAt: checked.expiresAt,
      scope: { allowedActions: allowedActions as SessionKey["scope"]["allowedActions"], contractIds, maxSignatures: scope.maxSignatures },
    });
  } catch { throw new DeviceSigningError("bad_input"); }
}

// packages/spec/src/identity/ephemeral.ts: DEFAULT_SESSION_KEY_CONFIG's MVP actions.
const mvpActions: readonly string[] = Object.freeze(["evidence_submit", "workflow_step_complete"]);

const forbiddenD2Prefixes = Object.freeze([
  Buffer.from("pcc-kernel-signing-key:", "utf8"),
  Buffer.from("sha256:", "utf8"),
]);

/** D2 signs caller-supplied raw32, excluding kernel-registration challenges and log-entry hashes. */
export function prepareD2(input: Uint8Array | string): Uint8Array {
  let bytes: Uint8Array;
  try {
    if (typeof input === "string") {
      if (!/^0x[0-9a-f]{64}$/.test(input)) throw new Error();
      bytes = Buffer.from(input.slice(2), "hex");
    } else {
      if (!(input instanceof Uint8Array)) throw new Error();
      bytes = new Uint8Array(input);
    }
    if (bytes.length !== 32) throw new Error();
  } catch { throw new DeviceSigningError("bad_bytes32"); }
  if (forbiddenD2Prefixes.some((prefix) => prefix.every((byte, index) => bytes[index] === byte))) {
    throw new DeviceSigningError("forbidden_protocol");
  }
  return bytes;
}
