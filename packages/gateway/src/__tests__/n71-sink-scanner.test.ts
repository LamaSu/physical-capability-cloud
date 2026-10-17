/**
 * N71 round 7 (astra pack 83f, DO-NOT-SHIP at 7d8ba154): the sink scanner, rebuilt
 * BY DECLARATION. See n71-sink-scanner-engine.ts for the full design rationale
 * (sinks by declaration/default-deny, no name allowlist, whole-package scope with
 * a shrink-only baseline) and DECISIONS.md's "N71 (#451): round 7 drops every hand
 * list" (05:43) for the ruling this engine implements.
 *
 * This file is the test wrapper: mechanics probes (each run against a REAL, typed
 * fixture function in fixtures/n71-sink-scanner-probes.ts — a TypeChecker-based
 * scanner has nothing to resolve against a bare syntax-only snippet, unlike round
 * 6's purely-syntactic scanner) plus the real whole-package scan with its
 * zero-tolerance N71 scope and shrink-only baseline for everything else.
 *
 * Performance: the `ts.Program` is built exactly ONCE (engine-level singleton,
 * `getScanner()`), shared by every probe AND the real scan in this file — never
 * rebuilt per test. The scan-time report lives in the last test below.
 */
import { describe, it, expect } from "vitest";
import {
  getScanner,
  scanWholePackage,
  scanNode,
  findNamedFunction,
  loadBaseline,
  baselineFromViolations,
  newViolations,
  staleBaselineEntries,
  N71_SCOPE_FILES,
  PROBE_FIXTURE_PATH,
  type Violation,
  type ScanResult,
} from "./n71-sink-scanner-engine.js";

function formatViolations(vs: Violation[]): string {
  if (vs.length === 0) return "(none)";
  return vs.map((v) => `${v.file} [${v.sink}] ${v.argText}`).join("\n");
}

/** Scans exactly one named function out of the probe fixture file. */
function probeScan(fnName: string): ScanResult {
  const scanner = getScanner();
  const sourceFile = scanner.program.getSourceFile(PROBE_FIXTURE_PATH);
  if (!sourceFile) throw new Error(`probe fixture not in program: ${PROBE_FIXTURE_PATH}`);
  const fn = findNamedFunction(sourceFile, fnName);
  if (!fn) throw new Error(`probe function not found in fixture: ${fnName}`);
  return scanNode(fn, "fixtures/n71-sink-scanner-probes.ts", sourceFile, scanner);
}

describe("N71 round 7: sink scanner mechanics (probes, against real typed fixtures)", () => {
  it("[neg] flags err.message and deviceId inside an optional-chained req.log?.warn?.() call; knownErrorClassName(err) is unflagged", () => {
    const r = probeScan("probeOptionalChainedLoggerCall");
    expect(r.violations, formatViolations(r.violations)).toHaveLength(2);
    expect(r.violations.every((v) => v.sink === "log.warn")).toBe(true);
    expect(r.violations.map((v) => v.argText).sort()).toEqual(["deviceId", "err.message"]);
  });

  it("control: a non-sink call is never scanned, however it is shaped", () => {
    const r = probeScan("probeNonSinkCallNeverScanned");
    expect(r.violations, formatViolations(r.violations)).toHaveLength(0);
    expect(r.unresolvedCallees).toHaveLength(0);
  });

  it("a template-literal hole recurses: Date.now() is allowed, a bare identifier is flagged", () => {
    expect(probeScan("probeTemplateHoleOk").violations).toHaveLength(0);
    const bad = probeScan("probeTemplateHoleBad").violations;
    expect(bad, formatViolations(bad)).toHaveLength(1);
    expect(bad[0].argText).toBe("someId");
  });

  it("a ternary of two literals is allowed; a non-literal branch is flagged", () => {
    expect(probeScan("probeTernaryOk").violations).toHaveLength(0);
    const bad = probeScan("probeTernaryBad").violations;
    expect(bad, formatViolations(bad)).toHaveLength(1);
    expect(bad[0].argText).toBe("freeText");
  });

  it("`a ?? b` / `a || b` recurses into both sides", () => {
    expect(probeScan("probeNullishOk").violations).toHaveLength(0);
    const nullishBad = probeScan("probeNullishBad").violations;
    expect(nullishBad, formatViolations(nullishBad)).toHaveLength(1);
    expect(nullishBad[0].argText).toBe("unsafe");
    const orBad = probeScan("probeOrBad").violations;
    expect(orBad, formatViolations(orBad)).toHaveLength(1);
    expect(orBad[0].argText).toBe("unsafe");
  });

  it("a spread element/assignment is checked the same way a bare identifier argument would be", () => {
    const bad = probeScan("probeSpreadBad").violations;
    expect(bad, formatViolations(bad)).toHaveLength(1);
    expect(bad[0].argText).toBe("rest");
    expect(bad[0].sink).toBe("pipelineTelemetry.emit");
  });

  it("every formatter (logSafeId, knownErrorClassName, logSafeSmallInt, logSafeInt, logSafeIsoTimestamp, facadeErrorTelemetryCode) is allowed regardless of its OWN argument", () => {
    const r = probeScan("probeFormattersAlwaysAllowed");
    expect(r.violations, formatViolations(r.violations)).toHaveLength(0);
  });

  it("control: a fully-literal call to a representative sink is clean", () => {
    expect(probeScan("probeControlAllLiteral").violations).toHaveLength(0);
  });

  it("[neg] recognizes the real server-event sink and checks properties and distinct identity", () => {
    const result = probeScan("probeRealTrackServerEvent");
    expect(result.violations, formatViolations(result.violations)).toHaveLength(2);
    expect(result.violations.every((violation) => violation.sink === "trackServerEvent" && violation.argText === "raw")).toBe(true);
    expect(result.unresolvedCallees).toHaveLength(0);
  });

  it("[neg] startTrace is a sink (round-6's shape list never recognized it; CRITICAL #2)", () => {
    const r = probeScan("probeStartTraceFlags");
    expect(r.violations.length, formatViolations(r.violations)).toBeGreaterThanOrEqual(1);
    expect(r.violations.some((v) => v.sink === "startTrace" && v.argText === "jobId")).toBe(true);
  });

  it("[neg] Sentry.startSpanManual({attributes:{id: bad}}, cb) is flagged (CRITICAL #2)", () => {
    const r = probeScan("probeSentryStartSpanManualFlags");
    expect(r.violations.length, formatViolations(r.violations)).toBeGreaterThanOrEqual(1);
    expect(r.violations.some((v) => v.sink === "Sentry.startSpanManual" && v.argText === "bad")).toBe(true);
  });

  it("[neg] Sentry.startSpan is flagged (CRITICAL #2)", () => {
    const r = probeScan("probeSentryStartSpanFlags");
    expect(r.violations.length, formatViolations(r.violations)).toBeGreaterThanOrEqual(1);
    expect(r.violations.some((v) => v.sink === "Sentry.startSpan" && v.argText === "bad")).toBe(true);
  });

  it("[neg] an `as any` callee in a scanned file FAILS as unresolvable, not as a silently-ignored non-sink", () => {
    const r = probeScan("probeAsAnyCalleeUnresolvable");
    expect(r.violations, formatViolations(r.violations)).toHaveLength(0); // never classified as a sink either
    expect(r.unresolvedCallees.length, "expected an unresolved-callee failure").toBeGreaterThanOrEqual(1);
  });

  it("process.stdout.write is a sink; an HTTP response's write is not swept in", () => {
    const sink = probeScan("probeProcessStdoutWriteIsSink");
    expect(sink.violations, formatViolations(sink.violations)).toHaveLength(1);
    expect(sink.violations[0]).toMatchObject({ sink: "process.stdout.write", argText: "bad" });

    const notSink = probeScan("probeHttpResponseWriteIsNotASink");
    expect(notSink.violations, formatViolations(notSink.violations)).toHaveLength(0);
    expect(notSink.unresolvedCallees).toHaveLength(0);
  });

  it("[neg] a local assigned a non-literal is flagged", () => {
    const r = probeScan("probeLocalNonLiteralAssignmentFlags");
    expect(r.violations, formatViolations(r.violations)).toHaveLength(1);
    expect(r.violations[0].argText).toBe("code");
  });

  it("a local whose every assignment (across branches) is a literal passes", () => {
    expect(probeScan("probeLocalAllLiteralAssignmentsOk").violations).toHaveLength(0);
  });

  it("[neg] a value returned by a formatter passes, even at a sink shape round 6 never recognized (an @opentelemetry/api span)", () => {
    expect(probeScan("probeFormatterReturnPassesAtOtelSpan").violations).toHaveLength(0);
    const bad = probeScan("probeOtelSpanFlagsRaw").violations;
    expect(bad, formatViolations(bad)).toHaveLength(1);
    expect(bad[0].argText).toBe("rawId");
  });
});

describe("N71 round 8: sink provenance and immutable value proofs", () => {
  it.each([
    ["probeConsoleElementAccess", "console.warn"],
    ["probeConsoleLocalAlias", "console.warn"],
    ["probeProcessReceiverAlias", "process.stderr.write"],
    ["probeConsoleTaggedTemplate", "console.warn"],
    ["probeConsoleDestructuredAlias", "console.warn"],
    ["probeConsoleObjectAlias", "console.warn"],
    ["probeProcessDestructuredReceiver", "process.stderr.write"],
    ["probeConsoleTypedReceiver", "console.warn"],
    ["probeArrayHeldSink", "console.warn"],
    ["probeAssignedObjectSink", "console.warn"],
    ["probeNullishAssignedSink", "console.warn"],
  ])("[neg] recognizes %s by its sink provenance", (name, sink) => {
    const result = probeScan(name);
    expect(result.violations, formatViolations(result.violations)).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({ sink, argText: "raw" });
  });

  it.each(["probeConsoleDynamicElement", "probeConsoleIndirectCall", "probeConsoleConditionalAlias", "probeReflectAppliedSink", "probeReflectAppliedAnyConsoleAlias"])("[neg] fails closed for unsupported sink invocation %s", (name) => {
    const result = probeScan(name);
    expect(result.unresolvedCallees.length).toBeGreaterThanOrEqual(1);
  });

  it.each([
    ["probeCompoundAssignment", "text"],
    ["probeLogicalAssignment", "text"],
    ["probePropertyMutation", "payload"],
    ["probeAliasedPropertyMutation", "payload"],
    ["probeComputedPropertyName", "raw"],
    ["probeParameterReassignment", "value"],
    ["probeIndirectParameterInvocation", "value"],
    ["probeEscapedAggregate", "payload"],
    ["probeLiteralMemberMutation", "payload.value"],
    ["probeDestructuringAssignment", "text"],
    ["probeForOfAssignment", "text"],
    ["probeForInAssignment", "text"],
    ["probeLiteralMemberRawInitializer", "payload.value"],
    ["probeLiteralMemberEscapedMutation", "payload.value"],
    ["probeLiteralScalarRawInitializer", "value"],
    ["probeLiteralParameterRawArgument", "value"],
    ["probeLiteralDestructuredRawInitializer", "value"],
    ["probeLiteralClassPropertyMutation", "this.value"],
  ])("[neg] rejects %s rather than trusting the initializer", (name, argText) => {
    const result = probeScan(name);
    expect(result.violations.some((violation) => violation.argText === argText), formatViolations(result.violations)).toBe(true);
  });
});

describe("N71 round 9: sink escapes, derived sinks and conservative proofs", () => {
  it.each([
    "probeStructuralLoggerArgument", "probeStructuralLoggerFields", "probeSinkObjectProperty",
    "probeSinkConstructorArgument", "probeDestructuredSinkAssignment", "probeSinkReturn",
    "probeSinkDefault", "probeSinkSpread", "probeSinkArrayEscape", "probePipelineObjectEscape",
    "probeUnionSinkObjectEscape", "probeDerivedFunctionValueEscape", "probeDerivedObjectMethodEscape", "probeNestedSinkBinding", "probeShorthandSinkProperty", "probeTypedSinkCallableReturn", "probeUnionSinkCallableEscape", "probeConsoleSubclassThisEscape",
  ])("[neg] fails closed for sink-value escape %s", (name) => {
    const result = probeScan(name);
    expect(result.unresolvedCallees.some((row) => row.sink === "<sink-escape>"), formatViolations(result.unresolvedCallees)).toBe(true);
    if (name === "probeSinkObjectProperty") {
      expect(result.unresolvedCallees.some((row) => row.sink === "<sink-escape>" && row.argText === "console.warn"), formatViolations(result.unresolvedCallees)).toBe(true);
    }
    if (name === "probeConsoleSubclassThisEscape") {
      expect(result.unresolvedCallees.some((row) => row.sink === "<sink-escape>" && row.argText === "this"), formatViolations(result.unresolvedCallees)).toBe(true);
    }
  });

  it.each([
    "probeVirtualOverride", "probeInterfaceImplementation", "probeLiteralUnionCallRoot",
    "probeLiteralUnionAwaitRoot", "probeLiteralUnionThisRoot", "probeActiveSpanUnion",
    "probeExplicitSpanUnion", "probePickLogger", "probeLoggerResolvedSignature", "probeStringifyReplacer", "probeStringifyToJSON",
    "probeFunctionInDataPosition", "probeReassignedTraceBinding", "probeWrittenTraceBinding", "probeTraceDestructuredDefault",
  ])("[neg] refuses an unproven argument in %s", (name) => {
    const result = probeScan(name);
    expect(result.violations.length, formatViolations(result.violations)).toBeGreaterThan(0);
  });

  it.each(["probeStructuralDerivedReceiver", "probeStructuralDerivedMethodAlias", "probeOverloadedForwarder", "probeOverloadedConstructor", "probeStructuralDerivedParameter"])("structural receiver erasure cannot hide a caller of %s", (name) => {
    const result = probeScan(name);
    const admittedParameterLeaves = baselineFromViolations(result.violations.filter((row) => row.sink !== "<derived-sink>"));
    expect(newViolations(result.violations, admittedParameterLeaves).some((row) => row.sink === "<derived-sink>" && row.argText === "raw"), formatViolations(result.violations)).toBe(true);
  });

  it.each(["probePersistedConstructorField", "probePersistedSetterField", "probePersistedGenericField", "probePersistedElementField"])("stored field provenance cannot hide a caller of %s", (name) => {
    const result = probeScan(name);
    const admittedBodyLeaves = baselineFromViolations(result.violations.filter((row) => row.sink !== "<derived-sink>"));
    expect(newViolations(result.violations, admittedBodyLeaves).some((row) => row.sink === "<derived-sink>" && row.argText === "raw"), formatViolations(result.violations)).toBe(true);
  });

  it("a new raw caller cannot hide behind a baselined forwarder leaf", () => {
    const result = probeScan("probeForwarderFutureCaller");
    const forwarderRows = result.violations.filter((row) => row.sink !== "<derived-sink>");
    expect(newViolations(result.violations, baselineFromViolations(forwarderRows)).some((row) => row.sink === "<derived-sink>" && row.argText === "raw")).toBe(true);
  });

  it("derives forwarding argument positions to a fixpoint", () => {
    const result = probeScan("probeForwarderFixpoint");
    expect(result.violations.some((row) => row.sink === "<derived-sink>" && row.argText === "raw"), formatViolations(result.violations)).toBe(true);
  });

  it.each(["probeVirtualOverride", "probeInterfaceImplementation", "probeDestructuredParameterForwarder", "probeTaggedForwarder", "probeRestForwarder", "probeSpreadForwarder", "probeDerivedDefaultFixpoint"])("scans callers of the derived sink in %s", (name) => {
    const result = probeScan(name);
    expect(result.violations.some((row) => row.sink === "<derived-sink>" && row.argText === "raw"), formatViolations(result.violations)).toBe(true);
  });

  it.each(["probeDerivedOmittedDefault", "probeDerivedUndefinedDefault", "probeDerivedBindingDefault"])("checks derived default initializers at callers in %s", (name) => {
    const result = probeScan(name);
    expect(result.violations.some((row) => row.sink === "<derived-sink>" && row.argText.startsWith("forward(")), formatViolations(result.violations)).toBe(true);
  });

  it("checks derived constructor arguments", () => {
    const result = probeScan("probeDerivedConstructor");
    expect(result.violations.some((row) => row.sink === "<derived-sink>" && row.argText === "raw"), formatViolations(result.violations)).toBe(true);
  });

  it("fails closed for a tagged derived caller", () => {
    const result = probeScan("probeDerivedTaggedCaller");
    expect(result.unresolvedCallees.length, formatViolations(result.unresolvedCallees)).toBeGreaterThan(0);
  });

  it("keeps literal defaults proven at derived callers", () => {
    const result = probeScan("probeDerivedLiteralDefaultControl");
    expect(result.violations, formatViolations(result.violations)).toHaveLength(0);
    expect(result.unresolvedCallees, formatViolations(result.unresolvedCallees)).toHaveLength(0);
  });

  it("keeps proven JSON values with the supported replacer forms", () => {
    const result = probeScan("probeStringifyControls");
    expect(result.violations, formatViolations(result.violations)).toHaveLength(0);
    expect(result.unresolvedCallees, formatViolations(result.unresolvedCallees)).toHaveLength(0);
  });
});

describe("N71 round 7: the sink scanner over the whole gateway package (ruling (3))", () => {
  it("N71's own 12 files are at ZERO violations and ZERO unresolved callees", () => {
    const scanner = getScanner();
    const result = scanWholePackage(scanner);
    const n71Violations = result.violations.filter((v) => N71_SCOPE_FILES.includes(v.file));
    const n71Unresolved = result.unresolvedCallees.filter((v) => N71_SCOPE_FILES.includes(v.file));
    expect(n71Violations, formatViolations(n71Violations)).toEqual([]);
    expect(n71Unresolved, formatViolations(n71Unresolved)).toEqual([]);
  });

  it("every other file's violations match the generated baseline exactly — the baseline can only shrink", () => {
    const scanner = getScanner();
    const result = scanWholePackage(scanner);
    const otherViolations = result.violations.filter((v) => !N71_SCOPE_FILES.includes(v.file));
    const otherUnresolved = result.unresolvedCallees
      .filter((v) => !N71_SCOPE_FILES.includes(v.file))
      .map((v) => ({ ...v, sink: "<unresolved-callee>" }));
    const combined = [...otherViolations, ...otherUnresolved];

    const baseline = loadBaseline();
    const added = newViolations(combined, baseline);
    const stale = staleBaselineEntries(combined, baseline);

    expect(
      added,
      `NEW violation(s) not in the baseline — fix the code (the baseline generator can only REMOVE entries, never add):\n${formatViolations(added)}`,
    ).toEqual([]);
    expect(
      stale,
      `STALE baseline entry/entries no longer occurring — regenerate via \`pnpm --dir packages/gateway exec tsx scripts/generate-n71-sink-baseline.ts\`:\n${formatViolations(stale)}`,
    ).toEqual([]);
  });

  it("reports the whole-package scan time", () => {
    const scanner = getScanner();
    const result = scanWholePackage(scanner);
    // eslint-disable-next-line no-console
    console.log(
      `[n71-sink-scanner] Program build: ${scanner.buildMs.toFixed(1)}ms; whole-package scan: ${result.scanMs.toFixed(1)}ms over ${result.fileCount} files (${result.violations.length} violations, ${result.unresolvedCallees.length} unresolved callees total).`,
    );
    expect(result.scanMs).toBeGreaterThanOrEqual(0);
    expect(result.fileCount).toBeGreaterThan(0);
  });
});
