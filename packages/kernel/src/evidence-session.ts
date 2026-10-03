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
 * event of one job could be recorded under the next (astra pack 172). Arrival time does
 * not prove whose an event is, so a window ends on a handshake with the adapters, never
 * on a clock (round 3b; round 3's quiet period was arrival-time attribution again):
 *   - Quiescence: before a job's window closes, each adapter is asked, once, through its
 *     required quiesceEvidence(), to finish the work it was given (adapters/types.ts). The
 *     window stays open until every one has resolved, bounded by the caller, so a late
 *     event of the job is still recorded under the job.
 *   - The handoff guard: a device is free for a new session only once its adapter's
 *     latest quiesceEvidence() has resolved. While one is pending (a quiesce timed out) or
 *     after one rejected, the device refuses new sessions as "quiescing": fail closed, with
 *     no time-based release. A hook that rejected is asked again by the next attempt to
 *     open a session on that adapter, and the device is free once that call resolves.
 *   - close() asks every adapter not yet asked, so no path releases a device without its
 *     adapter's word.
 *   - The lock is the DEVICE: the canonical identity is the evidence source's
 *     (kernelId, deviceId); two adapters that claim one device are one device. One that
 *     misreports its device is misconfigured kernel code (TCB). Taps stay one per adapter
 *     object, because a listener is per object; busy and quiescing are checked per device,
 *     across every tap that claims it.
 *
 * What the handshake cannot cover: an adapter whose quiesceEvidence() resolves while its
 * work can still emit breaks its contract, and an event it emits later is dropped or
 * recorded under the next job. Only job-bound events, an adapter-contract change, would
 * close that. The JobRunner refuses an adapter that has no quiesceEvidence() at all.
 */

import type { EvidenceEvent, EvidenceSource } from "@pcc/spec";
import { failureText } from "./failure-text.js";

/** An event as an adapter emits it, before the emitter ids and hashes it. */
export type EmittedEvidence = Omit<EvidenceEvent, "id" | "hash">;

/** The part of a machine, sensor or camera adapter that a session uses. */
export interface EvidenceAdapter {
  readonly id: string;
  /** The device the adapter drives: its (kernelId, deviceId) is what a session locks. */
  readonly source: Pick<EvidenceSource, "kernelId" | "deviceId">;
  onEvidence(callback: (event: EmittedEvidence) => void): void;
  /** Resolves once the adapter has emitted every event of the work it was given. */
  quiesceEvidence(): Promise<void>;
}

/** The job step a session records for. */
export interface EvidenceOwner {
  jobId: string;
  stepId: string;
}

export interface EvidenceSession {
  /**
   * Ask each adapter, once, to finish the work it was given (quiesceEvidence), and wait
   * for all of them while events keep reaching the session. Resolves false when that takes
   * longer than timeoutMs; rejects with the error of a hook that rejects. A second call
   * waits on the same answers.
   */
  quiesce(timeoutMs: number): Promise<boolean>;
  /**
   * Stop delivering. Idempotent: once it returns, no event reaches deliver. An adapter not
   * yet asked to quiesce is asked now, and its device stays quiescing until it answers.
   */
  close(): void;
}

/**
 * Why a session was refused. "adapter": the adapter's device is in another open session.
 * "quiescing": its adapter has not yet confirmed (quiesceEvidence) that the last job's
 * work is done, so an event it emits now could still be that job's.
 */
export interface EvidenceBusy {
  reason: "adapter" | "quiescing";
  adapterId: string;
  jobId: string;
}

export type OpenEvidenceSessionResult = { ok: true; session: EvidenceSession } | { ok: false; busy: EvidenceBusy };

interface Session {
  readonly owner: EvidenceOwner;
  readonly deliver: (event: EmittedEvidence) => void;
  closed: boolean;
  /** Every adapter's answer, once the session has asked. */
  answers: Promise<void> | null;
}

/** A physical device, shared by every adapter object that claims it. */
interface Device {
  /** The last session to claim the device: open, or closed. */
  holder: Session | null;
  /** Taps on the device whose latest quiesceEvidence() is pending or rejected. */
  unsettled: number;
}

/** An adapter object's permanent listener. */
interface Tap {
  device: Device;
  /** The last session to claim this adapter object. */
  session: Session | null;
  /** Where its latest quiesceEvidence() call stands. */
  hook: "settled" | "pending" | "rejected";
  /** Numbers the calls, so only the latest one settles the tap. */
  calls: number;
}

const devices = new Map<string, Device>();
const taps = new WeakMap<object, Tap>();

function deviceOf(adapter: EvidenceAdapter): Device {
  const key = `${adapter.source.kernelId}\u0000${adapter.source.deviceId}`;
  let device = devices.get(key);
  if (device === undefined) {
    device = { holder: null, unsettled: 0 };
    devices.set(key, device);
  }
  return device;
}

function setHook(tap: Tap, hook: Tap["hook"]): void {
  const was = tap.hook !== "settled";
  const is = hook !== "settled";
  if (was !== is) tap.device.unsettled += is ? 1 : -1;
  tap.hook = hook;
}

/** The adapter's tap. The first call registers it, through the adapter's own onEvidence. */
function tapOf(adapter: EvidenceAdapter, device: Device): Tap {
  const existing = taps.get(adapter);
  if (existing !== undefined) {
    if (existing.device !== device) {
      // The adapter now reports another device (misconfiguration): its hook state moves with it.
      const hook = existing.hook;
      setHook(existing, "settled");
      existing.device = device;
      setHook(existing, hook);
    }
    return existing;
  }
  const tap: Tap = { device, session: null, hook: "settled", calls: 0 };
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
 * Ask the adapter to quiesce. Its device is quiescing until this call (if it is still the
 * latest) resolves; if it rejects, the device stays quiescing until a later call resolves.
 */
function ask(adapter: EvidenceAdapter, tap: Tap): Promise<void> {
  const call = ++tap.calls;
  setHook(tap, "pending");
  let answer: Promise<void>;
  try {
    answer = Promise.resolve(adapter.quiesceEvidence());
  } catch (err) {
    answer = Promise.reject(err);
  }
  return answer.then(
    () => {
      if (tap.calls === call) setHook(tap, "settled");
    },
    (err: unknown) => {
      if (tap.calls === call) setHook(tap, "rejected");
      throw err;
    },
  );
}

/** An adapter's id for a log line, read without throwing. */
function idOf(adapter: EvidenceAdapter): string {
  try {
    const id: unknown = adapter.id;
    return typeof id === "string" ? id : "(unreadable id)";
  } catch {
    return "(unreadable id)";
  }
}

const logUnanswered = (adapterId: string) => (err: unknown) => {
  console.error(`[evidence-session] adapter ${adapterId} could not confirm its evidence is complete: ${failureText(err)}`);
};

/**
 * Deliver every event the adapters emit to `deliver`, until close().
 *
 * Refused, opening nothing, while any adapter's device is in another open session, or its
 * adapter has not confirmed that the last session's work is done: a device has one event
 * stream, and two jobs cannot tell whose events are whose.
 */
export function openEvidenceSession(
  adapters: readonly EvidenceAdapter[],
  owner: EvidenceOwner,
  deliver: (event: EmittedEvidence) => void,
): OpenEvidenceSessionResult {
  const unique = [...new Set(adapters)];
  const claims = unique.map((adapter) => ({ adapter, device: deviceOf(adapter) }));
  // Every check runs before any claim, so a refusal leaves nothing half-open.
  for (const { adapter, device } of claims) {
    const holder = device.holder;
    if (holder !== null && !holder.closed) return { ok: false, busy: { reason: "adapter", adapterId: adapter.id, jobId: holder.owner.jobId } };
    if (device.unsettled > 0) {
      // A hook of this adapter that rejected is asked again, so the device can recover.
      const tap = taps.get(adapter);
      // The handler is attached before any id is read, and reads ids without throwing: a hook that
      // rejects is never left unhandled (tracked from astra pack 212).
      if (tap?.hook === "rejected") ask(adapter, tap).catch((err: unknown) => logUnanswered(idOf(adapter))(err));
      return { ok: false, busy: { reason: "quiescing", adapterId: adapter.id, jobId: holder?.owner.jobId ?? "unknown" } };
    }
  }
  // Every tap first: an onEvidence that throws leaves nothing claimed.
  const claimed = claims.map(({ adapter, device }) => ({ adapter, tap: tapOf(adapter, device) }));
  const session: Session = { owner, deliver, closed: false, answers: null };
  for (const { tap } of claimed) {
    tap.session = session;
    tap.device.holder = session;
  }
  const askAll = () => Promise.all(claimed.map(({ adapter, tap }) => ask(adapter, tap))).then(() => undefined);
  return {
    ok: true,
    session: {
      quiesce: (timeoutMs) => {
        session.answers ??= askAll();
        return within(session.answers, timeoutMs);
      },
      close() {
        // Only this session's flag: a later session on the same adapters is unaffected.
        if (session.closed) return;
        session.closed = true;
        if (session.answers === null) {
          session.answers = askAll();
          session.answers.catch((err: unknown) => logUnanswered(claimed.map(({ adapter }) => idOf(adapter)).join(", "))(err));
        }
      },
    },
  };
}

/** True once `answers` resolves; false if timeoutMs passes first. Its timer never outlives it. */
async function within(answers: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    return await Promise.race([answers.then(() => true), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}
