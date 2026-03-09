const BASE_URL = "/api";

let sessionId: string | undefined;

async function fetchAPI<T>(path: string, options?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
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

  // Capabilities
  getCapabilityTypes: () => fetchAPI<{ types: string[] }>("/capabilities/types"),
  getCapabilityTemplates: () => fetchAPI<{ templates: unknown[] }>("/capabilities/templates"),

  // Build (contract builder)
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

  // Jobs
  getJobs: () => fetchAPI<{ jobs: unknown[] }>("/jobs"),
  getJob: (jobId: string) => fetchAPI<{ job: unknown }>(`/jobs/${jobId}`),

  // Kernels
  getKernels: () => fetchAPI<{ kernels: unknown[] }>("/kernels"),
  getKernel: (kernelId: string) => fetchAPI<{ kernel: unknown }>(`/kernels/${kernelId}`),

  // Escrow
  getEscrows: () => fetchAPI<{ escrows: unknown[] }>("/escrow"),
  getEscrow: (escrowId: string) => fetchAPI<{ escrow: unknown }>(`/escrow/${escrowId}`),

  // Agents
  getConversations: () => fetchAPI<{ conversations: unknown[] }>("/agents/conversations"),
  getConversation: (convId: string) => fetchAPI<{ conversation: unknown }>(`/agents/conversations/${convId}`),
};
