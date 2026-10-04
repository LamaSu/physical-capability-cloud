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
 * Every check runs on one plain-data copy of the request (`plainDataCopy`:
 * each field read exactly once), and the profile returned for storage is that
 * copy, so what is checked, digested and stored is one thing. The digest is
 * always computed here, from that copy. A client-supplied digest is only ever
 * compared, never stored or trusted.
 * Every problem is reported, not just the first, so an operator can fix a
 * profile in one pass.
 *
 * Nothing that runs after this module loads can make a request registrable,
 * or change the profile or digest returned for storage (#384 round 9,
 * steward #5186: the realm-mutation class of astra packs 162-171). The check
 * calls only intrinsics captured at load (util/primordials.ts), plain loops
 * and operators: never a method looked up on a prototype or a global at the
 * time of the call, never the iterator protocol, never `in` or a RegExp. The
 * copy, the validation, the unverifiable terms and the digest it relies on
 * are built the same way (plain-data.ts, measurement-profile.ts,
 * profile-admission.ts). A realm whose intrinsics were replaced before
 * @pcc/spec loaded is out of scope: no in-process check can tell. Anything
 * replaced after load can make registration refuse; it cannot make a request
 * registrable.
 */

import {
  computeMeasurementProfileDigest,
  plainDataCopy,
  validateMeasurementProfile,
  type MeasurementProfileDigest,
  type MeasurementProfileV1,
} from "./measurement-profile.js";
import { unverifiableProfileTerms } from "./profile-admission.js";
import { append, JSONStringify, listAt, mapList, newList } from "../util/primordials.js";

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

function problem(code: ProfileRegistrationCode, detail: string): ProfileRegistrationProblem {
  return { code, detail };
}

/** Never throws. */
export function checkProfileRegistration(input: ProfileRegistrationRequest): ProfileRegistrationResult {
  const copy = plainDataCopy(input);
  if (!copy.ok || typeof copy.value !== "object" || copy.value === null) {
    const problems = newList<ProfileRegistrationProblem>(0);
    append(problems, problem("profile-invalid", `<root>: the request is not plain JSON data (${copy.ok ? "not an object" : copy.reason})`));
    return { ok: false, problems };
  }
  // A null-prototype copy at every depth: every read below is the request's own.
  const request = copy.value as ProfileRegistrationRequest;
  const violations = validateMeasurementProfile(request.profile);
  if (violations.length > 0) {
    return { ok: false, problems: mapList(violations, (v) => problem("profile-invalid", `${v.path || "<root>"}: ${v.message}`)) };
  }
  const profile = request.profile as MeasurementProfileV1;
  const problems = newList<ProfileRegistrationProblem>(0);

  if (profile.device.deviceId !== request.deviceId) {
    append(
      problems,
      problem("device-mismatch", `the profile names device ${JSONStringify(profile.device.deviceId)} but would be registered for ${JSONStringify(request.deviceId)}`),
    );
  }
  if (profile.outcome.capabilityType !== request.capabilityType) {
    append(
      problems,
      problem("capability-type-mismatch", `the profile is for ${JSONStringify(profile.outcome.capabilityType)} but the capability is ${JSONStringify(request.capabilityType)}`),
    );
  }
  const terms = unverifiableProfileTerms(profile);
  for (let i = 0; i < terms.length; i++) append(problems, problem("unverifiable-term", listAt(terms, i)!));

  const profileDigest = computeMeasurementProfileDigest(profile);
  if (request.claimedDigest !== undefined && request.claimedDigest !== profileDigest) {
    append(
      problems,
      problem("digest-mismatch", `the client sent ${JSONStringify(request.claimedDigest)}; the submitted profile digests to ${profileDigest}`),
    );
  }

  return problems.length > 0 ? { ok: false, problems } : { ok: true, profile, profileDigest };
}
