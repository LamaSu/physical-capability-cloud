/**
 * Live reads of the gateway's Sovereign Wealth Fund routes (routes/swf.ts),
 * limited to what those routes hold as real records.
 *
 * The fund service (packages/payments/src/swf/swf-service.ts) keeps its state
 * in the gateway's memory, so it is cleared whenever the gateway restarts.
 * Its participants, proposals and votes are what callers registered, proposed
 * and cast, and its allocation strategy is its configuration. The dashboard
 * shows those. Its money is not real:
 *   - every milestone release is booked as a fixed 1,000 USDC gross, whatever
 *     was released (facades/settlement.facade.ts, routes/settlement.ts);
 *   - POST /api/swf/epochs/:epochId/distribute scores participants with
 *     Math.random() and creates dividend claims from those scores;
 *   - GET /api/swf/summary's chainBalances is the ledger total labelled Base
 *     USDC (nothing reads a chain), and its lastDistributionAt is the current
 *     time when nothing was ever distributed.
 * So nothing here parses or returns balances, accruals, epochs or claims.
 */

import type { SWFAllocationStrategy, SWFProposal, SWFVote } from "@pcc/spec";
import { apiGet } from "./api.js";
import { authorizedFetch } from "./authorized-fetch.js";

/** Shown wherever these records are rendered live. */
export const SWF_MEMORY_NOTE =
  "The gateway holds fund participants, proposals and votes in memory; they are cleared when it restarts.";

/** The parts of GET /api/swf/summary that are real records. */
export interface FundState {
  /** Active participants: the denominator the gateway uses for quorum. */
  participantCount: number;
  activeProposals: number;
  strategy: SWFAllocationStrategy;
}

/** The proposal fields the dashboard renders. */
export type ProposalFields = Pick<
  SWFProposal,
  "id" | "title" | "description" | "status" | "proposedStrategy" | "yesVotes" | "noVotes" | "totalVoters" | "quorumRequired" | "votingEnd"
>;

/** The vote fields the dashboard renders. */
export type VoteFields = Pick<SWFVote, "id" | "participantId" | "vote" | "weight" | "votedAt">;

export interface ProposalDetail {
  proposal: ProposalFields;
  votes: VoteFields[];
}

export const FUND_STATE_QUERY_KEY = ["swf", "summary"] as const;

// ── Shape checks: a response that isn't what the route serves is a failed read ──

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isCount(value: unknown): value is number {
  return isNumber(value) && Number.isInteger(value) && value >= 0;
}

function parseStrategy(value: unknown): SWFAllocationStrategy | null {
  if (
    isRecord(value) &&
    isNumber(value.dividendPercent) &&
    isNumber(value.infrastructurePercent) &&
    isNumber(value.grantsPercent) &&
    isNumber(value.reservePercent)
  ) {
    return {
      dividendPercent: value.dividendPercent,
      infrastructurePercent: value.infrastructurePercent,
      grantsPercent: value.grantsPercent,
      reservePercent: value.reservePercent,
    };
  }
  return null;
}

const PROPOSAL_STATUSES: ReadonlySet<string> = new Set(["active", "passed", "rejected", "executed"]);
const VOTE_CHOICES: ReadonlySet<string> = new Set(["yes", "no", "abstain"]);

function unexpected(route: string): Error {
  return new Error(`Unexpected response from ${route}`);
}

export function parseFundState(body: unknown): FundState {
  const summary = isRecord(body) ? body.summary : undefined;
  const strategy = isRecord(summary) ? parseStrategy(summary.currentAllocationStrategy) : null;
  if (!isRecord(summary) || !strategy || !isCount(summary.participantCount) || !isCount(summary.activeProposals)) {
    throw unexpected("/api/swf/summary");
  }
  return { participantCount: summary.participantCount, activeProposals: summary.activeProposals, strategy };
}

function parseProposal(value: unknown, route: string): ProposalFields {
  const proposedStrategy = isRecord(value) ? parseStrategy(value.proposedStrategy) : null;
  if (
    !isRecord(value) ||
    !proposedStrategy ||
    typeof value.id !== "string" ||
    typeof value.title !== "string" ||
    typeof value.description !== "string" ||
    typeof value.status !== "string" ||
    !PROPOSAL_STATUSES.has(value.status) ||
    !isNumber(value.yesVotes) ||
    !isNumber(value.noVotes) ||
    !isCount(value.totalVoters) ||
    !isNumber(value.quorumRequired) ||
    typeof value.votingEnd !== "string"
  ) {
    throw unexpected(route);
  }
  return {
    id: value.id,
    title: value.title,
    description: value.description,
    status: value.status as SWFProposal["status"],
    proposedStrategy,
    yesVotes: value.yesVotes,
    noVotes: value.noVotes,
    totalVoters: value.totalVoters,
    quorumRequired: value.quorumRequired,
    votingEnd: value.votingEnd,
  };
}

function parseVote(value: unknown, route: string): VoteFields {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.participantId !== "string" ||
    typeof value.vote !== "string" ||
    !VOTE_CHOICES.has(value.vote) ||
    !isNumber(value.weight) ||
    typeof value.votedAt !== "string"
  ) {
    throw unexpected(route);
  }
  return {
    id: value.id,
    participantId: value.participantId,
    vote: value.vote as SWFVote["vote"],
    weight: value.weight,
    votedAt: value.votedAt,
  };
}

// ── Reads ────────────────────────────────────────────────────────

/** GET /api/swf/summary, without its money fields. */
export async function readFundState(): Promise<FundState> {
  return parseFundState(await apiGet<unknown>("/swf/summary"));
}

/** GET /api/swf/proposals?status=active. */
export async function readActiveProposals(): Promise<ProposalFields[]> {
  const route = "/api/swf/proposals";
  const body = await apiGet<unknown>("/swf/proposals?status=active");
  const list = isRecord(body) ? body.proposals : undefined;
  if (!Array.isArray(list)) throw unexpected(route);
  return list.map((p) => parseProposal(p, route));
}

async function errorMessage(res: Response): Promise<string> {
  try {
    const json = (await res.json()) as { error?: unknown; message?: unknown };
    if (typeof json.message === "string" && json.message) return json.message;
    if (typeof json.error === "string" && json.error) return json.error;
  } catch {
    // not JSON: keep the status
  }
  return `API error: ${res.status}`;
}

/**
 * GET /api/swf/proposals/:proposalId: the proposal and its votes, or null when
 * the gateway answers that it has no such proposal. Any other failure throws.
 */
export async function readProposal(proposalId: string): Promise<ProposalDetail | null> {
  const route = "/api/swf/proposals/:proposalId";
  const res = await authorizedFetch(`/api/swf/proposals/${encodeURIComponent(proposalId)}`);
  if (res.status === 404) {
    // The route's own answer for an unknown id; a 404 for a missing route is a failure, not "no such proposal".
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    if (isRecord(body) && body.error === "not_found") return null;
    const message = isRecord(body) && typeof body.message === "string" ? body.message : "API error: 404";
    throw new Error(message);
  }
  if (!res.ok) throw new Error(await errorMessage(res));
  const body: unknown = await res.json();
  if (!isRecord(body) || !Array.isArray(body.votes)) throw unexpected(route);
  return {
    proposal: parseProposal(body.proposal, route),
    votes: body.votes.map((v) => parseVote(v, route)),
  };
}
