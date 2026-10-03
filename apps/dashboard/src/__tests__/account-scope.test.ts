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
