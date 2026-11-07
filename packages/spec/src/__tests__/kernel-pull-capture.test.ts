/**
 * Tests for the LO-SE-1 kernel-pull capture contract (astra pack 155 HIGH 1).
 *
 * The contract is CLOSED: kernelPullCaptureIssue returns null only for a
 * complete kernel-pull capture for the job, and each rule below is refused
 * when broken (one table row per rule). Accessors are refused without their
 * getter ever running, Proxies without any trap running, and a runtime with
 * no trap-free Proxy check refuses every capture.
 */

import { describe, it, expect, vi } from "vitest";
import { KERNEL_PULL_CAPTURE_TYPES, kernelPullCaptureIssue } from "../evidence/kernel-pull-capture.js";

const JOB = "job-lose1-r2-001";
const AT = "2026-10-02T12:00:00.000Z";
const HASH = `sha256:${"0123456789abcdef".repeat(4)}`;

type Payload = Record<PropertyKey, unknown>;
interface TestEvent {
  type: string;
  timestamp?: unknown;
  source?: unknown;
  payload?: unknown;
  id?: string;
  hash?: string;
}

const CAPTURE_KEYS = [
  "jobId",
  "acquiredAt",
  "imageHash",
  "storageRef",
  "frameStored",
  "rawSizeBytes",
  "captureMode",
  "captureClass",
  "device",
  "declaredChallengeId",
  "declaredChallengeAnchor",
  "antiSpoofScore",
] as const;
const INSPECTION_KEYS = ["passed", "confidence", "findings", "referenceHash", "model"] as const;

function capturePayload(): Payload {
  return {
    jobId: JOB,
    acquiredAt: AT,
    imageHash: HASH,
    storageRef: `photo:${HASH}`,
    frameStored: false,
    rawSizeBytes: 15_000,
    captureMode: "kernel-pull",
    captureClass: "CC0",
    device: { path: "/dev/video0", identity: "SER-1" },
    declaredChallengeId: null,
    declaredChallengeAnchor: null,
    antiSpoofScore: 1,
  };
}

function inspectionPayload(): Payload {
  return {
    ...capturePayload(),
    passed: true,
    confidence: 100,
    findings: ["anti-spoof heuristic score 1.00 on a frame the kernel acquired"],
    referenceHash: null,
    model: "anti-spoof-heuristic",
  };
}

function cameraSource(): Record<string, unknown> {
  return { deviceId: "cam-1", deviceType: "camera", kernelId: "k-1", firmwareVersion: "PullCameraAdapter-1.0.0" };
}

function snapshot(payload: Payload = capturePayload()): TestEvent {
  return { id: "ev-1", type: "camera_snapshot", timestamp: AT, source: cameraSource(), payload, hash: "sha256:00" };
}

function inspection(payload: Payload = inspectionPayload()): TestEvent {
  return { ...snapshot(payload), type: "cv_inspection_result" };
}

/** A capture (or inspection) whose payload `edit` changed. */
function edited(edit: (p: Payload) => void, kind: "snapshot" | "inspection" = "snapshot"): TestEvent {
  const payload = kind === "snapshot" ? capturePayload() : inspectionPayload();
  edit(payload);
  return kind === "snapshot" ? snapshot(payload) : inspection(payload);
}

/** Defines `key` on `target` as an enumerable accessor that records whether its getter ran. */
function trapGetter(target: object, key: PropertyKey, value: unknown): { ran: boolean } {
  const probe = { ran: false };
  Object.defineProperty(target, key, {
    enumerable: true,
    configurable: true,
    get() {
      probe.ran = true;
      return value;
    },
  });
  return probe;
}

class NotPlain {
  constructor(fields: Record<string, unknown>) {
    Object.assign(this, fields);
  }
}

// ---------------------------------------------------------------------------
// A complete capture counts
// ---------------------------------------------------------------------------

describe("kernelPullCaptureIssue: a complete LO-SE-1 capture for the job", () => {
  it("governs exactly the two camera event types", () => {
    expect([...KERNEL_PULL_CAPTURE_TYPES]).toEqual(["camera_snapshot", "cv_inspection_result"]);
  });

  it("a kernel-pull camera_snapshot for this job has no issue", () => {
    expect(kernelPullCaptureIssue(snapshot(), JOB)).toBeNull();
  });

  it("a kernel-pull cv_inspection_result for this job has no issue", () => {
    expect(kernelPullCaptureIssue(inspection(), JOB)).toBeNull();
  });

  it("a declared challenge (id and anchor both set) has no issue", () => {
    const e = edited((p) => {
      p.declaredChallengeId = "challenge-1";
      p.declaredChallengeAnchor = "0xblock";
    });
    expect(kernelPullCaptureIssue(e, JOB)).toBeNull();
  });

  it("a stored frame (frameStored true) has no issue", () => {
    const e = edited((p) => {
      p.frameStored = true;
      p.storageRef = "storacha://bafy-frame";
    });
    expect(kernelPullCaptureIssue(e, JOB)).toBeNull();
  });

  it("a null-prototype payload and source are plain objects too", () => {
    const e = snapshot(Object.assign(Object.create(null) as Payload, capturePayload()));
    e.source = Object.assign(Object.create(null) as object, cameraSource());
    expect(kernelPullCaptureIssue(e, JOB)).toBeNull();
  });

  it("the bounds hold: antiSpoofScore 0 and 1, confidence 0 and 100, no findings, a string referenceHash", () => {
    for (const [score, confidence] of [
      [0, 0],
      [1, 100],
    ] as const) {
      const e = edited((p) => {
        p.antiSpoofScore = score;
        p.confidence = confidence;
        p.findings = [];
        p.referenceHash = HASH;
        p.passed = false;
      }, "inspection");
      expect(kernelPullCaptureIssue(e, JOB)).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Each rule refuses when broken
// ---------------------------------------------------------------------------

interface Row {
  name: string;
  event: () => TestEvent;
  jobId?: unknown;
  reason: RegExp;
}

const EVENT_ROWS: Row[] = [
  { name: "a type that is not a camera type", event: () => ({ ...snapshot(), type: "execution_completed" }), reason: /not a kernel-pull capture type/ },
  {
    name: "a capture for another job",
    event: () => edited((p) => (p.jobId = "job-other")),
    reason: /payload\.jobId "job-other" is not this job's "job-lose1-r2-001"/,
  },
  { name: "a blank jobId (the payload's matching)", event: () => edited((p) => (p.jobId = "")), jobId: "", reason: /no job to bind the capture to/ },
  { name: "a whitespace jobId (the payload's matching)", event: () => edited((p) => (p.jobId = "  ")), jobId: "  ", reason: /no job to bind the capture to/ },
  {
    name: "no jobId at all (the payload's jobId undefined too)",
    event: () => edited((p) => (p.jobId = undefined)),
    jobId: undefined,
    reason: /no job to bind the capture to/,
  },
  {
    name: "a simulated source",
    event: () => ({ ...snapshot(), source: { ...cameraSource(), simulated: true } }),
    reason: /fabricated/,
  },
  { name: "payload.mock", event: () => edited((p) => (p.mock = true)), reason: /fabricated/ },
  {
    name: "a source that is not a camera",
    event: () => ({ ...snapshot(), source: { ...cameraSource(), deviceType: "controller" } }),
    reason: /source\.deviceType "controller" is not "camera"/,
  },
  {
    name: "a photo-camera source",
    event: () => ({ ...snapshot(), source: { ...cameraSource(), deviceType: "photo-camera" } }),
    reason: /source\.deviceType "photo-camera" is not "camera"/,
  },
  { name: "no source", event: () => ({ ...snapshot(), source: undefined }), reason: /source undefined is not an object/ },
  {
    name: "a source that is not a plain object",
    event: () => ({ ...snapshot(), source: new NotPlain(cameraSource()) }),
    reason: /source is not a plain object/,
  },
  { name: "no timestamp", event: () => ({ ...snapshot(), timestamp: undefined }), reason: /is not the event's timestamp undefined/ },
];

const STRUCTURE_ROWS: Row[] = [
  { name: "a null payload", event: () => ({ ...snapshot(), payload: null }), reason: /payload null is not an object/ },
  { name: "a string payload", event: () => ({ ...snapshot(), payload: "{}" }), reason: /payload "\{\}" is not an object/ },
  { name: "an array payload", event: () => ({ ...snapshot(), payload: [] }), reason: /payload is not a plain object/ },
  { name: "a class-instance payload", event: () => ({ ...snapshot(), payload: new NotPlain(capturePayload()) }), reason: /payload is not a plain object/ },
  { name: "an extra key", event: () => edited((p) => (p.extra = 1)), reason: /payload has an extra key "extra"/ },
  { name: "a symbol key", event: () => edited((p) => (p[Symbol("hidden")] = 1)), reason: /payload has an extra key Symbol\(hidden\)/ },
  {
    name: "a non-enumerable key (the event hash would not cover it)",
    event: () => edited((p) => Object.defineProperty(p, "captureClass", { value: "CC0", enumerable: false })),
    reason: /payload\.captureClass is not enumerable/,
  },
  {
    name: "a camera_snapshot carrying the inspection keys",
    event: () => snapshot(inspectionPayload()),
    reason: /payload has an extra key "passed"/,
  },
  ...CAPTURE_KEYS.map((key) => ({
    name: `a camera_snapshot missing ${key}`,
    event: () => edited((p) => delete p[key]),
    reason: new RegExp(`payload is missing ${key}$`),
  })),
  ...[...CAPTURE_KEYS, ...INSPECTION_KEYS].map((key) => ({
    name: `a cv_inspection_result missing ${key}`,
    event: () => edited((p) => delete p[key], "inspection"),
    reason: new RegExp(`payload is missing ${key}$`),
  })),
];

const CAPTURE_VALUE_ROWS: Row[] = [
  ...["2026-10-02T12:00:00Z", "2026-10-02 12:00:00", "not a date", ""].map((v) => ({
    name: `acquiredAt ${JSON.stringify(v)} is not canonical ISO`,
    event: () => {
      const e = edited((p) => (p.acquiredAt = v));
      e.timestamp = v;
      return e;
    },
    reason: /payload\.acquiredAt .* is not a canonical ISO-8601 instant/,
  })),
  { name: "acquiredAt as epoch milliseconds", event: () => edited((p) => (p.acquiredAt = Date.parse(AT))), reason: /acquiredAt .* is not a canonical ISO-8601/ },
  {
    name: "acquiredAt that is not the event's timestamp",
    event: () => edited((p) => (p.acquiredAt = "2026-10-02T12:00:01.000Z")),
    reason: /payload\.acquiredAt "2026-10-02T12:00:01\.000Z" is not the event's timestamp "2026-10-02T12:00:00\.000Z"/,
  },
  ...[
    HASH.toUpperCase().replace("SHA256", "sha256"),
    HASH.slice(0, -1),
    `${HASH}0`,
    HASH.slice("sha256:".length),
    HASH.replace("sha256", "sha512"),
    `${HASH}\n`,
    null,
  ].map((v) => ({ name: `imageHash ${JSON.stringify(v)}`, event: () => edited((p) => (p.imageHash = v)), reason: /payload\.imageHash .* is not sha256:<64 lowercase hex>/ })),
  ...["", "   ", 5, null].map((v) => ({ name: `storageRef ${JSON.stringify(v)}`, event: () => edited((p) => (p.storageRef = v)), reason: /payload\.storageRef .* is not a non-blank string/ })),
  ...["false", 0, null].map((v) => ({ name: `frameStored ${JSON.stringify(v)}`, event: () => edited((p) => (p.frameStored = v)), reason: /payload\.frameStored .* is not a boolean/ })),
  ...[0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, "15000", null].map((v) => ({
    name: `rawSizeBytes ${String(v)}`,
    event: () => edited((p) => (p.rawSizeBytes = v)),
    reason: /payload\.rawSizeBytes .* is not a positive safe integer/,
  })),
  ...["handed-in", "KERNEL-PULL", null].map((v) => ({ name: `captureMode ${JSON.stringify(v)}`, event: () => edited((p) => (p.captureMode = v)), reason: /payload\.captureMode .* is not "kernel-pull"/ })),
  ...["CC1", "cc0", null].map((v) => ({ name: `captureClass ${JSON.stringify(v)}`, event: () => edited((p) => (p.captureClass = v)), reason: /payload\.captureClass .* is not "CC0"/ })),
  { name: "a null device", event: () => edited((p) => (p.device = null)), reason: /payload\.device null is not an object/ },
  { name: "an array device", event: () => edited((p) => (p.device = ["/dev/video0", "SER-1"])), reason: /payload\.device is not a plain object/ },
  {
    name: "a device with an extra key",
    event: () => edited((p) => (p.device = { path: "/dev/video0", identity: "SER-1", serial: "SER-1" })),
    reason: /payload\.device has an extra key "serial"/,
  },
  { name: "a device missing identity", event: () => edited((p) => (p.device = { path: "/dev/video0" })), reason: /payload\.device is missing identity/ },
  { name: "a device with a blank path", event: () => edited((p) => (p.device = { path: "", identity: "SER-1" })), reason: /payload\.device\.path "" is not a non-blank string/ },
  {
    name: "a device with a blank identity",
    event: () => edited((p) => (p.device = { path: "/dev/video0", identity: "  " })),
    reason: /payload\.device\.identity "  " is not a non-blank string/,
  },
  {
    name: "a device with a non-string identity",
    event: () => edited((p) => (p.device = { path: "/dev/video0", identity: 5 })),
    reason: /payload\.device\.identity 5 is not a non-blank string/,
  },
  ...["", "  ", 5].map((v) => ({
    name: `declaredChallengeId ${JSON.stringify(v)}`,
    event: () =>
      edited((p) => {
        p.declaredChallengeId = v;
        p.declaredChallengeAnchor = "0xblock";
      }),
    reason: /payload\.declaredChallengeId .* is not a non-blank string or null/,
  })),
  ...["", "  ", 5].map((v) => ({
    name: `declaredChallengeAnchor ${JSON.stringify(v)}`,
    event: () =>
      edited((p) => {
        p.declaredChallengeId = "challenge-1";
        p.declaredChallengeAnchor = v;
      }),
    reason: /payload\.declaredChallengeAnchor .* is not a non-blank string or null/,
  })),
  {
    name: "declaredChallengeAnchor without declaredChallengeId",
    event: () => edited((p) => (p.declaredChallengeAnchor = "0xblock")),
    reason: /declaredChallengeAnchor is not null exactly when declaredChallengeId is null/,
  },
  {
    name: "declaredChallengeId without declaredChallengeAnchor",
    event: () => edited((p) => (p.declaredChallengeId = "challenge-1")),
    reason: /declaredChallengeAnchor is not null exactly when declaredChallengeId is null/,
  },
  ...[-0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY, "1", null].map((v) => ({
    name: `antiSpoofScore ${String(v)}`,
    event: () => edited((p) => (p.antiSpoofScore = v)),
    reason: /payload\.antiSpoofScore .* is not a finite number in \[0, 1\]/,
  })),
  { name: "a bigint value is described, never thrown on", event: () => edited((p) => (p.jobId = 5n)), reason: /payload\.jobId \(a bigint\) is not this job's/ },
];

const INSPECTION_VALUE_ROWS: Row[] = [
  ...["true", 1, null].map((v) => ({ name: `passed ${JSON.stringify(v)}`, event: () => edited((p) => (p.passed = v), "inspection"), reason: /payload\.passed .* is not a boolean/ })),
  ...[-1, 100.5, Number.NaN, "100", null].map((v) => ({
    name: `confidence ${String(v)}`,
    event: () => edited((p) => (p.confidence = v), "inspection"),
    reason: /payload\.confidence .* is not a finite number in \[0, 100\]/,
  })),
  { name: "findings not an array", event: () => edited((p) => (p.findings = "ok"), "inspection"), reason: /payload\.findings "ok" is not an array/ },
  { name: "findings an array-like object", event: () => edited((p) => (p.findings = { 0: "ok", length: 1 }), "inspection"), reason: /payload\.findings is not an array$/ },
  {
    name: "findings with a foreign prototype (the hash would call its map)",
    event: () => edited((p) => (p.findings = Object.setPrototypeOf(["ok"], { map: () => ["forged"] }) as unknown), "inspection"),
    reason: /payload\.findings is not a plain array/,
  },
  {
    name: "findings with an own map (the hash would call it)",
    event: () =>
      edited((p) => {
        const findings = ["ok"];
        Object.defineProperty(findings, "map", { value: () => ["forged"], enumerable: false });
        p.findings = findings;
      }, "inspection"),
    reason: /payload\.findings has an own key besides its indices and length/,
  },
  {
    name: "findings with an extra own key",
    event: () => edited((p) => (p.findings = Object.assign(["ok"], { extra: "x" })), "inspection"),
    reason: /payload\.findings has an own key besides its indices and length/,
  },
  { name: "findings with a non-string", event: () => edited((p) => (p.findings = ["ok", 1]), "inspection"), reason: /payload\.findings\[1\] 1 is not a string/ },
  {
    name: "findings with a hole",
    // eslint-disable-next-line no-sparse-arrays
    event: () => edited((p) => (p.findings = [, "ok"]), "inspection"),
    reason: /payload\.findings has a hole at index 0/,
  },
  ...[5, undefined, {}].map((v) => ({
    name: `referenceHash ${String(v)}`,
    event: () => edited((p) => (p.referenceHash = v), "inspection"),
    reason: /payload\.referenceHash .* is not a string or null/,
  })),
  ...["yolo-v8", null].map((v) => ({ name: `model ${JSON.stringify(v)}`, event: () => edited((p) => (p.model = v), "inspection"), reason: /payload\.model .* is not "anti-spoof-heuristic"/ })),
];

describe.each([
  ["the event", EVENT_ROWS],
  ["the payload's structure", STRUCTURE_ROWS],
  ["the capture values", CAPTURE_VALUE_ROWS],
  ["the inspection values", INSPECTION_VALUE_ROWS],
] as const)("kernelPullCaptureIssue refuses a broken rule: %s", (_group, rows) => {
  it.each(rows)("$name", (row) => {
    const jobId = "jobId" in row ? row.jobId : JOB;
    const issue = kernelPullCaptureIssue(row.event(), jobId as string);
    expect(issue).not.toBeNull();
    expect(issue).toMatch(row.reason);
  });
});

// ---------------------------------------------------------------------------
// Accessors: refused, and the getter is never run
// ---------------------------------------------------------------------------

describe("kernelPullCaptureIssue never runs a getter", () => {
  it.each([...CAPTURE_KEYS])("an accessor payload.%s is refused without running its getter", (key) => {
    const payload = capturePayload();
    const probe = trapGetter(payload, key, payload[key]);
    expect(kernelPullCaptureIssue(snapshot(payload), JOB)).toMatch(new RegExp(`payload\\.${key} is an accessor`));
    expect(probe.ran).toBe(false);
  });

  it.each([...INSPECTION_KEYS])("an accessor payload.%s on a cv_inspection_result is refused without running its getter", (key) => {
    const payload = inspectionPayload();
    const probe = trapGetter(payload, key, payload[key]);
    expect(kernelPullCaptureIssue(inspection(payload), JOB)).toMatch(new RegExp(`payload\\.${key} is an accessor`));
    expect(probe.ran).toBe(false);
  });

  it("an accessor payload.mock is refused before isFabricated could run it", () => {
    const payload = capturePayload();
    const probe = trapGetter(payload, "mock", false);
    expect(kernelPullCaptureIssue(snapshot(payload), JOB)).toMatch(/payload\.mock is an accessor/);
    expect(probe.ran).toBe(false);
  });

  it("an accessor payload.device.path is refused without running its getter", () => {
    const device = { identity: "SER-1" } as Record<string, unknown>;
    const probe = trapGetter(device, "path", "/dev/video0");
    const e = edited((p) => (p.device = device));
    expect(kernelPullCaptureIssue(e, JOB)).toMatch(/payload\.device\.path is an accessor/);
    expect(probe.ran).toBe(false);
  });

  it("an accessor findings element is refused without running its getter", () => {
    const findings: string[] = [];
    const probe = trapGetter(findings, 0, "ok");
    const e = edited((p) => (p.findings = findings), "inspection");
    expect(kernelPullCaptureIssue(e, JOB)).toMatch(/payload\.findings\[0\] is an accessor/);
    expect(probe.ran).toBe(false);
  });

  it.each(["simulated", "deviceType"])("an accessor source.%s is refused without running its getter", (key) => {
    const source = cameraSource();
    const probe = trapGetter(source, key, key === "simulated" ? false : "camera");
    expect(kernelPullCaptureIssue({ ...snapshot(), source }, JOB)).toMatch(new RegExp(`source\\.${key} is an accessor`));
    expect(probe.ran).toBe(false);
  });

  it.each(["type", "timestamp", "source", "payload"])("an accessor event.%s is refused without running its getter", (key) => {
    const e = snapshot() as unknown as Record<string, unknown>;
    const probe = trapGetter(e, key, e[key]);
    expect(kernelPullCaptureIssue(e as unknown as TestEvent, JOB)).toMatch(new RegExp(`event\\.${key} is an accessor`));
    expect(probe.ran).toBe(false);
  });
});

describe("kernelPullCaptureIssue never throws on a non-object event", () => {
  it.each([null, undefined, "camera_snapshot", 5])("%s gives a reason", (v) => {
    expect(kernelPullCaptureIssue(v as unknown as TestEvent, JOB)).toMatch(/is not an object/);
  });
});

// ---------------------------------------------------------------------------
// Proxies: refused, and no trap is ever run
// ---------------------------------------------------------------------------

const TRAPS = [
  "getOwnPropertyDescriptor",
  "ownKeys",
  "get",
  "has",
  "getPrototypeOf",
  "isExtensible",
  "defineProperty",
  "set",
  "deleteProperty",
  "preventExtensions",
  "setPrototypeOf",
] as const;

/** A Proxy over `target` that records every trap it runs (and forwards it). */
function recordingProxy<T extends object>(target: T): { proxy: T; trapsRun: string[] } {
  const trapsRun: string[] = [];
  const handler: Record<string, unknown> = {};
  for (const trap of TRAPS) {
    handler[trap] = (...args: unknown[]) => {
      trapsRun.push(trap);
      return (Reflect[trap] as (...a: unknown[]) => unknown)(...args);
    };
  }
  return { proxy: new Proxy(target, handler as ProxyHandler<T>), trapsRun };
}

describe("kernelPullCaptureIssue refuses a Proxy without running a trap", () => {
  it("a Proxy can show a descriptor read one value and [[Get]] (the hash) another; this is why", () => {
    const forged = new Proxy({} as Payload, {
      getOwnPropertyDescriptor: () => ({ value: "CC0", writable: true, enumerable: true, configurable: true }),
      get: () => "CC1",
    });
    expect(Object.getOwnPropertyDescriptor(forged, "captureClass")?.value).toBe("CC0");
    expect(forged.captureClass).toBe("CC1");
  });

  it("the event as a Proxy", () => {
    const { proxy, trapsRun } = recordingProxy(snapshot());
    expect(kernelPullCaptureIssue(proxy, JOB)).toMatch(/the event is a Proxy/);
    expect(trapsRun).toEqual([]);
  });

  it("the source as a Proxy", () => {
    const { proxy, trapsRun } = recordingProxy(cameraSource());
    expect(kernelPullCaptureIssue({ ...snapshot(), source: proxy }, JOB)).toMatch(/source is a Proxy/);
    expect(trapsRun).toEqual([]);
  });

  it("the payload as a Proxy", () => {
    const { proxy, trapsRun } = recordingProxy(capturePayload());
    expect(kernelPullCaptureIssue(snapshot(proxy), JOB)).toMatch(/payload is a Proxy/);
    expect(trapsRun).toEqual([]);
  });

  it("payload.device as a Proxy", () => {
    const { proxy, trapsRun } = recordingProxy({ path: "/dev/video0", identity: "SER-1" });
    expect(kernelPullCaptureIssue(edited((p) => (p.device = proxy)), JOB)).toMatch(/payload\.device is a Proxy/);
    expect(trapsRun).toEqual([]);
  });

  it("payload.findings as a Proxy", () => {
    const { proxy, trapsRun } = recordingProxy(["ok"]);
    expect(kernelPullCaptureIssue(edited((p) => (p.findings = proxy), "inspection"), JOB)).toMatch(/payload\.findings is a Proxy/);
    expect(trapsRun).toEqual([]);
  });

  it("a revoked Proxy anywhere gives a reason and never throws", () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    expect(kernelPullCaptureIssue(proxy as unknown as TestEvent, JOB)).toMatch(/the event is a Proxy/);
    expect(kernelPullCaptureIssue(edited((p) => (p.findings = proxy), "inspection"), JOB)).toMatch(/payload\.findings is a Proxy/);
    expect(kernelPullCaptureIssue(edited((p) => (p.jobId = proxy)), JOB)).toMatch(/payload\.jobId \(an object\) is not this job's/);
  });
});

describe("kernelPullCaptureIssue fails closed where no trap-free Proxy check exists", () => {
  it("with no process.getBuiltinModule (a browser, an old Node), every capture is refused", async () => {
    const original = process.getBuiltinModule;
    let fresh: typeof import("../evidence/kernel-pull-capture.js");
    try {
      (process as { getBuiltinModule?: unknown }).getBuiltinModule = undefined;
      vi.resetModules();
      fresh = await import("../evidence/kernel-pull-capture.js");
    } finally {
      process.getBuiltinModule = original;
      vi.resetModules();
    }
    expect(fresh.kernelPullCaptureIssue(snapshot(), JOB)).toMatch(/no trap-free Proxy check/);
    expect(fresh.kernelPullCaptureIssue(inspection(), JOB)).toMatch(/no trap-free Proxy check/);
    // The module this file imported statically, loaded with the check, still accepts the same capture.
    expect(kernelPullCaptureIssue(snapshot(), JOB)).toBeNull();
  });
});
