import { describe, it, expect } from "vitest";
import {
  DEVICE_REPORTED_EVENT_TYPES,
  EVIDENCE_LEVELS,
  EXECUTION_EVENT_TYPES,
  EvidenceLevelInputError,
  GATEWAY_STAMPED_DEVICE_ID,
  INSPECTION_EVENT_TYPES,
  NO_OUTCOME_LEVEL_EVENT_TYPES,
  SUBMITTED_EVENT_TYPES,
  deriveContradictions,
  evidenceLevelOfBundles,
  evidenceLevelRank,
  inspectionFailed,
  inspectionVerdict,
  meetsEvidenceLevel,
  type AuthenticatedBundle,
  type EvidenceLevel,
  type EvidenceLevelContext,
  type InspectionVerdict,
} from "../evidence/evidence-level.js";
import { bundleHasFabricatedEvents } from "../evidence/is-fabricated.js";
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
      ["a valid pass beside a stray verdict key still reads the pinned field", { pass: true, status: "FAIL" }, "pass"],
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

  it("cv_inspection_result: no verdict key is none; a verdict-looking key is malformed while the field is OPEN", () => {
    // OPEN (E5 triage, F2/F3): the producers emit `passed`, types/dpp.ts reads `pass`. The contract owner has not
    // pinned one, so this module reads neither: either spelling is malformed (proves no level, fails closed in
    // contradictions). When the field is pinned, move the pinned spelling to pass/fail and keep the other malformed.
    check("cv_inspection_result", [
      ["empty", {}, "none"],
      ["measurement only", { confidence: 0.9, findings: [], imageHash: "sha256:00" }, "none"],
      ["passed (what the kernel and onboard-kit cameras emit)", { passed: true }, "malformed"],
      ["pass (what types/dpp.ts reads)", { pass: true }, "malformed"],
      ["passed:false", { passed: false }, "malformed"],
      ["pass:false", { pass: false }, "malformed"],
    ]);
  });
  it.todo(
    "cv_inspection_result: the evidence lane pins ONE verdict field (`pass` per types/dpp.ts:462, or `passed` per photo-camera-adapter.ts:178,188-190), then pass/fail/none/malformed are tested like instrument_result",
  );

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

describe("deriveContradictions — the public contradiction rule the oracle signs rejects on (J4)", () => {
  const unit = (...events: EvidenceEvent[]) => [bundle(events, OP_A)];

  it("completion with execution_failed is a contradiction", () => {
    expect(deriveContradictions(unit(done(), failed()))).toEqual(["completion-and-failure"]);
  });

  it("completion with a failed inspection is a contradiction, in every pinned shape", () => {
    const fails: EvidenceEvent[] = [
      ev("instrument_result", READER, { pass: false }),
      ev("batch_sample_result", READER, { status: "FAIL" }),
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
      ev("cv_inspection_result", READER, { passed: false }), // OPEN: cv spelling not pinned yet
      ev("cv_inspection_result", READER, { pass: false }),
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
