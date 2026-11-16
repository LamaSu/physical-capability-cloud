import type { getRepos } from "../db.js";
import { ownerOf } from "../auth/kernel-authority.js";

/** A recorded operator is an IP owner only when it names a non-placeholder wallet. */
export function walletOwner(operatorAddress: unknown): string | null {
  const owner = ownerOf(operatorAddress);
  return owner !== null && /^0x[0-9a-f]{40}$/.test(owner) ? owner : null;
}

/** Resolve ownership exclusively through gateway records; read errors reach the route. */
export function recordedIpOwner(repos: ReturnType<typeof getRepos>, ipId: string): string | null {
  const registration = repos.story.findIpById(ipId);
  if (registration) {
    if (registration.capabilityId === null) return null;
    const cap = repos.capabilities.findById(registration.capabilityId);
    if (!cap) return null;
    return walletOwner(repos.kernels.findById(cap.kernelId)?.operatorAddress);
  }
  const links = repos.story.findDerivativeLinksByChild(ipId);
  if (links.length !== 1 || links[0].jobId === null) return null;
  const job = repos.jobs.findById(links[0].jobId);
  if (!job) return null;
  return walletOwner(repos.kernels.findById(job.kernelId)?.operatorAddress);
}

export const IP_REPLIES = {
  ip_owner_unknown: { error: "ip_owner_unknown", message: "No owner is recorded for this IP, so no one can change it, the gateway admin included." },
  wallet_proof_required: { error: "wallet_proof_required", message: "This IP action needs a proven wallet. Sign in with the wallet, then send a session key or the session token in the Authorization header." },
  not_kernel_operator: { error: "not_kernel_operator", message: "Only the recorded operator of this kernel can register its IP." },
  not_ip_owner: { error: "not_ip_owner", message: "Only the recorded owner of this IP can set its licensing terms." },
  designer_must_be_owner: { error: "designer_must_be_owner", message: "designerAddress must be the recorded owner of this IP." },
  operator_must_be_owner: { error: "operator_must_be_owner", message: "operatorAddress must be the recorded operator of this job's kernel." },
  not_parent_owner: { error: "not_parent_owner", message: "The parent IP's recorded owner is not this job's operator." },
  capability_not_found: { error: "capability_not_found", message: "No capability with this id is recorded, so it can't be registered as an IP." },
  job_not_found: { error: "job_not_found", message: "No job with this id is recorded." },
  capability_kernel_mismatch: { error: "capability_kernel_mismatch", message: "capability.kernelId is not the kernel recorded for this capability." },
  parent_not_job_capability: { error: "parent_not_job_capability", message: "parentIpId must be the IP registered for this job's own capability." },
  already_registered: { error: "already_registered", message: "This is already registered, or its registration is in progress." },
  registration_not_recorded: { error: "registration_not_recorded", message: "The gateway couldn't record this IP registration, so it doesn't count as registered. Try again." },
  derivative_not_recorded: { error: "derivative_not_recorded", message: "The gateway couldn't record this job's derivative link, so it doesn't count as registered. Try again." },
  read_failed: { error: "read_failed", message: "The gateway couldn't read the records that say who owns this IP. Try again shortly." },
} as const;
