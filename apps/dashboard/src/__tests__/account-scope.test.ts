/**
 * Every in-memory store but the identity itself belongs to the signed-in
 * account, and goes back to its initial state when the account changes
 * (astra 19c, CRITICAL; lib/account-scope.ts). This holds every store module
 * to registering, and checks that a reset restores the pristine state.
 */

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
/** The identity itself: what changes, not what is reset. */
const NOT_ACCOUNT_STATE = new Set(["stores/auth-store.ts"]);

function productionFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === "__tests__" ? [] : productionFiles(full);
    return /\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name) && !name.endsWith(".d.ts") ? [full] : [];
  });
}

const STORE_MODULES = productionFiles(SRC)
  .map((full) => ({ rel: relative(SRC, full).split(sep).join("/"), text: readFileSync(full, "utf-8") }))
  .filter((f) => /from\s+["']zustand["']/.test(f.text));

/**
 * Reviewed modules that call getState() or setState() on an account-scoped
 * store directly, instead of through an action read in a component. A direct
 * call reads the CURRENT account's actions, so if it ran after an await it
 * would reach the next account's store (astra 19d). Each module here is
 * synchronous: it has no await, and its only .then() doesn't touch a store.
 */
const DIRECT_STORE_CALLERS: Record<string, string> = {
  "features/chat/ChatEngine.ts": "chat commands open, close and minimize panels synchronously, in the keypress handler",
  "features/chat/ChatSidebar.tsx": "re-opens a panel from a chat message, in its click handler",
  "features/gestures/useGestures.ts": "gesture callbacks move panels and toggle the sidebar synchronously",
  "features/spatial/FloatingPanel.tsx": "the minimize button, in its click handler; its one .then() loads the panel's component into local state",
};

/**
 * A module being synchronous isn't enough when what calls it isn't (astra
 * 19e): HandTracker builds MediaPipe callbacks after an await, and they call
 * useGestures. A direct caller imported by a module with an await or a
 * .then() checks the account epoch it was created under, and is listed here.
 */
const EPOCH_GUARDED: Record<string, string> = {
  "features/gestures/useGestures.ts": "HandTracker calls it from MediaPipe callbacks it creates after loading the library",
};

/** Production modules that import `rel`, by a relative static or dynamic import. */
function importersOf(rel: string, files: Array<{ rel: string; text: string }>): Array<{ rel: string; text: string }> {
  const target = rel.replace(/\.tsx?$/, "");
  return files.filter((f) =>
    [...f.text.matchAll(/(?:from\s+|import\(\s*)["'](\.{1,2}\/[^"']+)["']/g)].some((m) => {
      const resolved = join(dirname(f.rel), m[1]!).split(sep).join("/").replace(/\.(js|jsx|ts|tsx)$/, "");
      return resolved === target;
    }),
  );
}

describe("every store but the identity is the account's state (astra 19c)", () => {
  it("finds the stores", () => {
    expect(STORE_MODULES.map((f) => f.rel)).toEqual(expect.arrayContaining(["features/chat/ChatStore.ts", "features/spatial/PanelStore.ts", "stores/auth-store.ts"]));
  });

  it("each store module registers its store with accountScoped", () => {
    const missing = STORE_MODULES.filter((f) => !NOT_ACCOUNT_STATE.has(f.rel)).flatMap((f) => {
      const stores = [...f.text.matchAll(/export const (\w+) = create\b/g)].map((m) => m[1]!);
      return stores.filter((name) => !new RegExp(`^accountScoped\\(${name}\\);$`, "m").test(f.text)).map((name) => `${f.rel}: ${name}`);
    });
    expect(missing, "Add accountScoped(<store>) after creating it, or say why it isn't account state").toEqual([]);
  });

  it("every one of them is registered at run time", async () => {
    const accountStores = STORE_MODULES.filter((f) => !NOT_ACCOUNT_STATE.has(f.rel));
    for (const f of accountStores) await import(`../${f.rel.replace(/\.tsx?$/, ".js")}`);
    const { accountScopedStoreCount } = await import("../lib/account-scope.js");
    expect(accountScopedStoreCount()).toBe(accountStores.length);
  });

  it("an action read before an account change does nothing after it; one read after works (astra 19d)", async () => {
    const { useNotificationStore } = await import("../stores/notification-store.js");
    const { resetAccountScopedState } = await import("../lib/account-scope.js");
    resetAccountScopedState();
    const clearAsA = useNotificationStore.getState().clear; // held by a component of the previous account
    useNotificationStore.setState({ notifications: [{ id: "n-b" } as never] });
    resetAccountScopedState(); // the account changes
    useNotificationStore.setState({ notifications: [{ id: "n-b2" } as never] }); // the next account's own state
    expect(clearAsA()).toBeUndefined();
    expect(useNotificationStore.getState().notifications).toHaveLength(1); // the stale action changed nothing
    useNotificationStore.getState().clear(); // read now, it works
    expect(useNotificationStore.getState().notifications).toHaveLength(0);
  });

  it("only reviewed, synchronous modules call getState() or setState() on an account-scoped store", () => {
    const accountStores = STORE_MODULES.filter((f) => !NOT_ACCOUNT_STATE.has(f.rel)).flatMap((f) =>
      [...f.text.matchAll(/export const (\w+) = create\b/g)].map((m) => m[1]!),
    );
    const direct = new RegExp(`\\b(?:${accountStores.join("|")})\\.(?:getState|setState)\\(`);
    const storeFiles = new Set(STORE_MODULES.map((f) => f.rel));
    const callers = productionFiles(SRC)
      .map((full) => ({ rel: relative(SRC, full).split(sep).join("/"), text: readFileSync(full, "utf-8") }))
      .filter((f) => !storeFiles.has(f.rel) && direct.test(f.text));
    expect(
      callers.map((f) => f.rel).filter((rel) => !(rel in DIRECT_STORE_CALLERS)),
      "Read the action in the component instead, or review the module and list it with a reason",
    ).toEqual([]);
    for (const f of callers) expect(/\bawait\b/.test(f.text), `${f.rel} must stay synchronous`).toBe(false);
  });

  it("a direct caller that async code reaches checks the account epoch itself (astra 19e)", () => {
    const files = productionFiles(SRC).map((full) => ({ rel: relative(SRC, full).split(sep).join("/"), text: readFileSync(full, "utf-8") }));
    for (const rel of Object.keys(DIRECT_STORE_CALLERS)) {
      const asyncImporters = importersOf(rel, files)
        .filter((i) => /\bawait\b|\.then\(/.test(i.text))
        .map((i) => i.rel);
      if (rel in EPOCH_GUARDED) {
        expect(asyncImporters.length, `${rel} is listed as reached from async code; drop it from EPOCH_GUARDED if nothing async imports it`).toBeGreaterThan(0);
        const text = files.find((f) => f.rel === rel)!.text;
        expect(text, `${rel} compares the account epoch before it touches a store`).toMatch(/currentAccountEpoch\(\)\s*!==/);
      } else {
        expect(asyncImporters, `${rel} is imported by async code: check the account epoch in it, and list it in EPOCH_GUARDED`).toEqual([]);
      }
    }
  });

  it("finds the importers it checks", () => {
    const files = productionFiles(SRC).map((full) => ({ rel: relative(SRC, full).split(sep).join("/"), text: readFileSync(full, "utf-8") }));
    expect(importersOf("features/gestures/useGestures.ts", files).map((f) => f.rel)).toEqual(["features/gestures/HandTracker.tsx"]);
    expect(importersOf("features/chat/ChatEngine.ts", files).map((f) => f.rel)).toEqual(["features/chat/ChatBar.tsx"]);
  });

  it("a reset restores each store's initial state, even after a store mutates its state in place", async () => {
    const { useSpatialChatStore } = await import("../features/chat/ChatStore.js");
    const { usePanelStore } = await import("../features/spatial/PanelStore.js");
    const { useNotificationStore } = await import("../stores/notification-store.js");
    const { resetAccountScopedState } = await import("../lib/account-scope.js");
    const data = () => ({
      chat: useSpatialChatStore.getState().messages.map((m) => m.content),
      sidebar: useSpatialChatStore.getState().sidebarOpen,
      panels: [...usePanelStore.getState().panels.keys()],
      notifications: useNotificationStore.getState().notifications.length,
    });
    const pristine = data();

    for (let round = 0; round < 2; round++) {
      useSpatialChatStore.getState().addMessage({ role: "user", content: "account-A-secret" });
      useSpatialChatStore.getState().setSidebarOpen(true);
      usePanelStore.getState().openPanel("jobs", "Jobs", async () => ({ default: () => null }));
      useNotificationStore.setState({ notifications: [{ id: "n1" } as never] });
      expect(data()).not.toEqual(pristine);
      resetAccountScopedState();
      expect(data()).toEqual(pristine);
      // In place, on the state a reset just restored: must not leak into what the next reset restores.
      (useSpatialChatStore.getState().messages as unknown[]).push({ id: "x", role: "user", content: "pushed", timestamp: 0 });
      resetAccountScopedState();
      expect(data()).toEqual(pristine);
    }
  });
});
