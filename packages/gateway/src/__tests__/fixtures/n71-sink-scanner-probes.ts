/**
 * N71 round 7 sink scanner — probe fixtures.
 *
 * Every probe is a REAL, typed function importing the gateway's own modules
 * (redaction.ts, facade-errors.ts, tracing.ts, telemetry.ts, sentry.ts) plus
 * @opentelemetry/api, fastify and node:http — so the round-7 scanner's
 * declaration-based resolution runs against genuine type information, the same
 * way it runs against the real 12-file scope. (A syntax-only parse of a bare
 * string snippet, as round 6's probes used, cannot exercise a TypeChecker-based
 * scanner at all — there is nothing for the checker to resolve.)
 *
 * None of these functions are ever CALLED from anywhere in the gateway package.
 * That is deliberate: it makes every parameter here NOT provably literal across
 * the whole program (zero call sites = isSafeParameterReference's "don't
 * vacuously trust" case) — exactly the "arbitrary caller-influenced value" shape
 * every probe needs to test against. This file is excluded from the gateway's own
 * build (it lives under src/__tests__/, which tsconfig.json's own `exclude`
 * already drops) and is NOT itself part of the whole-package scan: the scanner
 * engine adds it to the `ts.Program`'s root files explicitly, by path, for type
 * resolution only — n71-sink-scanner.test.ts scans individual named functions out
 * of it directly, never the whole file.
 */
import type { FastifyRequest } from "fastify";
import type { ServerResponse } from "node:http";
import { trace, type Span } from "@opentelemetry/api";
import {
  logSafeId,
  knownErrorClassName,
  logSafeSmallInt,
  logSafeInt,
  logSafeIsoTimestamp,
} from "../../redaction.js";
import { facadeErrorTelemetryCode } from "../../facades/facade-errors.js";
import { startTrace } from "../../tracing.js";
import { pipelineTelemetry } from "../../telemetry.js";
import { Sentry } from "../../sentry.js";
import { trackServerEvent } from "../../services/posthog-service.js";

const probeTracer = trace.getTracer("n71-probe", "1.0.0");

// ── Old cases (round 6), adapted to real typed call sites ────────────────────

/** [neg] flags err.message and deviceId inside an optional-chained req.log?.warn?.()
 *  call; the knownErrorClassName(err) call is unflagged. */
export function probeOptionalChainedLoggerCall(req: FastifyRequest, err: Error, deviceId: string): void {
  console.warn("fixed_code", knownErrorClassName(err));
  req.log?.warn?.({ err: err.message, deviceId }, "message");
}

/** control: a non-sink call (not declared in any recognized sink surface) is
 *  never scanned, however it is shaped. */
export function probeNonSinkCallNeverScanned(freeText: string, actorId: string): void {
  trackServerEventLike("x", { raw: freeText }, actorId);
  auditServiceLikeLog({ metadata: { raw: freeText } });
  auditServiceLikeLog(pipelineTelemetry);
}
function trackServerEventLike(_a: string, _b: unknown, _c: string): void {}
function auditServiceLikeLog(_a: unknown): void {}

/** [neg] a template-literal hole recurses: Date.now() is allowed, a bare
 *  identifier is flagged. */
export function probeTemplateHoleOk(): void {
  console.log(`t=${Date.now()}`);
}
export function probeTemplateHoleBad(someId: string): void {
  console.log(`id=${someId}`);
}

/** a ternary of two literals is allowed; a non-literal branch is flagged. */
export function probeTernaryOk(ok: boolean): void {
  console.warn(ok ? "a" : "b");
}
export function probeTernaryBad(ok: boolean, freeText: string): void {
  console.warn(ok ? "a" : freeText);
}

/** `a ?? b` / `a || b` recurses into both sides. (The left side here must be
 *  GENUINELY provable, not just named "safe" — round 7 has no name allowlist; a
 *  bare parameter with zero call sites anywhere, like every other probe
 *  parameter in this file, is correctly NOT provable on its own.) */
export function probeNullishOk(raw: unknown): void {
  console.log(logSafeId(raw) ?? "default");
}
export function probeNullishBad(unsafe: string): void {
  console.log(unsafe ?? "default");
}
export function probeOrBad(unsafe: string): void {
  console.log("" || unsafe);
}

/** a spread element/assignment is checked the same way a bare identifier
 *  argument would be. */
export function probeSpreadBad(rest: Record<string, unknown>): void {
  pipelineTelemetry.emit("id", "job_accepted", "completed", { metadata: { ...rest } });
}

/** formatters are allowed regardless of their OWN argument — that argument is
 *  exactly what each one launders. */
export function probeFormattersAlwaysAllowed(anyRawValue: unknown, err: unknown, n: unknown): void {
  console.warn(logSafeId(anyRawValue));
  console.warn(knownErrorClassName(err));
  console.warn(logSafeSmallInt(n, 0, 3));
  console.warn(logSafeInt(n));
  console.warn(logSafeIsoTimestamp(n));
  console.warn(facadeErrorTelemetryCode(err));
}

/** control: a fully-literal call to a representative set of sink shapes is clean. */
export function probeControlAllLiteral(): void {
  console.error("fixed", 1, true, null, undefined, { a: "x", b: [1, 2, "y"] }, `literal ${1}`);
}

// ── Round-7 probes ────────────────────────────────────────────────────────────

/** [neg] startTrace is a sink (gateway's own tracing.ts), and Sentry.startSpan /
 *  Sentry.startSpanManual are too (the round-6 scanner's shape list did not
 *  recognize any of these three — round-7 CRITICAL #2). */
export function probeStartTraceFlags(jobId: string): void {
  startTrace("job.lifecycle", "kernel", { "job.id": jobId });
}
export function probeSentryStartSpanManualFlags(bad: string): void {
  Sentry.startSpanManual({ name: "x", attributes: { id: bad } }, (span: Span, finish: () => void) => {
    finish();
  });
}
export function probeSentryStartSpanFlags(bad: string): void {
  Sentry.startSpan({ name: "x", attributes: { id: bad } }, (_span: Span) => undefined);
}

/** [neg] an `as any` callee in a scanned file FAILS as unresolvable — even though
 *  its own argument here is a harmless literal, the CALLEE itself cannot be
 *  resolved, so this call cannot be vouched for either way. */
export function probeAsAnyCalleeUnresolvable(req: FastifyRequest): void {
  (req as any).log?.warn?.("fine");
}

/** process.stdout.write is a sink (the Process interface's own stdout property);
 *  another Writable's .write — an HTTP response here — is not swept in. */
export function probeProcessStdoutWriteIsSink(bad: string): void {
  process.stdout.write(bad);
}
export function probeHttpResponseWriteIsNotASink(res: ServerResponse, bad: string): void {
  res.write(bad);
}

/** [neg] a local assigned a non-literal (even via a parameter, not just a bare
 *  string) is flagged — "a local whose every assignment is a literal" fails the
 *  moment ONE assignment isn't. */
export function probeLocalNonLiteralAssignmentFlags(bad: string): void {
  let code: string;
  code = bad;
  console.warn(code);
}

/** a local whose EVERY assignment (across branches) is a literal passes. */
export function probeLocalAllLiteralAssignmentsOk(takeBranchA: boolean): void {
  let code: string;
  if (takeBranchA) {
    code = "A";
  } else {
    code = "B";
  }
  console.warn(code);
}

/** [neg] a value returned by a formatter passes, at a sink the round-6 scanner's
 *  shape list never recognized (span.setAttribute, via @opentelemetry/api). */
export function probeFormatterReturnPassesAtOtelSpan(rawId: unknown): void {
  probeTracer.startActiveSpan("probe", (span) => {
    span.setAttribute("id", logSafeId(rawId));
    span.end();
  });
}
/** the same OTel span sink flags a raw, unformatted value. */
export function probeOtelSpanFlagsRaw(rawId: string): void {
  probeTracer.startActiveSpan("probe", (span) => {
    span.setAttribute("id", rawId);
    span.end();
  });
}

// Round-8 provenance and mutation probes.
export function probeConsoleElementAccess(raw: string): void {
  console["warn"](raw);
}
export function probeConsoleLocalAlias(raw: string): void {
  const warn = console.warn;
  warn(raw);
}
export function probeProcessReceiverAlias(raw: string): void {
  const out = process.stderr;
  out.write(raw);
}
export function probeConsoleTaggedTemplate(raw: string): void {
  console.warn`value ${raw}`;
}
export function probeConsoleDynamicElement(raw: string, method: "warn" | "error"): void {
  console[method](raw);
}
export function probeConsoleIndirectCall(raw: string): void {
  console.warn.call(console, raw);
}
export function probeCompoundAssignment(raw: string): void {
  let text = "fixed";
  text += raw;
  console.warn(text);
}
export function probeLogicalAssignment(raw: string): void {
  let text = "fixed";
  text &&= raw;
  console.warn(text);
}
export function probePropertyMutation(raw: string): void {
  const payload = { value: "fixed" };
  payload.value = raw;
  console.warn(payload);
}
export function probeAliasedPropertyMutation(raw: string): void {
  const payload = { value: "fixed" };
  const alias = payload;
  alias.value = raw;
  console.warn(payload);
}
export function probeComputedPropertyName(raw: string): void {
  console.warn({ [raw]: "fixed" });
}
export function probeParameterReassignment(raw: string): void {
  function emit(value: string): void {
    value = raw;
    console.warn(value);
  }
  emit("fixed");
}
export function probeIndirectParameterInvocation(raw: string): void {
  function emit(value: string): void {
    console.warn(value);
  }
  emit("fixed");
  const indirect = emit;
  indirect(raw);
}
export function probeEscapedAggregate(raw: string): void {
  const payload = { value: "fixed" };
  function modify(value: { value: string }): void { value.value = raw; }
  modify(payload);
  console.warn(payload);
}

export function probeConsoleDestructuredAlias(raw: string): void {
  const { warn } = console;
  warn(raw);
}
export function probeConsoleConditionalAlias(raw: string, choose: boolean): void {
  const warn = choose ? console.warn : console.error;
  warn(raw);
}
export function probeConsoleObjectAlias(raw: string): void {
  const logger = { warn: console.warn };
  logger.warn(raw);
}
export function probeProcessDestructuredReceiver(raw: string): void {
  const { stderr: out } = process;
  out.write(raw);
}

export function probeConsoleTypedReceiver(out: Console, raw: unknown): void {
  out.warn(raw);
}
export function probeArrayHeldSink(raw: string): void {
  const sinks = [console.warn];
  sinks[0](raw);
}
export function probeAssignedObjectSink(raw: string): void {
  const sinks = { write: (..._args: unknown[]): void => {} };
  sinks.write = console.warn;
  sinks.write(raw);
}
export function probeNullishAssignedSink(raw: string): void {
  let write: typeof console.warn | undefined;
  write ??= console.warn;
  write(raw);
}
export function probeLiteralMemberMutation(raw: string): void {
  const payload = { value: "fixed" as const };
  payload.value = raw as "fixed";
  console.warn(payload.value);
}
export function probeDestructuringAssignment(raw: string): void {
  let text = "fixed";
  ({ text } = { text: raw });
  console.warn(text);
}
export function probeForOfAssignment(raw: string[]): void {
  let text = "fixed";
  for (text of raw) break;
  console.warn(text);
}
export function probeForInAssignment(raw: Record<string, string>): void {
  let text = "fixed";
  for (text in raw) break;
  console.warn(text);
}
export function probeLiteralMemberRawInitializer(raw: string): void {
  const payload = { value: raw as "fixed" };
  console.warn(payload.value);
}
export function probeLiteralMemberEscapedMutation(raw: string): void {
  const payload = { value: "fixed" as const };
  function modify(value: typeof payload): void { value.value = raw as "fixed"; }
  modify(payload);
  console.warn(payload.value);
}

export function probeLiteralScalarRawInitializer(raw: string): void {
  const value = raw as "fixed";
  console.warn(value);
}

export function probeLiteralParameterRawArgument(raw: string): void {
  function emit(value: "fixed"): void { console.warn(value); }
  emit(raw as "fixed");
}
export function probeLiteralDestructuredRawInitializer(raw: { value: string }): void {
  const { value } = raw as { value: "fixed" };
  console.warn(value);
}
export function probeLiteralClassPropertyMutation(raw: string): void {
  class Payload {
    readonly value: "fixed";
    constructor() { this.value = raw as "fixed"; }
    emit(): void { console.warn(this.value); }
  }
  new Payload().emit();
}

export function probeReflectAppliedSink(raw: string): void {
  Reflect.apply(console.warn, console, [raw]);
}

export function probeRealTrackServerEvent(raw: string): void {
  trackServerEvent("job_submitted", { kernelId: raw }, raw);
}

export function probeReflectAppliedAnyConsoleAlias(raw: string): void {
  const out: any = console;
  Reflect.apply(out.warn, out, [raw]);
}
