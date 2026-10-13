import type { OperatorWorkDTO, OperatorWorkItem, OperatorWorkAction } from "@pcc/spec";
import { authorizedFetch } from "../authorized-fetch.js";
import { clampText, isAllowedActionRoute, type InboxAction, type InboxItem, type InboxNotice, type InboxSource } from "./inbox-model.js";

const SOURCE_LABEL: Readonly<Record<keyof OperatorWorkDTO["sources"], string>> = {
  job_offer: "job offers", skill_job: "skill jobs", kernel_job: "kernel jobs", approval: "approvals",
};
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object";
const stringOrNull = (v: unknown): string | null => typeof v === "string" ? v : null;

function decisionAction(value: unknown): InboxAction | null {
  if (!record(value) || (value.op !== "approve" && value.op !== "reject")) return null;
  const action = value as unknown as OperatorWorkAction;
  const route = record(action.route) ? action.route : { method: "POST", path: "" };
  const safe = isAllowedActionRoute({ op: action.op, route });
  return {
    op: value.op,
    allowed: action.allowed === true && safe,
    reasonIfNot: safe ? clampText(action.reasonIfNot, 200) : "This action is not available here",
    // Invalid routes remain visible as refused actions, never as request targets.
    route: { method: "POST", path: typeof route.path === "string" ? route.path : "" },
  };
}

function inboxItem(item: OperatorWorkItem): InboxItem {
  const jobId = record(item.refs) ? item.refs.jobId : null;
  return {
    id: "ow:" + item.id, sourceId: "operator-work", kind: "job_awaiting_accept", urgency: "decide_soon",
    createdAt: stringOrNull(item.postedAt), decideBy: stringOrNull(item.acceptBy),
    title: "A job waits for your decision", detail: clampText(item.capabilityType, 80),
    link: item.source === "kernel_job" && typeof jobId === "string" && jobId.length > 0 ? "/jobs/" + encodeURIComponent(jobId) : null,
    task: null, read: null, actions: item.actions.map(decisionAction).filter((v): v is InboxAction => v !== null),
  };
}

export function createOperatorWorkSource(deps: { fetch?: (path: string, init?: RequestInit) => Promise<{ status: number; json(): Promise<unknown> }> } = {}): InboxSource {
  const fetch = deps.fetch ?? authorizedFetch;
  return {
    id: "operator-work",
    async load(signal) {
      if (signal?.aborted) return { ok: false, error: "unavailable" };
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let cancel!: () => void;
      const timeout = new Promise<Awaited<ReturnType<InboxSource["load"]>>>((resolve) => {
        cancel = () => {
          clearTimeout(timer);
          controller.abort();
          resolve({ ok: false, error: "unavailable" });
        };
        timer = setTimeout(() => {
          controller.abort();
          resolve({ ok: false, error: "unavailable" });
        }, 20_000);
      });
      signal?.addEventListener("abort", cancel, { once: true });
      const read = async (): ReturnType<InboxSource["load"]> => {
        try {
          const res = await fetch("/api/operator/work?limit=200", { signal: controller.signal });
          if (res.status === 401) return { ok: false, error: "sign_in" };
          if (res.status === 503) return { ok: false, error: "unavailable" };
          if (res.status === 403) {
            const body = await res.json();
            return { ok: false, error: record(body) && body.error === "identity_unverified" ? "sign_in_wallet" : "failed" };
          }
          if (res.status !== 200) return { ok: false, error: "failed" };
          const body = await res.json();
          if (!record(body) || body.schemaId !== "pcc.operator-work/v1" || !Array.isArray(body.items)) return { ok: false, error: "failed" };
          const dto = body as unknown as OperatorWorkDTO;
          const items: InboxItem[] = [];
          const notices: InboxNotice[] = [];
          let unshown = 0;
          for (const value of dto.items) {
            if (!record(value) || value.phase !== "awaiting_me") continue;
            if (typeof value.id !== "string" || !Array.isArray(value.actions)) { unshown++; continue; }
            items.push(inboxItem(value as unknown as OperatorWorkItem));
          }
          for (const key of Object.keys(SOURCE_LABEL) as Array<keyof OperatorWorkDTO["sources"]>) {
            const source = dto.sources?.[key];
            if (source?.state === "unavailable") notices.push({ code: "source_unavailable", source: SOURCE_LABEL[key] });
            if (source?.state === "not_attributable") notices.push({ code: "source_not_attributable", source: SOURCE_LABEL[key] });
          }
          if (Array.isArray(dto.kernels) && dto.kernels.length === 0) notices.push({ code: "no_kernels" });
          const last = dto.items[dto.items.length - 1];
          if (dto.truncated && last?.phase === "awaiting_me") notices.push({ code: "more_items" });
          if (unshown) notices.push({ code: "unshown_items", count: unshown });
          return { ok: true, items, notices };
        } catch {
          return { ok: false, error: "unavailable" };
        }
      };
      try {
        // Settle even if a fetch implementation does not reject when aborted.
        return await Promise.race([read(), timeout]);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
      }
    },
    async act(_item, action) {
      if (!action.allowed || !isAllowedActionRoute(action)) return "not_allowed";
      try {
        const res = await fetch(action.route.path, { method: "POST" });
        if (res.status >= 200 && res.status < 300) return "done";
        if (res.status === 401) return "sign_in";
        if (res.status === 404) return "gone";
        if (res.status >= 500 && res.status < 600) return "unavailable";
        if (res.status === 409 || res.status === 403) {
          const body = await res.json();
          const error = record(body) ? body.error : null;
          if (res.status === 403) return error === "identity_unverified" ? "sign_in_wallet" : "not_allowed";
          if (error === "scope_expired") return "expired";
          if (error === "kernel_emergency_stopped") return "stopped";
          return "already_decided";
        }
        return "failed";
      } catch {
        return "unavailable";
      }
    },
  };
}
