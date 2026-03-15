// ---------------------------------------------------------------------------
// Maps tool result types → UICard types for inline rendering
// ---------------------------------------------------------------------------

import type { UICard } from "./agent-types.js";

type CardExtractor = (toolName: string, result: Record<string, unknown>) => UICard[];

/** Infer card types from a tool result — deterministic mapping, no LLM involvement. */
export function extractCards(toolName: string, result: unknown): UICard[] {
  if (!result || typeof result !== "object") return [];
  const data = result as Record<string, unknown>;

  const extractor = cardExtractors[toolName];
  if (extractor) return extractor(toolName, data);

  return [];
}

const cardExtractors: Record<string, CardExtractor> = {
  search_capabilities: (_name, data) => {
    const templates = data.templates as unknown[];
    if (!templates?.length) return [];
    if (templates.length === 1) {
      return [{ type: "capability_card", data: { capability: templates[0] } }];
    }
    return [{ type: "capability_grid", data: { capabilities: templates } }];
  },

  list_capability_types: (_name, data) => {
    const types = data.types as string[];
    if (!types?.length) return [];
    return [{ type: "capability_grid", data: { types } }];
  },

  get_build_options: (_name, data) => {
    if (data.options) return [{ type: "capability_card", data: { options: data.options } }];
    return [];
  },

  calculate_price: (_name, data) => {
    if (data.pricing) return [{ type: "price_breakdown", data: { pricing: data.pricing } }];
    return [];
  },

  build_contract: (_name, data) => {
    if (data.contract) return [{ type: "contract_summary", data: { contract: data.contract } }];
    return [];
  },

  list_kernels: (_name, data) => {
    const kernels = data.kernels as unknown[];
    if (!kernels?.length) return [];
    return kernels.slice(0, 4).map((k) => ({
      type: "kernel_card" as const,
      data: { kernel: k },
    }));
  },

  get_kernel: (_name, data) => {
    if (data.kernel) return [{ type: "kernel_card", data: { kernel: data.kernel } }];
    return [];
  },

  list_jobs: (_name, data) => {
    const jobs = data.jobs as Record<string, unknown>[];
    if (!jobs?.length) return [];
    return jobs.slice(0, 3).map((j) => ({
      type: "job_progress" as const,
      data: { job: j },
    }));
  },

  get_job: (_name, data) => {
    if (data.job) return [{ type: "job_progress", data: { job: data.job } }];
    return [];
  },

  list_escrows: (_name, data) => {
    const escrows = data.escrows as unknown[];
    if (!escrows?.length) return [];
    return escrows.slice(0, 3).map((e) => ({
      type: "escrow_summary" as const,
      data: { escrow: e },
    }));
  },

  get_escrow: (_name, data) => {
    if (data.escrow) return [{ type: "escrow_summary", data: { escrow: data.escrow } }];
    return [];
  },

  get_depin_stats: (_name, data) => [{ type: "depin_stats", data }],

  check_wallet_status: (_name, data) => {
    if (!data.connected) return [{ type: "wallet_connect", data: {} }];
    return [];
  },
};
