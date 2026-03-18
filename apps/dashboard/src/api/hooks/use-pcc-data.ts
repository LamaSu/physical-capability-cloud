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
 */

import { useQuery } from "@tanstack/react-query";
import { api } from "../gateway.js";

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

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

export function useJobs() {
  return useQuery({
    queryKey: ["jobs"],
    queryFn: async () => {
      const res = await api.getJobs();
      return (res.jobs ?? []) as any[];
    },
    retry: 1,
    staleTime: 10_000,
  });
}

export function useJob(jobId: string | undefined) {
  return useQuery({
    queryKey: ["job", jobId],
    queryFn: () => api.getJob(jobId!),
    enabled: !!jobId,
    retry: 1,
  });
}

// ---------------------------------------------------------------------------
// Kernels
// ---------------------------------------------------------------------------

export function useKernels() {
  return useQuery({
    queryKey: ["kernels"],
    queryFn: async () => {
      const res = await api.getKernels();
      return (res.kernels ?? []) as any[];
    },
    retry: 1,
    staleTime: 15_000,
  });
}

export function useKernel(kernelId: string | undefined) {
  return useQuery({
    queryKey: ["kernel", kernelId],
    queryFn: () => api.getKernel(kernelId!),
    enabled: !!kernelId,
    retry: 1,
  });
}

// ---------------------------------------------------------------------------
// Escrow
// ---------------------------------------------------------------------------

export function useEscrows() {
  return useQuery({
    queryKey: ["escrows"],
    queryFn: async () => {
      const res = await api.getEscrows();
      return (res.escrows ?? []) as any[];
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
      return (res.conversations ?? []) as any[];
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
      return (res.epochs ?? []) as any[];
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
