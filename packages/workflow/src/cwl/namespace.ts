/**
 * `pcc:` namespace constants — emitted under $namespaces and used as hint keys.
 *
 * See design §9.
 */

/** The namespace IRI referenced by `$namespaces.pcc`. */
export const PCC_NAMESPACE_IRI = 'https://capability.network/schemas/v1#';

/** Hint-key constants (avoid typos). */
export const PCC_KERNEL_REQUIREMENT = 'pcc:KernelRequirement';
export const PCC_COMPENSATION_REQUIREMENT = 'pcc:CompensationRequirement';
export const PCC_QUORUM_REQUIREMENT = 'pcc:QuorumRequirement';
export const PCC_RETRY_POLICY = 'pcc:RetryPolicy';
export const PCC_SIGNAL_REQUIREMENT = 'pcc:SignalRequirement';
