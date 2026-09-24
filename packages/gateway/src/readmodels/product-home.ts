/**
 * ProductHomeDTO (@pcc/spec readmodels/product-home.ts): the loader (one pass over the
 * store) and the pure builder. Each section is read separately; a section whose read fails,
 * or that the route withholds from this caller, is `unavailable` with a reason, never a zero.
 */
import {
  HELD_MILESTONE_STATUSES,
  NETWORK_CHAIN_IDS,
  NOT_HELD_MILESTONE_STATUSES,
  PRODUCT_HOME_SCHEMA_ID,
  currencyDecimals,
  executionPhaseOf,
  isTerminalExecutionPhase,
  normalizeMoneyStatus,
  toBaseUnits,
  type ExecutionPhase,
  type ProductHomeCapabilities,
  type ProductHomeCapabilityType,
  type ProductHomeDTO,
  type ProductHomeEscrowHeld,
  type ProductHomeHeldAmount,
  type ProductHomeJobs,
  type ProductHomeKernels,
} from "@pcc/spec";
import { ACTIVE_LISTING_GRACE_MS, STALE_HEARTBEAT_MS, isKernelStale } from "../facades/populators/staleness.js";
import { MOCK_ESCROW_ADDRESS_PREFIX, type SourceRead } from "./job-execution.js";

export interface HomeKernelRow {
  id: string;
  status?: string | null;
  lastHeartbeat?: string | null;
}
export interface HomeCapabilityRow {
  kernelId: string;
  type?: string | null;
}
export interface HomeJobRow {
  status?: string | null;
}
export interface HomeEscrowRow {
  id: string;
  contractAddress?: string | null;
  currency?: string | null;
}
export interface HomeMilestoneRow {
  escrowId: string;
  amount?: string | null;
  status?: string | null;
}

/** A source the route chose not to read for this caller, with the reason the caller is shown. */
export interface SourceWithheld {
  ok: false;
  withheld: string;
}
export type HomeSource<T> = SourceRead<T> | SourceWithheld;

export interface ProductHomeSources {
  kernels: SourceRead<{ kernels: HomeKernelRow[]; capabilities: HomeCapabilityRow[] }>;
  jobs: HomeSource<HomeJobRow[]>;
  escrow: HomeSource<{ escrows: HomeEscrowRow[]; milestones: HomeMilestoneRow[] }>;
  /** The configured network name (PCC_NETWORK, default base-sepolia). */
  network: string | null;
}

const ALL_PHASES: readonly ExecutionPhase[] = [
  "pending", "queued", "dispatched", "running", "awaiting_handoff", "paused",
  "completed", "failed", "timed_out", "cancelled", "unknown",
];

const KERNEL_RULE =
  `online = status "online" and a heartbeat within ${STALE_HEARTBEAT_MS / 60_000} minutes ` +
  `(${ACTIVE_LISTING_GRACE_MS / 3_600_000} hours for a kernel that lists a capability); ` +
  `an online kernel past that is stale`;

const HELD = new Set(HELD_MILESTONE_STATUSES);
const NOT_HELD = new Set(NOT_HELD_MILESTONE_STATUSES);

type KernelState = "online" | "stale" | "other";

function kernelStates(src: { kernels: HomeKernelRow[]; capabilities: HomeCapabilityRow[] }, nowMs: number): Map<string, KernelState> {
  const listing = new Set(src.capabilities.map((c) => c.kernelId));
  const states = new Map<string, KernelState>();
  for (const k of src.kernels) {
    if (k.status !== "online") states.set(k.id, "other");
    else if (isKernelStale(k.status ?? undefined, k.lastHeartbeat ?? null, listing.has(k.id), nowMs)) states.set(k.id, "stale");
    else states.set(k.id, "online");
  }
  return states;
}

export function buildKernels(src: { kernels: HomeKernelRow[]; capabilities: HomeCapabilityRow[] }, nowMs: number): ProductHomeKernels {
  const counts: Record<KernelState, number> = { online: 0, stale: 0, other: 0 };
  for (const state of kernelStates(src, nowMs).values()) counts[state]++;
  return { state: "read", total: src.kernels.length, ...counts, rule: KERNEL_RULE, source: "gateway_kernel_rows" };
}

/** A capability counts as on an online kernel only when its kernel row exists and is online by the kernel rule. */
export function buildCapabilities(
  src: { kernels: HomeKernelRow[]; capabilities: HomeCapabilityRow[] },
  nowMs: number,
): ProductHomeCapabilities {
  const states = kernelStates(src, nowMs);
  const byType = new Map<string | null, ProductHomeCapabilityType>();
  let onOnline = 0;
  for (const c of src.capabilities) {
    const type = typeof c.type === "string" && c.type.trim() !== "" ? c.type.trim() : null;
    const t = byType.get(type) ?? { type, total: 0, onOnlineKernels: 0 };
    t.total++;
    if (states.get(c.kernelId) === "online") {
      t.onOnlineKernels++;
      onOnline++;
    }
    byType.set(type, t);
  }
  const sorted = [...byType.values()].sort((a, b) =>
    a.type === b.type ? 0 : a.type === null ? 1 : b.type === null ? -1 : a.type < b.type ? -1 : 1,
  );
  return { state: "read", total: src.capabilities.length, onOnlineKernels: onOnline, byType: sorted, source: "gateway_capability_rows" };
}

export function buildJobs(rows: HomeJobRow[]): ProductHomeJobs {
  const byPhase = Object.fromEntries(ALL_PHASES.map((p) => [p, 0])) as Record<ExecutionPhase, number>;
  let active = 0;
  for (const j of rows) {
    const phase = executionPhaseOf(j.status);
    byPhase[phase]++;
    if (phase !== "unknown" && !isTerminalExecutionPhase(phase)) active++;
  }
  return { state: "read", total: rows.length, active, byPhase, source: "gateway_job_rows" };
}

export function buildEscrowHeld(src: { escrows: HomeEscrowRow[]; milestones: HomeMilestoneRow[] }): ProductHomeEscrowHeld {
  const escrowById = new Map(src.escrows.map((e) => [e.id, e]));
  const simulated = new Set(
    src.escrows.filter((e) => String(e.contractAddress ?? "").startsWith(MOCK_ESCROW_ADDRESS_PREFIX)).map((e) => e.id),
  );
  const sums = new Map<string, { decimals: number; sum: bigint; milestones: number }>();
  let uncounted = 0;
  let unclassified = 0;
  for (const ms of src.milestones) {
    if (simulated.has(ms.escrowId)) continue;
    const word = normalizeMoneyStatus(ms.status);
    if (!HELD.has(word)) {
      if (!NOT_HELD.has(word)) unclassified++;
      continue;
    }
    const escrow = escrowById.get(ms.escrowId);
    const currency = typeof escrow?.currency === "string" && escrow.currency.trim() !== "" ? escrow.currency.trim().toUpperCase() : null;
    const decimals = currencyDecimals(currency);
    const base = toBaseUnits(ms.amount, decimals);
    if (currency == null || decimals == null || base == null) {
      uncounted++;
      continue;
    }
    const t = sums.get(currency) ?? { decimals, sum: 0n, milestones: 0 };
    t.sum += BigInt(base);
    t.milestones++;
    sums.set(currency, t);
  }
  const byCurrency: ProductHomeHeldAmount[] = [...sums.entries()]
    .map(([currency, t]) => ({ currency, decimals: t.decimals, amountBaseUnits: t.sum.toString(), milestones: t.milestones }))
    .sort((a, b) => (a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : 0));
  return {
    state: "read",
    byCurrency,
    uncountedMilestones: uncounted,
    unclassifiedMilestones: unclassified,
    excludedSimulatedEscrows: simulated.size,
    heldStatuses: HELD_MILESTONE_STATUSES,
    source: "gateway_escrow_record",
    confirmation: "record_only",
  };
}

const unavailable = (src: { ok: false } | SourceWithheld, what: string) => ({
  state: "unavailable" as const,
  reason: "withheld" in src ? src.withheld : `The gateway's ${what} could not be read.`,
});

export function buildProductHomeDTO(src: ProductHomeSources, asOf: string): ProductHomeDTO {
  const nowMs = Date.parse(asOf);
  const name = typeof src.network === "string" && src.network.trim() !== "" ? src.network.trim() : null;
  return {
    schemaId: PRODUCT_HOME_SCHEMA_ID,
    asOf,
    kernels: src.kernels.ok ? buildKernels(src.kernels.value, nowMs) : unavailable(src.kernels, "kernel records"),
    capabilities: src.kernels.ok ? buildCapabilities(src.kernels.value, nowMs) : unavailable(src.kernels, "kernel and capability records"),
    jobs: src.jobs.ok ? buildJobs(src.jobs.value) : unavailable(src.jobs, "job records"),
    settlementNetwork: {
      name,
      chainId: name != null && Object.prototype.hasOwnProperty.call(NETWORK_CHAIN_IDS, name) ? NETWORK_CHAIN_IDS[name]! : null,
      basis: "gateway_config",
    },
    escrowHeld: src.escrow.ok ? buildEscrowHeld(src.escrow.value) : unavailable(src.escrow, "escrow records"),
  };
}
