import type { KernelDTO } from "../types/dto.js";

/** "12" for an exact count, "12+" for a lower bound. */
export function formatCount(value: number, atLeast: boolean): string {
  return atLeast ? `${value}+` : String(value);
}

/**
 * A kernel is online only if it reports "online" and says its heartbeat is
 * fresh. The gateway always sets `isStale` (facades/populators/kernel.populator.ts),
 * true when an online kernel has not sent a heartbeat recently; a kernel that
 * doesn't say is not counted as fresh.
 */
export function isKernelOnline(kernel: Pick<KernelDTO, "status" | "isStale">): boolean {
  return kernel.status === "online" && kernel.isStale === false;
}

