/**
 * PrimitiveVerifier — the oracle-side contract for authenticating a primitive
 * instance (spec §5.4).
 *
 * The verifier IMPLEMENTATIONS live in the oracle (the separate oracle lane) and
 * are mirrored-by-value against this interface, per the established cross-repo
 * convention (field order is load-bearing; golden parity fixtures vs @pcc/spec).
 * This file is the shared SHAPE only — @pcc/spec ships NO verifier logic. It is
 * the "interface + stub" seam so the oracle lane has a contract to build to.
 *
 * Stub policy (spec §8): any referenced-but-unimplemented primitive fails CLOSED
 * for verification (met:false) and yields a CAPPED verdict for eligibility —
 * exactly like the oracle's reserved clearing kinds today. No silent passes, ever.
 */

/** The result of verifying one primitive instance. `pending` = data not yet
 *  available (never throw; missing data is pending, not fail). */
export interface PrimitiveVerifyResult {
  met: boolean | "pending";
  detail: string[];
}

/**
 * Everything the oracle supplies to a verifier. Left open here — the oracle owns
 * the concrete VerifyCtx (job window, registry snapshots, replay store, …). The
 * vocabulary version is pinned so a verifier knows which contract judged the job.
 */
export interface PrimitiveVerifyContext {
  vocabVersion: number;
  [key: string]: unknown;
}

export interface PrimitiveVerifier {
  id: string;
  verify(
    instance: unknown,
    params: unknown,
    ctx: PrimitiveVerifyContext,
  ): Promise<PrimitiveVerifyResult>;
}

/**
 * The fail-closed default for any active primitive whose real verifier has not
 * shipped. The oracle registers real verifiers over these; an id with no
 * registered verifier resolves to this behavior (never a silent pass).
 */
export function makeStubVerifier(id: string): PrimitiveVerifier {
  return {
    id,
    async verify(): Promise<PrimitiveVerifyResult> {
      return {
        met: false,
        detail: [`primitive "${id}" verifier not implemented — fails closed (spec §8)`],
      };
    },
  };
}
