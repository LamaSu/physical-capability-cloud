/**
 * In-memory state that belongs to the signed-in account (astra 19c, CRITICAL).
 *
 * The dashboard's zustand stores live for the whole page, not for a session.
 * Signing out and in as someone else used to leave the first account's spatial
 * chat, open panels, notifications and half-filled wizards in memory, and the
 * next account saw them. Every store that holds what an account typed, opened,
 * was shown or was told registers here. When the account changes (a key signed
 * in or out, or a different key), App returns each one to its initial state,
 * before anything renders for the next account (App.tsx, onAccountChange).
 *
 * auth-store is the one store that doesn't register: it is the identity itself.
 * __tests__/account-scope.test.ts holds every other store to registering.
 */

/** The part of a zustand store this needs. */
interface Store<S> {
  getState: () => S;
  setState: (state: S, replace: true) => void;
}

const resets: Array<() => void> = [];

/** A copy of a data value; functions (store actions) are kept as they are. */
function copy(value: unknown): unknown {
  if (typeof value === "function") return value;
  try {
    return structuredClone(value);
  } catch {
    // Not cloneable (a value holding a function): kept by reference. Stores
    // replace such values rather than mutating them (PanelStore copies its Map).
    return value;
  }
}

function snapshot<S>(state: S): S {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(state as Record<string, unknown>)) out[key] = copy(value);
  return out as S;
}

/**
 * Register `store` as the account's state: on every account change it returns
 * to the state it had when this was called (at module load, before any use).
 * Each reset gets a fresh copy, so a store that mutates its state in place
 * can't alter what the next reset restores.
 */
export function accountScoped<S>(store: Store<S>): void {
  const initial = snapshot(store.getState());
  resets.push(() => store.setState(snapshot(initial), true));
}

/** Return every registered store to its initial state. */
export function resetAccountScopedState(): void {
  for (const reset of resets) reset();
}

/** How many stores are registered (for tests). */
export function accountScopedStoreCount(): number {
  return resets.length;
}
