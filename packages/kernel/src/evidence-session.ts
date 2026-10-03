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
 *
 * A tap gives an event to whichever session is open when the event ARRIVES, so a late
 * event of one job could be recorded under the next (astra pack 172). Hence:
 *   - Quiescence: a job's window stays open until its adapters are done: each adapter's
 *     quiesceEvidence() when it has one, otherwise until it has been quiet for the quiet
 *     period. It is bounded; events that arrive meanwhile are still the job's.
 *   - The handoff guard: once a session closes, its devices stay unavailable to a new
 *     session until they have been quiet for the quiet period since their last event.
 *     An event that arrives while no session is open is dropped, and restarts that clock.
 *   - The lock is the DEVICE: the canonical identity is the evidence source's
 *     (kernelId, deviceId); two adapters that claim one device are one device. One that
 *     misreports its device is misconfigured kernel code (TCB). Taps stay one per adapter
 *     object, because a listener is per object; busy and quiescing are checked per device,
 *     across every tap that claims it.
 *
 * The residual: an adapter without quiesceEvidence that emits a job's event more than the
 * quiet period after that job's previous event breaks the boundary (adapters/types.ts).
 * Only job-bound events, an adapter-contract change, would close that; it is a follow-up
 * for the adapters' owners.
 */

import type { EvidenceEvent, EvidenceSource } from "@pcc/spec";

/** An event as an adapter emits it, before the emitter ids and hashes it. */
export type EmittedEvidence = Omit<EvidenceEvent, "id" | "hash">;

/** The part of a machine, sensor or camera adapter that a session uses. */
export interface EvidenceAdapter {
  readonly id: string;
  /** The device the adapter drives: its (kernelId, deviceId) is what a session locks. */
  readonly source: Pick<EvidenceSource, "kernelId" | "deviceId">;
  onEvidence(callback: (event: EmittedEvidence) => void): void;
  /** Resolves once the adapter has emitted all its evidence for the work it was given. */
  quiesceEvidence?(): Promise<void>;
}

/** The job step a session records for. */
export interface EvidenceOwner {
  jobId: string;
  stepId: string;
}

export interface EvidenceSession {
  /**
   * Wait until every adapter has emitted all of this job's evidence: an adapter with
   * quiesceEvidence() until that resolves, any other until its device has been quiet
   * for quietMs. Events keep reaching the session meanwhile. Resolves false when that
   * takes longer than timeoutMs.
   */
  quiesce(quietMs: number, timeoutMs: number): Promise<boolean>;
  /** Stop delivering. Idempotent: once it returns, no event reaches deliver. */
  close(): void;
}

/**
 * Why a session was refused. "adapter": the adapter's device is in another open session.
 * "quiescing": its device has not been quiet since the last session on it closed, so an
 * event it emits now could still be that session's job's.
 */
export interface EvidenceBusy {
  reason: "adapter" | "quiescing";
  adapterId: string;
  jobId: string;
}

export type OpenEvidenceSessionResult = { ok: true; session: EvidenceSession } | { ok: false; busy: EvidenceBusy };

export interface OpenEvidenceSessionOptions {
  /** How long the session's devices stay unavailable after it closes, counted from their last event. */
  quietMs?: number;
}

/** The quiet period when a caller gives none. JobRunner's evidenceQuietMs has the same default. */
export const DEFAULT_EVIDENCE_QUIET_MS = 1_000;

interface Session {
  readonly owner: EvidenceOwner;
  readonly deliver: (event: EmittedEvidence) => void;
  /** How long its devices stay unavailable after it closes. */
  readonly quietMs: number;
  closed: boolean;
}

/** A physical device, shared by every adapter object that claims it. */
interface Device {
  /** The last session to claim the device: open, or closed. */
  holder: Session | null;
  /** When any tap on the device last saw an event, delivered or dropped. */
  lastEventAt: number;
}

/** An adapter object's permanent listener. */
interface Tap {
  device: Device;
  /** The last session to claim this adapter object. */
  session: Session | null;
}

/** Milliseconds on a monotonic clock. */
let now: () => number = () => performance.now();

/** Replace the clock that stamps events and measures quiet periods (tests); no argument restores it. */
export function setEvidenceClock(clock?: () => number): void {
  now = clock ?? (() => performance.now());
}

const devices = new Map<string, Device>();
const taps = new WeakMap<object, Tap>();

function deviceOf(adapter: EvidenceAdapter): Device {
  const key = `${adapter.source.kernelId}\u0000${adapter.source.deviceId}`;
  let device = devices.get(key);
  if (device === undefined) {
    device = { holder: null, lastEventAt: Number.NEGATIVE_INFINITY };
    devices.set(key, device);
  }
  return device;
}

/** The adapter's tap. The first call registers it, through the adapter's own onEvidence. */
function tapOf(adapter: EvidenceAdapter, device: Device): Tap {
  const existing = taps.get(adapter);
  if (existing !== undefined) return existing;
  const tap: Tap = { device, session: null };
  adapter.onEvidence((event) => {
    // Every event restarts its device's quiet clock, whether it is delivered or dropped.
    tap.device.lastEventAt = now();
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
 * Refused, opening nothing, while any adapter's device is in another open session, or
 * has not been quiet for the closed session's quiet period since its last event: a
 * device has one event stream, and two jobs cannot tell whose events are whose.
 */
export function openEvidenceSession(
  adapters: readonly EvidenceAdapter[],
  owner: EvidenceOwner,
  deliver: (event: EmittedEvidence) => void,
  options: OpenEvidenceSessionOptions = {},
): OpenEvidenceSessionResult {
  const unique = [...new Set(adapters)];
  const claims = unique.map((adapter) => ({ adapter, device: deviceOf(adapter) }));
  // Every check runs before any claim, so a refusal leaves nothing half-open.
  const at = now();
  for (const { adapter, device } of claims) {
    const holder = device.holder;
    if (holder === null) continue;
    if (!holder.closed) return { ok: false, busy: { reason: "adapter", adapterId: adapter.id, jobId: holder.owner.jobId } };
    if (at - device.lastEventAt < holder.quietMs) {
      return { ok: false, busy: { reason: "quiescing", adapterId: adapter.id, jobId: holder.owner.jobId } };
    }
  }
  // Every tap first: an onEvidence that throws leaves nothing claimed.
  const claimed = claims.map(({ adapter, device }) => ({ adapter, device, tap: tapOf(adapter, device) }));
  const session: Session = { owner, deliver, quietMs: options.quietMs ?? DEFAULT_EVIDENCE_QUIET_MS, closed: false };
  for (const { device, tap } of claimed) {
    tap.device = device;
    tap.session = session;
    device.holder = session;
  }
  return {
    ok: true,
    session: {
      quiesce: (quietMs, timeoutMs) => quiesce(claimed, quietMs, timeoutMs),
      close() {
        // Only this session's flag: a later session on the same adapters is unaffected.
        session.closed = true;
      },
    },
  };
}

async function quiesce(
  claimed: ReadonlyArray<{ adapter: EvidenceAdapter; device: Device }>,
  quietMs: number,
  timeoutMs: number,
): Promise<boolean> {
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        resolve();
      }, ms);
      timers.add(timer);
    });
  const hooked = claimed.filter(({ adapter }) => adapter.quiesceEvidence !== undefined);
  const timed = [...new Set(claimed.filter(({ adapter }) => adapter.quiesceEvidence === undefined).map(({ device }) => device))];
  const quiesced = async () => {
    // Inside an async function, so a quiesceEvidence that throws rejects instead.
    await Promise.all(hooked.map(({ adapter }) => adapter.quiesceEvidence!()));
    // Then until every other device has seen no event for quietMs, all at the same moment.
    // The clock is absolute, so waiting on the hooks first adds no time.
    for (;;) {
      const left = Math.max(0, ...timed.map((device) => device.lastEventAt + quietMs - now()));
      if (left <= 0) return true;
      await sleep(left);
    }
  };
  const timedOut = sleep(timeoutMs).then(() => false);
  try {
    return await Promise.race([quiesced(), timedOut]);
  } finally {
    for (const timer of timers) clearTimeout(timer);
  }
}
