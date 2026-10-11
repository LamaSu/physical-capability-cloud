export type InboxUrgency = "act_now" | "decide_soon" | "fyi";
export type InboxKind = "job_awaiting_accept" | "mail_this" | "device_problem" | "deadline_warning" | "unit_paid" | "unit_refused";
export type AckKind = "mailed" | "not_mailed" | "resolved" | "acknowledged";
export const ACK_LABEL: Readonly<Record<AckKind, string>> = { mailed: "Mailed", not_mailed: "Not mailed", resolved: "Fixed", acknowledged: "Seen" };
export interface InboxTask {
  id: string;
  dueAt: string | null;
  ackKinds: AckKind[];
  ack: { kind: AckKind; at: string } | null;
}
export interface InboxAction {
  op: "approve" | "reject";
  allowed: boolean;
  reasonIfNot: string | null;
  route: { method: "POST"; path: string };
}
export interface InboxItem {
  id: string;
  sourceId: string;
  kind: InboxKind;
  urgency: InboxUrgency;
  createdAt: string | null;
  decideBy: string | null;
  title: string;
  detail: string | null;
  link: string | null;
  task: InboxTask | null;
  actions: InboxAction[];
  read: boolean | null;
}
export interface InboxNotice {
  code: "source_unavailable" | "source_not_attributable" | "more_items" | "no_kernels" | "unshown_items";
  count?: number;
  source?: string;
}
export type InboxLoadError = "sign_in" | "sign_in_wallet" | "unavailable" | "failed";
export type ActOutcome = "done" | "already_decided" | "expired" | "stopped" | "sign_in" | "sign_in_wallet" | "not_allowed" | "gone" | "unavailable" | "failed";
export type AckOutcome = "acked" | "already_acked" | "sign_in" | "sign_in_wallet" | "not_allowed" | "gone" | "unavailable" | "failed";
export interface InboxSource {
  id: string;
  load(signal?: AbortSignal): Promise<{ ok: true; items: InboxItem[]; notices: InboxNotice[] } | { ok: false; error: InboxLoadError }>;
  act?(item: InboxItem, action: InboxAction): Promise<ActOutcome>;
  ack?(item: InboxItem, kind: AckKind, idempotencyKey: string): Promise<AckOutcome>;
  markRead?(items: InboxItem[]): Promise<boolean>;
}

/** A relative UI path. Encoded spaces are fine; literal whitespace is not. */
export function isInternalLink(v: unknown): v is string {
  return typeof v === "string" && v.length <= 512 && v.startsWith("/") &&
    !v.startsWith("//") && !/[\\\x00-\x1f\x7f\s]/.test(v) && !v.includes("://");
}

const APPROVE_ROUTE = /^\/api\/operator\/(?:approvals\/[A-Za-z0-9_~:-][A-Za-z0-9._~:-]{0,199}\/approve|scopes\/[A-Za-z0-9_~:-][A-Za-z0-9._~:-]{0,199}\/accept)$/;
const REJECT_ROUTE = /^\/api\/operator\/approvals\/[A-Za-z0-9_~:-][A-Za-z0-9._~:-]{0,199}\/reject$/;

export function isAllowedActionRoute(action: { op: string; route: { method: string; path: string } }): boolean {
  const { method, path } = action.route;
  if (method !== "POST" || typeof path !== "string" || path.includes("..") || /[\s\x00-\x1f\x7f]/.test(path)) return false;
  if (action.op === "approve") return APPROVE_ROUTE.test(path);
  if (action.op === "reject") return REJECT_ROUTE.test(path);
  return false;
}

export function isPinned(item: InboxItem): boolean {
  return item.urgency === "act_now" && (!item.task || item.task.ack === null);
}

function dateValue(iso: string | null | undefined): number | null {
  if (typeof iso !== "string") return null;
  const value = Date.parse(iso);
  return Number.isFinite(value) ? value : null;
}

/** Null and invalid dates sort last in either direction. */
function compareDate(a: string | null | undefined, b: string | null | undefined, descending = false): number {
  const av = dateValue(a);
  const bv = dateValue(b);
  if (av === null) return bv === null ? 0 : 1;
  if (bv === null) return -1;
  return descending ? bv - av : av - bv;
}
const byId = (a: InboxItem, b: InboxItem) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
const byCreated = (a: InboxItem, b: InboxItem) => compareDate(a.createdAt, b.createdAt, true) || byId(a, b);

export function orderForDisplay(items: InboxItem[], _now: number): { actNow: InboxItem[]; decideSoon: InboxItem[]; fyi: InboxItem[]; done: InboxItem[] } {
  return {
    actNow: items.filter(isPinned).sort((a, b) => compareDate(a.task?.dueAt, b.task?.dueAt) || byCreated(a, b)),
    decideSoon: items.filter((v) => v.urgency === "decide_soon").sort((a, b) => compareDate(a.decideBy, b.decideBy) || byCreated(a, b)),
    fyi: items.filter((v) => v.urgency === "fyi").sort(byCreated),
    done: items.filter((v) => v.urgency === "act_now" && !isPinned(v)).sort((a, b) => compareDate(a.task?.ack?.at, b.task?.ack?.at, true) || byId(a, b)),
  };
}

export function clampText(s: unknown, max: number): string | null {
  if (typeof s !== "string") return null;
  const text = s.replace(/[\x00-\x1f\x7f]/g, "").trim();
  return text.length > max ? text.slice(0, Math.max(0, max - 3)) + "..." : text;
}

export function formatWhen(iso: string | null, now: number): string {
  const value = dateValue(iso);
  if (value === null || !Number.isFinite(now)) return "time not reported";
  const delta = value - now;
  const mins = Math.floor(Math.abs(delta) / 60_000);
  if (mins < 1) return "just now";
  const amount = mins < 60 ? `${mins}m` : mins < 1440 ? `${Math.floor(mins / 60)}h` : `${Math.floor(mins / 1440)}d`;
  return delta > 0 ? `in ${amount}` : `${amount} ago`;
}
