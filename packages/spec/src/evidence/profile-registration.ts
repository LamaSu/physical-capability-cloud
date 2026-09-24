/**
 * checkProfileRegistration — may this MeasurementProfile be registered for a
 * (capability, device)?
 *
 * pcc-gateway stores an operator's concrete profile in its own append-only
 * table keyed by (capabilityId, deviceId) (bus #2621). The accepted-plan
 * compiler later takes the CURRENT row's digest from the server-re-read
 * provider snapshot (composition, bus #2238). This check is what the
 * registration route runs before inserting a row. The route owns
 * authentication, the kernel-ownership predicate and storage; this owns what
 * makes a profile registrable:
 *
 *   - `profile-invalid`: it fails `validateMeasurementProfile`;
 *   - `device-mismatch`: it names a different device from the row it would be
 *     stored under, so evidence from the registered device could never qualify;
 *   - `capability-type-mismatch`: its outcome is for another capability type;
 *   - `unverifiable-term`: admission cannot evaluate one of its terms, so every
 *     job under it would fail closed. Refused here rather than discovered at
 *     settlement;
 *   - `digest-mismatch`: the client sent a digest that is not the digest of
 *     the profile it sent.
 *
 * The digest is always computed here, from the submitted profile. A
 * client-supplied digest is only ever compared, never stored or trusted.
 * Every problem is reported, not just the first, so an operator can fix a
 * profile in one pass.
 */

import {
  computeMeasurementProfileDigest,
  validateMeasurementProfile,
  type MeasurementProfileDigest,
  type MeasurementProfileV1,
} from "./measurement-profile.js";
import { unverifiableProfileTerms } from "./profile-admission.js";

export type ProfileRegistrationCode =
  | "profile-invalid"
  | "device-mismatch"
  | "capability-type-mismatch"
  | "unverifiable-term"
  | "digest-mismatch";

export interface ProfileRegistrationProblem {
  code: ProfileRegistrationCode;
  detail: string;
}

export interface ProfileRegistrationRequest {
  /** The type of the capability the row belongs to (from the capability record, not the request). */
  capabilityType: string;
  /** The device the row is keyed by. */
  deviceId: string;
  /** The profile as submitted, unvalidated. */
  profile: unknown;
  /** A digest the client computed, if it sent one. Compared, never trusted. */
  claimedDigest?: string;
}

export type ProfileRegistrationResult =
  | { ok: true; profile: MeasurementProfileV1; profileDigest: MeasurementProfileDigest }
  | { ok: false; problems: ProfileRegistrationProblem[] };

/** Never throws. */
export function checkProfileRegistration(request: ProfileRegistrationRequest): ProfileRegistrationResult {
  const violations = validateMeasurementProfile(request.profile);
  if (violations.length > 0) {
    return {
      ok: false,
      problems: violations.map((v) => ({ code: "profile-invalid" as const, detail: `${v.path || "<root>"}: ${v.message}` })),
    };
  }
  const profile = request.profile as MeasurementProfileV1;
  const problems: ProfileRegistrationProblem[] = [];

  if (profile.device.deviceId !== request.deviceId) {
    problems.push({
      code: "device-mismatch",
      detail: `the profile names device ${JSON.stringify(profile.device.deviceId)} but would be registered for ${JSON.stringify(request.deviceId)}`,
    });
  }
  if (profile.outcome.capabilityType !== request.capabilityType) {
    problems.push({
      code: "capability-type-mismatch",
      detail: `the profile is for ${JSON.stringify(profile.outcome.capabilityType)} but the capability is ${JSON.stringify(request.capabilityType)}`,
    });
  }
  for (const term of unverifiableProfileTerms(profile)) {
    problems.push({ code: "unverifiable-term", detail: term });
  }

  const profileDigest = computeMeasurementProfileDigest(profile);
  if (request.claimedDigest !== undefined && request.claimedDigest !== profileDigest) {
    problems.push({
      code: "digest-mismatch",
      detail: `the client sent ${JSON.stringify(request.claimedDigest)}; the submitted profile digests to ${profileDigest}`,
    });
  }

  return problems.length > 0 ? { ok: false, problems } : { ok: true, profile, profileDigest };
}
