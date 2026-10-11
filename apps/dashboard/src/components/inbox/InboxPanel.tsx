import React from "react";
import { GlassPanel, GlowBadge } from "@pcc/ui";
import type { InboxStore } from "../../stores/inbox-store.js";
import { useInboxStore } from "../../stores/inbox-store.js";
import { orderForDisplay, type InboxLoadError, type InboxNotice } from "../../lib/inbox/inbox-model.js";
import { InboxItemCard } from "./InboxItemCard.js";

const ERROR_COPY: Record<InboxLoadError, string> = {
  sign_in: "Sign in to see your inbox.",
  sign_in_wallet: "Sign in with your wallet to see your inbox.",
  unavailable: "Your inbox could not be read just now, so nothing is shown. Try again shortly.",
  failed: "Your inbox could not be read.",
};
const SOURCE_COPY: Record<string, string> = {
  approvals: "Approvals could not be read, so they are not shown.",
  "job offers": "Job offers could not be read, so they are not shown.",
  "skill jobs": "Skill jobs could not be read, so they are not shown.",
  "kernel jobs": "Kernel jobs could not be read, so they are not shown.",
};
const NOT_LISTED_COPY: Record<string, string> = {
  approvals: "Approvals are not listed in this inbox yet.",
  "job offers": "Job offers are not listed in this inbox yet.",
  "skill jobs": "Skill jobs are not listed in this inbox yet.",
  "kernel jobs": "Kernel jobs are not listed in this inbox yet.",
};
function noticeCopy(notice: InboxNotice): string {
  switch (notice.code) {
    case "source_unavailable":
      return Object.prototype.hasOwnProperty.call(SOURCE_COPY, notice.source ?? "")
        ? SOURCE_COPY[notice.source!] : "Some inbox items could not be read, so they are not shown.";
    case "source_not_attributable":
      return Object.prototype.hasOwnProperty.call(NOT_LISTED_COPY, notice.source ?? "")
        ? NOT_LISTED_COPY[notice.source!] : "Some inbox items are not listed in this inbox yet.";
    case "no_kernels": return "No kernels are registered to this wallet.";
    case "more_items": return "More decisions are waiting than this page shows.";
    case "unshown_items": return `${notice.count ?? 0} items could not be shown here.`;
  }
}

export function InboxPanel({ store = useInboxStore, now = Date.now, pollMs = 15_000 }: { store?: InboxStore; now?: () => number; pollMs?: number }) {
  const { items, notices, errors, loaded, refresh, cancelRefresh } = store();
  React.useEffect(() => {
    void refresh();
    const timer = setInterval(() => { void refresh(); }, pollMs);
    return () => {
      clearInterval(timer);
      cancelRefresh();
    };
  }, [refresh, cancelRefresh, pollMs]);

  const time = now();
  const ordered = orderForDisplay(items, time);
  const groups = [
    { title: "Act now", items: ordered.actNow, color: "gold" },
    { title: "Needs your decision", items: ordered.decideSoon, color: "cyan" },
    { title: "For your information", items: ordered.fyi, color: "gray" },
    { title: "Done", items: ordered.done, color: "gray" },
  ] as const;
  const empty = loaded && Object.keys(errors).length === 0 &&
    !notices.some((v) => v.code === "unshown_items" ||
      (v.source === "approvals" && (v.code === "source_unavailable" || v.code === "source_not_attributable"))) &&
    groups.every((v) => v.items.length === 0);

  return (
    <div className="space-y-4">
      {!loaded && <GlassPanel padding="md"><p className="text-sm text-white/40">Loading your inbox...</p></GlassPanel>}
      {loaded && <>
        {Object.entries(errors).map(([id, error]) => (
          <GlassPanel key={id} padding="md"><p role="status" className="text-sm text-gold-300/80">{ERROR_COPY[error]}</p></GlassPanel>
        ))}
        {notices.map((notice, index) => (
          <p key={index} className="text-xs text-white/50">{noticeCopy(notice)}</p>
        ))}
        {groups.filter((group) => group.items.length > 0).map((group) => (
          <section key={group.title} className="space-y-3">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-medium text-white/70">{group.title}</h2>
              <GlowBadge color={group.color}>{group.items.length}</GlowBadge>
            </div>
            {group.items.map((item) => <InboxItemCard key={item.id} item={item} store={store} now={time} />)}
          </section>
        ))}
        {empty && <GlassPanel padding="lg"><p className="text-sm text-white/40">Nothing needs you right now.</p></GlassPanel>}
      </>}
    </div>
  );
}
