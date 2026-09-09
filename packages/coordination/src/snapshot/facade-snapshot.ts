/**
 * Org snapshot — a read-only tap of gateway facades, composed into one
 * object per tick.
 *
 * Scope decision (documented, not silent): `@pcc/gateway`'s facades
 * (packages/gateway/src/facades/*.facade.ts) are NOT a standalone,
 * constructor-injectable class — `BaseFacade` calls a module-level
 * `getRepos()` singleton (packages/gateway/src/db.ts) plus a reputation
 * service and an OTel tracer, all wired by the gateway's own bootstrap.
 * Depending on `@pcc/gateway` here would mean either (a) building the
 * entire gateway package — a large HTTP monolith with fastify, EAS SDK,
 * SimpleWebAuthn, etc., far outside an additive-only slice's dependency
 * budget on a resource-constrained box, or (b) reaching into a live
 * gateway process's internals. Per the task's own fallback clause ("if not
 * exported, wrap their public read interface"), this module instead
 * defines a minimal read-only interface — `OrgFacadeSource` — whose shape
 * mirrors the *documented, versioned* DTOs already public in this repo's
 * root CLAUDE.md (CapabilityDTO / KernelDTO / JobDTO): status, queueDepth,
 * available, isStale. A real deployment wires `OrgFacadeSource` to actual
 * facade instances (or their HTTP surface); this slice ships a
 * `StubFacadeSource` plus the composition function, so the rest of the
 * Brain (reactions, queue, dispatch) can be built and tested against a
 * stable contract today.
 */

export interface KernelSummary {
  id: string;
  name: string;
  status: "online" | "offline" | "maintenance" | "suspended";
  capabilityCount: number;
  isStale: boolean;
}

export interface CapabilitySummary {
  id: string;
  kernelId: string;
  type: string;
  available: boolean;
  queueDepth: number;
}

export interface JobSummary {
  id: string;
  kernelId: string;
  capabilityId: string;
  status: "pending" | "queued" | "in_progress" | "paused" | "completed" | "failed" | "cancelled";
}

/** The read-only surface this package needs from the gateway's facades. */
export interface OrgFacadeSource {
  listKernels(): Promise<KernelSummary[]>;
  listCapabilities(): Promise<CapabilitySummary[]>;
  listJobs(): Promise<JobSummary[]>;
}

/** Default source: no live gateway wired up. Returns empty data rather than
 *  throwing, so a Brain can run (and its reaction rules simply never fire on
 *  org state) before real facade wiring lands. */
export class StubFacadeSource implements OrgFacadeSource {
  async listKernels(): Promise<KernelSummary[]> {
    return [];
  }
  async listCapabilities(): Promise<CapabilitySummary[]> {
    return [];
  }
  async listJobs(): Promise<JobSummary[]> {
    return [];
  }
}

export interface OrgSnapshot {
  takenAt: string;
  kernels: KernelSummary[];
  capabilities: CapabilitySummary[];
  jobs: JobSummary[];
  staleKernelCount: number;
  offlineKernelCount: number;
}

/** Compose 2-3 facade reads into one org-snapshot object. Read-only, pure
 *  aside from the injected source's I/O. */
export async function takeOrgSnapshot(source: OrgFacadeSource): Promise<OrgSnapshot> {
  const [kernels, capabilities, jobs] = await Promise.all([
    source.listKernels(),
    source.listCapabilities(),
    source.listJobs(),
  ]);
  return {
    takenAt: new Date().toISOString(),
    kernels,
    capabilities,
    jobs,
    staleKernelCount: kernels.filter((k) => k.isStale).length,
    offlineKernelCount: kernels.filter((k) => k.status === "offline").length,
  };
}
