import { describe, it, expect } from "vitest";
import {
  DEVICE_REPORTED_EVENT_TYPES,
  EVIDENCE_LEVELS,
  EXECUTION_EVENT_TYPES,
  NON_EXECUTOR_EVENT_TYPES,
  EvidenceLevelInputError,
  GATEWAY_STAMPED_DEVICE_ID,
  INSPECTION_EVENT_TYPES,
  NO_OUTCOME_LEVEL_EVENT_TYPES,
  SUBMITTED_EVENT_TYPES,
  deriveContradictions,
  evidenceLevelOfBundles,
  evidenceLevelRank,
  evidenceLevelsOfEvents,
  inspectionFailed,
  inspectionVerdict,
  meetsEvidenceLevel,
  type AuthenticatedBundle,
  type EvidenceLevel,
  type EvidenceLevelContext,
  type EventLevel,
  type InspectionVerdict,
} from "../evidence/evidence-level.js";
import { bundleHasFabricatedEvents, isFabricated } from "../evidence/is-fabricated.js";
import * as evidenceBarrel from "../evidence/index.js";
import { EVIDENCE_EVENT_TYPES, type EvidenceEvent, type EvidenceEventType } from "../types/evidence.js";

const KERNEL = "kernel-print-1";
const PRINTER = "printer-hp-1";
const READER = "reader-inspect-1";
const CAMERA = "camera-inspect-1";

// Operator principals, the pcc.evidence.principal-id.v1 operator form.
const OP_A = `eip155:84532:0x${"a".repeat(40)}`; // the operator the job was assigned to
const OP_B = `eip155:84532:0x${"b".repeat(40)}`; // an independent operator
const OP_C = `eip155:1:0x${"c".repeat(40)}`; // a third operator

let seq = 0;
function ev(
  type: EvidenceEventType,
  deviceId: string | undefined,
  payload: unknown = {},
  extraSource: Record<string, unknown> = {},
): EvidenceEvent {
  seq += 1;
  return {
    id: `ev-${seq}`,
    type,
    timestamp: "2026-09-24T12:00:00.000Z",
    source: {
      ...(deviceId !== undefined ? { deviceId } : {}),
      deviceType: "controller",
      kernelId: KERNEL,
      ...extraSource,
    } as EvidenceEvent["source"],
    payload: payload as EvidenceEvent["payload"],
    hash: `sha256:${"0".repeat(64)}` as EvidenceEvent["hash"],
  };
}

/** An event whose `source` is exactly what the caller passes, for malformed attributions. */
function evWithSource(type: EvidenceEventType, source: unknown, payload: unknown = {}): EvidenceEvent {
  return { ...ev(type, undefined, payload), source: source as EvidenceEvent["source"] };
}

function bundle(events: EvidenceEvent[], trustDomain?: string): AuthenticatedBundle {
  return trustDomain === undefined ? { events } : { events, trustDomain };
}

const started = (device = PRINTER) => ev("execution_started", device);
const done = (device = PRINTER, payload: unknown = {}) => ev("execution_completed", device, payload);
const failed = (device = PRINTER) => ev("execution_failed", device);
const inspectPass = (device = READER) => ev("instrument_result", device, { pass: true });
const inspectFail = (device = READER) => ev("instrument_result", device, { pass: false });

/** The executing operator's bundle: started + completed, signed in OP_A. */
const executorBundle = () => bundle([started(), done()], OP_A);
const ASSIGNED_A: EvidenceLevelContext = { executorTrustDomains: [OP_A] };

const level = (bundles: AuthenticatedBundle[], context?: EvidenceLevelContext) =>
  evidenceLevelOfBundles(bundles, context);

describe("evidence levels — order", () => {
  it("is submitted < device_reported < inspected_output", () => {
    expect(EVIDENCE_LEVELS).toEqual(["submitted", "device_reported", "inspected_output"]);
    expect(evidenceLevelRank("submitted")).toBeLessThan(evidenceLevelRank("device_reported"));
    expect(evidenceLevelRank("device_reported")).toBeLessThan(evidenceLevelRank("inspected_output"));
  });

  it("a stronger level meets a weaker requirement, never the reverse, and null meets nothing", () => {
    const cases: Array<[EvidenceLevel | null, EvidenceLevel, boolean]> = [
      ["inspected_output", "device_reported", true],
      ["device_reported", "device_reported", true],
      ["device_reported", "inspected_output", false],
      ["submitted", "device_reported", false],
      [null, "submitted", false],
    ];
    for (const [reached, required, expected] of cases) {
      expect(meetsEvidenceLevel(reached, required), `${reached} vs ${required}`).toBe(expected);
    }
  });
});

describe("evidence levels — every event type is ruled on exactly once", () => {
  const ruled = [
    ...SUBMITTED_EVENT_TYPES,
    ...DEVICE_REPORTED_EVENT_TYPES,
    ...INSPECTION_EVENT_TYPES,
    ...NO_OUTCOME_LEVEL_EVENT_TYPES,
  ];

  it("covers the whole closed vocabulary, so a new type needs a ruling", () => {
    expect([...ruled].sort()).toEqual([...EVIDENCE_EVENT_TYPES].sort());
  });

  it("puts no type in two classes", () => {
    expect(new Set(ruled).size).toBe(ruled.length);
  });

  it("lists only vocabulary members as execution events", () => {
    for (const t of EXECUTION_EVENT_TYPES) expect(EVIDENCE_EVENT_TYPES).toContain(t);
  });
});

describe("evidence levels — each ruled type proves exactly its class", () => {
  const proves = (type: EvidenceEventType) => level([bundle([ev(type, PRINTER)], OP_A)]);

  it("every submitted type proves submitted", () => {
    for (const type of SUBMITTED_EVENT_TYPES) expect(proves(type), type).toBe("submitted");
  });

  it("every device-reported type proves device_reported", () => {
    for (const type of DEVICE_REPORTED_EVENT_TYPES) expect(proves(type), type).toBe("device_reported");
  });

  it("every no-outcome type proves no level on its own", () => {
    for (const type of NO_OUTCOME_LEVEL_EVENT_TYPES) expect(proves(type), type).toBeNull();
  });

  it("an inspection with a valid pinned verdict proves device_reported when independence is not shown", () => {
    expect(level([bundle([ev("instrument_result", READER, { pass: true })], OP_A)])).toBe("device_reported");
    expect(level([bundle([ev("batch_sample_result", READER, { status: "FAIL" })], OP_A)])).toBe("device_reported");
  });

  it("every execution type makes its bundle's domain an executor; a non-execution event does not", () => {
    for (const type of EXECUTION_EVENT_TYPES) {
      const executor = bundle([ev(type, "printer-c")], OP_C);
      expect(level([executor, bundle([inspectPass()], OP_C)], ASSIGNED_A), type).toBe("device_reported");
    }
    const telemetryOnly = bundle([ev("temperature_log", "sensor-c")], OP_C);
    expect(level([telemetryOnly, bundle([inspectPass()], OP_C)], ASSIGNED_A)).toBe("inspected_output");
  });
});

describe("evidence levels — the pcc-node shapes (PR #343)", () => {
  it("an accepted-only job is submitted, never device_reported", () => {
    const bundles = [
      bundle(
        [
          ev("execution_started", PRINTER),
          ev("execution_progress", PRINTER, { level: "submitted", result: { submitted: true } }),
        ],
        OP_A,
      ),
    ];
    expect(level(bundles)).toBe("submitted");
    expect(meetsEvidenceLevel(level(bundles), "device_reported")).toBe(false);
  });

  it("a device-reported completion is device_reported", () => {
    expect(level([executorBundle()])).toBe("device_reported");
    expect(level([executorBundle()], ASSIGNED_A)).toBe("device_reported");
  });

  it("a failed job proves no level", () => {
    expect(level([bundle([ev("execution_started", PRINTER), ev("execution_failed", PRINTER)], OP_A)])).toBeNull();
  });
});

describe("evidence levels — inspection needs an independent authenticated trust domain", () => {
  it("an instrument in another trust domain inspects the output", () => {
    expect(level([executorBundle(), bundle([inspectPass()], OP_B)], ASSIGNED_A)).toBe("inspected_output");
  });

  it("an inspection signed in the executing trust domain is only reporting (same bundle, or another bundle)", () => {
    const sameBundle = bundle([started(), done(), inspectPass(PRINTER)], OP_A);
    expect(level([sameBundle], ASSIGNED_A)).toBe("device_reported");
    expect(level([executorBundle(), bundle([inspectPass()], OP_A)], ASSIGNED_A)).toBe("device_reported");
  });

  it("an instrument reporting its own run is device_reported; another operator's measurement is inspected_output", () => {
    const own = bundle([ev("method_loaded", "reader-1"), ev("instrument_result", "reader-1", { pass: true })], OP_A);
    expect(level([own], ASSIGNED_A)).toBe("device_reported");
    const other = bundle([ev("instrument_result", "reader-2", { pass: true })], OP_B);
    expect(level([own, other], ASSIGNED_A)).toBe("inspected_output");
  });

  it("the assignment names the executor even when no bundle in the unit holds an execution event", () => {
    const inspectorOnly = (domain: string) => [bundle([inspectPass()], domain)];
    expect(level(inspectorOnly(OP_B))).toBe("device_reported"); // no assignment: independence cannot be shown
    expect(level(inspectorOnly(OP_A), ASSIGNED_A)).toBe("device_reported");
    expect(level(inspectorOnly(OP_B), ASSIGNED_A)).toBe("inspected_output");
  });

  it("a failed inspection is still inspected_output evidence (the level is strength, not verdict)", () => {
    expect(level([executorBundle(), bundle([inspectFail()], OP_B)], ASSIGNED_A)).toBe("inspected_output");
    const batchFail = bundle([ev("batch_sample_result", READER, { status: "FAIL" })], OP_B);
    expect(level([executorBundle(), batchFail], ASSIGNED_A)).toBe("inspected_output");
  });

  it("judges independence against the domain of every bundle that holds an execution event", () => {
    const execA = bundle([started("printer-a"), done("printer-a")], OP_A);
    const execC = bundle([started("printer-c"), done("printer-c")], OP_C);
    // Assigned to A only, but C also executed: an inspection in C is not independent, one in B is.
    expect(level([execA, execC, bundle([inspectPass()], OP_C)], ASSIGNED_A)).toBe("device_reported");
    expect(level([execA, execC, bundle([inspectPass()], OP_B)], ASSIGNED_A)).toBe("inspected_output");
  });

  it("any execution-type event makes its bundle's domain an executor, not only completions", () => {
    const onlyStarted = bundle([started("printer-c")], OP_C);
    expect(level([onlyStarted, bundle([inspectPass()], OP_C)], ASSIGNED_A)).toBe("device_reported");
    const onlyLoaded = bundle([ev("method_loaded", "printer-c")], OP_C);
    expect(level([onlyLoaded, bundle([inspectPass()], OP_C)], ASSIGNED_A)).toBe("device_reported");
  });

  it("a gateway-stamped execution record has no attribution, but its bundle's domain still counts as an executor", () => {
    const gatewayOwn = bundle([ev("execution_completed", GATEWAY_STAMPED_DEVICE_ID)], OP_C);
    expect(level([gatewayOwn, bundle([inspectPass()], OP_C)], ASSIGNED_A)).toBe("device_reported");
  });
});

describe("evidence levels — F1: independence is never judged from declared device ids", () => {
  it.each(["printer-1 ", " printer-1", "PRINTER-1", "printer-1-shadow", "a-second-id-it-controls", "decoy-1"])(
    "an inspection declared by %j in the executor's trust domain is not independent",
    (inspectorId) => {
      const sameKernelBundles = [
        bundle([ev("execution_completed", "printer-1")], OP_A),
        bundle([ev("instrument_result", inspectorId, { pass: true })], OP_A),
      ];
      expect(level(sameKernelBundles, ASSIGNED_A)).toBe("device_reported");
      const sameBundle = [
        bundle([ev("execution_completed", "printer-1"), ev("instrument_result", inspectorId, { pass: true })], OP_A),
      ];
      expect(level(sameBundle, ASSIGNED_A)).toBe("device_reported");
    },
  );

  it("naming only a decoy executor and declaring the real executor as the inspector gains nothing", () => {
    const decoy = bundle([ev("execution_completed", "decoy-1"), ev("instrument_result", "printer-1", { pass: true })], OP_A);
    expect(level([decoy], ASSIGNED_A)).toBe("device_reported");
  });

  it("the declared id is not consulted at all: the same id in two trust domains is independent", () => {
    const bundles = [
      bundle([ev("execution_completed", "printer-1")], OP_A),
      bundle([ev("instrument_result", "printer-1", { pass: true })], OP_B),
    ];
    expect(level(bundles, ASSIGNED_A)).toBe("inspected_output");
  });
});

describe("evidence levels — independence is blocked unless every precondition holds", () => {
  const inspectorB = () => bundle([inspectPass()], OP_B);

  it("an unknown executor domain blocks independence (an execution bundle with no trust domain)", () => {
    const executorNoDomain = bundle([started(), done()]);
    expect(level([executorNoDomain, inspectorB()], ASSIGNED_A)).toBe("device_reported");
  });

  it("a fabricated execution bundle with no trust domain also makes the executor set unknown", () => {
    const fakeNoDomain = bundle([ev("execution_completed", PRINTER, { mock: true })]);
    expect(level([fakeNoDomain, executorBundle(), inspectorB()], ASSIGNED_A)).toBe("device_reported");
  });

  it("a fabricated execution bundle's trust domain still joins the executor set", () => {
    const fakeInC = bundle([ev("execution_completed", PRINTER, { mock: true })], OP_C);
    const inspectorC = bundle([inspectPass()], OP_C);
    expect(level([fakeInC, inspectorC, executorBundle()], ASSIGNED_A)).toBe("device_reported");
    // Control: without the fabricated execution bundle, C is independent.
    expect(level([inspectorC, executorBundle()], ASSIGNED_A)).toBe("inspected_output");
  });

  it("an empty or absent executorTrustDomains blocks independence, whatever the bundles say", () => {
    const bundles = () => [executorBundle(), inspectorB()];
    expect(level(bundles())).toBe("device_reported");
    expect(level(bundles(), {})).toBe("device_reported");
    expect(level(bundles(), { executorTrustDomains: [] })).toBe("device_reported");
    expect(level(bundles(), ASSIGNED_A)).toBe("inspected_output");
  });

  it("an inspection whose bundle has no trust domain is not independent", () => {
    expect(level([executorBundle(), bundle([inspectPass()])], ASSIGNED_A)).toBe("device_reported");
  });

  it("an inspection in a domain that is both assigned and observed as executor is not independent", () => {
    expect(level([executorBundle(), bundle([inspectPass()], OP_A)], ASSIGNED_A)).toBe("device_reported");
  });
});

describe("evidence levels — F2: an inspection proves a level only with a valid verdict", () => {
  const independent = (events: EvidenceEvent[]) => level([executorBundle(), bundle(events, OP_B)], ASSIGNED_A);

  it("an empty-payload inspection of any type never reaches inspected_output (the completion keeps device_reported)", () => {
    for (const type of INSPECTION_EVENT_TYPES) {
      expect(independent([ev(type, CAMERA, {})]), type).toBe("device_reported");
    }
  });

  it("none and malformed verdicts prove NO level, not even device_reported", () => {
    const noVerdict: unknown[] = [{}, { note: "x" }, { confidence: 0.9, findings: [] }];
    const unreadable: unknown[] = [null, [], "pass", 7, { pass: "yes" }, { passed: true }, { verdict: "PASS" }];
    for (const type of INSPECTION_EVENT_TYPES) {
      for (const payload of [...noVerdict, ...unreadable]) {
        if (type === "cv_inspection_result" && (payload as { passed?: unknown } | null)?.passed === true) continue; // valid for cv
        expect(level([bundle([ev(type, READER, payload)], OP_B)], ASSIGNED_A), `${type} ${JSON.stringify(payload)}`).toBeNull();
      }
    }
  });

  it("a valid pass or fail proves a level; with independence it is inspected_output, without it device_reported", () => {
    for (const events of [
      [ev("instrument_result", READER, { pass: true })],
      [ev("instrument_result", READER, { pass: false })],
      [ev("batch_sample_result", READER, { status: "PASS" })],
      [ev("batch_sample_result", READER, { status: "FAIL" })],
      [ev("cv_inspection_result", READER, { passed: true })],
      [ev("cv_inspection_result", READER, { passed: false })],
    ]) {
      expect(level([bundle(events, OP_B)], ASSIGNED_A)).toBe("inspected_output");
      expect(level([bundle(events, OP_A)], ASSIGNED_A)).toBe("device_reported");
    }
  });
});

describe("evidence levels — fail closed", () => {
  it("F4: one fabricated event makes the whole bundle prove no level (source.simulated or payload.mock)", () => {
    const withMock = bundle([done(), ev("camera_snapshot", CAMERA, { mock: true })], OP_A);
    const withSimulated = bundle([done(), ev("camera_snapshot", CAMERA, {}, { simulated: true })], OP_A);
    for (const mixed of [withMock, withSimulated]) {
      expect(bundleHasFabricatedEvents(mixed)).toBe(true);
      expect(level([mixed])).toBeNull();
    }
  });

  it("a fabricated bundle beside a genuine one does not lift or lower the genuine bundle's level", () => {
    const fabricated = bundle([done("printer-ghost", { mock: true }), inspectPass(CAMERA)], OP_B);
    expect(level([fabricated])).toBeNull();
    expect(level([fabricated, executorBundle()], ASSIGNED_A)).toBe("device_reported");
  });

  it("a fabricated inspector bundle cannot reach inspected_output", () => {
    const fabricatedInspector = bundle([inspectPass(), ev("camera_snapshot", CAMERA, { mock: true })], OP_B);
    expect(level([executorBundle(), fabricatedInspector], ASSIGNED_A)).toBe("device_reported");
  });

  it("an event with no device attribution proves no level", () => {
    const sources: unknown[] = [
      undefined,
      null,
      "printer-1",
      7,
      {},
      { deviceType: "controller" },
      { deviceId: "" },
      { deviceId: 7 },
      { deviceId: null },
      { deviceId: ["printer-1"] },
    ];
    for (const source of sources) {
      const unattributed = bundle([evWithSource("execution_completed", source)], OP_A);
      expect(level([unattributed], ASSIGNED_A), JSON.stringify(source)).toBeNull();
    }
    for (const deviceId of [undefined, ""]) {
      expect(level([bundle([ev("execution_completed", deviceId)], OP_A)])).toBeNull();
    }
  });

  it("events the gateway stamps itself (PUT /complete) prove no level, whatever types the caller chose", () => {
    expect(GATEWAY_STAMPED_DEVICE_ID).toBe("gateway");
    const gatewayOwn = ev("execution_completed", GATEWAY_STAMPED_DEVICE_ID, { toolCallCount: 0 });
    const callerTyped = ev("instrument_result", GATEWAY_STAMPED_DEVICE_ID, { pass: true });
    expect(level([bundle([gatewayOwn, callerTyped], OP_B)], ASSIGNED_A)).toBeNull();
    expect(level([bundle([gatewayOwn], OP_B), executorBundle()], ASSIGNED_A)).toBe("device_reported");
  });

  it("the gateway stamp is compared after an ASCII trim and ASCII lowercase", () => {
    const aliases = [
      "gateway",
      "Gateway",
      "GATEWAY",
      "gAtEwAy",
      " gateway ",
      "gateway\t",
      "\n gateway\r\n",
      "\u000bgateway\u000c",
    ];
    for (const id of aliases) {
      expect(level([bundle([ev("execution_completed", id)], OP_A)]), JSON.stringify(id)).toBeNull();
    }
  });

  it("anything else is a real attribution: no locale or Unicode folding or trimming", () => {
    const notTheStamp = [
      "gateway-1",
      "gatewayx",
      "xgateway",
      "gate way",
      "gateway ", // NBSP is not ASCII whitespace
      " gateway",
      "gateway ",
      "gateway﻿",
      "﻿gateway",
      "gateway\u0000",
      "ｇａｔｅｗａｙ", // full-width "gateway"
    ];
    for (const id of notTheStamp) {
      expect(level([bundle([ev("execution_completed", id)], OP_A)]), JSON.stringify(id)).toBe("device_reported");
    }
  });

  it("the gateway comparison is linear: a very long padded id neither hangs nor matches", () => {
    const pad = " ".repeat(200_000);
    expect(level([bundle([ev("execution_completed", `${pad}gateway${pad}`)], OP_A)])).toBeNull();
    expect(level([bundle([ev("execution_completed", `${pad}x${pad}`)], OP_A)])).toBe("device_reported");
  });

  it("printer_job_verified (a log-stream summary with no success field) proves no level", () => {
    const events = [
      ev("printer_log_captured", PRINTER),
      ev("printer_job_verified", PRINTER, { chainLength: 12, summary: "completed with 12 log entries" }),
    ];
    expect(level([bundle(events, OP_A)])).toBeNull();
  });

  it("telemetry and raw captures alone prove no level", () => {
    const events = [
      ev("power_profile_summary", PRINTER),
      ev("temperature_log", PRINTER),
      ev("camera_snapshot", CAMERA),
      ev("photo_captured", CAMERA),
      ev("log_hash_chain_entry", PRINTER),
    ];
    expect(level([bundle(events, OP_A)])).toBeNull();
  });

  it("no bundles, or bundles with no events, prove no level", () => {
    expect(level([])).toBeNull();
    expect(level([bundle([], OP_A), bundle([])])).toBeNull();
  });
});

describe("evidence levels — trust domains and input are validated, never guessed", () => {
  const validDomains = [
    OP_A,
    `eip155:1:0x${"0".repeat(40)}`,
    `eip155:84532:0x${"0123456789abcdef".repeat(2)}01234567`,
    `eip155:9007199254740991:0x${"f".repeat(40)}`, // Number.MAX_SAFE_INTEGER
  ];
  const invalidDomains: unknown[] = [
    "",
    " ",
    `${OP_A} `,
    ` ${OP_A}`,
    `${OP_A}\n`,
    `0x${"a".repeat(40)}`,
    `eip155:84532:${"a".repeat(40)}`, // no 0x
    `eip155:84532:0X${"a".repeat(40)}`, // uppercase X
    `eip155:84532:0x${"A".repeat(40)}`, // uppercase hex
    `eip155:84532:0x${"a".repeat(39)}`,
    `eip155:84532:0x${"a".repeat(41)}`,
    `eip155:84532:0x${"g".repeat(40)}`,
    `eip155:0:0x${"a".repeat(40)}`, // chain id 0
    `eip155:084532:0x${"a".repeat(40)}`, // leading zero
    `eip155:-1:0x${"a".repeat(40)}`,
    `eip155:1.5:0x${"a".repeat(40)}`,
    `eip155:1e3:0x${"a".repeat(40)}`,
    `eip155:9007199254740992:0x${"a".repeat(40)}`, // 2^53, not a safe integer
    `eip155:${"9".repeat(40)}:0x${"a".repeat(40)}`,
    `eip156:1:0x${"a".repeat(40)}`,
    `EIP155:1:0x${"a".repeat(40)}`,
    `eip155:1:0x${"a".repeat(40)}:extra`,
    `did:pkh:eip155:1:0x${"a".repeat(40)}`,
    "gateway",
    123,
    null,
    {},
    [OP_A],
    true,
  ];

  it("accepts the exact operator form, including the largest safe chain id", () => {
    for (const domain of validDomains) {
      expect(() => level([bundle([], domain)]), domain).not.toThrow();
      expect(() => level([], { executorTrustDomains: [domain] }), domain).not.toThrow();
      expect(() => deriveContradictions([bundle([], domain)]), domain).not.toThrow();
    }
  });

  it("a malformed bundle trustDomain throws EvidenceLevelInputError, from both functions", () => {
    for (const domain of invalidDomains) {
      const bad = { events: [], trustDomain: domain } as unknown as AuthenticatedBundle;
      expect(() => level([bad]), String(domain)).toThrow(EvidenceLevelInputError);
      expect(() => deriveContradictions([bad]), String(domain)).toThrow(EvidenceLevelInputError);
    }
  });

  it("a malformed executorTrustDomains entry throws, wherever it sits in the list", () => {
    for (const domain of invalidDomains) {
      const first = { executorTrustDomains: [domain, OP_A] } as unknown as EvidenceLevelContext;
      const last = { executorTrustDomains: [OP_A, domain] } as unknown as EvidenceLevelContext;
      expect(() => level([], first), String(domain)).toThrow(EvidenceLevelInputError);
      expect(() => level([], last), String(domain)).toThrow(EvidenceLevelInputError);
    }
  });

  it("executorTrustDomains that is not an array, or a context that is not an object, throws", () => {
    for (const bad of ["x", 7, null, {}, new Set([OP_A])]) {
      const context = { executorTrustDomains: bad } as unknown as EvidenceLevelContext;
      expect(() => level([], context)).toThrow(EvidenceLevelInputError);
    }
    for (const bad of [null, "x", 7, []]) {
      expect(() => level([], bad as unknown as EvidenceLevelContext)).toThrow(EvidenceLevelInputError);
    }
  });

  it("bundles that is not an array, a bundle that is not an object, or events that is not an array throws", () => {
    for (const bad of [undefined, null, {}, "x", 7, new Set()]) {
      expect(() => level(bad as unknown as AuthenticatedBundle[])).toThrow(EvidenceLevelInputError);
      expect(() => deriveContradictions(bad as unknown as AuthenticatedBundle[])).toThrow(EvidenceLevelInputError);
    }
    for (const bad of [null, undefined, 7, "x", []]) {
      const input = [bad] as unknown as AuthenticatedBundle[];
      expect(() => level(input)).toThrow(EvidenceLevelInputError);
      expect(() => deriveContradictions(input)).toThrow(EvidenceLevelInputError);
    }
    for (const bad of [undefined, null, "x", 7, {}, new Set()]) {
      const input = [{ events: bad, trustDomain: OP_A }] as unknown as AuthenticatedBundle[];
      expect(() => level(input)).toThrow(EvidenceLevelInputError);
      expect(() => deriveContradictions(input)).toThrow(EvidenceLevelInputError);
    }
  });

  it("a bare event list (the old API shape) is refused, not silently misread", () => {
    const oldShape = [done(), failed()] as unknown as AuthenticatedBundle[];
    expect(() => level(oldShape)).toThrow(EvidenceLevelInputError);
    expect(() => deriveContradictions(oldShape)).toThrow(EvidenceLevelInputError);
  });

  it("an events entry that is not an object throws", () => {
    for (const bad of [null, undefined, 7, "x", []]) {
      const input = [{ events: [done(), bad], trustDomain: OP_A }] as unknown as AuthenticatedBundle[];
      expect(() => level(input)).toThrow(EvidenceLevelInputError);
      expect(() => deriveContradictions(input)).toThrow(EvidenceLevelInputError);
    }
  });

  it("validates every bundle: a bad one after a fabricated or empty bundle still throws", () => {
    const fabricated = bundle([done(PRINTER, { mock: true })], OP_A);
    const bad = { events: [], trustDomain: "nope" } as unknown as AuthenticatedBundle;
    expect(() => level([fabricated, bad])).toThrow(EvidenceLevelInputError);
    expect(() => deriveContradictions([fabricated, bad])).toThrow(EvidenceLevelInputError);
    expect(() => level([bundle([]), bad])).toThrow(EvidenceLevelInputError);
  });

  it("the error is a typed Error with its own name", () => {
    let caught: unknown;
    try {
      level([{ events: [], trustDomain: "nope" } as unknown as AuthenticatedBundle]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(EvidenceLevelInputError);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).name).toBe("EvidenceLevelInputError");
    expect(Object.prototype.hasOwnProperty.call(caught, "name")).toBe(true);
    expect((caught as Error).message).toMatch(/trustDomain/);
  });

  it("does not mutate frozen input", () => {
    const frozen = (b: AuthenticatedBundle): AuthenticatedBundle => {
      b.events.forEach((e) => Object.freeze(e));
      Object.freeze(b.events);
      return Object.freeze(b);
    };
    const bundles = [frozen(executorBundle()), frozen(bundle([inspectPass()], OP_B))];
    const context = Object.freeze({ executorTrustDomains: Object.freeze([OP_A]) });
    expect(level(bundles, context)).toBe("inspected_output");
    expect(deriveContradictions(bundles)).toEqual([]);
  });
});

describe("single read: one snapshot of the input per call, so no pass can disagree (D2)", () => {
  /** An own accessor that answers answers[n] on its n-th read (the last answer repeats) and counts its reads. */
  function flip(target: object, key: string, answers: unknown[]): { reads: () => number } {
    let reads = 0;
    Object.defineProperty(target, key, {
      enumerable: true,
      configurable: true,
      get() {
        const answer = answers[Math.min(reads, answers.length - 1)];
        reads += 1;
        return answer;
      },
    });
    return { reads: () => reads };
  }

  /** A Proxy over an array that logs every property read through it; an override answers the n-th read of a key. */
  function countingArray<T>(items: T[], overrides: Record<string, (n: number) => unknown> = {}) {
    const log: string[] = [];
    const counts: Record<string, number> = {};
    const proxy = new Proxy(items, {
      get(target, key, receiver) {
        const name = String(key);
        log.push(name);
        counts[name] = (counts[name] ?? 0) + 1;
        const override = overrides[name];
        return override !== undefined ? override(counts[name]!) : Reflect.get(target, key, receiver);
      },
    });
    return { proxy, log };
  }

  it("an event's type is read once: the contradiction rule and the level see the same event", () => {
    // The first read says execution_completed; every later read says execution_failed.
    const flipping = () => {
      const event = ev("execution_completed", PRINTER);
      return { event, type: flip(event, "type", ["execution_completed", "execution_failed"]) };
    };
    const forContradictions = flipping();
    expect(deriveContradictions([bundle([forContradictions.event, failed()], OP_A)])).toEqual(["completion-and-failure"]);
    expect(forContradictions.type.reads()).toBe(1);
    const forLevel = flipping();
    expect(level([bundle([forLevel.event], OP_A)])).toBe("device_reported");
    expect(forLevel.type.reads()).toBe(1);
    // And the reverse: first a failure, then a completion. No completion was ever read, so no contradiction and no level.
    const reverse = () => {
      const event = ev("execution_failed", PRINTER);
      return { event, type: flip(event, "type", ["execution_failed", "execution_completed"]) };
    };
    const reverseContradictions = reverse();
    expect(deriveContradictions([bundle([reverseContradictions.event], OP_A)])).toEqual([]);
    expect(reverseContradictions.type.reads()).toBe(1);
    const reverseLevel = reverse();
    expect(level([bundle([reverseLevel.event], OP_A)])).toBeNull();
    expect(reverseLevel.type.reads()).toBe(1);
  });

  it("source, source.deviceId, source.simulated, payload and payload.mock are each read once", () => {
    // source: a real device on the first read, a simulated gateway stamp on every later one.
    const viaSource = ev("execution_completed", PRINTER);
    const sourceReads = flip(viaSource, "source", [
      { deviceId: PRINTER, deviceType: "controller", kernelId: KERNEL },
      { deviceId: GATEWAY_STAMPED_DEVICE_ID, deviceType: "controller", kernelId: KERNEL, simulated: true },
    ]);
    expect(level([bundle([viaSource], OP_A)])).toBe("device_reported");
    expect(sourceReads.reads()).toBe(1);

    // source.deviceId and source.simulated on one source object.
    const source = { deviceType: "controller", kernelId: KERNEL };
    const deviceId = flip(source, "deviceId", [PRINTER, ""]);
    const simulated = flip(source, "simulated", [false, true]);
    const viaFields = { ...ev("execution_completed", PRINTER), source } as unknown as EvidenceEvent;
    expect(level([bundle([viaFields], OP_A)])).toBe("device_reported");
    expect(deviceId.reads()).toBe(1);
    expect(simulated.reads()).toBe(1);

    // payload.mock: not fabricated on the first read, fabricated on every later one.
    const payload: Record<string, unknown> = {};
    const mock = flip(payload, "mock", [false, true]);
    expect(level([bundle([ev("execution_completed", PRINTER, payload)], OP_A)])).toBe("device_reported");
    expect(mock.reads()).toBe(1);

    // payload: a passing inspection on the first read, an empty one on every later one.
    const viaPayload = ev("instrument_result", READER);
    const payloadReads = flip(viaPayload, "payload", [{ pass: true }, {}]);
    expect(level([executorBundle(), bundle([viaPayload], OP_B)], ASSIGNED_A)).toBe("inspected_output");
    expect(payloadReads.reads()).toBe(1);
  });

  it("a payload read once as a passing verdict is never re-read as a failing one by the contradiction rule", () => {
    const inspection = ev("instrument_result", READER);
    const payloadReads = flip(inspection, "payload", [{ pass: true }, { pass: false }]);
    expect(deriveContradictions([bundle([done(), inspection], OP_A)])).toEqual([]);
    expect(payloadReads.reads()).toBe(1);
  });

  it("a Proxy events array is read once: its length once, each index once, nothing else", () => {
    const events = () => countingArray([done(), inspectPass()]);
    const forLevel = events();
    expect(level([{ events: forLevel.proxy, trustDomain: OP_A }])).toBe("device_reported");
    expect([...forLevel.log].sort()).toEqual(["0", "1", "length"]);
    const forContradictions = events();
    expect(deriveContradictions([{ events: forContradictions.proxy, trustDomain: OP_A }])).toEqual([]);
    expect([...forContradictions.log].sort()).toEqual(["0", "1", "length"]);
  });

  it("a Proxy bundles array is read once too", () => {
    const { proxy, log } = countingArray([executorBundle(), bundle([inspectPass()], OP_B)]);
    expect(level(proxy, ASSIGNED_A)).toBe("inspected_output");
    expect([...log].sort()).toEqual(["0", "1", "length"]);
  });

  it("a length that answers differently on each read cannot truncate or extend the walk", () => {
    // First read 2, every later read 0: a second read of length would stop the walk early.
    const events = countingArray([done(), failed()], { length: (n) => (n === 1 ? 2 : 0) });
    expect(deriveContradictions([{ events: events.proxy, trustDomain: OP_A }])).toEqual(["completion-and-failure"]);
    // First read 1, every later read 5: a second read would walk past the end into undefined elements.
    const bundles = countingArray([bundle([done(), failed()], OP_A)], { length: (n) => (n === 1 ? 1 : 5) });
    expect(deriveContradictions(bundles.proxy)).toEqual(["completion-and-failure"]);
    // The assignment's own length is read once too: first 1, then 0 (a second read would lose the assigned executor).
    const assigned = countingArray([OP_A], { length: (n) => (n === 1 ? 1 : 0) });
    expect(
      level([executorBundle(), bundle([inspectPass()], OP_B)], { executorTrustDomains: assigned.proxy }),
    ).toBe("inspected_output");
    expect([...assigned.log].sort()).toEqual(["0", "length"]);
  });

  it("a length that is not a non-negative safe integer is refused", () => {
    for (const bad of ["2", NaN, -1, 1.5, 2 ** 53, Infinity, null, undefined]) {
      const events = countingArray([done()], { length: () => bad });
      expect(() => level([{ events: events.proxy, trustDomain: OP_A }]), String(bad)).toThrow(EvidenceLevelInputError);
      const bundles = countingArray([executorBundle()], { length: () => bad });
      expect(() => deriveContradictions(bundles.proxy), String(bad)).toThrow(EvidenceLevelInputError);
    }
    const domains = countingArray([OP_A], { length: () => "1" });
    expect(() => level([], { executorTrustDomains: domains.proxy })).toThrow(EvidenceLevelInputError);
    // A fractional length is refused for what it is, not merely because an index happens to be missing: here every
    // index answers with a valid event, so only the length can refuse it.
    for (const fractional of [0.5, 1.5]) {
      const generous = countingArray<EvidenceEvent>([], { length: () => fractional, "0": () => done(), "1": () => done() });
      expect(() => level([{ events: generous.proxy, trustDomain: OP_A }]), String(fractional)).toThrow(EvidenceLevelInputError);
    }
  });

  it("a bundle's events and trustDomain are each read once", () => {
    const raw: Record<string, unknown> = {};
    const eventsReads = flip(raw, "events", [[done()], []]);
    const domainReads = flip(raw, "trustDomain", [OP_A, "not-a-principal"]);
    expect(level([raw as unknown as AuthenticatedBundle])).toBe("device_reported");
    expect(eventsReads.reads()).toBe(1);
    expect(domainReads.reads()).toBe(1);
  });

  it("the public inspectionVerdict reads type and payload once each", () => {
    const event = ev("instrument_result", READER);
    const typeReads = flip(event, "type", ["instrument_result", "execution_completed"]);
    const payloadReads = flip(event, "payload", [{ pass: true }, {}]);
    expect(inspectionVerdict(event)).toBe("pass");
    expect(typeReads.reads()).toBe(1);
    expect(payloadReads.reads()).toBe(1);
  });

  it("the payload's own verdict material is read once: prototype, key names and the pinned field's descriptor", () => {
    const trapped = (target: Record<string, unknown>) => {
      const traps: string[] = [];
      const payload = new Proxy(target, {
        getPrototypeOf(inner) {
          traps.push("getPrototypeOf");
          return Reflect.getPrototypeOf(inner);
        },
        ownKeys(inner) {
          traps.push("ownKeys");
          return Reflect.ownKeys(inner);
        },
        getOwnPropertyDescriptor(inner, key) {
          traps.push("getOwnPropertyDescriptor:" + String(key));
          return Reflect.getOwnPropertyDescriptor(inner, key);
        },
        get(inner, key, receiver) {
          traps.push("get:" + String(key));
          return Reflect.get(inner, key, receiver);
        },
        has(inner, key) {
          traps.push("has:" + String(key));
          return Reflect.has(inner, key);
        },
      });
      return { payload, traps };
    };
    // Once for an Object.prototype payload and once for a null-prototype one: the plain-object check has two branches.
    const targets: Array<[string, Record<string, unknown>]> = [
      ["Object.prototype", { pass: true }],
      ["null prototype", Object.assign(Object.create(null) as Record<string, unknown>, { pass: true })],
    ];
    for (const [label, target] of targets) {
      const { payload, traps } = trapped(target);
      expect(
        level([executorBundle(), bundle([ev("instrument_result", READER, payload)], OP_B)], ASSIGNED_A),
        label,
      ).toBe("inspected_output");
      // getOwnPropertyDescriptor:mock is the own-only read of payload.mock (astra pack 267): an
      // absent mock is never read through the prototype, so no get:mock.
      expect([...traps].sort(), label).toEqual(["getOwnPropertyDescriptor:mock", "getOwnPropertyDescriptor:pass", "getPrototypeOf", "ownKeys"]);
    }
  });

  it("a getter that throws refuses the classification; it cannot skew one", () => {
    const event = ev("execution_completed", PRINTER);
    Object.defineProperty(event, "type", {
      enumerable: true,
      get() {
        throw new Error("boom");
      },
    });
    expect(() => level([bundle([event], OP_A)])).toThrow("boom");
    expect(() => deriveContradictions([bundle([event], OP_A)])).toThrow("boom");
  });

  it("fabrication is exactly isFabricated: the same predicate over the same event", () => {
    const variants: Array<[string, EvidenceEvent]> = [
      ["simulated:true", ev("execution_completed", PRINTER, {}, { simulated: true })],
      ["simulated:false", ev("execution_completed", PRINTER, {}, { simulated: false })],
      ["simulated:'true'", ev("execution_completed", PRINTER, {}, { simulated: "true" })],
      ["simulated:1", ev("execution_completed", PRINTER, {}, { simulated: 1 })],
      ["mock:true", ev("execution_completed", PRINTER, { mock: true })],
      ["mock:false", ev("execution_completed", PRINTER, { mock: false })],
      ["mock:'true'", ev("execution_completed", PRINTER, { mock: "true" })],
      ["mock:1", ev("execution_completed", PRINTER, { mock: 1 })],
      ["payload null", ev("execution_completed", PRINTER, null)],
      ["payload undefined", { ...ev("execution_completed", PRINTER), payload: undefined as never }],
      ["both markers", ev("execution_completed", PRINTER, { mock: true }, { simulated: true })],
    ];
    for (const [label, variant] of variants) {
      // An attributed completion proves a level unless it is fabricated.
      const provesALevel = level([bundle([variant], OP_A)]) !== null;
      expect(provesALevel, label).toBe(!isFabricated(variant));
      expect(bundleHasFabricatedEvents({ events: [variant] }), label).toBe(isFabricated(variant));
    }
    // An INHERITED marker (here a custom prototype) is not the payload's own: the levels read
    // own fields only (astra pack 267), so it is ignored, as one written on Object.prototype
    // would be. Hashed evidence never carries one, because canonicalize reads own fields only.
    const inherited = ev("execution_completed", PRINTER, Object.create({ mock: true }));
    expect(isFabricated(inherited)).toBe(true);
    expect(level([bundle([inherited], OP_A)])).toBe("device_reported");
  });
});

describe("evidenceLevelsOfEvents — the per-event level, from the same facts and rules (D3)", () => {
  const levelsOf = (bundles: AuthenticatedBundle[], context?: EvidenceLevelContext) =>
    evidenceLevelsOfEvents(bundles, context).map((entry) => entry.level);

  it("returns one frozen record per event, in input order, with the bundle and event indices", () => {
    const inspector = bundle([inspectPass(), ev("camera_snapshot", CAMERA)], OP_B);
    const result = evidenceLevelsOfEvents([executorBundle(), inspector], ASSIGNED_A);
    expect(result).toEqual([
      { bundleIndex: 0, eventIndex: 0, level: null }, // execution_started proves no level
      { bundleIndex: 0, eventIndex: 1, level: "device_reported" }, // execution_completed
      { bundleIndex: 1, eventIndex: 0, level: "inspected_output" }, // the independent inspection
      { bundleIndex: 1, eventIndex: 1, level: null }, // camera_snapshot
    ] satisfies EventLevel[]);
    expect(Object.isFrozen(result)).toBe(true);
    for (const entry of result) expect(Object.isFrozen(entry)).toBe(true);
  });

  it("gives each class of event its level", () => {
    const events = [
      ev("method_loaded", PRINTER), // submitted
      done(), // device_reported
      ev("instrument_result", READER, { pass: true }), // valid verdict, same trust domain: device_reported
      ev("instrument_result", READER, {}), // none: no level
      ev("instrument_result", READER, { pass: "x" }), // malformed: no level
      failed(), // no outcome
      ev("execution_completed", undefined), // no device attribution
      ev("execution_completed", GATEWAY_STAMPED_DEVICE_ID), // the gateway's own stamp
      ev("temperature_log", PRINTER), // telemetry
    ];
    expect(levelsOf([bundle(events, OP_A)], ASSIGNED_A)).toEqual([
      "submitted",
      "device_reported",
      "device_reported",
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
    // The valid inspection in its own bundle, in an independent trust domain. (In a bundle that also held an
    // execution event its domain would be an executor itself.)
    const executing = bundle(events.slice(0, 2), OP_A);
    const independentInspection = bundle(events.slice(2, 3), OP_B);
    expect(levelsOf([executing, independentInspection], ASSIGNED_A)).toEqual([
      "submitted",
      "device_reported",
      "inspected_output",
    ]);
  });

  it("every event of a fabricated bundle is null, even one that would prove a level; a genuine bundle beside it is unaffected", () => {
    const fabricated = bundle([done(), inspectPass(), ev("camera_snapshot", CAMERA, { mock: true })], OP_B);
    expect(levelsOf([fabricated, executorBundle()], ASSIGNED_A)).toEqual([null, null, null, null, "device_reported"]);
  });

  it("independence applies per bundle", () => {
    const bundles = [executorBundle(), bundle([inspectPass()], OP_A), bundle([inspectPass()], OP_B)];
    expect(levelsOf(bundles, ASSIGNED_A)).toEqual([null, "device_reported", "device_reported", "inspected_output"]);
    // No assignment: nobody is provably independent.
    expect(levelsOf(bundles)).toEqual([null, "device_reported", "device_reported", "device_reported"]);
  });

  it("no bundles, or bundles with no events, give a frozen empty array", () => {
    for (const bundles of [[], [bundle([], OP_A), bundle([])]]) {
      const result = evidenceLevelsOfEvents(bundles);
      expect(result).toEqual([]);
      expect(Object.isFrozen(result)).toBe(true);
    }
  });

  it("refuses the same input the other functions refuse, and reads its input once", () => {
    expect(() => evidenceLevelsOfEvents(undefined as unknown as AuthenticatedBundle[])).toThrow(EvidenceLevelInputError);
    expect(() => evidenceLevelsOfEvents([{ events: [], trustDomain: "nope" }])).toThrow(EvidenceLevelInputError);
    expect(() => evidenceLevelsOfEvents([], { executorTrustDomains: ["nope"] })).toThrow(EvidenceLevelInputError);
    const event = ev("execution_completed", PRINTER);
    let reads = 0;
    Object.defineProperty(event, "type", {
      enumerable: true,
      get() {
        reads += 1;
        return reads === 1 ? "execution_completed" : "execution_failed";
      },
    });
    expect(levelsOf([bundle([event], OP_A)])).toEqual(["device_reported"]);
    expect(reads).toBe(1);
  });

  it("evidenceLevelOfBundles is the maximum over evidenceLevelsOfEvents, on every combination", () => {
    const domains: Array<string | undefined> = [undefined, OP_A, OP_B, OP_C];
    const contexts: Array<EvidenceLevelContext | undefined> = [
      undefined,
      {},
      { executorTrustDomains: [] },
      ASSIGNED_A,
      { executorTrustDomains: [OP_B] },
      { executorTrustDomains: [OP_A, OP_C] },
    ];
    const payloads: unknown[] = [{ pass: true }, { pass: false }, {}, { pass: "x" }];
    let cases = 0;
    for (const executorDomain of domains) {
      for (const inspectorDomain of domains) {
        for (const context of contexts) {
          for (const payload of payloads) {
            for (const fakeExecutor of [false, true]) {
              for (const fakeInspector of [false, true]) {
                const mock = () => ev("camera_snapshot", CAMERA, { mock: true });
                const executor = bundle([started(), done(), ...(fakeExecutor ? [mock()] : [])], executorDomain);
                const inspector = bundle(
                  [ev("instrument_result", READER, payload), ...(fakeInspector ? [mock()] : [])],
                  inspectorDomain,
                );
                let best: EvidenceLevel | null = null;
                for (const { level: reached } of evidenceLevelsOfEvents([executor, inspector], context)) {
                  if (reached !== null && (best === null || evidenceLevelRank(reached) > evidenceLevelRank(best))) {
                    best = reached;
                  }
                }
                expect(evidenceLevelOfBundles([executor, inspector], context)).toBe(best);
                cases += 1;
              }
            }
          }
        }
      }
    }
    expect(cases).toBe(4 * 4 * 6 * 4 * 2 * 2);
  });

  it("is exported from the evidence barrel", () => {
    expect(evidenceBarrel.evidenceLevelsOfEvents).toBe(evidenceLevelsOfEvents);
    expect(evidenceBarrel.evidenceLevelOfBundles).toBe(evidenceLevelOfBundles);
  });
});

describe("inspectionVerdict — one closed verdict per inspection type", () => {
  type Row = [label: string, payload: unknown, expected: InspectionVerdict];
  const check = (type: EvidenceEventType, rows: Row[]) => {
    for (const [label, payload, expected] of rows) {
      expect(inspectionVerdict(ev(type, READER, payload)), `${type} ${label}`).toBe(expected);
    }
  };

  it("instrument_result: `pass`, a boolean", () => {
    check("instrument_result", [
      ["pass:true", { pass: true }, "pass"],
      ["pass:false", { pass: false }, "fail"],
      ["empty", {}, "none"],
      ["measurement only", { od600: 0.42 }, "none"],
      ["sila liquid-handling record (error is not a verdict key)", { action: "aspirate", error: false }, "none"],
      ["pass:'true'", { pass: "true" }, "malformed"],
      ["pass:'false'", { pass: "false" }, "malformed"],
      ["pass:1", { pass: 1 }, "malformed"],
      ["pass:0", { pass: 0 }, "malformed"],
      ["pass:null", { pass: null }, "malformed"],
      ["pass:undefined (own key)", { pass: undefined }, "malformed"],
      ["pass:[true]", { pass: [true] }, "malformed"],
      ["pass:{}", { pass: {} }, "malformed"],
      ["passed instead of pass", { passed: true }, "malformed"],
      ["status instead of pass", { status: "PASS" }, "malformed"],
      ["result", { result: "ok" }, "malformed"],
      ["verdict", { verdict: "PASS" }, "malformed"],
      ["ok", { ok: true }, "malformed"],
      ["success", { success: true }, "malformed"],
      ["a valid pass beside a stray verdict key is two claims: malformed", { pass: true, status: "FAIL" }, "malformed"],
    ]);
  });

  it("batch_sample_result: `status`, exactly 'PASS' or 'FAIL'", () => {
    check("batch_sample_result", [
      ["PASS", { status: "PASS" }, "pass"],
      ["FAIL", { status: "FAIL" }, "fail"],
      ["empty", {}, "none"],
      ["chromatograph injection record", { position: 1, phase: "injection", slotId: "slot-1" }, "none"],
      ["lowercase pass", { status: "pass" }, "malformed"],
      ["Pass", { status: "Pass" }, "malformed"],
      ["PASS with a leading space", { status: " PASS" }, "malformed"],
      ["PASS with a trailing space", { status: "PASS " }, "malformed"],
      ["fail", { status: "fail" }, "malformed"],
      ["OK", { status: "OK" }, "malformed"],
      ["status:true", { status: true }, "malformed"],
      ["status:null", { status: null }, "malformed"],
      ["status:undefined (own key)", { status: undefined }, "malformed"],
      ["pass instead of status", { pass: true }, "malformed"],
      ["passed instead of status", { passed: false }, "malformed"],
      ["verdict", { verdict: "PASS" }, "malformed"],
    ]);
  });

  it("photo_comparison_result has no pinned field: none unless the payload carries a verdict-looking key", () => {
    check("photo_comparison_result", [
      ["empty", {}, "none"],
      ["match score only", { match: true, score: 0.97 }, "none"],
      ["pass", { pass: true }, "malformed"],
      ["passed", { passed: true }, "malformed"],
      ["status", { status: "PASS" }, "malformed"],
      ["result", { result: "match" }, "malformed"],
      ["verdict", { verdict: "match" }, "malformed"],
      ["ok", { ok: true }, "malformed"],
      ["success", { success: true }, "malformed"],
    ]);
  });

  it("cv_inspection_result: `passed`, a boolean (what every producer emits)", () => {
    check("cv_inspection_result", [
      ["passed:true", { passed: true }, "pass"],
      ["passed:false", { passed: false }, "fail"],
      ["empty", {}, "none"],
      ["measurement only", { confidence: 0.9, findings: [], imageHash: "sha256:00" }, "none"],
      ["passed:'true'", { passed: "true" }, "malformed"],
      ["passed:'false'", { passed: "false" }, "malformed"],
      ["passed:1", { passed: 1 }, "malformed"],
      ["passed:0", { passed: 0 }, "malformed"],
      ["passed:null", { passed: null }, "malformed"],
      ["passed:undefined (own key)", { passed: undefined }, "malformed"],
      ["passed:[true]", { passed: [true] }, "malformed"],
      ["passed:{}", { passed: {} }, "malformed"],
      ["pass:true (what types/dpp.ts reads)", { pass: true }, "malformed"],
      ["pass:false", { pass: false }, "malformed"],
      ["status instead of passed", { status: "PASS" }, "malformed"],
      ["a valid passed beside a stray pass is two claims (dpp.ts reads pass): malformed", { passed: true, pass: false }, "malformed"],
    ]);
  });

  it("cv_inspection_result: a pinned passed proves a level, the pass spelling proves none", () => {
    const independentCv = (payload: unknown) =>
      level([executorBundle(), bundle([ev("cv_inspection_result", CAMERA, payload)], OP_B)], ASSIGNED_A);
    expect(independentCv({ passed: true })).toBe("inspected_output");
    expect(independentCv({ passed: false })).toBe("inspected_output");
    expect(independentCv({ pass: true })).toBe("device_reported"); // the completion alone
  });

  it("a payload that is not a plain, non-null, non-array object is malformed, for every inspection type", () => {
    class Shaped {
      pass = true;
    }
    const notPlain: Array<[string, unknown]> = [
      ["null", null],
      ["undefined", undefined],
      ["array", [{ pass: true }]],
      ["string", "pass"],
      ["number", 1],
      ["boolean", true],
      ["class instance", new Shaped()],
      ["inherited pass", Object.create({ pass: true })],
      ["Map", new Map([["pass", true]])],
    ];
    for (const type of INSPECTION_EVENT_TYPES) {
      for (const [label, payload] of notPlain) {
        // Not ev(type, READER, payload): its default parameter would turn an explicit undefined into {}.
        const event = { ...ev(type, READER), payload: payload as EvidenceEvent["payload"] };
        expect(inspectionVerdict(event), `${type} ${label}`).toBe("malformed");
      }
    }
  });

  it("a null-prototype payload is plain, but a null-prototype array is still an array", () => {
    const payload = Object.assign(Object.create(null) as Record<string, unknown>, { pass: true });
    expect(inspectionVerdict(ev("instrument_result", READER, payload))).toBe("pass");
    const array = Object.setPrototypeOf([{ pass: true }], null) as unknown;
    for (const type of INSPECTION_EVENT_TYPES) {
      const event = { ...ev(type, READER), payload: array as EvidenceEvent["payload"] };
      expect(inspectionVerdict(event), type).toBe("malformed");
    }
  });

  it("only own properties count: a polluted Object.prototype is ignored", () => {
    Object.defineProperty(Object.prototype, "pass", { value: true, configurable: true, writable: true });
    Object.defineProperty(Object.prototype, "status", { value: "PASS", configurable: true, writable: true });
    try {
      expect(inspectionVerdict(ev("instrument_result", READER, {}))).toBe("none");
      expect(inspectionVerdict(ev("batch_sample_result", READER, {}))).toBe("none");
      expect(inspectionVerdict(ev("photo_comparison_result", READER, {}))).toBe("none");
    } finally {
      delete (Object.prototype as unknown as Record<string, unknown>).pass;
      delete (Object.prototype as unknown as Record<string, unknown>).status;
    }
  });

  it("an accessor on the pinned field is malformed and the getter is never invoked", () => {
    let reads = 0;
    const payload: Record<string, unknown> = {};
    Object.defineProperty(payload, "pass", {
      enumerable: true,
      get() {
        reads += 1;
        return true;
      },
    });
    expect(inspectionVerdict(ev("instrument_result", READER, payload))).toBe("malformed");
    expect(reads).toBe(0);
  });

  it("events that are not inspections claim no verdict, whatever their payload says", () => {
    for (const type of [...DEVICE_REPORTED_EVENT_TYPES, ...SUBMITTED_EVENT_TYPES, "temperature_log", "execution_failed"] as const) {
      expect(inspectionVerdict(ev(type, PRINTER, { pass: false, passed: false, status: "FAIL" })), type).toBe("none");
      expect(inspectionFailed(ev(type, PRINTER, { pass: false })), type).toBe(false);
    }
  });

  it("inspectionFailed is true for fail and malformed, false for pass and none", () => {
    expect(inspectionFailed(ev("instrument_result", READER, { pass: false }))).toBe(true);
    expect(inspectionFailed(ev("instrument_result", READER, { pass: "false" }))).toBe(true);
    expect(inspectionFailed(ev("instrument_result", READER, null))).toBe(true);
    expect(inspectionFailed(ev("instrument_result", READER, { pass: true }))).toBe(false);
    expect(inspectionFailed(ev("instrument_result", READER, {}))).toBe(false);
    expect(inspectionFailed(ev("batch_sample_result", READER, { status: "FAIL" }))).toBe(true);
    expect(inspectionFailed(ev("batch_sample_result", READER, { status: "PASS" }))).toBe(false);
  });
});

describe("inspectionVerdict — verdict keys are matched after an ASCII trim and lowercase (D4)", () => {
  type Row = [label: string, payload: unknown, expected: InspectionVerdict];
  const check = (type: EvidenceEventType, rows: Row[]) => {
    for (const [label, payload, expected] of rows) {
      expect(inspectionVerdict(ev(type, READER, payload)), type + " " + label).toBe(expected);
    }
  };
  /** Spellings of a name that an ASCII trim and ASCII lowercase fold back to it. */
  const spellings = (name: string): string[] => [
    name.toUpperCase(),
    name.charAt(0).toUpperCase() + name.slice(1),
    name.charAt(0) + name.slice(1).toUpperCase(),
    " " + name,
    name + " ",
    "\t" + name + "\n",
    "\u000b" + name + "\u000c",
    "\r\n " + name + " \t",
  ];
  const VERDICT_NAMES = ["pass", "passed", "status", "result", "verdict", "ok", "success"];

  it("a spelling of the pinned field that is not the exact key is malformed, never a pass", () => {
    const pins: Array<[EvidenceEventType, string, unknown]> = [
      ["instrument_result", "pass", true],
      ["cv_inspection_result", "passed", true],
      ["batch_sample_result", "status", "PASS"],
    ];
    for (const [type, field, value] of pins) {
      for (const spelling of spellings(field)) {
        check(type, [[JSON.stringify(spelling), { [spelling]: value }, "malformed"]]);
        // Even with the exact key beside it: the payload carries two readings.
        check(type, [[JSON.stringify(spelling) + " beside " + field, { [field]: value, [spelling]: value }, "malformed"]]);
      }
      check(type, [["the exact key alone", { [field]: value }, "pass"]]);
    }
  });

  it("every verdict-looking name counts as present in any ASCII spelling, when the pinned field is absent", () => {
    for (const type of INSPECTION_EVENT_TYPES) {
      for (const name of VERDICT_NAMES) {
        for (const spelling of spellings(name)) {
          check(type, [[JSON.stringify(spelling), { [spelling]: true }, "malformed"]]);
        }
      }
    }
  });

  it("instrument_result: pass, Pass, PASS and a padded pass are all the pinned field's names, so only the exact key reads", () => {
    check("instrument_result", [
      ["Pass", { Pass: true }, "malformed"],
      ["PASS", { PASS: false }, "malformed"],
      ["mixed case", { pAsS: true }, "malformed"],
      ["Passed (a different verdict-looking name)", { Passed: true }, "malformed"],
      ["conflicting spellings", { pass: true, Pass: false }, "malformed"],
      ["conflicting spellings, padded", { pass: false, " pass": true }, "malformed"],
      ["a valid pass beside another verdict-looking key: malformed", { pass: true, Status: "FAIL" }, "malformed"],
      ["a valid fail beside another verdict-looking key: malformed", { pass: false, RESULT: "ok" }, "malformed"],
    ]);
  });

  it("cv_inspection_result: {Passed:true} is malformed, not a pass", () => {
    check("cv_inspection_result", [
      ["Passed", { Passed: true }, "malformed"],
      [" passed", { " passed": true }, "malformed"],
      ["PASSED:false", { PASSED: false }, "malformed"],
      ["PASS (a different verdict-looking name)", { PASS: true }, "malformed"],
      ["passed beside Passed", { passed: true, Passed: false }, "malformed"],
      ["a valid passed beside PASS: malformed", { passed: true, PASS: false }, "malformed"],
    ]);
    // It proves no level and counts as a failed inspection.
    const independentCv = (payload: unknown) =>
      level([executorBundle(), bundle([ev("cv_inspection_result", CAMERA, payload)], OP_B)], ASSIGNED_A);
    expect(independentCv({ passed: true })).toBe("inspected_output");
    expect(independentCv({ Passed: true })).toBe("device_reported"); // the completion alone
    expect(deriveContradictions([bundle([done(), ev("cv_inspection_result", CAMERA, { Passed: true })], OP_A)])).toEqual([
      "completion-and-failed-inspection",
    ]);
  });

  it("batch_sample_result: Status is not status", () => {
    check("batch_sample_result", [
      ["Status", { Status: "PASS" }, "malformed"],
      ["STATUS", { STATUS: "FAIL" }, "malformed"],
      [" status", { " status": "PASS" }, "malformed"],
      ["status beside Status", { status: "PASS", Status: "FAIL" }, "malformed"],
      ["Pass instead of status", { Pass: true }, "malformed"],
      ["a valid status beside Result is two claims: malformed", { status: "PASS", Result: "x" }, "malformed"],
    ]);
  });

  it("photo_comparison_result has no pinned field: any spelling of a verdict name is malformed", () => {
    check("photo_comparison_result", [
      ["Pass", { Pass: true }, "malformed"],
      ["STATUS", { STATUS: 1 }, "malformed"],
      ["Verdict", { Verdict: "match" }, "malformed"],
      ["OK", { OK: true }, "malformed"],
      ["Success", { Success: false }, "malformed"],
      ["a measurement named Match", { Match: true, Score: 0.97 }, "none"],
    ]);
  });

  it("the fold is ASCII only: Unicode lookalikes and non-ASCII whitespace never match", () => {
    const lookalikes = [
      "pass ", // NBSP is not ASCII whitespace
      " pass",
      "pass ",
      "pass﻿",
      "pa​ss", // zero-width space inside
      "ｐａｓｓ", // full-width "pass"
      "oK", // KELVIN SIGN: Unicode lowercasing would turn it into "ok"
      "OK",
      "success\u0000",
    ];
    for (const type of INSPECTION_EVENT_TYPES) {
      for (const key of lookalikes) check(type, [[JSON.stringify(key), { [key]: true }, "none"]]);
    }
  });

  it("only own string keys count: symbols are ignored, non-enumerable own keys are not", () => {
    check("instrument_result", [["symbol key", { [Symbol("pass")]: true }, "none"]]);
    const hidden = Object.defineProperty({}, "Pass", { value: true, enumerable: false });
    check("instrument_result", [["non-enumerable Pass", hidden, "malformed"]]);
    const hiddenExact = Object.defineProperty({}, "pass", { value: true, enumerable: false });
    check("instrument_result", [["non-enumerable exact pass", hiddenExact, "pass"]]);
  });

  it("a key longer than any verdict name cannot match, however padded, and the fold is linear", () => {
    check("instrument_result", [
      ["padded too long to be a name", { "passed  x": true }, "none"],
      ["a long key", { ["x".repeat(1_000_000)]: true }, "none"],
      ["pass plus filler", { passxxxxx: true }, "none"],
      ["200k leading spaces then pass", { [" ".repeat(200_000) + "pass"]: true }, "malformed"],
      ["pass then 200k tabs", { ["pass" + "\t".repeat(200_000)]: true }, "malformed"],
    ]);
  });

  it("a folded spelling proves no level and counts as a failed inspection, a lookalike does neither", () => {
    const independent = (payload: unknown) =>
      level([executorBundle(), bundle([ev("instrument_result", READER, payload)], OP_B)], ASSIGNED_A);
    expect(independent({ pass: true })).toBe("inspected_output");
    expect(independent({ PASS: true })).toBe("device_reported"); // the completion alone
    expect(independent({ "pass ": true })).toBe("device_reported"); // none: also no level
    expect(deriveContradictions([bundle([done(), ev("instrument_result", READER, { PASS: true })], OP_A)])).toEqual([
      "completion-and-failed-inspection",
    ]);
    expect(deriveContradictions([bundle([done(), ev("instrument_result", READER, { "pass ": true })], OP_A)])).toEqual([]);
    expect(inspectionFailed(ev("instrument_result", READER, { Pass: true }))).toBe(true);
    expect(inspectionFailed(ev("instrument_result", READER, { "oK": true }))).toBe(false);
  });
});

describe("deriveContradictions — the public contradiction rule the oracle signs rejects on (J4)", () => {
  const unit = (...events: EvidenceEvent[]) => [bundle(events, OP_A)];

  it("completion with execution_failed is a contradiction", () => {
    expect(deriveContradictions(unit(done(), failed()))).toEqual(["completion-and-failure"]);
  });

  it("completion with a failed inspection is a contradiction, in every pinned shape", () => {
    const fails: EvidenceEvent[] = [
      ev("instrument_result", READER, { pass: false }),
      ev("batch_sample_result", READER, { status: "FAIL" }),
      ev("cv_inspection_result", READER, { passed: false }),
    ];
    for (const fail of fails) {
      expect(deriveContradictions(unit(done(), fail)), fail.type).toEqual(["completion-and-failed-inspection"]);
    }
  });

  it("a malformed verdict counts as failed (fail closed)", () => {
    const unreadable: EvidenceEvent[] = [
      ev("instrument_result", READER, { pass: "false" }),
      ev("instrument_result", READER, { pass: "true" }),
      ev("instrument_result", READER, { passed: false }),
      ev("instrument_result", READER, null),
      ev("batch_sample_result", READER, { status: "fail" }),
      ev("batch_sample_result", READER, { pass: false }),
      ev("photo_comparison_result", READER, { verdict: "mismatch" }),
      ev("cv_inspection_result", READER, { pass: false }), // the types/dpp.ts spelling is not the pinned field
      ev("cv_inspection_result", READER, { passed: "false" }),
    ];
    for (const bad of unreadable) {
      expect(deriveContradictions(unit(done(), bad)), JSON.stringify([bad.type, bad.payload])).toEqual([
        "completion-and-failed-inspection",
      ]);
    }
  });

  it("an inspection that claims no verdict (none) contradicts nothing", () => {
    const silent: EvidenceEvent[] = [
      ev("instrument_result", READER, {}),
      ev("batch_sample_result", READER, { phase: "injection" }),
      ev("photo_comparison_result", READER, { match: true }),
      ev("cv_inspection_result", READER, {}),
      ev("cv_inspection_result", READER, { confidence: 0.2, findings: ["defect"] }),
    ];
    for (const quiet of silent) {
      expect(deriveContradictions(unit(done(), quiet)), quiet.type).toEqual([]);
    }
  });

  it("a passing inspection contradicts nothing", () => {
    expect(deriveContradictions(unit(done(), inspectPass()))).toEqual([]);
    expect(deriveContradictions(unit(done(), ev("batch_sample_result", READER, { status: "PASS" })))).toEqual([]);
  });

  it("both at once are both reported, in a fixed order", () => {
    expect(deriveContradictions(unit(inspectFail(), failed(), done()))).toEqual([
      "completion-and-failure",
      "completion-and-failed-inspection",
    ]);
  });

  it("a failure without a completion is a device failure, not a contradiction", () => {
    expect(deriveContradictions(unit(failed()))).toEqual([]);
    expect(deriveContradictions(unit(inspectFail()))).toEqual([]);
    expect(deriveContradictions(unit(ev("instrument_result", READER, null)))).toEqual([]);
  });

  it("a non-inspection event with a failing-looking payload contradicts nothing", () => {
    expect(deriveContradictions(unit(done(), ev("temperature_log", PRINTER, { passed: false, pass: false })))).toEqual([]);
  });

  it("works across the bundles of one unit, with or without trust domains", () => {
    const executor = bundle([done()]);
    const reader = bundle([inspectFail()], OP_B);
    expect(deriveContradictions([executor, reader])).toEqual(["completion-and-failed-inspection"]);
    expect(deriveContradictions([bundle([done()], OP_A), bundle([failed()], OP_B)])).toEqual(["completion-and-failure"]);
  });

  it("a gateway-stamped completion still contradicts a failure (types decide; a contradiction only refuses)", () => {
    const gatewayOwn = ev("execution_completed", GATEWAY_STAMPED_DEVICE_ID);
    expect(deriveContradictions(unit(gatewayOwn, failed()))).toEqual(["completion-and-failure"]);
    const gatewayInspection = ev("instrument_result", GATEWAY_STAMPED_DEVICE_ID, { pass: false });
    expect(deriveContradictions(unit(done(), gatewayInspection))).toEqual(["completion-and-failed-inspection"]);
  });

  it("an unattributed completion or failure still counts too", () => {
    expect(deriveContradictions(unit(ev("execution_completed", undefined), failed()))).toEqual(["completion-and-failure"]);
    expect(deriveContradictions(unit(done(), ev("execution_failed", undefined)))).toEqual(["completion-and-failure"]);
    const gatewayFailure = ev("execution_failed", GATEWAY_STAMPED_DEVICE_ID);
    expect(deriveContradictions(unit(done(), gatewayFailure))).toEqual(["completion-and-failure"]);
  });

  it("every device-reported completion type contradicts a failure and a failed inspection, not only execution_completed", () => {
    for (const type of DEVICE_REPORTED_EVENT_TYPES) {
      expect(deriveContradictions(unit(ev(type, PRINTER), failed())), type).toEqual(["completion-and-failure"]);
      expect(deriveContradictions(unit(ev(type, PRINTER), inspectFail())), type).toEqual([
        "completion-and-failed-inspection",
      ]);
    }
  });

  it("a submitted-level event is not a completion: an accepted-only job that failed is a device failure", () => {
    for (const type of SUBMITTED_EVENT_TYPES) {
      expect(deriveContradictions(unit(ev(type, PRINTER), failed(), inspectFail())), type).toEqual([]);
    }
  });

  it("F4: a bundle with any fabricated event is ignored, whichever of its events is fabricated", () => {
    const mock = (type: EvidenceEventType) => ev(type, PRINTER, { mock: true });
    // The untagged failure sits in a bundle that also holds a mock event: the whole bundle is out.
    const fabricatedBundle = bundle([done(), failed(), ev("camera_snapshot", CAMERA, { mock: true })], OP_A);
    expect(bundleHasFabricatedEvents(fabricatedBundle)).toBe(true);
    expect(deriveContradictions([fabricatedBundle])).toEqual([]);
    // A fabricated failure bundle beside a genuine completion bundle, and the reverse.
    expect(deriveContradictions([bundle([mock("execution_failed")], OP_B), bundle([done()], OP_A)])).toEqual([]);
    expect(deriveContradictions([bundle([mock("execution_completed")], OP_A), bundle([failed()], OP_B)])).toEqual([]);
    const simulated = bundle([ev("execution_completed", PRINTER, {}, { simulated: true })], OP_A);
    expect(deriveContradictions([simulated, bundle([failed()], OP_B)])).toEqual([]);
  });

  it("F4: a fabricated bundle does not hide a contradiction that lives in the genuine bundles", () => {
    const fake = bundle([ev("camera_snapshot", CAMERA, { mock: true })], OP_C);
    expect(deriveContradictions([fake, bundle([done(), failed()], OP_A)])).toEqual(["completion-and-failure"]);
  });

  it("no bundles, or a bundle with no events, contradict nothing", () => {
    expect(deriveContradictions([])).toEqual([]);
    expect(deriveContradictions([bundle([])])).toEqual([]);
  });

  it("F5 scope: contradictions are judged within ONE settlement unit; callers must not pool attempts, steps or devices", () => {
    // Evidence-lane ruling: no PCC flow retries a job under the same job id, a failed unit is refunded and a new
    // attempt is a new job, and EvidenceBlockV2 commits ONE bundle per settlement unit. So the contract is that a
    // caller passes the bundles of one unit, and within a unit a completion plus a failure IS a contradiction.
    const attemptA = bundle([started("printer-A"), failed("printer-A")], OP_A);
    const attemptB = bundle([started("printer-B"), done("printer-B")], OP_B);
    // Each unit on its own: no contradiction.
    expect(deriveContradictions([attemptA])).toEqual([]);
    expect(deriveContradictions([attemptB])).toEqual([]);
    // Pooled across attempts and devices (what the contract forbids): refused, fail-closed. No correlation is attempted.
    expect(deriveContradictions([attemptA, attemptB])).toEqual(["completion-and-failure"]);
  });
});

describe("E5 round 2 (lane): a second verdict-looking key beside a valid pinned field fails closed", () => {
  const completion = { id: "c", type: "execution_completed", timestamp: "2026-10-01T00:00:00Z", source: { deviceId: "printer-1", kernelId: "k" }, payload: {}, hash: "sha256:" + "00".repeat(32) };
  const cv = (payload: Record<string, unknown>) => ({ ...completion, id: "i", type: "cv_inspection_result", source: { deviceId: "camera-1", kernelId: "k" }, payload });
  it("real camera payloads (passed plus measurements) still read as their verdict", () => {
    expect(inspectionVerdict(cv({ passed: true, confidence: 0.9, findings: [], imageHash: "x" }) as never)).toBe("pass");
    expect(inspectionVerdict(cv({ passed: false, confidence: 0.9, findings: ["scratch"] }) as never)).toBe("fail");
  });
  it("a passing cv that also claims pass:false derives completion-and-failed-inspection", () => {
    const bundles = [{ events: [completion, cv({ passed: true, pass: false })] }] as never;
    expect(deriveContradictions(bundles)).toEqual(["completion-and-failed-inspection"]);
  });
});

describe("E5b (cross-family): a party that took or finished the work is an executor, courier legs included", () => {
  it("a courier delivery and an inspection signed in the same unassigned domain stay device_reported (the reviewer's reproduction)", () => {
    expect(level([bundle([ev("courier_delivery_confirmed", "courier-1"), ev("instrument_result", "reader-1", { pass: true })], OP_B)], ASSIGNED_A)).toBe("device_reported");
  });

  it("a courier pickup in one bundle makes that domain's inspection in another bundle non-independent", () => {
    const pickup = bundle([ev("courier_pickup_confirmed", "courier-1")], OP_B);
    expect(level([executorBundle(), pickup, bundle([inspectPass()], OP_B)], ASSIGNED_A)).toBe("device_reported");
  });

  it("a genuinely independent domain still reaches inspected_output beside a courier leg", () => {
    const courier = bundle([ev("courier_delivery_confirmed", "courier-1")], OP_B);
    expect(level([executorBundle(), courier, bundle([inspectPass()], OP_C)], ASSIGNED_A)).toBe("inspected_output");
  });
});

describe("executor identification: every vocabulary member is ruled on", () => {
  it("EXECUTION_EVENT_TYPES and NON_EXECUTOR_EVENT_TYPES partition the vocabulary", () => {
    const ruled = [...EXECUTION_EVENT_TYPES, ...NON_EXECUTOR_EVENT_TYPES];
    expect(new Set(ruled).size).toBe(ruled.length);
    expect([...ruled].sort()).toEqual([...EVIDENCE_EVENT_TYPES].sort());
  });

  it("every submitted and device-reported type identifies an executor; no inspection does", () => {
    for (const t of [...SUBMITTED_EVENT_TYPES, ...DEVICE_REPORTED_EVENT_TYPES]) expect(EXECUTION_EVENT_TYPES as readonly string[], t).toContain(t);
    for (const t of INSPECTION_EVENT_TYPES) expect(NON_EXECUTOR_EVENT_TYPES as readonly string[], t).toContain(t);
  });

  it("no non-executor record makes its domain an executor", () => {
    const inspections = new Set<string>(INSPECTION_EVENT_TYPES);
    for (const type of NON_EXECUTOR_EVENT_TYPES) {
      if (inspections.has(type)) continue;
      const observer = bundle([ev(type, "observer-c")], OP_C);
      expect(level([executorBundle(), observer, bundle([inspectPass()], OP_C)], ASSIGNED_A), type).toBe("inspected_output");
    }
  });
});

describe("E5c (cross-family): custody confirmed by the party doing the drop-off is execution", () => {
  it("a custody handoff confirmed in an unassigned domain makes that domain's inspection non-independent (the reviewer's reproduction)", () => {
    expect(level([bundle([ev("custody_handoff_confirmed", "human-driver"), ev("instrument_result", "reader", { pass: true })], OP_B)], ASSIGNED_A)).toBe("device_reported");
  });

  it("the driver handoff's own photo, and sealing or initiating a handoff, also make the domain an executor", () => {
    for (const type of ["photo_captured", "custody_sealed", "custody_handoff_initiated"] as const) {
      expect(level([bundle([ev(type, "human-driver"), inspectPass()], OP_B)], ASSIGNED_A), type).toBe("device_reported");
    }
  });

  it("camera_snapshot alone does not: an independent inspection camera emits it too", () => {
    expect(level([executorBundle(), bundle([ev("camera_snapshot", "camera-c"), inspectPass()], OP_C)], ASSIGNED_A)).toBe("inspected_output");
  });
});
