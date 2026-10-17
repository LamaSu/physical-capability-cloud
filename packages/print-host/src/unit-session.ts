import { createHash, createPublicKey, randomUUID, verify } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, open, readdir, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  canonicalize, hashBundle, hashEvent, isCompromisedDevicePublicKey, sessionKeyDelegationPreimage, signingPreimage,
  type EvidenceBundle, type EvidenceEvent, type SessionKey,
} from "@pcc/spec";
import type { PrintJobResult } from "@pcc/kernel";
import type { DeviceKey } from "./keys.js";
import { makeKernelEd25519Signer } from "./kernel-signer.js";

export type UnitSessionErrorCode = "bad_options" | "clock_skew" | "expired" |
  "bad_event" | "event_binding" | "event_fabricated" | "event_time" | "event_limit" | "empty_session" |
  "finalized" | "journal_exists" | "journal_io" | "journal_integrity" |
  "unit_mismatch" | "device_mismatch" | "compromised_device" | "signing_failed";

/** Deliberately contains no path, input, cause, or library error. */
export class UnitSessionError extends Error {
  readonly code: UnitSessionErrorCode;
  constructor(code: UnitSessionErrorCode) {
    super(code);
    this.name = "UnitSessionError";
    this.code = code;
  }
}

export interface OpenUnitEvidenceSessionOptions {
  settlementUnitId: string;
  challengeNonce: string;
  jobId: string;
  parentAgentId: string;
  fundedAt: number;
  expiresAt: number;
  deviceKey: DeviceKey;
  journalDir: string;
  /** Whole Unix seconds, like fundedAt and expiresAt. */
  now?: () => number;
}

export interface ResumeUnitEvidenceSessionOptions {
  journalDir: string;
  settlementUnitId: string;
  deviceKey: DeviceKey;
}

export interface UnitEvidenceSession {
  addPrintResult(result: PrintJobResult): Promise<void>;
  addEvent(event: EvidenceEvent): Promise<void>;
  finalize(): Promise<EvidenceBundle>;
}

// Journal records are local storage, never protocol wire types. They hold public data only.
type Binding = Omit<OpenUnitEvidenceSessionOptions, "deviceKey" | "journalDir" | "now"> & {
  devicePublicKey: string;
};
type RecordBody = { kind: "open"; binding: Binding } |
  { kind: "event"; event: EvidenceEvent } | { kind: "final"; bundle: EvidenceBundle };
type JournalRecord = { sequence: number; previousHash: string; record: RecordBody; hash: string };
type JournalState = { binding: Binding; events: EvidenceEvent[]; final?: EvidenceBundle; count: number; head: string };

const systemNow = () => Math.floor(Date.now() / 1_000);
// Share serialization between sessions resumed on the same directory. Copies
// deliberately have independent paths; they remain portable public journals.
const queues = new Map<string, Promise<unknown>>();
const seconds = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const fundingSeconds = (value: unknown): value is number => seconds(value) && value >= 1_600_000_000 && value < 2 ** 32;
const bytes32 = (value: unknown): value is string => typeof value === "string" && /^0x[0-9a-f]{64}$/.test(value);
const digest = (value: unknown) => createHash("sha256").update(canonicalize(value)).digest("hex");
const clone = <T>(value: T): T => JSON.parse(canonicalize(value)) as T;
const filename = (sequence: number) => `${String(sequence).padStart(8, "0")}.json`;
const temporaryName = /^\.\d{8}\.json\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/;
const genesis = (unit: string, key: string) => digest({ domain: "pcc-printhost.unit-session.v1", settlementUnitId: unit, devicePublicKey: key });

function checkBinding(binding: Binding): void {
  if (!bytes32(binding.settlementUnitId) || !bytes32(binding.challengeNonce) ||
    typeof binding.jobId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(binding.jobId) ||
    typeof binding.parentAgentId !== "string" || !/^eip155:(84532|31337):0x[0-9a-f]{40}$/.test(binding.parentAgentId) ||
    !fundingSeconds(binding.fundedAt) || !fundingSeconds(binding.expiresAt) || binding.expiresAt <= binding.fundedAt ||
    typeof binding.devicePublicKey !== "string" || !/^[0-9a-f]{64}$/.test(binding.devicePublicKey)) throw new UnitSessionError("bad_options");
}

function clock(now: () => number): number {
  try {
    const value = now();
    if (!seconds(value)) throw new Error();
    return value;
  } catch { throw new UnitSessionError("bad_options"); }
}

async function waitForFunding(now: () => number, fundedAt: number): Promise<void> {
  // Bound the wait by elapsed timers, not the skewed wall clock. Never move issuedAt.
  for (let elapsed = 0; clock(now) < fundedAt; elapsed += 1_000) {
    if (elapsed >= 120_000) throw new UnitSessionError("clock_skew");
    await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
  }
}

function eventTime(timestamp: string): number {
  // RFC 3339 needs an explicit offset. Check calendar fields rather than accepting
  // Date.parse's normalization of impossible dates such as February 31.
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.exec(timestamp);
  if (!match) throw new UnitSessionError("event_time");
  const [, year, month, day, hour, minute, second, offset] = match;
  const calendar = new Date(`${year}-${month}-${day}T00:00:00Z`);
  const time = Date.parse(timestamp) / 1_000;
  if (!Number.isFinite(time) || !Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== `${year}-${month}-${day}` ||
    Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59 ||
    (offset !== "Z" && (Number(offset.slice(1, 3)) > 23 || Number(offset.slice(4)) > 59))) {
    throw new UnitSessionError("event_time");
  }
  return time;
}

async function checkedEvent(input: EvidenceEvent, state: JournalState): Promise<EvidenceEvent> {
  let event: EvidenceEvent;
  try { event = clone(input); } catch { throw new UnitSessionError("bad_event"); }
  if (!event || typeof event.id !== "string" || event.id.length === 0 ||
    typeof event.type !== "string" || event.type.length === 0 || typeof event.timestamp !== "string" ||
    !event.source || typeof event.source !== "object" || Array.isArray(event.source) ||
    !event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) throw new UnitSessionError("bad_event");
  if ((Object.hasOwn(event.source, "simulated") && event.source.simulated !== false) ||
    (Object.hasOwn(event.payload, "mock") && event.payload.mock !== false)) throw new UnitSessionError("event_fabricated");
  const { binding, events } = state;
  const kernelId = event.source.kernelId;
  if (event.payload.settlementUnitId !== binding.settlementUnitId || event.payload.challengeNonce !== binding.challengeNonce ||
    event.payload.jobId !== binding.jobId || typeof kernelId !== "string" ||
    !/^[\x20-\x7e]{1,128}$/.test(kernelId) || /^(eip155:|ed25519:)/i.test(kernelId) ||
    (events.length > 0 && kernelId !== events[0].source.kernelId) ||
    (event.payload.kernelId !== undefined && event.payload.kernelId !== kernelId)) throw new UnitSessionError("event_binding");
  const time = eventTime(event.timestamp);
  if (time < binding.fundedAt || time > binding.expiresAt) throw new UnitSessionError("event_time");
  event.hash = await hashEvent(event);
  return event;
}

function stampEvent(event: EvidenceEvent, binding: Binding): EvidenceEvent {
  if (!event || !event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) throw new UnitSessionError("bad_event");
  const { settlementUnitId, challengeNonce } = binding;
  if ((event.payload.settlementUnitId !== undefined && event.payload.settlementUnitId !== settlementUnitId) ||
    (event.payload.challengeNonce !== undefined && event.payload.challengeNonce !== challengeNonce)) throw new UnitSessionError("event_binding");
  return { ...event, payload: { ...event.payload, settlementUnitId, challengeNonce } };
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function privateDirectory(directory: string): Promise<void> {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700 ||
    info.uid !== process.geteuid!()) throw new UnitSessionError("journal_io");
}

async function checkFinal(bundle: EvidenceBundle, state: JournalState): Promise<void> {
  const { binding, events } = state;
  const auth = bundle.sessionKeyAuthorization;
  if (events.length === 0 || canonicalize(bundle.events) !== canonicalize(events) ||
    bundle.bundleHash !== await hashBundle(events) || bundle.jobId !== binding.jobId ||
    bundle.stepId !== binding.settlementUnitId || bundle.kernelId !== events[0].source.kernelId || bundle.assuranceTier !== 0 ||
    !auth || auth.parentAgentId !== binding.parentAgentId || auth.issuedAt !== binding.fundedAt || auth.expiresAt !== binding.expiresAt ||
    auth.scope.maxSignatures !== events.length || canonicalize(auth.scope.contractIds) !== canonicalize([binding.jobId]) ||
    canonicalize([...auth.scope.allowedActions].sort()) !== canonicalize(["evidence_submit", "workflow_step_complete"]) ||
    !/^[0-9a-f]{64}$/.test(auth.publicKey) || auth.publicKey === binding.devicePublicKey ||
    !/^[0-9a-f]{128}$/.test(auth.parentSignature) || bundle.kernelSignature.algorithm !== "ed25519" ||
    bundle.kernelSignature.signer !== `0x${auth.publicKey.slice(0, 40)}` || !/^[0-9a-f]{128}$/.test(bundle.kernelSignature.value)) {
    throw new UnitSessionError("journal_integrity");
  }
  const publicKey = (hex: string) => createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(hex, "hex")]), format: "der", type: "spki",
  });
  const body = { ...auth, parentAgentId: auth.parentAgentId as SessionKey["parentAgentId"], publicKey: Buffer.from(auth.publicKey, "hex"), scope: {
    ...auth.scope, allowedActions: auth.scope.allowedActions as SessionKey["scope"]["allowedActions"],
  } };
  if (!verify(null, signingPreimage(bundle.bundleHash), publicKey(auth.publicKey), Buffer.from(bundle.kernelSignature.value, "hex")) ||
    !verify(null, sessionKeyDelegationPreimage(body), publicKey(binding.devicePublicKey), Buffer.from(auth.parentSignature, "hex"))) {
    throw new UnitSessionError("journal_integrity");
  }
}

async function append(directory: string, state: JournalState, body: RecordBody): Promise<void> {
  const content = { sequence: state.count, previousHash: state.head, record: body };
  const record: JournalRecord = { ...content, hash: digest(content) };
  // Publish only complete, durable bytes. link's EEXIST preserves exclusive
  // creation across processes; failed writes/links leave ignorable orphan temps.
  const temporary = join(directory, `.${filename(state.count)}.${randomUUID()}.tmp`);
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.chmod(0o600);
    await handle.writeFile(canonicalize(record));
    await handle.sync();
  } finally { await handle.close(); }
  await link(temporary, join(directory, filename(state.count)));
  await unlink(temporary);
  await syncDirectory(directory);
  state.count++;
  state.head = record.hash;
}

async function readJournal(directory: string, unit: string, deviceKey: DeviceKey): Promise<JournalState> {
  try {
    await privateDirectory(directory);
    const files = (await readdir(directory)).filter((name) => !temporaryName.test(name)).sort();
    if (files.length === 0) throw new UnitSessionError("journal_integrity");
    let state: JournalState | undefined;
    for (let sequence = 0; sequence < files.length; sequence++) {
      if (files[sequence] !== filename(sequence)) throw new UnitSessionError("journal_integrity");
      const handle = await open(join(directory, files[sequence]), constants.O_RDONLY | constants.O_NOFOLLOW);
      let record: JournalRecord;
      try {
        const info = await handle.stat();
        if (!info.isFile() || (info.mode & 0o777) !== 0o600 || info.uid !== process.geteuid!()) throw new UnitSessionError("journal_io");
        record = JSON.parse(await handle.readFile("utf8")) as JournalRecord;
      } finally { await handle.close(); }
      if (sequence === 0) {
        if (record.record.kind !== "open") throw new UnitSessionError("journal_integrity");
        const binding = record.record.binding;
        checkBinding(binding);
        if (binding.settlementUnitId !== unit) throw new UnitSessionError("unit_mismatch");
        if (binding.devicePublicKey !== deviceKey.publicKeyHex) throw new UnitSessionError("device_mismatch");
        state = { binding, events: [], count: 0, head: genesis(unit, deviceKey.publicKeyHex) };
      }
      if (!state || state.final || record.sequence !== sequence || record.previousHash !== state.head ||
        record.hash !== digest({ sequence: record.sequence, previousHash: record.previousHash, record: record.record }) ||
        Object.keys(record).sort().join(",") !== "hash,previousHash,record,sequence") throw new UnitSessionError("journal_integrity");
      if (record.record.kind === "event") {
        const event = await checkedEvent(record.record.event, state);
        if (event.hash !== record.record.event.hash || state.events.length >= 1000) throw new UnitSessionError("journal_integrity");
        state.events.push(event);
      } else if (record.record.kind === "final") {
        await checkFinal(record.record.bundle, state);
        state.final = record.record.bundle;
      } else if (sequence !== 0 || record.record.kind !== "open") throw new UnitSessionError("journal_integrity");
      state.count++;
      state.head = record.hash;
    }
    return state!;
  } catch (error) {
    if (error instanceof UnitSessionError && ["unit_mismatch", "device_mismatch", "journal_io"].includes(error.code)) throw error;
    throw new UnitSessionError("journal_integrity");
  }
}

function session(directory: string, deviceKey: DeviceKey, initial: JournalState, now: () => number): UnitEvidenceSession {
  let state = initial;
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const pending = (queues.get(directory) ?? Promise.resolve()).then(async () => {
      try {
        // Also detects a competing resumed writer or disk edits before a mutation.
        state = await readJournal(directory, state.binding.settlementUnitId, deviceKey);
        return await work();
      } catch (error) {
        if (error instanceof UnitSessionError) throw error;
        throw new UnitSessionError("journal_io");
      }
    });
    const tail = pending.then(() => undefined, () => undefined);
    queues.set(directory, tail);
    void tail.then(() => { if (queues.get(directory) === tail) queues.delete(directory); });
    return pending;
  };
  const addEvents = async (inputs: EvidenceEvent[]): Promise<void> => {
    if (state.final) throw new UnitSessionError("finalized");
    if (state.events.length + inputs.length > 1000) throw new UnitSessionError("event_limit");
    // Validate the whole batch against its preceding events before any write.
    const checking = { ...state, events: [...state.events] };
    const accepted: EvidenceEvent[] = [];
    for (const input of inputs) {
      const event = await checkedEvent(stampEvent(input, state.binding), checking);
      // Receipt-time freshness is an ADD constraint, never a replay constraint.
      if (eventTime(event.timestamp) > clock(now) + 300) throw new UnitSessionError("event_time");
      checking.events.push(event);
      accepted.push(event);
    }
    for (const event of accepted) {
      await append(directory, state, { kind: "event", event });
      state.events.push(event);
    }
  };
  return {
    addEvent(input) {
      // Snapshot before queueing, so later caller mutations cannot change this call.
      let event: EvidenceEvent;
      try { event = clone(input); } catch { return Promise.reject(new UnitSessionError("bad_event")); }
      return serial(() => addEvents([event]));
    },
    addPrintResult(result) {
      let events: EvidenceEvent[];
      try { events = clone(result.events); } catch { return Promise.reject(new UnitSessionError("bad_event")); }
      return serial(async () => {
        if (!Array.isArray(events)) throw new UnitSessionError("bad_event");
        // H3: consume the print events only, never its device-signed success bundle.
        await addEvents(events);
      });
    },
    finalize() {
      return serial(async () => {
        if (state.final) return clone(state.final);
        if (state.events.length === 0) throw new UnitSessionError("empty_session");
        if (clock(now) < state.binding.fundedAt) throw new UnitSessionError("clock_skew");
        if (clock(now) >= state.binding.expiresAt) throw new UnitSessionError("expired");
        const { binding, events } = state;
        const bundleHash = await hashBundle(events);
        let bundle: EvidenceBundle;
        let signer: ReturnType<typeof makeKernelEd25519Signer> | undefined;
        try {
          // H1(b): mint at finalization only. Neither secret ever enters a record.
          signer = makeKernelEd25519Signer();
          const body: Omit<SessionKey, "parentSignature"> = {
            sessionId: `session:${randomUUID()}`, parentAgentId: binding.parentAgentId as SessionKey["parentAgentId"],
            publicKey: Buffer.from(signer.publicKeyHex, "hex"), issuedAt: binding.fundedAt, expiresAt: binding.expiresAt,
            scope: { allowedActions: ["evidence_submit", "workflow_step_complete"], contractIds: [binding.jobId], maxSignatures: events.length },
          };
          const parentSignature = await deviceKey.signDelegation({
            ...body, jobId: binding.jobId, fundedAt: binding.fundedAt, reclaimAt: binding.expiresAt,
            firstEventAt: eventTime(events[0].timestamp), eventCount: events.length,
          });
          const signedAt = clock(now);
          if (signedAt < binding.fundedAt) throw new UnitSessionError("clock_skew");
          if (signedAt >= binding.expiresAt) throw new UnitSessionError("expired");
          // The kernel signer signs UTF-8; LO-EV-1's digest preimage is exactly
          // UTF-8 of the tagged hash (71 bytes), not raw32 and not JSON.
          const kernelSignature = await signer.signFn(new TextDecoder().decode(signingPreimage(bundleHash)));
          bundle = {
            id: `bundle:${randomUUID()}`, jobId: binding.jobId, stepId: binding.settlementUnitId,
            kernelId: events[0].source.kernelId!, assuranceTier: 0, events: clone(events), bundleHash, kernelSignature,
            createdAt: new Date(signedAt * 1_000).toISOString(),
            sessionKeyAuthorization: {
              ...body, publicKey: signer.publicKeyHex, parentSignature: parentSignature.replace(/^0x/, ""),
            },
          };
        } catch (error) {
          if (error instanceof UnitSessionError) throw error;
          throw new UnitSessionError("signing_failed");
        }
        finally { signer?.secretKey.fill(0); }
        await append(directory, state, { kind: "final", bundle });
        state.final = bundle;
        return clone(bundle);
      });
    },
  };
}

export async function openUnitEvidenceSession(options: OpenUnitEvidenceSessionOptions): Promise<UnitEvidenceSession> {
  try {
    const { settlementUnitId, challengeNonce, jobId, parentAgentId, fundedAt, expiresAt, deviceKey } = options;
    const binding: Binding = { settlementUnitId, challengeNonce, jobId, parentAgentId, fundedAt, expiresAt, devicePublicKey: deviceKey.publicKeyHex };
    checkBinding(binding);
    if (parentAgentId !== deviceKey.delegationParent) throw new UnitSessionError("bad_options");
    if (isCompromisedDevicePublicKey(deviceKey.publicKeyHex)) throw new UnitSessionError("compromised_device");
    if (typeof options.journalDir !== "string" || options.journalDir.length === 0) throw new UnitSessionError("bad_options");
    const journalDir = resolve(options.journalDir);
    const now = options.now ?? systemNow;
    await waitForFunding(now, fundedAt);
    if (clock(now) >= expiresAt) throw new UnitSessionError("expired");
    let created = false;
    try { await mkdir(journalDir, { mode: 0o700 }); created = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const info = await lstat(journalDir);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.geteuid!()) throw new UnitSessionError("journal_io");
    if ((await readdir(journalDir)).some((name) => !temporaryName.test(name))) throw new UnitSessionError("journal_exists");
    await chmod(journalDir, 0o700);
    const state: JournalState = { binding, events: [], count: 0, head: genesis(settlementUnitId, deviceKey.publicKeyHex) };
    await append(journalDir, state, { kind: "open", binding });
    if (created) await syncDirectory(dirname(journalDir));
    return session(journalDir, deviceKey, state, now);
  } catch (error) {
    if (error instanceof UnitSessionError) throw error;
    throw new UnitSessionError("journal_io");
  }
}

export async function resumeUnitEvidenceSession(options: ResumeUnitEvidenceSessionOptions): Promise<UnitEvidenceSession> {
  try {
    const directory = resolve(options.journalDir);
    const state = await readJournal(directory, options.settlementUnitId, options.deviceKey);
    return session(directory, options.deviceKey, state, systemNow);
  } catch (error) {
    if (error instanceof UnitSessionError) throw error;
    throw new UnitSessionError("journal_integrity");
  }
}
