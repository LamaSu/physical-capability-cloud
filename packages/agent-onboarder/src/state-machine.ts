// In-memory session store + state machine for operator onboarding.
//
// Discovery state machine:
//   started -> data_connected -> docs_ingested -> interview ->
//   capabilities_drafted -> built
//
// Ported from `LamaSu/navi` packages/backend/src/onboard/state.ts. The map
// store is preserved as a placeholder; Wave 4 of the migration plan replaces
// it with PCC's Postgres + RLS so multiple replicas of the onboarder agent
// can resume sessions across restart. See:
//   docs/agent-onboarder/NAVI-V2-MIGRATION-PLAN.md (§4.3 Persistent state)
//
// TODO(wave-4): replace `store` with a `@pcc/db` table-backed store and add
// session restart recovery. Public function signatures are stable across the
// swap — only the storage layer changes. Keep `advanceSession` idempotent so
// concurrent advances from voice + chat doorways don't double-fire side
// effects when persistence becomes durable.

export type OnboardState =
  | "started"
  | "data_connected"
  | "docs_ingested"
  | "interview"
  | "capabilities_drafted"
  | "built";

export interface Capability {
  id: string;
  label: string;
  params_schema?: Record<string, unknown>;
  availability?: string;
}

export interface OnboardSession {
  id: string;
  name: string;
  url?: string;
  contact_email?: string;
  state: OnboardState;
  capabilities?: Capability[];
  data_sources?: unknown[];
  backend?: { project_url: string; anon_key: string };
  agent?: { url: string; marketplace_url?: string };
  extras?: Record<string, unknown>;
  updated_at: number;
}

const store = new Map<string, OnboardSession>();

export async function startSession(input: {
  id: string;
  name: string;
  url?: string;
  contact_email?: string;
}): Promise<OnboardSession> {
  const session: OnboardSession = {
    ...input,
    state: "started",
    updated_at: Date.now(),
  };
  store.set(input.id, session);
  return session;
}

export async function getSession(id: string): Promise<OnboardSession | undefined> {
  return store.get(id);
}

export async function advanceSession(
  id: string,
  to: OnboardState,
  patch: Record<string, unknown> = {}
): Promise<OnboardSession> {
  const current = store.get(id);
  if (!current) throw new Error(`session ${id} not found`);
  const next: OnboardSession = {
    ...current,
    ...patch,
    state: to,
    updated_at: Date.now(),
  };
  store.set(id, next);
  return next;
}

/** Test-only helper: clear all sessions from the in-memory store. Removed
 *  along with the `store` variable when Wave 4 swaps in Postgres. */
export function _resetStoreForTests(): void {
  store.clear();
}
