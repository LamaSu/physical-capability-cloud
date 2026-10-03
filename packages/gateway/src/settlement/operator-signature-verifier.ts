/**
 * createEip712OperatorVerifier — the production D1 (operator) EIP-712 verifier for the
 * FinalMilestonePackageV2 mint guard's injected `OperatorSignatureVerifier` seam
 * (`final-milestone-package-v2.ts`, called from `MintablePackage.assert` after every other
 * check has already passed).
 *
 * Contract: `returns/pcc-evidence-work/d1-eip712-struct-proposal.md` — RATIFIED by the oracle
 * (bus #5773) and escrow (bus #5785), 2026-10-03. Golden vectors: #270 @59f6c45f
 * (`finalmilestonepackage-v2-d1-eip712.vectors.json`), mirrored byte-identical into
 * `src/__tests__/fixtures/finalmilestonepackage-v2-d1-eip712.vectors.json`.
 *
 * The struct (exact field order — the ratified doc wins if this ever drifts from it):
 *   FinalMilestonePackageV2(uint256 chainId,address escrow,bytes32 settlementUnitId,bytes32
 *     jobIdHash,uint256 milestoneIndex,bytes32 stepId,bytes32 compositionRoot,bytes32
 *     acceptedEnvelopeHash,bytes32 packageBodyHash)
 * Domain: EIP712Domain(string name,string version,uint256 chainId,address verifyingContract),
 *   name="PCC FinalMilestonePackage", version="2", chainId=unitBinding.chainId,
 *   verifyingContract=unitBinding.escrow, no salt. `chainId` and `escrow` are deliberately the
 *   SAME fields in both the domain and the struct (the contract doc says so, on purpose): this
 *   verifier has no separate "domain chainId/verifyingContract" input — there is exactly one
 *   chainId and one escrow per unit, and both appearances of each are always equal, by
 *   construction, never independently settable by a caller.
 * Digest: keccak256(0x1901 || domainSeparator || hashStruct(message)) — `viem`'s `hashTypedData`
 *   computes exactly this; EIP-191 (`personal_sign`) stays rejected because this module never
 *   re-wraps anything with the EIP-191 prefix and never recovers against anything but this
 *   digest.
 *
 * ERC-1271 (contract) operators CANNOT MINT under v1. The ratified rule is a 65-byte ECDSA
 * recovery ONLY — the oracle applies exactly the same rule before it signs a verdict.
 * Supporting `isValidSignature` against a clone's `operator()` would be a versioned change
 * that the oracle and escrow must both adopt together; it is not part of this verifier. A
 * contract operator has no ECDSA private key, so no signature it could ever produce passes
 * the 65-byte recovery below — it fails the same way a malformed signature does, not through
 * a distinct code path.
 *
 * `deps.operatorForUnit` is the ONLY chain-reading seam: this module builds no chain client of
 * its own. The AUTHORITATIVE operator for a unit is the escrow CLONE's `operator()`, read at
 * ONE pinned block AFTER the clone is bound (`escrow == fundedEscrowOf(policyKey(payer,
 * operator, jobIdHash))`) — never the funded policy's `operatorSettlementAddress`, which is a
 * payout address, not an identity. Binding the clone and reading the chain are the CALLER's
 * job (the injected function does that); this module only compares the recovered address
 * against whatever `operatorForUnit` answers, and refuses on `null`, a throw or a rejected
 * promise exactly like it refuses a wrong address (rule 5 below).
 *
 * CANONICAL INPUT ONLY (cross-family E13 F1): before anything is encoded, every field is checked
 * against the ratified body's own spellings, the same rules `final-milestone-package-v2.ts`
 * applies before it calls this verifier: chainId and milestoneIndex are canonical decimal strings
 * (no sign, no leading zero, no white space, no 0x/0o/0b, all of which `BigInt` would read),
 * and escrow and the bytes32 fields are lowercase hex. So a spelling the body refuses is refused
 * here too, even when it would encode the same bytes, and the principal id cannot embed one.
 *
 * BOUNDED LOOKUP (cross-family E13 F2): `operatorForUnit` gets an AbortSignal and at most
 * `operatorLookupTimeoutMs` (default 10 s). A lookup that has not settled by then is aborted and
 * refused, so a chain read that never answers cannot hold the mint guard open.
 *
 * FAILS CLOSED, NEVER THROWS: every rule below is a refusal (`verifyOperatorSignature` answers
 * `false`), never an exception. A hostile or malformed `input` of any shape, an
 * `operatorForUnit` that throws, rejects or does not settle in time, a value no rule admits —
 * all of these collapse to one answer, `false`, caught by the single outer try/catch in
 * `verifyOperatorSignature`. The guard (`assertMintablePackage`) already converts
 * a thrown error from this interface into `PackageNotMintableError`, but this implementation
 * does not rely on that safety net — it is designed to never throw in the first place.
 */
import { hashTypedData, recoverAddress, type Hex } from "viem";
import type {
  OperatorSignatureVerifier,
  OperatorSignatureVerifierInput,
  UnitBinding,
} from "./final-milestone-package-v2.js";

/** The ratified struct, in its exact field order — `encodeType` walks fields in THIS order, not
 *  alphabetically, and the typeHash depends on it. */
const TYPES = {
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

const DOMAIN_NAME = "PCC FinalMilestonePackage";
const DOMAIN_VERSION = "2";

/** secp256k1's group order and its floor half — the low-s bound. Matches the golden vectors'
 *  own pinned constants (`finalmilestonepackage-v2-d1-eip712.vectors.json#verification.constants`,
 *  cross-checked there against the house literal already used elsewhere in evidence's goldens). */
const SECP256K1_N = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");
const SECP256K1_N_DIV2 = SECP256K1_N / 2n;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** `0x` + exactly 130 LOWERCASE hex digits: r (64) || s (64) || v (2). Any other spelling — the
 *  wrong length (including the 64-byte EIP-2098 compact form), a `0X` prefix, or any uppercase
 *  hex digit — is refused outright here, never normalized (rule 1). */
const SIG_65_LOWERCASE = /^0x[0-9a-f]{130}$/;

/** The ratified body's own spellings (`final-milestone-package-v2.ts`: DECIMAL, ADDR, HEX32), checked
 *  again here so the verifier is safe on its own (E13 F1). */
const CANONICAL_DECIMAL = /^(0|[1-9][0-9]*)$/;
const LOWERCASE_ADDRESS = /^0x[0-9a-f]{40}$/;
const LOWERCASE_BYTES32 = /^0x[0-9a-f]{64}$/;

/** The default bound on `operatorForUnit` (E13 F2): a pinned-block `operator()` read answers well inside it. */
export const DEFAULT_OPERATOR_LOOKUP_TIMEOUT_MS = 10_000;

const TIMED_OUT: unique symbol = Symbol("operatorForUnit did not settle in time");

/** The injected chain read, and how long it may take. */
export interface Eip712OperatorVerifierDeps {
  /**
   * The AUTHORITATIVE operator for the unit: the escrow clone's `operator()`, read at one pinned
   * block after the clone is bound (see the module doc). `null` means unknown, so the verifier
   * refuses. `options.signal` is aborted when the lookup's bound passes; a lookup should stop then.
   */
  operatorForUnit(unitBinding: UnitBinding, options: { signal: AbortSignal }): Promise<string | null> | string | null;
  /** How long `operatorForUnit` may take, in milliseconds: a positive safe integer. Default 10 000. */
  operatorLookupTimeoutMs?: number;
}

/**
 * Builds the production D1 verifier. `deps.operatorForUnit` is the injected chain read (see the
 * module doc above): given a package's `unitBinding`, it answers the unit's authoritative
 * operator address, or `null` if that is not known — in which case this verifier refuses.
 */
export function createEip712OperatorVerifier(deps: Eip712OperatorVerifierDeps): OperatorSignatureVerifier {
  // Only `undefined` selects the default: `null`, like any other non-number, is refused (E13b).
  const timeoutMs = deps.operatorLookupTimeoutMs === undefined ? DEFAULT_OPERATOR_LOOKUP_TIMEOUT_MS : deps.operatorLookupTimeoutMs;
  if (typeof timeoutMs !== "number" || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("operatorLookupTimeoutMs must be a positive safe integer of milliseconds");
  }
  const operatorForUnit = deps.operatorForUnit;
  return {
    async verifyOperatorSignature(input: OperatorSignatureVerifierInput): Promise<boolean> {
      try {
        return await verify(input, operatorForUnit, timeoutMs);
      } catch {
        // Never throw: a hostile or malformed input (bad hex, a non-decimal chain id, a
        // mis-sized bytes32, `operatorForUnit` throwing or its promise rejecting) all collapse
        // to the same answer, false, exactly like any other refusal below.
        return false;
      }
    },
  };
}

type OperatorForUnit = Eip712OperatorVerifierDeps["operatorForUnit"];

/**
 * `operatorForUnit`'s answer, or TIMED_OUT once `timeoutMs` passes; its signal is aborted then (E13 F2).
 * The deadline is LATCHED before the abort (E13b): abort() runs its listeners synchronously, so a lookup
 * that answers from one (a thenable can settle the race inside abort() itself) answered after the bound,
 * and `expired` turns that answer into TIMED_OUT whichever promise the race saw first. A lookup that
 * answers before the bound settles the race in microtasks, which all run before the timer can fire.
 */
async function lookupOperator(
  operatorForUnit: OperatorForUnit,
  unitBinding: UnitBinding,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => {
      expired = true;
      resolve(TIMED_OUT);
      controller.abort();
    }, timeoutMs);
  });
  try {
    // A synchronous throw becomes a rejection, which the outer try/catch turns into false.
    const lookup = Promise.resolve().then(() => operatorForUnit(unitBinding, { signal: controller.signal }));
    const answer = await Promise.race([lookup, timedOut]);
    return expired ? TIMED_OUT : answer;
  } finally {
    clearTimeout(timer);
  }
}

/** Every field the digest or the principal id uses, in the ratified body's own spelling (E13 F1). */
function isCanonicalBinding(input: OperatorSignatureVerifierInput): boolean {
  const ub = input.unitBinding;
  if (ub === null || typeof ub !== "object") return false;
  const decimals = [ub.chainId, ub.milestoneIndex];
  const words = [ub.settlementUnitId, ub.jobIdHash, ub.stepId, ub.compositionRoot, ub.acceptedEnvelopeHash, input.packageBodyHash];
  return (
    decimals.every((v) => typeof v === "string" && CANONICAL_DECIMAL.test(v)) &&
    typeof ub.escrow === "string" &&
    LOWERCASE_ADDRESS.test(ub.escrow) &&
    words.every((v) => typeof v === "string" && LOWERCASE_BYTES32.test(v))
  );
}

async function verify(
  input: OperatorSignatureVerifierInput,
  operatorForUnit: OperatorForUnit,
  timeoutMs: number,
): Promise<boolean> {
  // Rule 1: exactly 65 bytes, r || s || v, as 0x + 130 lowercase hex. v in {27,28} (0/1, the raw
  // recovery id, is refused even where it would recover the operator — see the v-raw-recid-*
  // golden vectors). 0 < r < n. 0 < s <= n/2 (low-s/canonical only; the 64-byte EIP-2098 compact
  // form has no v byte at all and is refused by the length check alone). All of this is checked
  // BEFORE recovery is ever attempted — never delegated to a library to refuse high-s.
  const sig = input.sig;
  if (typeof sig !== "string" || !SIG_65_LOWERCASE.test(sig)) return false;
  const r = BigInt(`0x${sig.slice(2, 66)}`);
  const s = BigInt(`0x${sig.slice(66, 130)}`);
  const v = Number.parseInt(sig.slice(130, 132), 16);
  if (r === 0n || r >= SECP256K1_N) return false;
  if (s === 0n || s >= SECP256K1_N) return false;
  if (v !== 27 && v !== 28) return false;
  if (s > SECP256K1_N_DIV2) return false; // high-s: (r, n-s, v flipped) recovers the same key, refused anyway

  // Rule 2: the digest is EIP-712 over the ratified struct and domain, built ONLY from the
  // validated `input.unitBinding` and `input.packageBodyHash` — chainId and milestoneIndex are
  // the body's decimal strings, encoded here as uint256; escrow doubles as verifyingContract.
  // Each field must first be in the ratified body's own spelling (E13 F1).
  if (!isCanonicalBinding(input)) return false;
  const ub = input.unitBinding;
  const chainId = BigInt(ub.chainId);
  const domain = {
    name: DOMAIN_NAME,
    version: DOMAIN_VERSION,
    chainId,
    verifyingContract: ub.escrow,
  };
  const message = {
    chainId,
    escrow: ub.escrow,
    settlementUnitId: ub.settlementUnitId,
    jobIdHash: ub.jobIdHash,
    milestoneIndex: BigInt(ub.milestoneIndex),
    stepId: ub.stepId,
    compositionRoot: ub.compositionRoot,
    acceptedEnvelopeHash: ub.acceptedEnvelopeHash,
    packageBodyHash: input.packageBodyHash,
  };
  const digest = hashTypedData({ domain, types: TYPES, primaryType: "FinalMilestonePackageV2", message });

  // Rule 3: recover, then the recovered address must be non-zero.
  const recovered = await recoverAddress({ hash: digest, signature: sig as Hex });
  if (recovered.toLowerCase() === ZERO_ADDRESS) return false;

  // Rule 4: the recovered address must equal the D1 entry's OWN claimed signer label
  // (case-folded on both sides — the label's case, unlike operatorPrincipalId below, carries
  // no meaning of its own here; `final-milestone-package-v2.ts` already pins the D1 signer to
  // its lowercase form before this module ever sees it, but this check does not rely on that).
  if (typeof input.signer !== "string" || recovered.toLowerCase() !== input.signer.toLowerCase()) {
    return false;
  }

  // Rule 5: the recovered address must equal the injected, AUTHORITATIVE operator. `null`, a
  // throw or a rejected promise from `operatorForUnit` all refuse the same way a wrong address
  // does (a throw/rejection is caught by the outer try/catch in `verifyOperatorSignature`).
  const authoritative = await lookupOperator(operatorForUnit, ub, timeoutMs);
  if (authoritative === TIMED_OUT) return false;
  if (typeof authoritative !== "string" || recovered.toLowerCase() !== authoritative.toLowerCase()) {
    return false;
  }

  // Rule 6: operatorPrincipalId must be eip155:<decimal chainId>:<recovered, LOWERCASE>, byte
  // for byte. A checksummed or uppercase address — or any other chain-id spelling — is
  // refused, never folded to match.
  const expectedPrincipalId = `eip155:${ub.chainId}:${recovered.toLowerCase()}`;
  if (input.operatorPrincipalId !== expectedPrincipalId) return false;

  return true;
}
