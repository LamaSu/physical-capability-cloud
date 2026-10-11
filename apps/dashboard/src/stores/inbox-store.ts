import { create, type StoreApi, type UseBoundStore } from "zustand";
import type { AckKind, AckOutcome, ActOutcome, InboxAction, InboxItem, InboxLoadError, InboxNotice, InboxSource } from "../lib/inbox/inbox-model.js";
import { createOperatorWorkSource } from "../lib/inbox/operator-work-source.js";
import { useNotificationStore } from "./notification-store.js";
import { onIdentityChange } from "./auth-store.js";
export interface InboxState {
  items: InboxItem[];
  notices: InboxNotice[];
  errors: Record<string, InboxLoadError>;
  loaded: boolean;
  pending: Record<string, "acting" | "acking" | "reading">;
  outcomes: Record<string, ActOutcome | AckOutcome>;
  refresh(): Promise<void>;
  cancelRefresh(reading?: Promise<void>): void;
  decideItem(itemId: string, op: InboxAction["op"]): Promise<void>;
  ackTask(itemId: string, kind: AckKind): Promise<void>;
  markItemsRead(itemIds: string[]): Promise<void>;
}
/** Source capability metadata lets a card explain missing ack support without calling a source. */
export type InboxStore = UseBoundStore<StoreApi<InboxState>> & { readonly ackSourceIds: readonly string[] };

export function createInboxStore(sources: InboxSource[], deps: {
  notify?(n: { type: "warning" | "info"; title: string }): void;
  clearNotifications?(): void;
  newKey?(): string;
  onIdentityChange?(listener: () => void): () => void;
} = {}): InboxStore {
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const keys = new Map<string, string>();
  const newKey = deps.newKey ?? (() => globalThis.crypto.randomUUID());
  let refreshing: Promise<void> | null = null;
  let refreshController: AbortController | null = null;
  let readRevision = 0;
  const confirmedReads = new Map<string, number>();
  const seenIds = new Set<string>();
  const baselinedSources = new Set<string>();
  let epoch = 0;

  const hook = create<InboxState>((set, get) => {
    const clearPending = (ids: string[], startedEpoch: number) => {
      if (epoch !== startedEpoch) return;
      set((state) => {
        const pending = { ...state.pending };
        ids.forEach((id) => { delete pending[id]; });
        return { pending };
      });
    };
    // A read begun before a decision may be stale. Let it settle, then read the new state.
    const reconcile = async (startedEpoch: number) => {
      if (refreshing) {
        const controller = refreshController;
        await refreshing;
        if (controller?.signal.aborted) return;
      }
      if (epoch !== startedEpoch) return;
      await get().refresh();
    };
    return {
      items: [], notices: [], errors: {}, loaded: false, pending: {}, outcomes: {},
      refresh() {
        if (refreshing) return refreshing;
        const startedEpoch = epoch;
        const controller = new AbortController();
        refreshController = controller;
        let cancel!: () => void;
        const cancelled = new Promise<null>((resolve) => {
          cancel = () => resolve(null);
          controller.signal.addEventListener("abort", cancel, { once: true });
        });
        const run = async () => {
          const readStartedAt = readRevision;
          const results = await Promise.race([Promise.all(sources.map(async (source) => {
            try { return await source.load(controller.signal); }
            catch { return { ok: false, error: "unavailable" } as const; }
          })), cancelled]);
          if (!results || controller.signal.aborted || epoch !== startedEpoch) return;
          const items: InboxItem[] = [];
          const notices: InboxNotice[] = [];
          const errors: Record<string, InboxLoadError> = {};
          const seen = new Set<string>();
          let duplicates = 0;
          results.forEach((result, index) => {
            if (!result.ok) { errors[sources[index].id] = result.error; return; }
            notices.push(...result.notices);
            for (const item of result.items) {
              if (seen.has(item.id)) { duplicates++; continue; }
              seen.add(item.id);
              items.push(item);
            }
          });
          if (duplicates) notices.push({ code: "unshown_items", count: duplicates });
          const previous = get();
          const news = items.filter((v) => baselinedSources.has(v.sourceId) && !seenIds.has(v.id) && (v.urgency === "act_now" || v.urgency === "decide_soon"));
          items.forEach((item) => seenIds.add(item.id));
          results.forEach((result, index) => { if (result.ok) baselinedSources.add(sources[index].id); });
          // Keep an in-flight optimistic read mark through a polling read. Ack is never optimistic.
          const merged = items.map((item) => {
            const local = previous.items.find((v) => v.id === item.id && v.sourceId === item.sourceId);
            const markedAfterRead = (confirmedReads.get(item.id) ?? 0) > readStartedAt;
            return item.read === false && local?.read === true && (previous.pending[item.id] === "reading" || markedAfterRead)
              ? { ...item, read: true } : item;
          });
          set({ items: merged, notices, errors, loaded: true });
          if (epoch === startedEpoch && news.length) deps.notify?.({
            type: news.some((v) => v.urgency === "act_now") ? "warning" : "info",
            title: `${news.length} new item${news.length === 1 ? "" : "s"} in your inbox`,
          });
        };
        const promise = run().finally(() => {
          controller.signal.removeEventListener("abort", cancel);
          if (refreshing === promise) { refreshing = null; refreshController = null; }
        });
        refreshing = promise;
        return promise;
      },
      cancelRefresh(reading) {
        // A supplied handle owns only that run. Panel unmount cancels any current read, including reconciliation.
        if (reading && refreshing !== reading) return;
        const controller = refreshController;
        refreshing = null;
        refreshController = null;
        controller?.abort();
      },
      async decideItem(itemId, op) {
        const startedEpoch = epoch;
        const state = get();
        const item = state.items.find((v) => v.id === itemId);
        const action = item?.actions.find((v) => v.op === op && v.allowed);
        const source = item && sourceById.get(item.sourceId);
        if (!item || !action || !source?.act || state.pending[itemId]) return;
        set((s) => ({ pending: { ...s.pending, [itemId]: "acting" } }));
        try {
          let outcome: ActOutcome;
          try { outcome = await source.act(item, action); }
          catch { outcome = "unavailable"; }
          if (epoch !== startedEpoch) return;
          set((s) => ({ outcomes: { ...s.outcomes, [itemId]: outcome } }));
          if (epoch === startedEpoch && (outcome === "done" || outcome === "already_decided" || outcome === "expired")) await reconcile(startedEpoch);
        } finally { clearPending([itemId], startedEpoch); }
      },
      async ackTask(itemId, kind) {
        const startedEpoch = epoch;
        const state = get();
        const item = state.items.find((v) => v.id === itemId);
        const source = item && sourceById.get(item.sourceId);
        if (!item?.task || item.task.ack !== null || !item.task.ackKinds.includes(kind) || !source?.ack || state.pending[itemId]) return;
        const slot = JSON.stringify([itemId, kind]);
        let key = keys.get(slot);
        if (!key) { key = newKey(); keys.set(slot, key); }
        set((s) => ({ pending: { ...s.pending, [itemId]: "acking" } }));
        try {
          let outcome: AckOutcome;
          try { outcome = await source.ack(item, kind, key); }
          catch { outcome = "unavailable"; }
          if (epoch !== startedEpoch) return;
          set((s) => ({ outcomes: { ...s.outcomes, [itemId]: outcome } }));
          if (epoch !== startedEpoch) return;
          if (outcome !== "unavailable" && outcome !== "failed") keys.delete(slot);
          if (outcome === "acked" || outcome === "already_acked") await reconcile(startedEpoch);
        } finally { clearPending([itemId], startedEpoch); }
      },
      async markItemsRead(itemIds) {
        const startedEpoch = epoch;
        const state = get();
        const wanted = new Set(itemIds);
        const groups = new Map<InboxSource, InboxItem[]>();
        for (const item of state.items) {
          const source = sourceById.get(item.sourceId);
          if (!wanted.has(item.id) || item.read !== false || state.pending[item.id] || !source?.markRead) continue;
          const group = groups.get(source) ?? [];
          group.push(item);
          groups.set(source, group);
        }
        const selected = new Set([...groups.values()].flat().map((v) => v.id));
        if (!selected.size) return;
        set((s) => ({
          items: s.items.map((v) => selected.has(v.id) ? { ...v, read: true } : v),
          pending: { ...s.pending, ...Object.fromEntries([...selected].map((id) => [id, "reading" as const])) },
        }));
        await Promise.all([...groups].map(async ([source, items]) => {
          let confirmed = false;
          try { confirmed = await source.markRead!(items); }
          catch { /* Restore the optimistic mark when the source cannot confirm it. */ }
          if (epoch !== startedEpoch) return;
          if (!confirmed) {
            const ids = new Set(items.map((v) => v.id));
            set((s) => ({ items: s.items.map((v) => ids.has(v.id) && v.sourceId === source.id && v.read === true ? { ...v, read: false } : v) }));
          } else {
            items.forEach((item) => { confirmedReads.set(item.id, ++readRevision); });
          }
          clearPending(items.map((v) => v.id), startedEpoch);
        }));
      },
    };
  });
  deps.onIdentityChange?.(() => {
    epoch++;
    if (refreshing) hook.getState().cancelRefresh(refreshing);
    keys.clear();
    confirmedReads.clear();
    seenIds.clear();
    baselinedSources.clear();
    readRevision = 0;
    refreshing = null;
    hook.setState({ items: [], notices: [], errors: {}, pending: {}, outcomes: {}, loaded: false });
    deps.clearNotifications?.();
  });
  return Object.assign(hook, { ackSourceIds: Object.freeze(sources.filter((v) => v.ack).map((v) => v.id)) });
}

export const useInboxStore = createInboxStore([createOperatorWorkSource()], {
  onIdentityChange,
  notify: (n) => useNotificationStore.getState().add(n),
  clearNotifications: () => useNotificationStore.getState().clear(),
});
