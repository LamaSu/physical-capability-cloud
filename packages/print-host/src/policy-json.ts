import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { JobPolicyFields, UnitConfig } from "@pcc/contracts/vnext";
import type { HostTerms, JobPolicyAcceptanceInput } from "./keys.js";
import { OperatorSigningError, validateHostTerms } from "./operator-signing.js";

export type PolicyJsonErrorCode = "read_failed" | "too_large" | "bad_json";

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
  minG: decimal, allowedRequiredTiers: z.array(integer),
  reclaimMinSeconds: integer, reclaimMaxSeconds: integer, maxFeeBps: integer,
  allowedFeeRecipients: z.array(address), allowedPayoutRecipients: z.array(address).nonempty(),
  maxUnits: integer, maxAcceptanceSeconds: integer,
}).strict();

async function readJson(path: string): Promise<unknown> {
  let bytes: Buffer;
  try { bytes = await readFile(path); }
  catch { throw new PolicyJsonError("read_failed"); }
  try {
    if (bytes.length > 1024 * 1024) throw new PolicyJsonError("too_large");
    try { return JSON.parse(bytes.toString("utf8")) as unknown; }
    catch { throw new PolicyJsonError("bad_json"); }
  } finally { bytes.fill(0); }
}

export async function loadJobPolicyInput(path: string): Promise<JobPolicyAcceptanceInput> {
  const parsed = inputSchema.safeParse(await readJson(path));
  if (!parsed.success) throw new OperatorSigningError("bad_input");
  // These annotations bind the JSON schema to the compiler's exported types.
  const policy: JobPolicyFields = parsed.data.policy;
  const units: UnitConfig[] = parsed.data.units;
  return { policy, units };
}

export async function loadHostTerms(path: string): Promise<HostTerms> {
  const parsed = termsSchema.safeParse(await readJson(path));
  if (!parsed.success) throw new OperatorSigningError("bad_terms");
  return validateHostTerms(parsed.data);
}
