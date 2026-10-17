import { GlassPanel, GlowBadge } from "@pcc/ui";
import { Link } from "react-router-dom";
import type { InboxItem } from "../../lib/inbox/inbox-model.js";
import { formatWhen, isInternalLink, isPinned, type ActOutcome, type AckOutcome } from "../../lib/inbox/inbox-model.js";
import type { InboxStore } from "../../stores/inbox-store.js";
import { TaskCard } from "./TaskCard.js";

const OUTCOME_COPY: Record<ActOutcome | AckOutcome, string> = {
  done: "Done.",
  accepted_awaiting_funding: "Accepted. It starts once the buyer's funding is confirmed.",
  accepted_unknown: "Accepted. Check again for its current status.",
  already_decided: "Already decided.",
  already_active: "This scope is already active.",
  already_awaiting_funding: "This scope was already accepted. It starts once the buyer's funding is confirmed.",
  already_awaiting_acceptance: "This scope is awaiting acceptance.",
  already_approved: "Already approved.",
  already_rejected: "Already rejected.",
  already_expired: "This scope has expired.",
  already_revoked: "This scope was revoked.",
  already_completed: "This scope is already completed.",
  expired: "This expired before it was decided.",
  stopped: "The kernel's emergency stop is on; nothing was decided.",
  sign_in: "Sign in to see your inbox.",
  sign_in_wallet: "Sign in with your wallet to see your inbox.",
  not_allowed: "You can't decide this one.",
  gone: "This is no longer here.",
  unavailable: "No answer from the gateway. Check again before retrying.",
  failed: "That didn't work. Nothing changed.",
  acked: "Acknowledgment received.",
  already_acked: "Already acknowledged.",
};
const URGENCY_COPY = { act_now: "Act now", decide_soon: "Needs your decision", fyi: "For your information" } as const;

export function InboxItemCard({ item, store, now }: { item: InboxItem; store: InboxStore; now: number }) {
  const pending = store((s) => s.pending[item.id]);
  const outcome = store((s) => s.outcomes[item.id]);
  const decideItem = store((s) => s.decideItem);
  const markItemsRead = store((s) => s.markItemsRead);
  const buttonClass = "px-3 py-1.5 rounded-lg text-xs font-medium border border-white/20 text-white/70 hover:bg-white/5 transition-all disabled:opacity-40";
  return (
    <GlassPanel padding="md" className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-sm font-medium text-white/80 break-words min-w-0">{item.title}</h3>
        <GlowBadge color={isPinned(item) ? "gold" : "gray"}>{URGENCY_COPY[item.urgency]}</GlowBadge>
      </div>
      {item.detail !== null && <div role="group" aria-label="Requested capability (as submitted; not checked by PCC):" className="space-y-1 text-xs text-white/50 break-words">
        <p>Requested capability (as submitted; not checked by PCC):</p>
        <blockquote className="border-l border-white/20 pl-3 font-mono">{item.detail}</blockquote>
      </div>}
      <div className="flex flex-wrap gap-3 text-xs text-white/40">
        <span>{formatWhen(item.createdAt, now)}</span>
        {item.decideBy !== null && <span>Decide by {formatWhen(item.decideBy, now)}</span>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {isInternalLink(item.link) && <Link to={item.link} className="text-xs text-cyan-300 hover:underline">Open</Link>}
        {item.read === false && <button type="button" disabled={!!pending} className={buttonClass} onClick={() => { void markItemsRead([item.id]); }}>Mark read</button>}
        {item.actions.map((action, index) => action.allowed ? (
          <button key={index} type="button" disabled={!!pending} className={buttonClass} onClick={() => { void decideItem(item.id, action.op); }}>
            {action.op === "approve" ? "Approve" : "Reject"}
          </button>
        ) : <p key={index} className="text-xs text-white/50">{action.reasonIfNot}</p>)}
      </div>
      {item.task && <TaskCard item={item} store={store} now={now} />}
      {!item.task && isPinned(item) && <p className="text-xs text-white/50">This can't be acknowledged here.</p>}
      {outcome && <p role="status" className="text-xs text-white/60">{OUTCOME_COPY[outcome]}</p>}
    </GlassPanel>
  );
}
