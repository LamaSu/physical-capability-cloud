/**
 * TanStack Query hooks for PCC gateway data.
 *
 * Each hook tries the real gateway API first. If the gateway is unavailable
 * or returns an error, data is empty — no mock fallbacks. Pages must handle
 * the empty state gracefully.
 *
 * Pattern:
 *   const { data, isLoading, error } = useJobs();
 *   if (isLoading) return <Skeleton />;
 *   if (!data?.length) return <EmptyState />;
 *
 * DTO contracts live in src/types/dto.ts. When the backend facade shape
 * changes, only this file and gateway.ts need updating — page components
 * are shielded from the wire format.
 */

import { useQuery } from "@tanstack/react-query";
import { api } from "../gateway.js";
import { authorizedFetch } from "../../lib/authorized-fetch.js";
import type {
  CapabilityDTO,
  JobDTO,
  JobDetailDTO,
  KernelDTO,
  KernelHealthSnapshot,
  EscrowSummaryDTO,
  EvidenceSummaryDTO,
  ComplianceReportDTO,
  DriftAlertDTO,
  PaginatedResult,
  AgentMeDTO,
} from "../../types/dto.js";

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

export function useCapabilityTypes() {
  return useQuery({
    queryKey: ["capabilityTypes"],
    queryFn: () => api.getCapabilityTypes(),
    retry: 1,
    staleTime: 60_000,
  });
}

export function useCapabilityTemplates() {
  return useQuery({
    queryKey: ["capabilityTemplates"],
    queryFn: () => api.getCapabilityTemplates(),
    retry: 1,
    staleTime: 60_000,
  });
}

/**
 * List capability instances with optional pagination.
 * Returns the full PaginatedResult<CapabilityDTO> — callers use data.items, data.total.
 * Route: GET /api/capabilities → PaginatedResult<CapabilityDTO> (no envelope wrapper).
 */
export function useCapabilities(params?: { offset?: number; limit?: number }) {
  return useQuery<PaginatedResult<CapabilityDTO>>({
    queryKey: ["capabilities", params],
    queryFn: () => api.getCapabilities(params),
    retry: 1,
    staleTime: 30_000,
  });
}

/**
 * Compliance report for a specific capability.
 * Only fires when capabilityId is defined.
 * Route: GET /api/capabilities/:capabilityId/compliance → ComplianceReportDTO
 * NOTE: This gateway route is not yet implemented — hook returns undefined until added.
 */
export function useComplianceReport(capabilityId: string | undefined) {
  return useQuery<ComplianceReportDTO>({
    queryKey: ["complianceReport", capabilityId],
    queryFn: () => api.getComplianceReport(capabilityId!),
    enabled: !!capabilityId,
    retry: 1,
    staleTime: 60_000,
  });
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

/**
 * List jobs with optional filtering.
 * Route: GET /api/jobs → { jobs: JobDTO[] } (backward-compat envelope).
 * Returns JobDTO[] — envelope is unwrapped here so callers see a flat array.
 */
export function useJobs(params?: { kernelId?: string; status?: string }) {
  return useQuery<JobDTO[]>({
    queryKey: ["jobs", params],
    queryFn: async () => {
      const res = await api.getJobs(params);
      // Route wraps result in { jobs: [...] } for backward compat. A response without that
      // array is an error, never an empty list (absence is not evidence).
      if (!Array.isArray(res?.jobs)) throw new Error("unexpected response shape from /api/jobs");
      return res.jobs;
    },
    retry: 1,
    staleTime: 10_000,
  });
}

/**
 * Single job detail with timeline, evidence bundles, and optional escrow.
 * Route: GET /api/jobs/:jobId → { job: JobDetailDTO, evidence: EvidenceSummaryDTO[] }
 * Returns the full { job, evidence } shape — callers destructure as needed.
 */
export function useJob(jobId: string | undefined) {
  return useQuery<{ job: JobDetailDTO; evidence: EvidenceSummaryDTO[] }>({
    queryKey: ["job", jobId],
    queryFn: () => api.getJob(jobId!),
    enabled: !!jobId,
    retry: 1,
  });
}

/**
 * Drift alerts for a specific job.
 * Only fires when jobId is defined.
 * Route: GET /api/jobs/:jobId/drift-alerts → DriftAlertDTO[]
 * NOTE: This gateway route is not yet implemented — hook returns undefined until added.
 */
export function useDriftAlerts(jobId: string | undefined) {
  return useQuery<DriftAlertDTO[]>({
    queryKey: ["driftAlerts", jobId],
    queryFn: () => api.getDriftAlerts(jobId!),
    enabled: !!jobId,
    retry: 1,
    staleTime: 30_000,
  });
}

// ---------------------------------------------------------------------------
// Kernels
// ---------------------------------------------------------------------------

/**
 * List all kernels with staleness detection and capability type enrichment.
 * Route: GET /api/kernels → { kernels: KernelDTO[] } (backward-compat envelope).
 * Returns KernelDTO[] — envelope is unwrapped here so callers see a flat array.
 *
 * Backward-compat note: pages that previously accessed kernel.capabilities[]
 * should now use kernel.capabilityTypes[] (CapabilityType[]) instead.
 */
export function useKernels(params?: { status?: string }) {
  return useQuery<KernelDTO[]>({
    queryKey: ["kernels", params],
    queryFn: async () => {
      const res = await api.getKernels(params);
      // Route wraps result in { kernels: [...] } for backward compat. A response without that
      // array is an error, never an empty list: "0 kernels online" would be a guess.
      if (!Array.isArray(res?.kernels)) throw new Error("unexpected response shape from /api/kernels");
      return res.kernels;
    },
    retry: 1,
    staleTime: 15_000,
  });
}

/**
 * Single kernel detail with devices and recent jobs (KernelHealthSnapshot).
 * Route: GET /api/kernels/:kernelId → { kernel: KernelHealthSnapshot } (backward-compat).
 * Returns the { kernel } envelope — callers use data.kernel to access the snapshot.
 */
/**
 * The gateway's own answer that it has no such record. Only its not-found code
 * counts: a 404 from a missing route or a proxy is an unavailable read.
 */
export class RecordNotFoundError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "RecordNotFoundError";
  }
}

export function useKernel(kernelId: string | undefined) {
  return useQuery<{ kernel: KernelHealthSnapshot }>({
    queryKey: ["kernel", kernelId],
    // Reads the route directly (api.getKernel drops the error body) so the
    // kernel facade's KERNEL_NOT_FOUND can be told apart from any other 404.
    queryFn: async () => {
      const res = await authorizedFetch(`/api/kernels/${encodeURIComponent(kernelId!)}`);
      const body = (await res.json().catch(() => null)) as { error?: unknown; message?: unknown; kernel?: unknown } | null;
      if (res.status === 404 && body?.error === "KERNEL_NOT_FOUND") {
        throw new RecordNotFoundError("KERNEL_NOT_FOUND", typeof body.message === "string" ? body.message : "kernel not found");
      }
      if (!res.ok) throw new Error(typeof body?.message === "string" ? body.message : `API error: ${res.status}`);
      if (!body || typeof body.kernel !== "object" || body.kernel === null) {
        throw new Error("unexpected response shape from /api/kernels/:id");
      }
      return { kernel: body.kernel as KernelHealthSnapshot };
    },
    enabled: !!kernelId,
    retry: (failures, error) => !(error instanceof RecordNotFoundError) && failures < 1,
  });
}

// ---------------------------------------------------------------------------
// Escrow
// ---------------------------------------------------------------------------

/**
 * List escrows with milestone counts.
 * Route: GET /api/escrow → { escrows: EscrowSummaryDTO[] } (backward-compat envelope).
 * Returns EscrowSummaryDTO[] — envelope is unwrapped here so callers see a flat array.
 *
 * Backward-compat note: EscrowSummaryDTO does NOT include a milestones[] array.
 * Pages that rendered milestone lists must switch to milestoneCount / releasedCount /
 * disputedCount fields instead.
 */
export function useEscrows(params?: { status?: string }) {
  return useQuery<EscrowSummaryDTO[]>({
    queryKey: ["escrows", params],
    queryFn: async () => {
      const res = await api.getEscrows(params);
      // Route wraps result in { escrows: [...] } for backward compat. A response without that
      // array is an error, never an empty list.
      if (!Array.isArray(res?.escrows)) throw new Error("unexpected response shape from /api/escrow");
      return res.escrows;
    },
    retry: 1,
    staleTime: 10_000,
  });
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

export function useConversations() {
  return useQuery({
    queryKey: ["conversations"],
    queryFn: async () => {
      const res = await api.getConversations();
      return (res.conversations ?? []) as unknown[];
    },
    retry: 1,
    staleTime: 10_000,
  });
}

// ---------------------------------------------------------------------------
// Settlement
// ---------------------------------------------------------------------------

export function useSettlementStatus() {
  return useQuery({
    queryKey: ["settlementStatus"],
    queryFn: () => api.getSettlementStatus(),
    retry: 1,
    staleTime: 5_000,
  });
}

export function useSettlementEpochs() {
  return useQuery({
    queryKey: ["settlementEpochs"],
    queryFn: async () => {
      const res = await api.getSettlementEpochs();
      return (res.epochs ?? []) as unknown[];
    },
    retry: 1,
    staleTime: 10_000,
  });
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

/**
 * Gateway liveness (GET /api/health).
 * `refetchInterval` lets always-visible chrome (the StatusBar) re-check
 * periodically instead of reporting the state it saw at page load.
 */
export function useGatewayHealth(options?: { refetchInterval?: number }) {
  return useQuery({
    queryKey: ["health"],
    queryFn: () => api.health(),
    retry: 0,
    staleTime: 30_000,
    refetchInterval: options?.refetchInterval,
  });
}

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------

/**
 * Where the current API key's operator stands (GET /api/agent/me): identity,
 * scopes, keys, kernels and in-flight work. Each section reports its own
 * `unavailable` reason instead of failing the whole answer.
 */
export function useAgentMe() {
  return useQuery<AgentMeDTO>({
    queryKey: ["agentMe"],
    queryFn: async () => {
      const res = await api.getAgentMe();
      // An answer without the identity block is not an account; treat it as a failed read.
      if (!res?.identity || !Array.isArray(res.identity.scopes)) {
        throw new Error("unexpected response shape from /api/agent/me");
      }
      return res;
    },
    retry: 1,
    staleTime: 30_000,
  });
}
