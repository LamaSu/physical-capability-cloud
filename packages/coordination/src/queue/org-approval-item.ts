/**
 * OrgApprovalItem — the exact wire contract from
 * ai/research/unified-control-plane/UI-COORDINATION.md §9.1 (contract (a),
 * "fully ours"): `GET /org/approvals?status&persona` returns
 * `OrgApprovalItem[]`; `POST /org/approvals/:id/resolve` takes
 * `{approved, editedArgs?, resolvedBy}` and returns the resolved item.
 *
 * SCOPE DECISION (documented, not silent — same practice as
 * snapshot/facade-snapshot.ts): `queue/human-queue.ts`'s internal
 * `HumanQueueItem` was built against `@pcc/agent-support`'s `Escalation`
 * shape (severity x category x ack/resolve) plus dispatch-linkage fields
 * (`dispatchRunId`, `acknowledged`) that the spec's `OrgApprovalItem` has no
 * slot for. Rather than reshape the durable SQLite schema around a wire
 * contract (and lose the dispatch-linkage this package's durability guarantee
 * depends on), this module is a pure, additive mapping layer — the same
 * pattern `~/.claude/lib/genui/contracts.js` already uses for its own
 * `QueueItem` <-> `Intent` conversions. `listApprovals` / `resolveApproval`
 * are what a `GET /org/approvals` / `POST /org/approvals/:id/resolve` route
 * handler calls; the durable storage underneath never changes shape.
 *
 * Fields with no current internal analog are honestly absent rather than
 * faked:
 *   - `status: "expired"` — no SLA/timeout poller exists in this slice
 *     (`slaHours` / `defaultOnTimeout` are accordingly never set either).
 *   - `evidenceRefs` — no evidence linkage in this slice.
 * Derivations that DO have a principled source:
 *   - `authorityClass` — "mutate" if the item carries a dispatchable
 *     `action` (approval will cause a `@pcc/workflow` run), else "observe"
 *     (pure escalation, nothing to dispatch).
 *   - `trustLevel` — mapped from `authorityClass` via the SAME
 *     observe/mutate/actuate/privileged -> read/write/exec/credential
 *     scheme the harness's own action-policy uses
 *     (`rules/library/security-pipeline.md`), for consistency.
 *   - `persona` — mirrors `contracts.js`'s own heuristic
 *     (`lens: requiredAuthority === 'observe' ? 'user' : 'orchestrator'`).
 *   - `createdBy` — reuses org-bus.ts's `ORG_BUS_FROM` identity constant.
 */

import { ORG_BUS_FROM } from "../events/org-bus.js";
import {
  type HumanQueueItem,
  type HumanQueueStatus,
  type HumanQueueStore,
} from "./human-queue.js";

export type OrgApprovalSource = "brain-proposal" | "reaction-escalation";
export type OrgAuthorityClass = "observe" | "mutate" | "actuate" | "privileged";
export type OrgTrustLevel = "read" | "write" | "exec" | "network" | "credential" | "settlement";
export type OrgPersona = "user" | "operator" | "orchestrator";
export type OrgSeverity = "info" | "warn" | "critical";
export type OrgApprovalStatus = "pending" | "approved" | "rejected" | "resolved" | "expired";

export interface OrgIntent {
  capabilityId?: string;
  action: string;
  args?: Record<string, unknown>;
  description: string;
}

export interface OrgVerdict {
  approved: boolean;
  resolvedBy?: string;
  resolvedAt?: string;
}

export interface OrgApprovalItem {
  id: string;
  ts: string;
  source: OrgApprovalSource;
  intent: OrgIntent;
  authorityClass: OrgAuthorityClass;
  trustLevel: OrgTrustLevel;
  persona: OrgPersona;
  rationale: string;
  severity: OrgSeverity;
  category: string;
  status: OrgApprovalStatus;
  slaHours?: number;
  defaultOnTimeout?: "hold" | "reject";
  evidenceRefs?: string[];
  createdBy: string;
  verdict?: OrgVerdict;
}

const AUTHORITY_TO_TRUST: Record<OrgAuthorityClass, OrgTrustLevel> = {
  observe: "read",
  mutate: "write",
  actuate: "exec",
  privileged: "credential",
};

const SEVERITY_MAP: Record<HumanQueueItem["severity"], OrgSeverity> = {
  critical: "critical",
  high: "warn",
  medium: "warn",
  low: "info",
  info: "info",
};

/** Internal statuses collapse 1:1 except `acknowledged`, which the contract
 *  has no slot for — an acknowledged-but-undecided item is still "pending"
 *  from a caller-deciding-approve/reject point of view. */
function mapStatus(status: HumanQueueStatus): OrgApprovalStatus {
  return status === "acknowledged" ? "pending" : status;
}

function deriveAuthorityClass(item: HumanQueueItem): OrgAuthorityClass {
  return item.action ? "mutate" : "observe";
}

export function toOrgApprovalItem(item: HumanQueueItem): OrgApprovalItem {
  const authorityClass = deriveAuthorityClass(item);
  const verdict: OrgVerdict | undefined =
    item.status === "approved" || item.status === "rejected" || item.status === "resolved"
      ? { approved: item.status !== "rejected", resolvedAt: item.resolvedAt ?? item.updatedAt }
      : undefined;

  return {
    id: item.id,
    ts: item.createdAt,
    source: "reaction-escalation",
    intent: {
      action: item.action?.workflowName ?? item.category,
      ...(item.action?.args !== undefined ? { args: item.action.args } : {}),
      description: item.title,
    },
    authorityClass,
    trustLevel: AUTHORITY_TO_TRUST[authorityClass],
    persona: authorityClass === "observe" ? "user" : "orchestrator",
    rationale: item.details,
    severity: SEVERITY_MAP[item.severity],
    category: item.category,
    status: mapStatus(item.status),
    createdBy: ORG_BUS_FROM,
    ...(verdict !== undefined ? { verdict } : {}),
  };
}

export interface ListApprovalsFilter {
  status?: OrgApprovalStatus;
  persona?: OrgPersona;
}

/** `GET /org/approvals?status&persona` handler body. */
export function listApprovals(queue: HumanQueueStore, filter: ListApprovalsFilter = {}): OrgApprovalItem[] {
  // "expired" and "acknowledged" have no internal-status counterpart in
  // opposite directions (see mapStatus) — for "expired" there is simply
  // nothing to filter on internally (no producer of it yet), so we fetch
  // unfiltered and filter the mapped shape instead of trying to push an
  // unmappable status down into the SQL query.
  const internalStatus = filter.status && filter.status !== "expired" ? toInternalStatusForQuery(filter.status) : undefined;
  const rows = queue.list(internalStatus ? { status: internalStatus } : undefined);
  let mapped = rows.map(toOrgApprovalItem);
  if (filter.status) mapped = mapped.filter((i) => i.status === filter.status);
  if (filter.persona) mapped = mapped.filter((i) => i.persona === filter.persona);
  return mapped;
}

/** Only used to narrow the SQL-level query as an optimization; the
 *  authoritative filter still re-checks the mapped status afterward (a
 *  `pending` filter must also catch internal `acknowledged` rows). */
function toInternalStatusForQuery(status: OrgApprovalStatus): HumanQueueStatus | undefined {
  if (status === "pending" || status === "approved" || status === "rejected" || status === "resolved") {
    return status;
  }
  return undefined;
}

export interface ResolveApprovalInput {
  approved: boolean;
  editedArgs?: Record<string, unknown>;
  resolvedBy: string;
}

/** `POST /org/approvals/:id/resolve {approved, editedArgs?, resolvedBy}`
 *  handler body. On approve, the item becomes eligible for
 *  `dispatch/workflow-dispatch.ts`'s next `dispatchApproved()` pass (contract
 *  (c) — the Brain/queue never calls the broker directly; approval only
 *  flips a status bit here). `editedArgs`, if supplied, replaces the
 *  dispatchable action's args before dispatch. */
export function resolveApproval(
  queue: HumanQueueStore,
  id: string,
  input: ResolveApprovalInput,
): OrgApprovalItem {
  if (input.approved) {
    if (input.editedArgs !== undefined) {
      queue.replaceActionArgs(id, input.editedArgs);
    }
    const approved = queue.approve(id);
    return toOrgApprovalItem(approved);
  }
  queue.reject(id, input.resolvedBy);
  const rejected = queue.get(id);
  if (!rejected) throw new Error(`resolveApproval: item ${id} vanished after reject`);
  return toOrgApprovalItem(rejected);
}
