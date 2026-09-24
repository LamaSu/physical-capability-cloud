/**
 * Kernel ownership: who may mutate a kernel's liveness or its catalog.
 *
 * A kernel's owner is its `operatorAddress`. For authenticated creates that is
 * the stable actor identity apiGate resolved (`operatorId ?? userId`).
 * Mutations that change what the catalog serves for a kernel (heartbeat,
 * per-capability heartbeat, capability announce) are owner-only.
 *
 * Legacy rows can carry a placeholder instead of an owner ("" or the zero
 * address). Nobody owns those rows: they must be claimed through an
 * authenticated `POST /api/kernels` (register) before any owner-only mutation
 * is accepted. Fail closed: a missing actor, a missing kernel or a placeholder
 * owner is never the owner.
 */

/** operatorAddress values that mean "no recorded owner". */
export const UNOWNED_OPERATOR_ADDRESSES: ReadonlySet<string> = new Set([
  "",
  "0x0000000000000000000000000000000000000000",
]);

/** True iff the kernel row has a real recorded owner (not a legacy placeholder). */
export function hasRecordedOwner(
  kernel: { operatorAddress?: string | null } | null | undefined,
): boolean {
  const owner = kernel?.operatorAddress;
  return typeof owner === "string" && !UNOWNED_OPERATOR_ADDRESSES.has(owner);
}

/**
 * True iff `actorId` is the recorded owner of `kernel`. Uses exact identity
 * equality, the same comparison register() uses for its ownership check.
 */
export function isKernelOwner(
  kernel: { operatorAddress?: string | null } | null | undefined,
  actorId: string | null | undefined,
): boolean {
  if (typeof actorId !== "string" || actorId.length === 0) return false;
  if (!hasRecordedOwner(kernel)) return false;
  return kernel!.operatorAddress === actorId;
}

/** The authenticated actor apiGate attached to a request (`operatorId ?? userId`), if any. */
export function requestActor(req: unknown): string | undefined {
  const r = req as { operatorId?: unknown; userId?: unknown } | null | undefined;
  const actor = r?.operatorId ?? r?.userId;
  return typeof actor === "string" && actor.length > 0 ? actor : undefined;
}
