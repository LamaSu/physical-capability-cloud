/**
 * Activity idempotency key derivation — 3-tier fallback.
 *
 * See design §6.1 for general activity keys and §6.2 for the
 * dedicated on-chain semantic key (delegates to deriveOnchainOpKey).
 *
 * IMPORTANT (design §8.2 + §12 risk #2):
 *   The `attempt` slot in the on-chain semantic key is a fencing token,
 *   managed by the watchdog — NOT the per-retry counter. Handlers MUST NOT
 *   pass `ctx.attempt` to deriveOnchainOpKey — it hardcodes attempt=1n
 *   by default, which is what the smart contract's executedOps mapping
 *   expects. The attempt field only bumps when a stuck-processing row is
 *   explicitly reclaimed via IdempotencyStore.reclaim().
 */

import type { CanonicalInput } from '../shared/types.js';
import { canonicalJSONStrict } from '../shared/canonical-json.js';
import { sha256Hex, keccak256Hex } from '../shared/hash.js';

/** Context needed to derive a general activity key. */
export interface ActivityKeyDerivationContext {
  readonly activityName: string;
  readonly workflowRunId: string;
  readonly args: CanonicalInput;
  /** Engine-managed retry attempt — currently always 1 for a single activity invocation. */
  readonly attemptNumber: number;
  /**
   * Actor-scoped client-provided Idempotency-Key header value (Stripe-style).
   * When present, this short-circuits the derivation and returns a client key
   * with an http: scope.
   */
  readonly clientProvidedKey?: string;
  readonly actorId?: string;
  readonly httpMethod?: string;
  readonly httpPath?: string;
}

export interface ActivityKey {
  key: string;
  scope: string;
}

/**
 * General activity idempotency key derivation (design §6.1).
 *   1. If clientProvidedKey is set, honor it with an http: scope.
 *   2. Otherwise content-address: sha256(canonicalJSON({ activityName, args, workflowRunId, attemptNumber })).
 */
export function deriveActivityKey(ctx: ActivityKeyDerivationContext): ActivityKey {
  if (ctx.clientProvidedKey) {
    const method = ctx.httpMethod ?? 'POST';
    const path = ctx.httpPath ?? '/unknown';
    const actor = ctx.actorId ?? 'system';
    return {
      key: ctx.clientProvidedKey,
      scope: `http:${actor}:${method}:${path}`,
    };
  }

  const canonical = canonicalJSONStrict({
    activityName: ctx.activityName,
    args: ctx.args,
    workflowRunId: ctx.workflowRunId,
    attemptNumber: ctx.attemptNumber,
  });
  const key = sha256Hex(canonical);
  return { key, scope: `workflow:activity:${ctx.activityName}` };
}

// ── On-chain semantic key (escrow) ────────────────────────────────────────

/**
 * Encode ABI arguments for the on-chain semantic key (design §6.2).
 *
 * This is a minimal, dependency-free encoding that mirrors solidityABIEncode
 * just for the (bytes32, uint256, string, uint256) shape used by the
 * MilestoneEscrow contract. Produces a deterministic byte sequence suitable
 * for keccak256.
 *
 * For more general ABI encoding, callers should use viem — we include this
 * minimal version so @pcc/workflow has zero runtime deps beyond what's
 * already declared in package.json.
 */
export function encodeOnchainOpArgs(args: {
  jobId: `0x${string}`;
  milestoneIdx: number | bigint;
  action: string;
  attempt: number | bigint;
}): Uint8Array {
  const milestoneIdx = typeof args.milestoneIdx === 'bigint' ? args.milestoneIdx : BigInt(args.milestoneIdx);
  const attempt = typeof args.attempt === 'bigint' ? args.attempt : BigInt(args.attempt);

  // Solidity layout for this signature (all static head + one dynamic tail):
  //   [0  .. 32)   jobId (bytes32, padded full 32 bytes)
  //   [32 .. 64)   milestoneIdx (uint256)
  //   [64 .. 96)   offset to action bytes (== 128)
  //   [96 .. 128)  attempt (uint256)
  //   [128.. 160)  action length (uint256)
  //   [160.. ...)  action bytes, zero-padded to 32-byte boundary
  const jobIdBytes = hexToBytes(args.jobId);
  if (jobIdBytes.length !== 32) {
    throw new Error(`encodeOnchainOpArgs: jobId must be 32 bytes (bytes32), got ${jobIdBytes.length}`);
  }
  const actionBytes = new TextEncoder().encode(args.action);
  const actionPadded = padRight32(actionBytes);

  const head = new Uint8Array(32 + 32 + 32 + 32);
  head.set(jobIdBytes, 0);
  setUint256BE(head, 32, milestoneIdx);
  setUint256BE(head, 64, 128n); // offset to dynamic tail
  setUint256BE(head, 96, attempt);

  const lenWord = new Uint8Array(32);
  setUint256BE(lenWord, 0, BigInt(actionBytes.length));

  const total = new Uint8Array(head.length + lenWord.length + actionPadded.length);
  total.set(head, 0);
  total.set(lenWord, head.length);
  total.set(actionPadded, head.length + lenWord.length);
  return total;
}

/**
 * Derive the keccak256 semantic key for an on-chain escrow op.
 *
 * Returns the key already wrapped in {key, scope: "onchain:escrow"}.
 *
 * The `attempt` field defaults to 1n — see module-level JSDoc for why
 * handlers MUST NOT pass ctx.attempt here.
 */
export function deriveOnchainOpKey(args: {
  jobId: `0x${string}`;
  milestoneIdx: number | bigint;
  action: string;
  attempt?: number | bigint;
}): ActivityKey {
  const encoded = encodeOnchainOpArgs({
    jobId: args.jobId,
    milestoneIdx: args.milestoneIdx,
    action: args.action,
    attempt: args.attempt ?? 1n,
  });
  const key = keccak256Hex(encoded);
  return { key, scope: 'onchain:escrow' };
}

// ── Internal: hex/uint256 helpers ─────────────────────────────────────────

function hexToBytes(hex: string): Uint8Array {
  let clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) clean = '0' + clean;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function setUint256BE(buf: Uint8Array, offset: number, value: bigint): void {
  let v = value;
  if (v < 0n) throw new Error('setUint256BE: negative values not allowed');
  for (let i = 31; i >= 0; i--) {
    buf[offset + i] = Number(v & 0xffn);
    v >>= 8n;
  }
  if (v !== 0n) {
    throw new Error('setUint256BE: value does not fit in 256 bits');
  }
}

function padRight32(bytes: Uint8Array): Uint8Array {
  const padded = new Uint8Array(Math.ceil(bytes.length / 32) * 32);
  padded.set(bytes, 0);
  return padded;
}
