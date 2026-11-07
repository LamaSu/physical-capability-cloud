import { JOB_EXECUTION_SCHEMA_ID, type JobExecutionDTO } from "@pcc/spec";

const unreadable = () => new Error("Snapshot could not be read. Pick a complete job execution JSON file.");
const isText = (v: unknown) => typeof v === "string";
const isNumber = (v: unknown) => typeof v === "number" && Number.isFinite(v);
const isBoolean = (v: unknown) => typeof v === "boolean";
const nullable = (check: (v: unknown) => boolean) => (v: unknown) => v === null || check(v);

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw unreadable();
  return value as Record<string, unknown>;
}

function fields(value: Record<string, unknown>, keys: string[], check: (v: unknown) => boolean) {
  for (const key of keys) if (!check(value[key])) throw unreadable();
}

function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw unreadable();
  return value;
}

/** Unknown enum strings stay data for the renderer's fixed unknown copy. Where the
 * spec has an unknown member, normalize to it. Never guess a success/default state. */
function vocabulary(value: Record<string, unknown>, key: string, known: readonly string[], fallback?: "unknown") {
  fields(value, [key], isText);
  if (fallback && !known.includes(value[key] as string)) value[key] = fallback;
}

function error(value: unknown) {
  if (value === null) return;
  const e = object(value);
  vocabulary(e, "code", ["source_read_failed"]);
  fields(e, ["message"], isText);
}

function money(value: unknown) {
  const m = object(value);
  fields(m, ["sourceStatus"], isText);
  fields(m, ["label"], nullable(isText));
  fields(m, ["known"], isBoolean);
  vocabulary(m, "vocabulary", ["escrow_record", "escrow_milestone"]);
  vocabulary(m, "tone", ["settled", "refunded", "waiting", "running", "failed", "unknown"], "unknown");
}

/** Validate the imported DTO's complete render shape before passing it to React.
 * The only cast is at this untrusted JSON boundary: future enum strings without
 * a spec `unknown` member are retained for JobFlowCard's fixed unknown fallback. */
export function parseJobExecutionSnapshot(text: string): JobExecutionDTO {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw unreadable(); }
  const dto = object(parsed);
  if (dto.schemaId !== JOB_EXECUTION_SCHEMA_ID) {
    throw new Error(`Unsupported snapshot schema. Expected ${JOB_EXECUTION_SCHEMA_ID}.`);
  }
  fields(dto, ["asOf"], isText);
  const job = object(dto.job);
  fields(job, ["jobId", "stepId", "capabilityId", "kernelId"], isText);
  fields(job, ["capabilityType", "capabilityName", "kernelName", "createdAt"], nullable(isText));
  fields(job, ["contractedTier"], nullable(isNumber));

  const execution = object(dto.execution);
  vocabulary(execution, "phase", ["pending", "queued", "dispatched", "running", "awaiting_handoff", "paused", "completed", "failed", "timed_out", "cancelled", "unknown"], "unknown");
  vocabulary(execution, "source", ["gateway_job_row"]);
  fields(execution, ["sourceStatus"], isText);
  fields(execution, ["terminal"], isBoolean);
  fields(execution, ["progressPercent"], nullable(isNumber));
  fields(execution, ["completedAt"], nullable(isText));

  const evidence = object(dto.evidence);
  vocabulary(evidence, "state", ["none", "received", "unavailable"]);
  vocabulary(evidence, "source", ["gateway_evidence_store"]);
  fields(evidence, ["bundleCount", "eventCount", "fabricatedEventCount"], nullable(isNumber));
  fields(evidence, ["latestStoredAt"], nullable(isText));
  fields(evidence, ["truncated"], isBoolean);
  error(evidence.error);
  for (const item of list(evidence.bundles)) {
    const bundle = object(item);
    fields(bundle, ["bundleId", "stepId", "bundleHash", "storedAt"], isText);
    fields(bundle, ["claimedTier", "eventCount", "fabricatedEventCount"], isNumber);
    if (bundle.signer !== null) fields(object(bundle.signer), ["algorithm", "id"], isText);
  }

  const verification = object(dto.verification);
  const outcome = object(verification.outcome);
  vocabulary(outcome, "state", ["not_available"]);
  vocabulary(outcome, "reason", ["no_public_outcome_verdict"]);
  const capture = object(verification.captureChecks);
  vocabulary(capture, "state", ["none", "present", "unavailable"]);
  vocabulary(capture, "source", ["gateway_capture_verdicts"]);
  fields(capture, ["pass", "partial", "fail", "unrecognized"], nullable(isNumber));
  fields(capture, ["latestAt"], nullable(isText));
  error(capture.error);
  for (const item of list(capture.items)) {
    const check = object(item);
    fields(check, ["verdictId", "sourceVerdict", "declaredClass", "verifiedClass", "checkedAt"], isText);
    vocabulary(check, "verdict", ["pass", "partial", "fail", "unknown"], "unknown");
  }

  const settlement = object(dto.settlement);
  const bases = ["negotiation_session_escrow_address", "negotiation_session_cwm", "job_cwm"];
  vocabulary(settlement, "link", ["linked", "not_linked", "ambiguous", "conflicting", "unavailable"]);
  vocabulary(settlement, "source", ["gateway_escrow_record"]);
  vocabulary(settlement, "payout", ["paid", "reported_released", "refunded", "not_paid", "simulated", "unknown"], "unknown");
  if (settlement.linkBasis !== null) vocabulary(settlement, "linkBasis", bases);
  for (const basis of list(settlement.linkMatches)) if (!isText(basis)) throw unreadable();
  if (settlement.payoutBasis !== null) vocabulary(settlement, "payoutBasis", ["milestone_record"]);
  if (settlement.payoutUnknownReason !== null) vocabulary(settlement, "payoutUnknownReason", ["records_conflict", "job_row_conflict", "status_unrecognized", "status_ambiguous", "milestone_shared", "no_single_milestone"]);
  if (settlement.payoutConfirmation !== null) vocabulary(settlement, "payoutConfirmation", ["record_only"]);
  error(settlement.error);
  if (settlement.record !== null) {
    const record = object(settlement.record);
    vocabulary(record, "kind", ["gateway_escrow_record"]);
    fields(record, ["escrowId", "contractAddress", "createdAt", "deadline"], isText);
    fields(record, ["contractVersion", "statusObservedAt"], nullable(isText));
    fields(record, ["simulated"], isBoolean);
    fields(record, ["milestoneClaimants"], nullable(isNumber));
    money(record.escrow);
    vocabulary(record, "milestoneMatch", ["exact", "no_milestones", "step_not_in_escrow", "ambiguous", "shared_by_jobs"]);
    fields(object(record.escrowTotal), ["amount", "currency"], isText);
    if (record.milestone !== null) {
      const milestone = object(record.milestone);
      fields(milestone, ["milestoneId", "stepId", "amount"], isText);
      fields(milestone, ["challengeWindowEnd"], nullable(isText));
      money(milestone.status);
    }
  }
  for (const notice of list(dto.notices)) if (!isText(notice)) throw unreadable();
  return dto as unknown as JobExecutionDTO;
}
