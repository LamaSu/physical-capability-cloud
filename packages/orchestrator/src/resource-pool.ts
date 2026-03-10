/**
 * ResourcePool — manages exclusive locks on instrument nodes.
 *
 * Provides claim/release semantics with a FIFO waiting queue per node
 * and automatic expiration of stale claims.
 */

import type { ResourceClaim } from "@pcc/spec";
import { ids } from "@pcc/spec";

export class ResourceBusyError extends Error {
  readonly nodeId: string;

  constructor(nodeId: string) {
    super(`Resource ${nodeId} is currently busy`);
    this.name = "ResourceBusyError";
    this.nodeId = nodeId;
  }
}

interface Waiter {
  claimerId: string;
  resolve: (claim: ResourceClaim) => void;
  reject: (err: Error) => void;
  timeoutHandle?: ReturnType<typeof setTimeout>;
}

export class ResourcePool {
  /** nodeId → active claim */
  private activeClaims = new Map<string, ResourceClaim>();
  /** nodeId → FIFO queue of waiters */
  private queues = new Map<string, Waiter[]>();
  /** All claims ever issued (for getAllClaims) */
  private allClaims = new Map<string, ResourceClaim>();

  // ── Public API ──────────────────────────────────────────────────

  claim(nodeId: string, claimerId: string, durationMs?: number): ResourceClaim {
    this.checkExpired();

    if (this.activeClaims.has(nodeId)) {
      throw new ResourceBusyError(nodeId);
    }

    const now = new Date().toISOString();
    const claim: ResourceClaim = {
      id: ids.resourceClaim(),
      nodeId,
      claimedBy: claimerId,
      claimedAt: now,
      expiresAt: durationMs
        ? new Date(Date.now() + durationMs).toISOString()
        : undefined,
      released: false,
    };

    this.activeClaims.set(nodeId, claim);
    this.allClaims.set(claim.id, claim);
    return claim;
  }

  release(claimId: string): void {
    const claim = this.allClaims.get(claimId);
    if (!claim || claim.released) return;

    claim.released = true;
    claim.releasedAt = new Date().toISOString();
    this.activeClaims.delete(claim.nodeId);

    // Resolve next waiter in FIFO queue
    this.resolveNextWaiter(claim.nodeId);
  }

  isAvailable(nodeId: string): boolean {
    this.checkExpired();
    return !this.activeClaims.has(nodeId);
  }

  getActiveClaim(nodeId: string): ResourceClaim | undefined {
    this.checkExpired();
    return this.activeClaims.get(nodeId);
  }

  getQueue(nodeId: string): string[] {
    const waiters = this.queues.get(nodeId);
    if (!waiters) return [];
    return waiters.map((w) => w.claimerId);
  }

  getAllClaims(): ResourceClaim[] {
    return [...this.allClaims.values()];
  }

  waitForAvailability(
    nodeId: string,
    claimerId: string,
    timeoutMs?: number,
  ): Promise<ResourceClaim> {
    this.checkExpired();

    // If available right now, claim immediately
    if (!this.activeClaims.has(nodeId)) {
      return Promise.resolve(this.claim(nodeId, claimerId));
    }

    return new Promise<ResourceClaim>((resolve, reject) => {
      const waiter: Waiter = { claimerId, resolve, reject };

      if (timeoutMs !== undefined) {
        waiter.timeoutHandle = setTimeout(() => {
          // Remove this waiter from the queue
          const q = this.queues.get(nodeId);
          if (q) {
            const idx = q.indexOf(waiter);
            if (idx !== -1) q.splice(idx, 1);
          }
          reject(new Error(`Timed out waiting for resource ${nodeId} after ${timeoutMs}ms`));
        }, timeoutMs);
      }

      let q = this.queues.get(nodeId);
      if (!q) {
        q = [];
        this.queues.set(nodeId, q);
      }
      q.push(waiter);
    });
  }

  checkExpired(): void {
    const now = Date.now();
    for (const [nodeId, claim] of this.activeClaims) {
      if (claim.expiresAt && new Date(claim.expiresAt).getTime() <= now) {
        claim.released = true;
        claim.releasedAt = new Date().toISOString();
        this.activeClaims.delete(nodeId);
        this.resolveNextWaiter(nodeId);
      }
    }
  }

  // ── Internals ───────────────────────────────────────────────────

  private resolveNextWaiter(nodeId: string): void {
    const q = this.queues.get(nodeId);
    if (!q || q.length === 0) return;

    const waiter = q.shift()!;
    if (waiter.timeoutHandle !== undefined) {
      clearTimeout(waiter.timeoutHandle);
    }

    try {
      const newClaim = this.claim(nodeId, waiter.claimerId);
      waiter.resolve(newClaim);
    } catch (err) {
      // Should not happen since we only resolve when the node is free,
      // but handle defensively.
      waiter.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }
}
