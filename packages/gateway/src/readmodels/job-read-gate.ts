/**
 * The ONE gate for reads of a job's records (readmodels F3; gateway #2831 asked for one
 * shared helper, not copies). Every route that returns a job, its status, evidence, drift
 * alerts or money runs it first:
 *
 *   GET /api/jobs/:jobId              GET /api/jobs/:jobId/execution
 *   GET /api/jobs/:jobId/status       GET /api/jobs/:jobId/settlement
 *   GET /api/jobs/:jobId/evidence     GET /api/jobs/:jobId/drift-alerts
 *   GET /api/settlement/:jobId        GET /api/evidence/:jobId (the job-id form)
 *   GET /api/batches/by-job/:jobId    GET /api/telemetry/pipeline/:jobId
 *   GET /api/telemetry/logs?jobId=    GET /api/sensors/readings/:channel?jobId=
 *   GET /sse/stream/job/:jobId
 *   GET /api/compliance/evidence/:bundleId and its /tier-compliance, on the bundle's job
 *
 * (GET /api/print-and-mail/:jobId names a courier job, not a PCC job: it runs the same
 * identity precheck, then only an admin reads; see that route.)
 *
 * Identity first (precheckJobRead, #353's review r3): an admin (valid X-Admin-Key) proceeds;
 * no credential is 401 and a credential without a PROVEN wallet is 403 identity_unverified,
 * both BEFORE the job row is read, so neither says whether the job exists. A proven wallet
 * (SIWE: WP-A's req.provenWallet) then needs the job: it reads the job row, applies
 * TENANT_ENFORCE, and must be the job's kernel operator or its recorded buyer. Anyone else,
 * like a caller asking about a job that does not exist, gets the route's own 404. An API
 * key's operatorId or an email is never trusted as an identity here: self-service
 * provisioning lets anyone claim one.
 *
 * The authorization reads take only the caller's wallet (jobReaderOf; cross-family review r2
 * of #403, MEDIUM): the kernels it operates and the jobs whose single session names it. So a
 * refusal costs the same reads whether the job exists or not; only the requested row's own
 * lookup is keyed by the request.
 *
 * The routes that list or enumerate jobs use the same rule (F3 round 2): jobReadScopeOf
 * gives the set of jobs the caller may read (GET /api/jobs, /api/telemetry/jobs and /active,
 * /api/query's job intents).
 *
 * Records that belong to a KERNEL rather than one job (F3 round 3, review r2 of #403) take the
 * kernel's rule (gateKernelRead, kernelScopeOf): an admin or the kernel's operator. That is
 * the kernel, device and batch SSE streams, which carry job-bound sensor readings, and the
 * batch list and detail, whose slots name every sample's job and buyer. A job's buyer reads
 * its batches by job, where it sees only its own slots.
 *
 * Routes that mix records of many jobs and kernels (log lines, the live log stream, sensor
 * readings) keep a record only when the caller may read EVERY job and kernel it names, at any
 * depth (jobRecordFilterOf). A record that names neither is an admin's: its text can name any
 * job.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import { getStore } from "../db.js";
import { tenantOpts } from "../config/tenant-enforce.js";
import { batchOwnership } from "./batch-ownership.js";
import { declare, keyedHash, lit } from "../observability/closed-schema.js";
import {
  JOB_READ_REFUSAL,
  decideJobRead,
  jobReadCallerOf,
  jobReaderOf,
  jobsReadableBy,
  operatedKernelsOf,
  precheckJobRead,
  type JobReader,
  type JobRow,
} from "./job-execution.js";

export type JobReadGate =
  | { ok: true; job: JobRow; as: "admin" | "kernel_operator" | "buyer" }
  | { ok: false; kind: "unavailable" | "unauthenticated" | "identity_unverified" | "not_found" };

export function gateJobRead(req: FastifyRequest, jobId: string): JobReadGate {
  const pre = precheckJobRead(jobReadCallerOf(req as unknown as { headers: Record<string, unknown> }));
  if (!pre.proceed) return { ok: false, kind: pre.reason };

  let store: ReturnType<typeof getStore>;
  let found: JobRow | undefined;
  try {
    store = getStore();
    found = store.repos.jobs.findById(jobId) as JobRow | undefined;
  } catch (error) {
    req.log.error({ jobId: declare.id(jobId), err: error }, lit("job read gate: job row read failed"));
    return { ok: false, kind: "unavailable" };
  }
  const tenant = tenantOpts(req as any);
  const job = found && inTenant(found, tenant) ? found : undefined;

  if (pre.as === "admin") return job ? { ok: true, job, as: "admin" } : { ok: false, kind: "not_found" };
  try {
    // The caller's reader is built for every request, whether or not the job exists or is in
    // the caller's tenant, from reads keyed by the wallet alone (review r2 of #403, MEDIUM).
    const reader = jobReaderOf(pre.wallet, store.repos, store.db);
    const decision = job ? decideJobRead(job, reader) : undefined;
    if (job && decision?.allow) return { ok: true, job, as: decision.as };
    return { ok: false, kind: "not_found" };
  } catch (error) {
    req.log.error({ jobId: declare.id(jobId), err: error }, lit("job read gate: authorization read failed"));
    return { ok: false, kind: "unavailable" };
  }
}

/**
 * The gate for a record found by its own id (an evidence bundle) whose job decides who may read
 * it. Identity first, as in gateJobRead, before the record is looked up. Then (cross-family review
 * r3 of #403, MEDIUM): a proven wallet that is not a party to the record's job, judged from the
 * record's own job and kernel with the caller's wallet-keyed reader, is refused before any job row
 * is read. So a refusal makes the same reads whether the record exists or not, beyond the record's
 * own lookup. A party, or an admin, then goes through gateJobRead on the record's job: the job row,
 * its tenant and its kernel decide, as for any job read. A missing record, or one naming no job,
 * is not_found.
 */
export function gateJobRecordRead(
  req: FastifyRequest,
  recordOf: () => { jobId?: unknown; kernelId?: unknown; tenantId?: unknown } | null | undefined,
): JobReadGate {
  const pre = precheckJobRead(jobReadCallerOf(req as unknown as { headers: Record<string, unknown> }));
  if (!pre.proceed) return { ok: false, kind: pre.reason };
  let record: { jobId?: unknown; kernelId?: unknown; tenantId?: unknown } | null | undefined;
  let reader: JobReader | null = null;
  try {
    const store = getStore();
    if (pre.as !== "admin") reader = jobReaderOf(pre.wallet, store.repos, store.db);
    record = recordOf();
  } catch (error) {
    req.log.error({ err: error }, lit("job read gate: record read failed"));
    return { ok: false, kind: "unavailable" };
  }
  const jobId = typeof record?.jobId === "string" && record.jobId !== "" ? record.jobId : undefined;
  if (!jobId) return { ok: false, kind: "not_found" };
  // Under TENANT_ENFORCE a record that carries its own tenant is refused on it before any job row is
  // read (review r4 of #403, MEDIUM): a tenant-scoped admin's refusal then makes the same reads
  // whether the record exists or not. The job row's tenant is still checked after (gateJobRead).
  const tenant = tenantOpts(req as any);
  if (tenant && record && Object.prototype.hasOwnProperty.call(record, "tenantId") && (record.tenantId ?? null) !== tenant.tenantId) {
    return { ok: false, kind: "not_found" };
  }
  if (reader) {
    const kernelId = typeof record?.kernelId === "string" ? record.kernelId : "";
    if (!decideJobRead({ id: jobId, kernelId }, reader).allow) return { ok: false, kind: "not_found" };
  }
  return gateJobRead(req, jobId);
}

/** TENANT_ENFORCE's rule, as the gate has applied it since #353: a tenant-less job matches only a tenant-less caller. */
const inTenant = (job: Pick<JobRow, "tenantId">, tenant: { tenantId: string | null } | undefined) =>
  !tenant || (job.tenantId ?? null) === tenant.tenantId;

/**
 * The gate for a record that belongs to a kernel (a kernel, a device or a batch): an admin or
 * the kernel's operator, as a proven wallet. Identity first, as in gateJobRead. A proven
 * wallet's operated kernels are read from its wallet alone, before `kernelIdOf` resolves the
 * record to its kernel (a device's or a batch's); anyone who does not operate that kernel gets
 * the not_found a missing kernel, device or batch gets. An admin reads any record that exists:
 * `kernelRow` says the record is the kernel itself, named only by its id, so its row must exist.
 */
export type KernelReadGate =
  | { ok: true; kernelId: string; as: "admin" | "kernel_operator" }
  | { ok: false; kind: "unavailable" | "unauthenticated" | "identity_unverified" | "not_found" };

export function gateKernelRead(
  req: FastifyRequest,
  kernelIdOf: () => string | null | undefined,
  opts: { kernelRow?: boolean } = {},
): KernelReadGate {
  const pre = precheckJobRead(jobReadCallerOf(req as unknown as { headers: Record<string, unknown> }));
  if (!pre.proceed) return { ok: false, kind: pre.reason };
  let kernelId: string | undefined;
  let operated: ReadonlySet<string> | null = null;
  try {
    const store = getStore();
    if (pre.as !== "admin") operated = operatedKernelsOf(pre.wallet, store.repos);
    kernelId = kernelIdOf() ?? undefined;
    if (pre.as === "admin" && opts.kernelRow && kernelId !== undefined && store.repos.kernels.findById(kernelId) == null) {
      kernelId = undefined;
    }
  } catch (error) {
    req.log.error({ err: error }, lit("kernel read gate: record read failed"));
    return { ok: false, kind: "unavailable" };
  }
  if (kernelId === undefined) return { ok: false, kind: "not_found" };
  if (pre.as === "admin") return { ok: true, kernelId, as: "admin" };
  // Operated kernels are registered kernels, so this also refuses a kernel that does not exist.
  return operated!.has(kernelId) ? { ok: true, kernelId, as: "kernel_operator" } : { ok: false, kind: "not_found" };
}

/** The kernels whose records this caller may read: null for an admin (all of them). */
export type KernelReadScope =
  | { ok: true; kernels: ReadonlySet<string> | null }
  | { ok: false; kind: "unavailable" | "unauthenticated" | "identity_unverified" };

export function kernelScopeOf(req: FastifyRequest): KernelReadScope {
  const pre = precheckJobRead(jobReadCallerOf(req as unknown as { headers: Record<string, unknown> }));
  if (!pre.proceed) return { ok: false, kind: pre.reason };
  if (pre.as === "admin") return { ok: true, kernels: null };
  try {
    return { ok: true, kernels: operatedKernelsOf(pre.wallet, getStore().repos) };
  } catch (error) {
    req.log.error({ err: error }, lit("kernel read scope: kernel read failed"));
    return { ok: false, kind: "unavailable" };
  }
}

/**
 * The jobs this caller may read, for the routes that list jobs or read records keyed by a
 * job id. The refusals are gateJobRead's, in the same order. An admin reads every job, within
 * its tenant under TENANT_ENFORCE; a proven wallet reads the jobs whose kernel it operates or
 * whose single negotiation session names it as buyer (jobsReadableBy). `jobIds` is null when
 * every job id is readable, including ids with no job row (an admin without a tenant).
 */
export type JobReadScope =
  | { ok: true; as: "admin" | "proven"; jobIds: ReadonlySet<string> | null }
  | { ok: false; kind: "unavailable" | "unauthenticated" | "identity_unverified" };

export function jobReadScopeOf(req: FastifyRequest): JobReadScope {
  const pre = precheckJobRead(jobReadCallerOf(req as unknown as { headers: Record<string, unknown> }));
  if (!pre.proceed) return { ok: false, kind: pre.reason };
  const tenant = tenantOpts(req as any);
  if (pre.as === "admin" && !tenant) return { ok: true, as: "admin", jobIds: null };
  try {
    const store = getStore();
    const jobs = (store.repos.jobs.findAll() as JobRow[]).filter((job) => inTenant(job, tenant));
    if (pre.as === "admin") return { ok: true, as: "admin", jobIds: new Set(jobs.map((job) => job.id)) };
    return { ok: true, as: "proven", jobIds: jobsReadableBy(jobs, pre.wallet, store.repos, store.db) };
  } catch (error) {
    req.log.error({ err: error }, lit("job read scope: job or authorization read failed"));
    return { ok: false, kind: "unavailable" };
  }
}

/** May a caller with this scope read the records of the job with this id? */
export function scopeAllows(scope: Extract<JobReadScope, { ok: true }>, jobId: unknown): boolean {
  return scope.jobIds === null || (typeof jobId === "string" && scope.jobIds.has(jobId));
}

/**
 * A record exactly as it will be sent (cross-family review r3 of #403, HIGH): its JSON text, and
 * that text parsed back. Every filter here judges the parsed form, and every route sends that form
 * (or that text), never the live object: a getter or a toJSON could make the two differ.
 * Undefined when the record does not serialize; it is then not sent.
 */
export function asSent(record: unknown): { text: string; value: unknown } | undefined {
  let text: string | undefined;
  try {
    text = JSON.stringify(record);
  } catch {
    return undefined;
  }
  return text === undefined ? undefined : { text, value: JSON.parse(text) };
}

/** The records `keep` allows, each as it will be sent (asSent's parsed form). */
export function keepAsSent(records: readonly unknown[], keep: (record: unknown) => boolean): unknown[] {
  const out: unknown[] = [];
  for (const record of records) {
    const sent = asSent(record);
    if (sent && keep(sent.value)) out.push(sent.value);
  }
  return out;
}

/**
 * For a stream the caller was allowed to open (a job's, or a kernel's, device's or batch's), and
 * for a kernel record's events: keeps an event only when the caller may read every job that owns
 * it (recordOwnersOf: the jobs it names, and the jobs the live batch holds for the slots and
 * batches it is tied to; cross-family reviews r3 and r5 of #403, CRITICAL). A batch's own stream
 * passes the batch's id (ctx.batchId), so an event there that names none of its slots is the
 * batch's, shown only to a caller who may read every job of the batch. The job rule is
 * tenant-aware (jobReadScopeOf), so under TENANT_ENFORCE a kernel's stream carries only the jobs
 * of the caller's tenant. An event no job owns is the topic's own; one whose owners cannot be
 * known is dropped. An admin without a tenant keeps every event. Judge the event as sent (asSent).
 */
export type StreamEventFilter =
  | { ok: true; keep: (event: unknown) => boolean }
  | { ok: false; kind: "unavailable" | "unauthenticated" | "identity_unverified" };

export function streamEventFilterOf(req: FastifyRequest, ctx: { batchId?: string } = {}): StreamEventFilter {
  const scope = jobReadScopeOf(req);
  if (!scope.ok) return scope;
  if (scope.jobIds === null) return { ok: true, keep: () => true };
  return {
    ok: true,
    keep: (event) => {
      const owners = recordOwnersOf(event, ctx);
      return owners !== undefined && owners.jobs.every((jobId) => scopeAllows(scope, jobId));
    },
  };
}

/**
 * Which job-bound parts of a kernel's record (its batches' slots) this caller may see (cross-family
 * review r3 of #403, CRITICAL): the parts whose job it may read under the tenant-aware job rule.
 * `all` is true only for an admin without a tenant, who sees every part.
 */
export type JobPartScope =
  | { ok: true; all: boolean; keep: (jobId: unknown) => boolean }
  | { ok: false; kind: "unavailable" | "unauthenticated" | "identity_unverified" };

export function jobPartScopeOf(req: FastifyRequest): JobPartScope {
  const scope = jobReadScopeOf(req);
  if (!scope.ok) return scope;
  return { ok: true, all: scope.jobIds === null, keep: (jobId) => scopeAllows(scope, jobId) };
}

/**
 * Keys that bind a record to jobs, kernels, batch slots or batches, in any of the shapes producers
 * use. A slot's id is its sample's id (BatchTracker), so a sensor reading's sampleId names a slot.
 */
const JOB_KEY = /^job_?id$/i;
const JOB_LIST_KEY = /^job_?ids$/i;
const KERNEL_KEY = /^kernel_?id$/i;
const KERNEL_LIST_KEY = /^kernel_?ids$/i;
const SLOT_KEY = /^(slot|sample)_?id$/i;
const SLOT_LIST_KEY = /^(slot|sample)_?ids$/i;
const BATCH_KEY = /^batch_?id$/i;
const BATCH_LIST_KEY = /^batch_?ids$/i;
const MAX_DEPTH = 8;

export interface RecordBindings {
  jobs: string[];
  kernels: string[];
  /** The batch slots (samples) it names. Who owns them is the live batch's to say (recordOwnersOf). */
  slots: string[];
  batches: string[];
  /** A binding key held something other than a nonempty string: the record cannot be placed. */
  malformed: boolean;
}

/**
 * Every job, kernel, batch slot and batch a record names, at any depth (up to MAX_DEPTH), in
 * objects and arrays.
 * A binding key whose value is not a nonempty string, or a record nested deeper than
 * MAX_DEPTH, is malformed: the filter then keeps the record only for an unscoped admin.
 */
export function recordBindingsOf(record: unknown): RecordBindings {
  return walkBindings(record).bound;
}

/** One object of a record, with the batches and slots that object names itself. */
interface BindingNode {
  root: boolean;
  batches: string[];
  slots: string[];
}

function walkBindings(record: unknown): { bound: RecordBindings; nodes: BindingNode[] } {
  const out: RecordBindings = { jobs: [], kernels: [], slots: [], batches: [], malformed: false };
  const nodes: BindingNode[] = [];
  const seen = new WeakSet<object>();
  const one = (value: unknown, ...into: string[][]) => {
    if (value === undefined || value === null) return;
    if (typeof value === "string" && value.trim() !== "") into.forEach((list) => list.push(value));
    else out.malformed = true;
  };
  const many = (value: unknown, ...into: string[][]) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) value.forEach((v) => one(v, ...into));
    else out.malformed = true;
  };
  const walk = (value: unknown, depth: number) => {
    if (value === null || typeof value !== "object") return;
    if (seen.has(value as object)) return;
    if (depth > MAX_DEPTH) {
      out.malformed = true;
      return;
    }
    seen.add(value as object);
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    const node: BindingNode = { root: depth === 0, batches: [], slots: [] };
    nodes.push(node);
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (JOB_KEY.test(key)) one(child, out.jobs);
      else if (JOB_LIST_KEY.test(key)) many(child, out.jobs);
      else if (KERNEL_KEY.test(key)) one(child, out.kernels);
      else if (KERNEL_LIST_KEY.test(key)) many(child, out.kernels);
      else if (SLOT_KEY.test(key)) one(child, out.slots, node.slots);
      else if (SLOT_LIST_KEY.test(key)) many(child, out.slots, node.slots);
      else if (BATCH_KEY.test(key)) one(child, out.batches, node.batches);
      else if (BATCH_LIST_KEY.test(key)) many(child, out.batches, node.batches);
      else walk(child, depth + 1);
    }
  };
  walk(record, 0);
  return { bound: out, nodes };
}

export interface RecordOwners {
  /** The jobs that own the record: the caller must be able to read each one. */
  jobs: string[];
  /** The kernels it names, for the rule on a record that no job owns. */
  kernels: string[];
}

/**
 * Who owns a record (cross-family reviews r5 and r6 of #403, CRITICAL):
 *   - every job it names, at any depth;
 *   - for each batch slot (sample) it names, the job the LIVE slot belongs to;
 *   - for each object in it that names a batch, and for the record itself when it is on the
 *     batch's own stream (ctx.batchId), every job of that batch, unless the same object names a
 *     slot of that batch. Each object is resolved on its own, so a derived record's sources (an
 *     anomaly's readings) keep their own ties: a batch-level source is the whole batch's even
 *     when another source names a sample of that batch.
 * A name can only add owners, never take one away. Undefined when the owners cannot be known (a
 * malformed binding; a slot or batch that no live batch has; a slot that names no job; no
 * registered BatchOwnership, batch-ownership.ts): such a record is an unscoped admin's only.
 */
export function recordOwnersOf(record: unknown, ctx: { batchId?: string } = {}): RecordOwners | undefined {
  const { bound, nodes } = walkBindings(record);
  if (bound.malformed) return undefined;
  const jobs = new Set(bound.jobs);
  const ties = nodes
    .filter((node) => node.batches.length > 0 || (node.root && ctx.batchId !== undefined))
    .map((node) => ({ slots: node.slots, batches: node.root && ctx.batchId !== undefined ? [...node.batches, ctx.batchId] : node.batches }));
  if (ctx.batchId !== undefined && !nodes.some((node) => node.root)) ties.push({ slots: [], batches: [ctx.batchId] });
  if (bound.slots.length > 0 || ties.length > 0) {
    const live = batchOwnership();
    if (!live) return undefined;
    const batchOfSlot = new Map<string, string>();
    for (const slotId of new Set(bound.slots)) {
      const slot = live.slotOf(slotId);
      if (!slot || slot.jobId === undefined) return undefined;
      jobs.add(slot.jobId);
      batchOfSlot.set(slotId, slot.batchId);
    }
    for (const tie of ties) {
      const covered = new Set(tie.slots.map((slotId) => batchOfSlot.get(slotId)));
      for (const batchId of new Set(tie.batches)) {
        if (covered.has(batchId)) continue;
        const batchJobs = live.batchJobsOf(batchId);
        if (!batchJobs) return undefined;
        for (const jobId of batchJobs) {
          if (jobId === undefined) return undefined;
          jobs.add(jobId);
        }
      }
    }
  }
  return { jobs: [...jobs], kernels: bound.kernels };
}

/**
 * For a route that returns records of many jobs and kernels (log lines, sensor readings, live
 * telemetry): keeps a record only when the caller may read every job that owns it (recordOwnersOf:
 * the jobs it names, and for a record tied to a batch slot or a batch, the jobs the live batch
 * holds; review r5 of #403), and, when no job owns it, every kernel it names (the kernel's
 * operator). A record that names neither is kept only for an admin: free text such as a log
 * message can name any job. A record whose owners cannot be known (a malformed binding, a slot or
 * batch no live batch has) is kept only for an unscoped admin. Refused like the other gates: 401 without a
 * credential, 403 without a proven wallet, 503 when the records the rule needs cannot be read.
 *
 * #538's closed structured log (structured-logger.ts) stores an id its producer declared
 * (declare.id) as its keyed hash, so its line names a job or kernel by keyedHash(id). Such a value
 * counts as the job or kernel it is the keyed hash of, among those the caller may read: the
 * filter compares it with the keyed hashes of exactly those ids (computed once, when a keyed value
 * is first met). A keyed value that is no readable id's hash is a job or kernel the caller may not
 * read, so the line is left out. A field whose producer did not declare it is stored with its key
 * keyed too, so it binds nothing, and its line is an unscoped admin's only (the free-text rule).
 */
export type JobRecordFilter =
  | { ok: true; keep: (record: unknown) => boolean }
  | { ok: false; kind: "unavailable" | "unauthenticated" | "identity_unverified" };

export function jobRecordFilterOf(req: FastifyRequest): JobRecordFilter {
  const scope = jobReadScopeOf(req);
  if (!scope.ok) return scope;
  if (scope.as === "admin" && scope.jobIds === null) return { ok: true, keep: () => true };
  let operated: ReadonlySet<string> | null = null;
  if (scope.as === "proven") {
    const kernels = kernelScopeOf(req);
    if (!kernels.ok) return kernels;
    operated = kernels.kernels;
  }
  const admin = scope.as === "admin";
  let keyedJobs: ReadonlySet<string> | undefined;
  let keyedKernels: ReadonlySet<string> | undefined;
  const jobAllowed = (jobId: string): boolean => {
    if (scopeAllows(scope, jobId)) return true;
    if (scope.jobIds === null || !jobId.startsWith("h:")) return false;
    keyedJobs ??= new Set([...scope.jobIds].map((id) => keyedHash(id)));
    return keyedJobs.has(jobId);
  };
  const kernelAllowed = (kernelId: string): boolean => {
    if (operated === null) return false;
    if (operated.has(kernelId)) return true;
    if (!kernelId.startsWith("h:")) return false;
    keyedKernels ??= new Set([...operated].map((id) => keyedHash(id)));
    return keyedKernels.has(kernelId);
  };
  return {
    ok: true,
    keep: (record) => {
      const owners = recordOwnersOf(record);
      if (!owners) return false;
      if (owners.jobs.length > 0) return owners.jobs.every(jobAllowed);
      if (admin) return true;
      if (owners.kernels.length > 0) return owners.kernels.every(kernelAllowed);
      return false;
    },
  };
}

/**
 * Sends the refusal for a gate or a scope that did not pass. `notFound` is the route's own
 * body for a job that does not exist, so "not yours" and "no such job" are indistinguishable
 * (a scope is never refused as not_found). The 401 and 403 bodies are the same for every
 * job id.
 */
export function refuseJobRead(
  reply: FastifyReply,
  gate:
    | Extract<JobReadGate, { ok: false }>
    | Extract<JobReadScope, { ok: false }>
    | Extract<JobRecordFilter, { ok: false }>
    | Extract<KernelReadGate, { ok: false }>
    | Extract<KernelReadScope, { ok: false }>,
  notFound: Record<string, unknown> = {},
) {
  if (gate.kind === "unavailable") {
    return reply.code(503).send({
      error: "read_model_unavailable",
      message: "The job record could not be read. Try again shortly.",
    });
  }
  if (gate.kind === "unauthenticated" || gate.kind === "identity_unverified") {
    const refusal = JOB_READ_REFUSAL[gate.kind];
    return reply.code(refusal.status).send(refusal.body);
  }
  return reply.code(404).send(notFound);
}
