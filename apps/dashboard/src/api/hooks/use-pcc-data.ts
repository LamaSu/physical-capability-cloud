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
import {
  ESCROW_CURRENCIES,
  KNOWN_ESCROW_STATUSES,
  KNOWN_JOB_STATUSES,
  KNOWN_KERNEL_STATUSES,
  isCanonicalAmount,
  isCount,
  isInRange,
} from "../wire-vocabulary.js";

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

/** Absent, or present and valid: for fields a page shows when they're there and marks unavailable when not. */
const optional = (v: unknown, ok: (v: unknown) => boolean) => v === undefined || v === null || ok(v);

/**
 * Every job is counted and classified by its status, so a row without a
 * status the gateway defines is malformed (wire-vocabulary.ts).
 */
const jobRowOk = (r: Record<string, unknown>) => isText(r.id) && isText(r.status) && KNOWN_JOB_STATUSES.has(r.status);
/** "Online" needs a known status and the staleness flag the gateway always sets. */
const kernelRowOk = (r: Record<string, unknown>) =>
  isText(r.id) && isText(r.status) && KNOWN_KERNEL_STATUSES.has(r.status) && typeof r.isStale === "boolean";
/**
 * An escrow is shown with its amount in its own currency, so both must be
 * readable: a canonical decimal amount, and a currency the escrows table
 * allows (astra 18b F1). Milestone counts may be absent (the pages mark them
 * unavailable); when present they are counts, and the released and disputed
 * milestones are among the escrow's milestones.
 */
const escrowRowOk = (r: Record<string, unknown>) =>
  isText(r.id) &&
  isText(r.status) &&
  KNOWN_ESCROW_STATUSES.has(r.status) &&
  isCanonicalAmount(r.totalAmount) &&
  typeof r.currency === "string" &&
  ESCROW_CURRENCIES.has(r.currency) &&
  optional(r.jobId, (v) => typeof v === "string") &&
  optional(r.milestoneCount, isCount) &&
  optional(r.releasedCount, isCount) &&
  optional(r.disputedCount, isCount) &&
  (!isCount(r.milestoneCount) || !isCount(r.releasedCount) || !isCount(r.disputedCount) || r.releasedCount + r.disputedCount <= r.milestoneCount);
/**
 * A capability is grouped by kernel and type, and its queue depth, assurance
 * score and reputation are summed, averaged and ranked, so each must be valid
 * when present (astra 18b F3). A missing queue depth or score is shown as
 * unknown by the pages.
 */
const capabilityRowOk = (r: Record<string, unknown>) =>
  isText(r.id) &&
  isText(r.kernelId) &&
  isText(r.type) &&
  optional(r.name, (v) => typeof v === "string") &&
  optional(r.queueDepth, isCount) &&
  optional(r.assuranceScore, (v) => isInRange(v, 0, 1)) &&
  optional(r.reputation, (v) => isInRange(v, 0, 1000));

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
 * All capability instances, for views that rank, total or search across the
 * whole network (the kernel leaderboard, Discover). Pages through
 * GET /api/capabilities, since one request returns at most
 * CAPABILITIES_PAGE_LIMIT rows.
 *
 * The pages must describe one list (astra 18b F4). The read fails, and the
 * query's retry starts it over, when:
 * - the total changes between pages (the list changed mid-read);
 * - a page answers for an offset other than the one asked;
 * - its hasMore disagrees with its own offset, limit and total;
 * - an id repeats;
 * - more rows arrive than the total.
 * A page that comes back empty before the total is reached ends the read,
 * which is then marked incomplete, as is one that stops at
 * CAPABILITIES_MAX_PAGES.
 */
export function useAllCapabilities() {
  return useQuery<AllCapabilities>({
    queryKey: ["capabilities", "all"],
    queryFn: async () => {
      const route = "/api/capabilities";
      const items: CapabilityDTO[] = [];
      const seen = new Set<string>();
      let total: number | null = null;
      for (let page = 0; page < CAPABILITIES_MAX_PAGES; page++) {
        const offset = items.length;
        const res = await api.getCapabilities({ offset, limit: CAPABILITIES_PAGE_LIMIT });
        if (!isRecord(res) || !isCount(res.total)) throw new Error(`unexpected response shape from ${route}`);
        const rows = rowsOrThrow<CapabilityDTO>(res.items, route, capabilityRowOk);
        if (total !== null && res.total !== total) {
          throw new Error(`the capability list changed while it was read (${route} total ${total}, then ${res.total})`);
        }
        total = res.total;
        if (typeof res.offset === "number" && res.offset !== offset) {
          throw new Error(`${route} answered for offset ${res.offset} when offset ${offset} was asked`);
        }
        if (typeof res.hasMore === "boolean" && typeof res.limit === "number" && res.hasMore !== offset + res.limit < total) {
          throw new Error(`${route} hasMore disagrees with its offset, limit and total`);
        }
        for (const row of rows) {
          if (seen.has(row.id)) throw new Error(`${route} listed capability ${row.id} twice`);
          seen.add(row.id);
        }
        items.push(...rows);
        if (items.length > total) throw new Error(`${route} returned more rows than its total of ${total}`);
        if (items.length === total || rows.length === 0) break;
      }
      const read = total ?? 0;
      return { items, total: read, complete: items.length === read };
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
 * because finishing the work never makes the money final. A 404, 401 or 403 is final (no
 * retry), and the page then shows only that refusal, never data cached from an earlier read;
 * any other failure is retried once and then surfaces as an error. It never falls back to
 * fixtures. The cache is cleared when the signed-in identity changes (onIdentityChange).
 */
export function useJobExecution(jobId: string | undefined) {
  return useQuery<JobExecutionDTO>({
    queryKey: ["jobExecution", jobId],
    queryFn: () => api.getJobExecution(jobId!),
    enabled: !!jobId,
    retry: (failureCount, error) =>
      !(error instanceof ApiError && (error.status === 404 || error.status === 401 || error.status === 403)) && failureCount < 1,
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
 * a count when active is one too. Both must be counts, and the wildcard keys
 * are among the active ones (routes/agent-introspection.ts counts them from
 * the same list): anything else is unavailable, never shown (astra 18b F3).
 */
export function keyCounts(keys: unknown): { active: number; wildcardKeys: number } | null {
  if (!isRecord(keys) || keys.unavailable || !isCount(keys.active) || !isCount(keys.wildcard_keys) || keys.wildcard_keys > keys.active) {
    return null;
  }
  return { active: keys.active, wildcardKeys: keys.wildcard_keys };
}
