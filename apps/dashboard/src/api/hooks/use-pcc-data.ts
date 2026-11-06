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
} from "../../types/dto.js";
import { KNOWN_KERNEL_STATUSES, isCount, isInRange } from "../wire-vocabulary.js";

// ---------------------------------------------------------------------------
// Wire guards
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const isText = (v: unknown): v is string => typeof v === "string" && v !== "";

/** Kernel reads stay strict: an unreadable row makes the whole read unavailable. */
function rowsOrThrow<T>(list: unknown, route: string, rowOk: (row: Record<string, unknown>) => boolean): T[] {
  if (!Array.isArray(list)) throw new Error(`unexpected response shape from ${route}`);
  if (!list.every((row) => isRecord(row) && rowOk(row))) throw new Error(`unexpected row in the response from ${route}`);
  return list as T[];
}

/** Absent, or present and valid: for fields a page marks unknown when absent. */
const optional = (v: unknown, ok: (v: unknown) => boolean) => v === undefined || v === null || ok(v);

/** "Online" needs a known status and the staleness flag the gateway always sets. */
const kernelRowOk = (r: Record<string, unknown>) =>
  isText(r.id) && isText(r.status) && KNOWN_KERNEL_STATUSES.has(r.status) && typeof r.isStale === "boolean";

/** Fields used to group, count and rank a capability must be readable when present. */
const capabilityRowOk = (r: Record<string, unknown>) =>
  isText(r.id) &&
  isText(r.kernelId) &&
  isText(r.type) &&
  optional(r.name, (v) => typeof v === "string") &&
  optional(r.queueDepth, isCount) &&
  optional(r.assuranceScore, (v) => isInRange(v, 0, 1)) &&
  optional(r.reputation, (v) => isInRange(v, 0, 1000));

/** Leave unreadable capabilities out and count them independently of page completeness. */
function readableCapabilities(rows: unknown[]): { items: CapabilityDTO[]; skipped: number } {
  const items = rows.filter((row) => isRecord(row) && capabilityRowOk(row)) as CapabilityDTO[];
  return { items, skipped: rows.length - items.length };
}

/** Every JSON row participates in paging checks, including rows left out of the catalog. */
const capabilityIdentity = (row: unknown): string =>
  isRecord(row) && isText(row.id) ? row.id : JSON.stringify(row);

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
  return useQuery<PaginatedResult<CapabilityDTO> & { skipped: number }>({
    queryKey: ["capabilities", params],
    queryFn: async () => {
      const res = await api.getCapabilities(params);
      if (!isRecord(res) || !isCount(res.total) || !Array.isArray(res.items)) {
        throw new Error("unexpected response shape from /api/capabilities");
      }
      return { ...res, ...readableCapabilities(res.items) };
    },
    retry: 1,
    staleTime: 30_000,
  });
}

/** GET /api/capabilities serves at most this many rows per request (routes/capabilities.ts). */
export const CAPABILITIES_PAGE_LIMIT = 200;
/** Stop paging after this many pages; what was read is then marked incomplete. */
export const CAPABILITIES_MAX_PAGES = 25;

/** The capabilities kept from a paged read, with page completeness and unreadable-row counts. */
export interface AllCapabilities {
  items: CapabilityDTO[];
  total: number;
  /** Whether every listed row was read, including rows left out as unreadable. */
  complete: boolean;
  /** Initial pages combined into the list, excluding the consistency re-read. */
  pages: number;
  skipped: number;
}

/**
 * Read every page of the public capability list. Total, offset, hasMore,
 * repeated-row and row-count checks apply to every row, including unreadable
 * rows. An empty page before the total or the page cap makes the read partial.
 * A complete read spanning several pages re-reads every page but the last,
 * in order, and compares total and row identities. The gateway has no snapshot
 * across pages, so a changed earlier page makes the whole read fail.
 */
export function useAllCapabilities() {
  return useQuery<AllCapabilities>({
    queryKey: ["capabilities", "all"],
    queryFn: async () => {
      const route = "/api/capabilities";
      const readPage = async (offset: number) => {
        const res = await api.getCapabilities({ offset, limit: CAPABILITIES_PAGE_LIMIT });
        if (!isRecord(res) || !isCount(res.total) || !Array.isArray(res.items)) {
          throw new Error(`unexpected response shape from ${route}`);
        }
        if (typeof res.offset !== "number" || typeof res.limit !== "number" || typeof res.hasMore !== "boolean") {
          throw new Error(`unexpected response shape from ${route}`);
        }
        return res as { items: unknown[]; total: number; offset: number; limit: number; hasMore: boolean };
      };

      const items: CapabilityDTO[] = [];
      const seen = new Set<string>();
      let total: number | null = null;
      let pages = 0;
      let skipped = 0;
      let rowsRead = 0;
      const pageIds: Array<{ offset: number; ids: string[] }> = [];
      for (let page = 0; page < CAPABILITIES_MAX_PAGES; page++) {
        const offset = rowsRead;
        const res = await readPage(offset);
        const rows = res.items;
        if (total !== null && res.total !== total) {
          throw new Error(`the capability list changed while it was read (${route} total ${total}, then ${res.total})`);
        }
        total = res.total;
        if (res.offset !== offset) {
          throw new Error(`${route} answered for offset ${res.offset} when offset ${offset} was asked`);
        }
        if (res.hasMore !== offset + res.limit < total) {
          throw new Error(`${route} hasMore disagrees with its offset, limit and total`);
        }
        const ids = rows.map(capabilityIdentity);
        for (const id of ids) {
          if (seen.has(id)) throw new Error(`${route} listed capability ${id} twice`);
          seen.add(id);
        }
        pageIds.push({ offset, ids });
        const readable = readableCapabilities(rows);
        items.push(...readable.items);
        skipped += readable.skipped;
        rowsRead += rows.length;
        pages++;
        if (rowsRead > total) throw new Error(`${route} returned more rows than its total of ${total}`);
        if (rowsRead === total || rows.length === 0) break;
      }

      const read = total ?? 0;
      const complete = rowsRead === read;
      if (complete && pages > 1) {
        for (const first of pageIds.slice(0, -1)) {
          const reread = await readPage(first.offset);
          const ids = reread.items.map(capabilityIdentity);
          const unchanged = reread.total === total && ids.length === first.ids.length && ids.every((id, i) => id === first.ids[i]);
          if (!unchanged) {
            throw new Error(`the capability list changed while it was read (a re-read of ${route} at offset ${first.offset} no longer matches)`);
          }
        }
      }
      return { items, total: read, complete, pages, skipped };
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
 * Product read model for one job (PX-6). Route: GET /api/jobs/:jobId/execution.
 * Always polls: every 15s while the work is in motion, every 60s once it is finished,
 * because finishing the work never makes the money final. A 404, 401 or 403 is final (no
 * retry), and the page then shows only that refusal, never data cached from an earlier read;
 * any other failure is retried once and then surfaces as an error. It never falls back to
 * fixtures. Polling pauses while the tab is hidden. The cache is cleared when the signed-in
 * identity changes (onIdentityChange).
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
export function useKernels(params?: { status?: string }) {
  return useQuery<KernelDTO[]>({
    queryKey: ["kernels", params],
    queryFn: async () => {
      const res = await api.getKernels(params);
      // Missing rows or a row without its status and staleness flag fail the read.
      return rowsOrThrow<KernelDTO>(res?.kernels, "/api/kernels", kernelRowOk);
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
      // Route wraps result in { escrows: [...] } for backward compat.
      return res.escrows ?? [];
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

export function useGatewayHealth() {
  return useQuery({
    queryKey: ["health"],
    queryFn: () => api.health(),
    retry: 0,
    staleTime: 30_000,
  });
}
