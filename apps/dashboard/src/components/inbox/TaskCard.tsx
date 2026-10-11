import { GlassPanel, GlowBadge } from "@pcc/ui";
import type { InboxItem } from "../../lib/inbox/inbox-model.js";
import { ACK_LABEL, formatWhen, type AckKind } from "../../lib/inbox/inbox-model.js";
import type { InboxStore } from "../../stores/inbox-store.js";

const knownKind = (kind: unknown): kind is AckKind => typeof kind === "string" && Object.prototype.hasOwnProperty.call(ACK_LABEL, kind);

export function TaskCard({ item, store, now }: { item: InboxItem; store: InboxStore; now: number }) {
  const pending = store((s) => s.pending[item.id]);
  const ackTask = store((s) => s.ackTask);
  const task = item.task;
  if (!task) return null;
  const canAck = store.ackSourceIds.includes(item.sourceId);
  return (
    <GlassPanel padding="sm" className="space-y-2">
      <GlowBadge color="gray">Due {formatWhen(task.dueAt, now)}</GlowBadge>
      {task.ack ? (
        <p className="text-xs text-white/60">{knownKind(task.ack.kind)
          ? <>Marked {ACK_LABEL[task.ack.kind]} {formatWhen(task.ack.at, now)}</>
          : <>Acknowledgment recorded {formatWhen(task.ack.at, now)}.</>}</p>
      ) : canAck ? (
        <div className="flex flex-wrap gap-2">
          {task.ackKinds.filter(knownKind).map((kind) => (
            <button key={kind} type="button" disabled={!!pending}
              className="px-3 py-1.5 rounded-lg text-xs font-medium border border-gold-400/30 text-gold-300 hover:bg-gold-400/10 transition-all disabled:opacity-40"
              onClick={() => { void ackTask(item.id, kind); }}>
              {ACK_LABEL[kind]}
            </button>
          ))}
        </div>
      ) : <p className="text-xs text-white/50">This can't be acknowledged here.</p>}
    </GlassPanel>
  );
}
