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
 * Each store's actions are also bound to the account they were read under
 * (astra 19d). An action reference that A's component captured, and calls
 * after the switch (a late fetch result, a timer), does nothing. Only actions
 * read after the switch write. A reset alone would leave A's closures able to
 * refill B's store.
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

/** Which account's state the stores hold now. It changes on every reset. */
let epoch = 0;

/** The account epoch now: async work can compare it before acting on a result. */
export function currentAccountEpoch(): number {
  return epoch;
}

/**
 * `state` with each action (function) wrapped to run only while the account
 * epoch is still `at`. A call through a reference read under an earlier
 * account returns undefined and changes nothing.
 */
function bindToEpoch<S>(state: S, at: number): S {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(state as Record<string, unknown>)) {
    out[key] =
      typeof value === "function"
        ? function (this: unknown, ...args: unknown[]) {
            return epoch === at ? (value as (...a: unknown[]) => unknown).apply(this, args) : undefined;
          }
        : value;
  }
  return out as S;
}

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
  const initial = snapshot(store.getState()); // the store's own actions, unwrapped
  store.setState(bindToEpoch(snapshot(initial), epoch), true);
  resets.push(() => store.setState(bindToEpoch(snapshot(initial), epoch), true));
}

/**
 * A new account: every registered store returns to its initial state, and
 * every action reference read before this call stops working.
 */
export function resetAccountScopedState(): void {
  epoch += 1;
  for (const reset of resets) reset();
}

/** How many stores are registered (for tests). */
export function accountScopedStoreCount(): number {
  return resets.length;
}
