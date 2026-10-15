/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { InboxItemCard } from "../InboxItemCard.js";
import { createInboxStore } from "../../../stores/inbox-store.js";
import { createOperatorWorkSource } from "../../../lib/inbox/operator-work-source.js";
import type { InboxItem } from "../../../lib/inbox/inbox-model.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mounted: Array<{ root: Root; host: HTMLDivElement }> = [];
afterEach(() => {
  for (const { root, host } of mounted.splice(0)) {
    act(() => root.unmount());
    host.remove();
  }
});

describe("operator scope outcome copy", () => {
  it.each([
    [200, "awaiting_funding", "Accepted. It starts once the buyer's funding is confirmed."],
    [200, "active", "Done."],
    [200, "future_status", "Accepted. Check again for its current status."],
    [200, undefined, "Accepted. Check again for its current status."],
    [409, "expired", "This scope has expired."],
    [409, "revoked", "This scope was revoked."],
    [409, "active", "This scope is already active."],
    [409, "awaiting_funding", "This scope was already accepted. It starts once the buyer's funding is confirmed."],
    [409, "awaiting_acceptance", "This scope is awaiting acceptance."],
    [409, "approved", "Already approved."],
    [409, "rejected", "Already rejected."],
    [409, "completed", "This scope is already completed."],
    [409, "future_status", "Already decided."],
    [409, undefined, "Already decided."],
  ] as const)("shows fixed copy for HTTP %s status %s", async (status, scopeStatus, copy) => {
    const current: InboxItem = {
      id: "scope:one", sourceId: "operator-work", kind: "job_awaiting_accept", urgency: "decide_soon",
      createdAt: null, decideBy: null, title: "A job waits for your decision", detail: null, link: null,
      task: null, read: null, actions: [
        { op: "approve", allowed: true, reasonIfNot: null, route: { method: "POST", path: "/api/operator/scopes/one/accept" } },
      ],
    };
    const source = createOperatorWorkSource({ fetch: async () => ({ status, json: async () => ({ error: "already_decided", status: scopeStatus }) }) });
    const store = createInboxStore([{ id: source.id, load: async () => ({ ok: true, items: [current], notices: [] }), act: source.act }]);
    await store.getState().refresh();
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    mounted.push({ root, host });
    await act(async () => { root.render(<MemoryRouter><InboxItemCard item={current} store={store} now={Date.now()} /></MemoryRouter>); });
    await act(async () => { host.querySelector("button")!.click(); });
    expect(host.querySelector('[role="status"]')?.textContent).toBe(copy);
  });
});
