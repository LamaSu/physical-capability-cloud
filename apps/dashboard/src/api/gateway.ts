import { getAuthHeaders } from "../stores/auth-store.js";
import type {
  CapabilityDTO,
  JobDTO,
  JobDetailDTO,
  KernelDTO,
  KernelHealthSnapshot,
  EscrowSummaryDTO,
  ComplianceReportDTO,
  DriftAlertDTO,
  EvidenceSummaryDTO,
  PaginatedResult,
} from "../types/dto.js";

const BASE_URL = "/api";

let sessionId: string | undefined;

async function fetchAPI<T>(path: string, options?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...getAuthHeaders(),
    ...(sessionId ? { "x-pcc-session": sessionId } : {}),
  };

  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: { ...headers, ...options?.headers },
  });

  if (!res.ok) {
    throw new Error(`API error: ${res.status} ${res.statusText}`);
  }

  // Capture session ID from response if returned
  const newSession = res.headers.get("x-pcc-session");
  if (newSession) sessionId = newSession;

  return res.json();
}

export const api = {
  // Health
  health: () => fetchAPI<{ status: string }>("/health"),

  // ── Capabilities ─────────────────────────────────────────────────────────

  /** List capability type strings (e.g. "3d-printing", "cnc"). */
  getCapabilityTypes: () => fetchAPI<{ types: string[] }>("/capabilities/types"),

  /** List capability templates with metadata. */
  getCapabilityTemplates: () => fetchAPI<{ templates: unknown[] }>("/capabilities/templates"),

  /**
   * List all capability instances across kernels.
   * Returns PaginatedResult<CapabilityDTO> directly (no envelope wrapper).
   * Supports optional pagination: offset, limit.
   */
  getCapabilities: (params?: { offset?: number; limit?: number }) => {
    const qs = new URLSearchParams();
    if (params?.offset != null) qs.set("offset", String(params.offset));
    if (params?.limit != null) qs.set("limit", String(params.limit));
    const query = qs.toString() ? `?${qs.toString()}` : "";
    return fetchAPI<PaginatedResult<CapabilityDTO>>(`/capabilities${query}`);
  },

  /** Get a single capability by ID with full enrichment. */
  getCapability: (capabilityId: string) =>
    fetchAPI<CapabilityDTO>(`/capabilities/${capabilityId}`),

  /**
   * Get compliance report for a capability.
   * NOTE: This route does not yet exist in the gateway — returns 404 until added.
   * The hook is enabled: false by default until capabilityId is provided.
   */
  getComplianceReport: (capabilityId: string) =>
    fetchAPI<ComplianceReportDTO>(`/capabilities/${capabilityId}/compliance`),

  // ── Build (contract builder) ──────────────────────────────────────────────

  getBuildOptions: (type: string, selections?: Record<string, unknown>, profileId?: string) =>
    fetchAPI<{ options: unknown }>("/build/options", {
      method: "POST",
      body: JSON.stringify({ type, selections, profileId }),
    }),

  calculatePrice: (type: string, selections: Record<string, unknown>, profileId?: string) =>
    fetchAPI<{ pricing: unknown }>("/build/price", {
      method: "POST",
      body: JSON.stringify({ type, selections, profileId }),
    }),

  buildContract: (type: string, selections: Record<string, unknown>, assuranceTier: number, profileId?: string) =>
    fetchAPI<{ contract: unknown }>("/build/contract", {
      method: "POST",
      body: JSON.stringify({ type, selections, assuranceTier, profileId }),
    }),

  // ── Jobs ─────────────────────────────────────────────────────────────────

  /**
   * List jobs with optional filtering.
   * Route returns backward-compat { jobs: JobDTO[] } envelope.
   * Accepts optional kernelId, status, offset, limit query params.
   */
  getJobs: (params?: { kernelId?: string; status?: string; offset?: number; limit?: number }) => {
    const qs = new URLSearchParams();
    if (params?.kernelId) qs.set("kernelId", params.kernelId);
    if (params?.status) qs.set("status", params.status);
    if (params?.offset != null) qs.set("offset", String(params.offset));
    if (params?.limit != null) qs.set("limit", String(params.limit));
    const query = qs.toString() ? `?${qs.toString()}` : "";
    return fetchAPI<{ jobs: JobDTO[] }>(`/jobs${query}`);
  },

  /**
   * Get a single job by ID.
   * Route returns backward-compat { job: JobDetailDTO, evidence: EvidenceSummaryDTO[] }.
   */
  getJob: (jobId: string) =>
    fetchAPI<{ job: JobDetailDTO; evidence: EvidenceSummaryDTO[] }>(`/jobs/${jobId}`),

  /**
   * Get drift alerts for a job.
   * NOTE: This route does not yet exist in the gateway — returns 404 until added.
   */
  getDriftAlerts: (jobId: string) =>
    fetchAPI<DriftAlertDTO[]>(`/jobs/${jobId}/drift-alerts`),

  // ── Kernels ───────────────────────────────────────────────────────────────

  /**
   * List all kernels.
   * Route returns backward-compat { kernels: KernelDTO[] } envelope.
   * Supports optional ?status= filter.
   */
  getKernels: (params?: { status?: string }) => {
    const qs = new URLSearchParams();
    if (params?.status) qs.set("status", params.status);
    const query = qs.toString() ? `?${qs.toString()}` : "";
    return fetchAPI<{ kernels: KernelDTO[] }>(`/kernels${query}`);
  },

  /**
   * Get a single kernel by ID with health snapshot (devices + recent jobs).
   * Route returns backward-compat { kernel: KernelHealthSnapshot } envelope.
   */
  getKernel: (kernelId: string) =>
    fetchAPI<{ kernel: KernelHealthSnapshot }>(`/kernels/${kernelId}`),

  // ── Escrow ────────────────────────────────────────────────────────────────

  /**
   * List escrows.
   * Route returns backward-compat { escrows: EscrowSummaryDTO[] } envelope.
   * Supports optional ?status= filter.
   */
  getEscrows: (params?: { status?: string }) => {
    const qs = new URLSearchParams();
    if (params?.status) qs.set("status", params.status);
    const query = qs.toString() ? `?${qs.toString()}` : "";
    return fetchAPI<{ escrows: EscrowSummaryDTO[] }>(`/escrow${query}`);
  },

  /** Get a single escrow by ID or on-chain address. */
  getEscrow: (escrowId: string) =>
    fetchAPI<{ escrow: unknown; source: "on-chain" | "db" }>(`/escrow/${escrowId}`),

  // ── Agents ────────────────────────────────────────────────────────────────

  getConversations: () => fetchAPI<{ conversations: unknown[] }>("/agents/conversations"),
  getConversation: (convId: string) => fetchAPI<{ conversation: unknown }>(`/agents/conversations/${convId}`),

  // ── Settlement (ERC-4337 batch) ───────────────────────────────────────────

  getSettlementStatus: () => fetchAPI<{
    batchEnabled: boolean;
    pending: number;
    totalValue: string;
    smartAccountAddress: string | null;
  }>("/settlement/status"),

  getSettlementEpochs: () => fetchAPI<{ epochs: unknown[] }>("/settlement/epochs"),

  flushSettlement: () => fetchAPI<{
    epoch: number;
    totalIntents: number;
    batches: number;
  }>("/settlement/flush", { method: "POST" }),

  // ── Feedback ─────────────────────────────────────────────────────────────

  submitFeedback: (body: { type: string; message: string; page?: string }) =>
    fetchAPI<{ id: string; submitted: boolean }>("/feedback", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  getFeedback: () => fetchAPI<{ count: number; entries: unknown[] }>("/feedback"),

  // ── Agent Chat (streaming — returns raw Response for SSE consumption) ─────

  agentChat: (body: {
    system: string;
    messages: unknown[];
    tools?: unknown[];
    max_tokens?: number;
    stream?: boolean;
  }): Promise<Response> =>
    fetch(`${BASE_URL}/agent/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...getAuthHeaders(),
        ...(sessionId ? { "x-pcc-session": sessionId } : {}),
      },
      body: JSON.stringify(body),
    }),
};
