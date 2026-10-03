/**
 * Evidence sessions: which job an adapter's events belong to, and until when.
 *
 * onEvidence cannot unsubscribe, and runs share adapter objects (server.ts makes a
 * JobRunner per /execute over the same adapters; the gateway keeps one per machine).
 * A listener bound to one run therefore kept recording every later and overlapping
 * job's events into that run's step (astra pack 168).
 *
 * So each adapter instance gets ONE permanent listener, a tap, registered through its
 * own onEvidence the first time a job uses it. The tap forwards each event to the one
 * session open on that adapter, and drops it, with a warning, when none is open.
 * A session is opened for a job's whole evidence window and closed when it ends.
 */

import type { EvidenceEvent } from "@pcc/spec";

/** An event as an adapter emits it, before the emitter ids and hashes it. */
export type EmittedEvidence = Omit<EvidenceEvent, "id" | "hash">;

/** The part of a machine, sensor or camera adapter that a session uses. */
export interface EvidenceAdapter {
  readonly id: string;
  onEvidence(callback: (event: EmittedEvidence) => void): void;
}

/** The job step a session records for. */
export interface EvidenceOwner {
  jobId: string;
  stepId: string;
}

export interface EvidenceSession {
  /** Stop delivering. Idempotent: once it returns, no event reaches deliver. */
  close(): void;
}

export type OpenEvidenceSessionResult =
  | { ok: true; session: EvidenceSession }
  | { ok: false; busy: { adapterId: string; jobId: string } };

interface Session {
  readonly owner: EvidenceOwner;
  readonly deliver: (event: EmittedEvidence) => void;
  closed: boolean;
}

/** The permanent listener's state: the last session to claim the adapter. */
interface Tap {
  session: Session | null;
}

const taps = new WeakMap<object, Tap>();

/** The adapter's tap. The first call registers it, through the adapter's own onEvidence. */
function tapOf(adapter: EvidenceAdapter): Tap {
  const existing = taps.get(adapter);
  if (existing !== undefined) return existing;
  const tap: Tap = { session: null };
  adapter.onEvidence((event) => {
    const session = tap.session;
    if (session !== null && !session.closed) {
      session.deliver(event);
    } else {
      // Not the payload: it is device evidence, not a log line.
      console.warn(`[evidence-session] dropped a ${event.type} event from adapter ${adapter.id}: no job is recording it`);
    }
  });
  // Stored only once registered, so an onEvidence that throws leaves no dead tap behind.
  taps.set(adapter, tap);
  return tap;
}

/**
 * Deliver every event the adapters emit to `deliver`, until close().
 *
 * Refused, opening nothing, while any of the adapters is in another open session: an
 * adapter has one event stream, and two jobs cannot tell whose events are whose.
 */
export function openEvidenceSession(
  adapters: readonly EvidenceAdapter[],
  owner: EvidenceOwner,
  deliver: (event: EmittedEvidence) => void,
): OpenEvidenceSessionResult {
  const unique = [...new Set(adapters)];
  // Every check runs before any claim, so a refusal leaves nothing half-open.
  for (const adapter of unique) {
    const holder = taps.get(adapter)?.session ?? null;
    if (holder !== null && !holder.closed) {
      return { ok: false, busy: { adapterId: adapter.id, jobId: holder.owner.jobId } };
    }
  }
  const session: Session = { owner, deliver, closed: false };
  for (const tap of unique.map(tapOf)) tap.session = session;
  return {
    ok: true,
    session: {
      close() {
        // Only this session's flag: a later session on the same adapters is unaffected.
        session.closed = true;
      },
    },
  };
}
