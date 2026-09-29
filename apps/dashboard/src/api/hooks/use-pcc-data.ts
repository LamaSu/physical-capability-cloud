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
import type { JobExecutionDTO } from "@pcc/spec";
import { api, ApiError } from "../gateway.js";
import { JOB_EXECUTION_REFRESH_MS, JOB_EXECUTION_TERMINAL_REFRESH_MS } from "../../lib/job-execution-view.js";
import { parseProductHome } from "../../lib/product-home.js";
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
// Wire guards
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const isText = (v: unknown): v is string => typeof v === "string" && v !== "";

/**
 * The rows of a list read, or a thrown error when the list or any row lacks
 * a field the pages count or classify by. A malformed row makes the whole
 * read unavailable: counting the rows that happen to parse would present a
 * partial list as the answer.
 */
function rowsOrThrow<T>(list: unknown, route: string, rowOk: (row: Record<string, unknown>) => boolean): T[] {
  if (!Array.isArray(list)) throw new Error(`unexpected response shape from ${route}`);
  if (!list.every((row) => isRecord(row) && rowOk(row))) throw new Error(`unexpected row in the response from ${route}`);
  return list as T[];
}

/** Every job is classified by its status, so a row without one is malformed. */
const jobRowOk = (r: Record<string, unknown>) => isText(r.id) && isText(r.status);
/** "Online" needs both the status and the staleness flag the gateway always sets. */
const kernelRowOk = (r: Record<string, unknown>) => isText(r.id) && isText(r.status) && typeof r.isStale === "boolean";
const escrowRowOk = (r: Record<string, unknown>) => isText(r.id) && isText(r.status);
const capabilityRowOk = (r: Record<string, unknown>) => isText(r.id) && isText(r.kernelId);

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
    queryFn: async () => {
      const res = await api.getCapabilityTemplates();
      // Missing templates are a failed read, never "no capabilities available".
      if (!isRecord(res) || !Array.isArray(res.templates)) {
        throw new Error("unexpected response shape from /api/capabilities/templates");
      }
      return res as { templates: unknown[] };
    },
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
    queryFn: async () => {
      const res = await api.getCapabilities(params);
      if (!isRecord(res) || typeof res.total !== "number") throw new Error("unexpected response shape from /api/capabilities");
      rowsOrThrow<CapabilityDTO>(res.items, "/api/capabilities", capabilityRowOk);
      return res;
    },
    retry: 1,
    staleTime: 30_000,
  });
}

/** GET /api/capabilities serves at most this many rows per request (routes/capabilities.ts). */
export const CAPABILITIES_PAGE_LIMIT = 200;
/** Stop paging after this many requests; what was read is then marked incomplete. */
export const CAPABILITIES_MAX_PAGES = 25;

/** Every capability the gateway lists, read page by page, and whether the read reached the end. */
export interface AllCapabilities {
  items: CapabilityDTO[];
  /** The gateway's total when the read ended. */
  total: number;
  /** True when every listed capability was read; a ranking over fewer is only partial. */
  complete: boolean;
}

/**
 * All capability instances, for views that rank or total across the whole
 * network (the kernel leaderboard). Pages through GET /api/capabilities, since
 * one request returns at most CAPABILITIES_PAGE_LIMIT rows.
 */
export function useAllCapabilities() {
  return useQuery<AllCapabilities>({
    queryKey: ["capabilities", "all"],
    queryFn: async () => {
      const items: CapabilityDTO[] = [];
      let total = 0;
      for (let page = 0; page < CAPABILITIES_MAX_PAGES; page++) {
        const res = await api.getCapabilities({ offset: items.length, limit: CAPABILITIES_PAGE_LIMIT });
        if (!isRecord(res) || typeof res.total !== "number") throw new Error("unexpected response shape from /api/capabilities");
        const rows = rowsOrThrow<CapabilityDTO>(res.items, "/api/capabilities", capabilityRowOk);
        items.push(...rows);
        total = res.total;
        if (items.length >= total || rows.length === 0) break;
      }
      return { items, total, complete: items.length >= total };
    },
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
export function useJobs(params?: { kernelId?: string; status?: string }, options?: { refetchInterval?: number }) {
  return useQuery<JobDTO[]>({
    queryKey: ["jobs", params],
    queryFn: async () => {
      const res = await api.getJobs(params);
      // Route wraps result in { jobs: [...] } for backward compat. A response without that
      // array, or with a row that has no id or status, is an error, never an empty or
      // shorter list (absence is not evidence).
      return rowsOrThrow<JobDTO>(res?.jobs, "/api/jobs", jobRowOk);
    },
    retry: 1,
    staleTime: 10_000,
    refetchInterval: options?.refetchInterval,
  });
}

/**
 * Product read model for one job (PX-6). Route: GET /api/jobs/:jobId/execution.
 * Always polls: every 15s while the work is in motion, every 60s once it is finished,
 * because finishing the work never makes the money final. A 404 or 401 is final (no
 * retry); any other failure is retried once and then surfaces as an error. It never
 * falls back to fixtures.
 */
export function useJobExecution(jobId: string | undefined) {
  return useQuery<JobExecutionDTO>({
    queryKey: ["jobExecution", jobId],
    queryFn: () => api.getJobExecution(jobId!),
    enabled: !!jobId,
    retry: (failureCount, error) =>
      !(error instanceof ApiError && (error.status === 404 || error.status === 401)) && failureCount < 1,
    refetchInterval: (query) =>
      query.state.data?.execution.terminal ? JOB_EXECUTION_TERMINAL_REFRESH_MS : JOB_EXECUTION_REFRESH_MS,
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
export function useKernels(params?: { status?: string }, options?: { refetchInterval?: number }) {
  return useQuery<KernelDTO[]>({
    queryKey: ["kernels", params],
    queryFn: async () => {
      const res = await api.getKernels(params);
      // Route wraps result in { kernels: [...] } for backward compat. A response without that
      // array, or a kernel without its status or staleness flag (the populator always sets
      // isStale), is an error, never a list to count: "0 kernels online" would be a guess.
      return rowsOrThrow<KernelDTO>(res?.kernels, "/api/kernels", kernelRowOk);
    },
    retry: 1,
    staleTime: 15_000,
    refetchInterval: options?.refetchInterval,
  });
}

/**
 * Single kernel detail with devices and recent jobs (KernelHealthSnapshot).
 * Route: GET /api/kernels/:kernelId → { kernel: KernelHealthSnapshot } (backward-compat).
 * Returns the { kernel } envelope — callers use data.kernel to access the snapshot.
 */
export function useKernel(kernelId: string | undefined) {
  return useQuery<{ kernel: KernelHealthSnapshot }>({
    queryKey: ["kernel", kernelId],
    queryFn: () => api.getKernel(kernelId!),
    enabled: !!kernelId,
    retry: 1,
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
      // array, or with a row that has no id or status, is an error, never an empty list.
      return rowsOrThrow<EscrowSummaryDTO>(res?.escrows, "/api/escrow", escrowRowOk);
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
/**
 * The platform-wide home facts (GET /api/product/home), counted by the gateway
 * over its own records: exact totals, not counts over one page. An answer that
 * isn't a ProductHomeDTO is a failed read.
 */
export function useProductHome(options?: { refetchInterval?: number }) {
  return useQuery({
    queryKey: ["productHome"],
    queryFn: async () => parseProductHome(await api.getProductHome()),
    retry: 1,
    staleTime: 15_000,
    refetchInterval: options?.refetchInterval,
  });
}

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
      // An answer without a complete identity block is not an account; treat it as a
      // failed read. The other sections may each be unavailable; Settings reads them
      // field by field (keyCounts).
      const id = isRecord(res) ? res.identity : undefined;
      const ok =
        isRecord(id) &&
        isText(id.operator) &&
        isText(id.key_id) &&
        (id.key_name === null || id.key_name === undefined || typeof id.key_name === "string") &&
        Array.isArray(id.scopes) &&
        id.scopes.every((s: unknown) => typeof s === "string");
      if (!ok) throw new Error("unexpected response shape from /api/agent/me");
      return res;
    },
    retry: 1,
    staleTime: 30_000,
  });
}

/**
 * The key counts of GET /api/agent/me, or null when that section is
 * unavailable. The gateway reports an unreadable key list as
 * { active: null, wildcard_keys: 0, unavailable }, so wildcard_keys is only
 * a count when active is one too.
 */
export function keyCounts(keys: unknown): { active: number; wildcardKeys: number } | null {
  if (!isRecord(keys) || keys.unavailable || typeof keys.active !== "number" || typeof keys.wildcard_keys !== "number") {
    return null;
  }
  return { active: keys.active, wildcardKeys: keys.wildcard_keys };
}
