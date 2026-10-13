import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
import type { JobPolicyFields, UnitConfig } from "@pcc/contracts/vnext";
import type { HostTerms, JobPolicyAcceptanceInput } from "./keys.js";
import { OperatorSigningError, validateHostTerms } from "./operator-signing.js";

export type PolicyJsonErrorCode = "not_absolute" | "not_found" | "symlink" | "not_regular_file"
  | "bad_owner" | "bad_mode" | "too_large" | "changed_during_open" | "read_failed" | "bad_json";

export interface HostTermsLoadOptions { expectedUid?: number }

/** Carries no file name, JSON value, parser details, or underlying exception. */
export class PolicyJsonError extends Error {
  readonly code: PolicyJsonErrorCode;
  constructor(code: PolicyJsonErrorCode) {
    super(code);
    this.name = "PolicyJsonError";
    this.code = code;
  }
}

const decimal = z.string().max(78).regex(/^(0|[1-9][0-9]*)$/).transform((value) => BigInt(value));
const integer = z.number().int().nonnegative().safe();
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((value) => value as `0x${string}`);
const bytes32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform((value) => value as `0x${string}`);

// The wire form uses decimal strings wherever the canonical compiler uses bigint.
const policySchema = z.object({
  chainId: decimal, factory: address, implementation: address, escrow: address,
  payer: address, operator: address, jobIdHash: bytes32, termsHash: bytes32,
  policyNonce: decimal, prePolicyRoot: bytes32, unitsRoot: bytes32,
  expiry: decimal, acceptedPolicyDigest: bytes32,
}).strict();
const unitSchema = z.object({
  milestoneIndex: decimal, stepId: bytes32, requiredTier: integer, requestedTier: integer,
  g: decimal, f: decimal, n: decimal, feeBps: integer, feeRecipient: address,
  reclaimAt: decimal, compositionSchemaVersion: integer, compositionRoot: bytes32,
  payouts: z.array(z.object({ recipient: address, amount: decimal }).strict()),
}).strict();
const inputSchema = z.object({ policy: policySchema, units: z.array(unitSchema) }).strict();
const termsSchema = z.object({
  factory: address, implementation: address,
  minG: decimal, allowedRequiredTiers: z.array(integer),
  reclaimMinSeconds: integer, reclaimMaxSeconds: integer, maxFeeBps: integer,
  allowedFeeRecipients: z.array(address), allowedPayoutRecipients: z.array(address).nonempty(),
  operatorPayoutRecipient: address, maxPassThrough: decimal,
  maxUnits: integer, maxAcceptanceSeconds: integer,
}).strict();

async function readJson(path: string, maxBytes: number, expectedUid?: number): Promise<unknown> {
  if (typeof path !== "string" || !isAbsolute(path)) throw new PolicyJsonError("not_absolute");
  let before;
  try { before = await lstat(path); }
  catch (error) {
    const missing = typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
    throw new PolicyJsonError(missing ? "not_found" : "read_failed");
  }
  if (before.isSymbolicLink()) throw new PolicyJsonError("symlink");
  if (!before.isFile()) throw new PolicyJsonError("not_regular_file");
  if (expectedUid !== undefined) {
    if (before.uid !== expectedUid) throw new PolicyJsonError("bad_owner");
    if ((before.mode & 0o022) !== 0) throw new PolicyJsonError("bad_mode");
  }
  if (before.size > maxBytes) throw new PolicyJsonError("too_large");
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NOCTTY | constants.O_NONBLOCK); }
  catch { throw new PolicyJsonError("read_failed"); }
  const bytes = Buffer.alloc(maxBytes + 1);
  try {
    const opened = await file.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino) throw new PolicyJsonError("changed_during_open");
    if (!opened.isFile()) throw new PolicyJsonError("not_regular_file");
    if (expectedUid !== undefined) {
      if (opened.uid !== expectedUid) throw new PolicyJsonError("bad_owner");
      if ((opened.mode & 0o022) !== 0) throw new PolicyJsonError("bad_mode");
    }
    if (opened.size > maxBytes) throw new PolicyJsonError("too_large");
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > maxBytes) throw new PolicyJsonError("too_large");
    try { return JSON.parse(bytes.subarray(0, length).toString("utf8")) as unknown; }
    catch { throw new PolicyJsonError("bad_json"); }
  } catch (error) {
    if (error instanceof PolicyJsonError) throw error;
    throw new PolicyJsonError("read_failed");
  } finally {
    bytes.fill(0);
    await file.close().catch(() => undefined);
  }
}

export async function loadJobPolicyInput(path: string): Promise<JobPolicyAcceptanceInput> {
  const parsed = inputSchema.safeParse(await readJson(path, 1024 * 1024));
  if (!parsed.success) throw new OperatorSigningError("bad_input");
  // These annotations bind the JSON schema to the compiler's exported types.
  const policy: JobPolicyFields = parsed.data.policy;
  const units: UnitConfig[] = parsed.data.units;
  return { policy, units };
}

export async function loadHostTerms(path: string, options: HostTermsLoadOptions = {}): Promise<HostTerms> {
  if (typeof path !== "string" || !isAbsolute(path)) throw new PolicyJsonError("not_absolute");
  const expectedUid = options.expectedUid ?? process.getuid?.();
  if (expectedUid === undefined || !Number.isSafeInteger(expectedUid) || expectedUid < 0) {
    throw new PolicyJsonError("bad_owner");
  }
  const parsed = termsSchema.safeParse(await readJson(path, 64 * 1024, expectedUid));
  if (!parsed.success) throw new OperatorSigningError("bad_terms");
  return validateHostTerms(parsed.data);
}
