import { createHash } from "node:crypto";
import * as Sentry from "@sentry/node";
import { beforeAll, describe, expect, it, vi } from "vitest";
import nacl from "tweetnacl";
import {
  compileTierLadder, sha256, verifyBundleHash, verifyEventHash,
  type AssuranceTier, type CSD, type EvidenceBundle, type EvidenceEvent,
  type EvidenceSource, type SHA256, type TierLadderV1,
} from "@pcc/spec";
import type { MachineAdapter, MachineCommand, MachineCommandResult } from "../adapters/types.js";
import { EvidenceEmitter } from "../evidence-emitter.js";
import { JobRunner, type JobConfig } from "../job-runner.js";
import { makeKernelEd25519Signer } from "../printer-job.js";

vi.mock("@sentry/node", () => ({
  startSpan: vi.fn().mockImplementation((_opts: unknown, fn: () => unknown) => fn()),
  addBreadcrumb: vi.fn(),
  captureException: vi.fn(),
}));

type RawEvent = Omit<EvidenceEvent, "id" | "hash">;
type Config = Omit<JobConfig, "gcodeHash"> & {
  inputHash?: SHA256; gcodeHash?: SHA256;
  inputData?: string | Uint8Array; gcodeData?: string | Uint8Array;
  tierLadder?: TierLadderV1;
};
const hash = (bytes: string | Uint8Array): SHA256 => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const INPUT = "liquid protocol";
const H = hash(INPUT);
const OTHER_H = `sha256:${"cd".repeat(32)}` as SHA256;
let ladder: TierLadderV1;
const csd = {
  url: "pcc://capabilities/test-liquid-transfer/v1",
  evidence: Object.fromEntries([
    ["method_loaded", "execution_completed"],
    ["method_loaded", "execution_completed", "instrument_result"],
    ["method_loaded", "execution_completed", "instrument_result", "calibration_record"],
  ].map((required, tier) => [`tier${tier}`, {
    description: `Liquid transfer tier ${tier}`, required,
    primitives: [{ id: "receipt.kernel_signed", bind: "execution_completed" }],
  }])),
} as unknown as CSD;
beforeAll(async () => {
  vi.useRealTimers();
  ladder = await compileTierLadder(csd);
  expect(ladder.tiers.map((t) => t.tier)).toEqual([0, 1, 2]);
});
let serial = 0;
class LegacyStub implements MachineAdapter {
  readonly id = `neutral-device-${++serial}`;
  readonly type = "liquid-handler";
  source: EvidenceSource = { deviceId: this.id, deviceType: "controller", kernelId: "neutral-kernel" };
  commands: MachineCommand[] = [];
  actuations: string[] = [];
  progress = 0;
  deviceJobId = `staged-${this.id}`;
  events: EvidenceEvent["type"][] = ["execution_completed"];
  listeners: ((event: RawEvent) => void)[] = [];
  prepareAck?: (command: MachineCommand) => unknown;
  beforeLoad?: () => void;
  beforeStart?: () => void;
  afterEmit?: (event: RawEvent) => void;
  emit(type: EvidenceEvent["type"], payload: Record<string, unknown> = {}) {
    const event: RawEvent = { type, timestamp: new Date().toISOString(), source: this.source,
      payload: { deviceJobId: this.deviceJobId, ...payload } };
    for (const listener of this.listeners) listener(event);
    this.afterEmit?.(event);
  }
  async execute(command: MachineCommand): Promise<MachineCommandResult> {
    this.commands.push(command);
    if (command.type === "load_gcode") this.beforeLoad?.();
    // Check the future command as a string so the test suite runs against unchanged types.
    if ((command.type as string) === "prepare") {
      expect(this.actuations).toEqual([]);
      return (this.prepareAck?.(command) ?? { success: true, data: {
        jobId: command.payload!.jobId, inputHash: command.payload!.inputHash, deviceJobId: this.deviceJobId,
      } }) as MachineCommandResult;
    }
    if (command.type === "start") {
      this.beforeStart?.();
      this.actuations.push("start");
      for (const type of this.events) this.emit(type);
      this.progress = 100;
    }
    return { success: true };
  }
  async getStatus() { return "idle" as const; }
  async getProgress() { return this.progress; }
  onEvidence(callback: (event: RawEvent) => void) { this.listeners.push(callback); }
  async quiesceEvidence() {}
  async dispose() {}
}
class NeutralStub extends LegacyStub {
  accepts = ["prepare", "start", "stop", "status"] as MachineCommand["type"][];
}
function setup(machine: LegacyStub = new NeutralStub(), signer?: ReturnType<typeof makeKernelEd25519Signer>) {
  const emitter = new EvidenceEmitter("neutral-kernel", signer?.signFn);
  const bundles: EvidenceBundle[] = [];
  emitter.onBundle((bundle) => bundles.push(bundle));
  const register = vi.spyOn(emitter, "registerStep");
  const add = vi.spyOn(emitter, "addEvent");
  const onPhase = vi.fn();
  const config: Config = { jobId: `job-${machine.id}`, stepId: "step", inputHash: H, inputData: INPUT,
    assuranceTier: 0, tierLadder: ladder, onPhase };
  const run = (overrides: Partial<Config> = {}) => new JobRunner(machine, [], null, emitter).run({ ...config, ...overrides } as JobConfig);
  return { machine, emitter, bundles, register, add, onPhase, config, run };
}
function legacy() {
  const f = setup(new LegacyStub());
  f.config.inputHash = undefined;
  f.config.inputData = undefined;
  f.config.gcodeHash = H;
  f.config.tierLadder = undefined;
  return f;
}
async function refusal(overrides: Record<string, unknown>, error: string, accepts?: unknown, machine: LegacyStub = new NeutralStub()) {
  const f = setup(machine);
  if (accepts !== undefined) Object.assign(f.machine, { accepts });
  const result = await f.run(overrides as Partial<Config>);
  expect(result.success).toBe(false);
  expect(result.error).toBe(error);
  expect(result.busy).toBeUndefined();
  expect(result.bundleId).toBeUndefined();
  expect(f.machine.commands).toEqual([]);
  expect(f.register).not.toHaveBeenCalled();
  expect(f.onPhase).not.toHaveBeenCalled();
  expect(f.bundles).toEqual([]);
}
function method(bundle: EvidenceBundle) { return bundle.events.filter((e) => e.type === "method_loaded"); }

describe("A legacy commands", () => {
  it("A1 preserves command payload bytes and key order", async () => {
    const f = legacy();
    expect((await f.run()).success).toBe(true);
    expect(f.machine.commands.map((c) => c.type)).toEqual(["load_gcode", "start"]);
    expect(JSON.stringify(f.machine.commands[0]!.payload)).toBe(JSON.stringify({ gcodeHash: H, jobId: f.config.jobId }));
    expect(f.machine.commands[1]!.payload).toStrictEqual({ jobId: f.config.jobId });
  });
  it("A2 preserves a legacy short hash", async () => {
    const f = legacy();
    expect((await f.run({ gcodeHash: "sha256:abc" })).success).toBe(true);
    expect(f.machine.commands[0]!.payload).toStrictEqual({ gcodeHash: "sha256:abc", jobId: f.config.jobId });
  });
  it("A3 inputHash aliases the legacy gcodeHash payload", async () => {
    const f = legacy();
    expect((await f.run({ inputHash: H, gcodeHash: undefined })).success).toBe(true);
    expect(f.machine.commands[0]!.payload).toStrictEqual({ gcodeHash: H, jobId: f.config.jobId });
  });
  it("A4 retains the tier 2 FDM defaults without a ladder", async () => {
    const f = legacy();
    const result = await f.run({ assuranceTier: 2 });
    expect(result.success).toBe(false);
    expect(result.error).toBe("Tier 2 requirements not met: Missing one of: gcode_hash_verified, Missing one of: power_profile_summary, Missing one of: cv_inspection_result | camera_snapshot, Need at least 4 events, have 1");
    expect(f.bundles).toEqual([]);
  });
  it("A5 still records legacy adapter method_loaded without inputHash unchanged", async () => {
    const f = legacy();
    const payload = { gcodeHash: H, jobId: f.config.jobId, mock: true };
    let emitted: RawEvent | undefined;
    f.machine.beforeStart = () => {
      emitted = { type: "method_loaded", timestamp: new Date().toISOString(), source: f.machine.source, payload };
      for (const listener of f.machine.listeners) listener(emitted);
    };
    expect((await f.run()).success).toBe(true);
    const methods = method(f.bundles[0]!);
    expect(methods).toHaveLength(1);
    expect(methods[0]).toStrictEqual({ ...emitted, id: methods[0]!.id, hash: methods[0]!.hash });
    expect(JSON.stringify(methods[0]!.payload)).toBe(JSON.stringify(payload));
  });
  it("A6 an explicit load_gcode and start list remains legacy", async () => {
    const f = legacy(); Object.assign(f.machine, { accepts: ["load_gcode", "start"] });
    expect((await f.run()).success).toBe(true);
    expect(f.machine.commands.map((c) => c.type)).toEqual(["load_gcode", "start"]);
  });
  it("X-1 legacy load_gcode never carries configured input bytes", async () => {
    const f = legacy(); const inputData = new Uint8Array([1, 2, 3]); const gcodeHash = hash(inputData);
    expect((await f.run({ inputData, gcodeHash })).success).toBe(true);
    expect(f.machine.commands).toStrictEqual([
      { type: "load_gcode", payload: { gcodeHash, jobId: f.config.jobId } },
      { type: "start", payload: { jobId: f.config.jobId } },
    ]);
  });
});

describe("B synchronous refusals", () => {
  it.each([
    ["B1 neither hash", { inputHash: undefined }, "give exactly one of inputHash and gcodeHash"],
    ["B2 different hashes", { gcodeHash: OTHER_H }, "give exactly one of inputHash and gcodeHash"],
    ["B3 equal hashes", { gcodeHash: H }, "give exactly one of inputHash and gcodeHash"],
    ["B4 both data fields", { inputData: "x", gcodeData: "x" }, "give at most one of inputData and gcodeData"],
    ["B5 numeric data", { inputData: 7 }, "input data must be a string or bytes"],
    ["B6 lone surrogate", { inputData: "\uD800", inputHash: hash("\uD800") }, "input data is not well-formed text"],
    ["B7 prepare data mismatch", { inputData: "wrong" }, "input data does not match its hash"],
  ] as const)("%s", async (_name, overrides, error) => { await refusal(overrides, error); });
  it("B7b legacy data mismatch", async () => {
    const f = legacy(); const result = await f.run({ gcodeData: "wrong" });
    expect(result.success).toBe(false); expect(result.error).toBe("input data does not match its hash");
    expect(result.busy).toBeUndefined(); expect(result.bundleId).toBeUndefined();
    expect(f.machine.commands).toEqual([]); expect(f.register).not.toHaveBeenCalled();
    expect(f.onPhase).not.toHaveBeenCalled(); expect(f.bundles).toEqual([]);
  });
  it.each([
    ["B8 string accepts", "prepare start", "accepts must be a list of command types"],
    ["B9 missing start", ["prepare"], "adapter does not accept start"],
    ["X-16 legacy list missing start", ["load_gcode"], "adapter does not accept start"],
    ["B10 missing input command", ["stop", "start"], "accepts neither prepare nor load_gcode"],
    ["B11 non-string entry", [1, "prepare", "start"], "accepts must be a list of command types"],
  ])("%s", async (_name, accepts, error) => { await refusal({}, error as string, accepts); });
  const malformedHashes = [
    ["short", "sha256:abc"], ["uppercase", `sha256:${"AB".repeat(32)}`],
    ["63 digits", `sha256:${"a".repeat(63)}`], ["65 digits", `sha256:${"a".repeat(65)}`],
    ["uppercase prefix", `SHA256:${"ab".repeat(32)}`], ["leading space", ` sha256:${"ab".repeat(32)}`],
    ["newline", `${H}\n`], ["no prefix", "ab".repeat(32)],
  ];
  for (const field of ["inputHash", "gcodeHash"]) {
    it.each(malformedHashes)(`B12 ${field} %s`, async (_name, value) => {
      await refusal({ inputHash: undefined, [field]: value }, "inputHash must be sha256: followed by 64 lowercase hex digits");
    });
  }
  it.each([0, 2] as const)("B13 no prepare ladder tier %i", async (assuranceTier) => {
    await refusal({ tierLadder: undefined, assuranceTier }, "the prepare path needs a tier ladder");
  });
  it("B14 ladder lacks tier 3", async () => { await refusal({ assuranceTier: 3 }, "tier ladder has no tier 3"); });
  it("X-10 legacy ladder lacks tier 3 before commands or registerStep", async () => {
    await refusal({ assuranceTier: 3 }, "tier ladder has no tier 3", undefined, new LegacyStub());
  });
  it.each(["schema", "minimumEvents"])("B15 malformed ladder %s", async (fault) => {
    const bad = structuredClone(ladder);
    if (fault === "schema") Object.assign(bad, { schemaHash: "x" });
    else bad.tiers[0]!.minimumEvents++;
    await refusal({ tierLadder: bad }, "tier ladder is malformed: malformed-ladder");
  });
  it.each(["schema", "minimumEvents"])("X-11 malformed legacy ladder %s before commands or registerStep", async (fault) => {
    const bad = structuredClone(ladder);
    if (fault === "schema") Object.assign(bad, { schemaHash: "x" });
    else bad.tiers[0]!.minimumEvents++;
    await refusal({ tierLadder: bad }, "tier ladder is malformed: malformed-ladder", undefined, new LegacyStub());
  });
  it.each((["prepare", "legacy"] as const).flatMap((path) =>
    (["inputData", "gcodeData"] as const).map((field) => ({ path, field }))))(
    "INFO-1 detached $field on $path is refused before commands or registerStep", async ({ path, field }) => {
      const bytes = new Uint8Array([1, 2, 3]); const inputHash = hash(bytes);
      structuredClone(bytes.buffer, { transfer: [bytes.buffer] });
      await refusal({ inputData: undefined, gcodeData: undefined, [field]: bytes, inputHash },
        "input data must be a string or bytes", undefined, path === "prepare" ? new NeutralStub() : new LegacyStub());
    });
  it("X-17 empty input data with another hash is refused", async () => {
    await refusal({ inputData: "", inputHash: H }, "input data does not match its hash");
  });
});

describe("C exact data hashing", () => {
  it("X-17 empty input data is delivered as empty bytes", async () => {
    const f = setup(); const inputHash = hash("");
    expect((await f.run({ inputData: "", inputHash })).success).toBe(true);
    expect(f.machine.commands[0]).toStrictEqual({
      type: "prepare", payload: { jobId: f.config.jobId, inputHash, inputData: new Uint8Array(0) },
    });
  });
  it("C1 accepts the spec string hash", async () => {
    const f = setup(); const inputData = "liquid protocol";
    expect((await f.run({ inputData, inputHash: await sha256(inputData) })).success).toBe(true);
  });
  it("C2 preserves BOM and CRLF bytes", async () => {
    const f = setup(); const inputData = "\uFEFFline1\r\nline2\n";
    const inputHash = hash(Buffer.from(inputData, "utf8"));
    expect((await f.run({ inputData, inputHash })).success).toBe(true);
    expect(f.machine.commands[0]!.payload!.inputData).toStrictEqual(new Uint8Array(Buffer.from(inputData, "utf8")));
  });
  it("C3 hashes non-UTF8 bytes raw", async () => {
    const f = setup(); const inputData = new Uint8Array([0xff, 0x00, 0xfe, 0x80]);
    expect((await f.run({ inputData, inputHash: hash(inputData) })).success).toBe(true);
    expect(f.machine.commands[0]!.payload!.inputData).toStrictEqual(inputData);
  });
  it("C4 accepts the gcodeData alias", async () => {
    const f = setup(); const gcodeData = Buffer.from("alias\r\n");
    expect((await f.run({ inputData: undefined, gcodeData, inputHash: hash(gcodeData) })).success).toBe(true);
    expect(f.machine.commands[0]!.payload!.inputData).toStrictEqual(new Uint8Array(gcodeData));
  });
  it.each(["🧪", "literal \uFFFD character"])("C5 well-formed unicode %s", async (inputData) => {
    expect((await setup().run({ inputData, inputHash: hash(inputData) })).success).toBe(true);
  });
  it.each([
    ["X-14 leading f", "hash boundary 7", /^sha256:f/],
    ["X-15 trailing zero", "hash boundary 9", /0$/],
  ] as const)("%s is a valid input hash", async (_name, inputData, boundary) => {
    const inputHash = hash(inputData);
    expect(inputHash).toMatch(boundary);
    expect((await setup().run({ inputHash, inputData })).success).toBe(true);
  });
});

describe("D neutral prepare", () => {
  it("X-4 job.prepare span carries only the job id", async () => {
    const f = setup(); vi.mocked(Sentry.startSpan).mockClear();
    expect((await f.run()).success).toBe(true);
    const spans = vi.mocked(Sentry.startSpan).mock.calls.map(([options]) => options);
    expect(spans.filter((options) => options.name === "job.prepare")).toStrictEqual([
      { name: "job.prepare", op: "job.phase", attributes: { "job.id": f.config.jobId } },
    ]);
    for (const options of spans) {
      expect(JSON.stringify(options.attributes)).not.toContain(H);
      expect(JSON.stringify(options.attributes)).not.toContain(f.machine.deviceJobId);
    }
  });
  it.each(["inputHash", "gcodeHash"] as const)("D1 hash only via %s is refused before commands or registerStep", async (field) => {
    await refusal({ inputHash: undefined, [field]: H, inputData: undefined }, "the prepare path needs input data");
  });
  it("D1 data delivers the exact UTF8 bytes", async () => {
    const f = setup(); const text = "🧪\r\n"; const inputHash = hash(text);
    expect((await f.run({ inputData: text, inputHash })).success).toBe(true);
    expect(f.machine.commands).toStrictEqual([
      { type: "prepare", payload: { jobId: f.config.jobId, inputHash, inputData: new Uint8Array(Buffer.from(text, "utf8")) } },
      { type: "start", payload: { jobId: f.config.jobId } },
    ]);
  });
  it("D1 copy isolates caller bytes even if the adapter mutates them", async () => {
    const f = setup(); const inputData = new Uint8Array([3, 2, 1]); const inputHash = hash(inputData);
    f.machine.prepareAck = (command) => {
      const received = command.payload!.inputData;
      expect(received).toBeInstanceOf(Uint8Array);
      expect(received).not.toBe(inputData);
      expect(hash(received as Uint8Array)).toBe(inputHash);
      (received as Uint8Array).fill(99);
      return { success: true, data: { jobId: f.config.jobId, inputHash, deviceJobId: f.machine.deviceJobId } };
    };
    expect((await f.run({ inputData, inputHash })).success).toBe(true);
    expect(inputData).toStrictEqual(new Uint8Array([3, 2, 1]));
    expect(method(f.bundles[0]!)[0]!.payload.inputHash).toBe(inputHash);
  });
  it("D1 preflight snapshots shared bytes before step registration", async () => {
    const f = setup(); const inputData = new Uint8Array(new SharedArrayBuffer(3));
    inputData.set([3, 2, 1]); const inputHash = hash(inputData);
    f.register.mockImplementationOnce((...args) => {
      // Model a concurrent writer after hashing, before the prepare command is built.
      inputData.fill(99);
      EvidenceEmitter.prototype.registerStep.call(f.emitter, ...args);
    });
    expect((await f.run({ inputData, inputHash })).success).toBe(true);
    const received = f.machine.commands[0]!.payload!.inputData as Uint8Array;
    expect(received).toStrictEqual(new Uint8Array([3, 2, 1]));
    expect(received.buffer).not.toBeInstanceOf(SharedArrayBuffer);
    expect(hash(received)).toBe(inputHash);
    expect(inputData).toStrictEqual(new Uint8Array([99, 99, 99]));
  });
  it("D2 prefers prepare when both inputs are listed", async () => {
    const f = setup(); Object.assign(f.machine, { accepts: ["load_gcode", "prepare", "start"] });
    expect((await f.run()).success).toBe(true);
    expect(f.machine.commands.map((c) => c.type)).toEqual(["prepare", "start"]);
  });
  it("D3 prepare never actuates and its proof precedes start evidence", async () => {
    const f = setup(); f.machine.events = ["instrument_result", "execution_completed"];
    f.machine.beforeStart = () => { expect(f.machine.actuations).toEqual([]); };
    expect((await f.run()).success).toBe(true);
    expect(f.machine.actuations).toEqual(["start"]);
    expect(f.bundles[0]!.events.map((e) => e.type)).toEqual(["method_loaded", "instrument_result", "execution_completed"]);
  });
  it("D4 records exactly the kernel payload and source despite ack extras", async () => {
    const f = setup(); const source = { ...f.machine.source };
    f.machine.prepareAck = () => ({ success: true, data: { jobId: f.config.jobId, inputHash: H, deviceJobId: f.machine.deviceJobId, extra: 1 } });
    expect((await f.run()).success).toBe(true);
    const events = method(f.bundles[0]!); expect(events).toHaveLength(1);
    expect(events[0]!.payload).toStrictEqual({ jobId: f.config.jobId, deviceJobId: f.machine.deviceJobId, inputHash: H });
    expect(events[0]!.source).toStrictEqual(source);
  });
  it("D5 snapshots ack values and source before start mutates them", async () => {
    const f = setup(); const source = { ...f.machine.source }; const deviceJobId = f.machine.deviceJobId;
    const data: Record<string, unknown> = { jobId: f.config.jobId, inputHash: H, deviceJobId };
    f.machine.prepareAck = () => ({ success: true, data });
    f.machine.beforeStart = () => { data.deviceJobId = "changed"; data.extra = 1; f.machine.source.deviceId = "changed-source"; };
    expect((await f.run()).success).toBe(true);
    expect(method(f.bundles[0]!)[0]!.payload).toStrictEqual({ jobId: f.config.jobId, deviceJobId, inputHash: H });
    expect(method(f.bundles[0]!)[0]!.source).toStrictEqual(source);
  });
  it("D6 signs the method proof and whole bundle", async () => {
    const signer = makeKernelEd25519Signer(new Uint8Array(32).fill(41)); const f = setup(new NeutralStub(), signer);
    expect((await f.run()).success).toBe(true); const bundle = f.bundles[0]!;
    expect(await verifyBundleHash(bundle)).toBe(true);
    const events = method(bundle); expect(events).toHaveLength(1);
    expect(await verifyEventHash(events[0]!)).toBe(true);
    expect(nacl.sign.detached.verify(new TextEncoder().encode(bundle.bundleHash),
      Buffer.from(bundle.kernelSignature.value, "hex"), Buffer.from(signer.publicKeyHex, "hex"))).toBe(true);
  });
});

describe("E prepare ack fails closed", () => {
  const faults: [string, (data: Record<string, unknown>) => unknown, string][] = [
    ["bare success", () => ({ success: true }), "the prepare ack carries no data"],
    ["false success", (data) => ({ success: false, message: "refused", data }), "Failed to prepare the input: refused"],
    ["string success", (data) => ({ success: "true", data }), "Failed to prepare the input: undefined"],
    ["null data", () => ({ success: true, data: null }), "the prepare ack carries no data"],
    ["array data", () => ({ success: true, data: [] }), "the prepare ack carries no data"],
    ["other job", (data) => ({ success: true, data: { ...data, jobId: "another-job" } }), "the prepare ack did not echo jobId"],
    ["job suffix", (data) => ({ success: true, data: { ...data, jobId: `${data.jobId}x` } }), "the prepare ack did not echo jobId"],
    ["other hash", (data) => ({ success: true, data: { ...data, inputHash: OTHER_H } }), "the prepare ack did not echo inputHash"],
    ["uppercase hash", (data) => ({ success: true, data: { ...data, inputHash: H.toUpperCase() } }), "the prepare ack did not echo inputHash"],
    ["missing deviceJobId", ({ deviceJobId: _discard, ...data }) => ({ success: true, data }), "the prepare ack named no deviceJobId"],
    ["empty deviceJobId", (data) => ({ success: true, data: { ...data, deviceJobId: "" } }), "the prepare ack named no deviceJobId"],
    ["numeric deviceJobId", (data) => ({ success: true, data: { ...data, deviceJobId: 7 } }), "the prepare ack named no deviceJobId"],
  ];
  it.each(faults)("E %s", async (_name, ack, error) => {
    const f = setup(); f.machine.prepareAck = () => ack({ jobId: f.config.jobId, inputHash: H, deviceJobId: f.machine.deviceJobId });
    const result = await f.run(); expect(result.success).toBe(false); expect(result.error).toBe(error);
    expect(f.machine.actuations).toEqual([]); expect(f.machine.commands.map((c) => c.type)).toEqual(["prepare"]);
    expect(f.bundles).toEqual([]); expect(result.bundleId).toBeUndefined();
    expect(f.add.mock.calls.filter((c) => c[2].type === "method_loaded")).toEqual([]);
  });
});

describe("F only the kernel writes method_loaded", () => {
  it("legacy: a forbidden method_loaded after another event during load_gcode is refused before start", async () => {
    const f = legacy();
    f.machine.beforeLoad = () => {
      f.machine.emit("instrument_result", { step: 1 });
      f.machine.emit("method_loaded", { jobId: f.config.jobId, inputHash: H });
    };
    const result = await f.run();
    expect(result.success).toBe(false);
    expect(result.error).toBe("an adapter emitted method_loaded");
    expect(f.machine.commands.map((c) => c.type)).toStrictEqual(["load_gcode"]);
    expect(f.bundles).toEqual([]);
  });
  it("F1 refuses adapter method_loaded inside prepare", async () => {
    const f = setup(); f.machine.prepareAck = (command) => {
      f.machine.emit("method_loaded");
      return { success: true, data: { ...command.payload, deviceJobId: f.machine.deviceJobId } };
    };
    const result = await f.run(); expect(result.success).toBe(false); expect(result.error).toBe("an adapter emitted method_loaded");
    expect(f.machine.commands.map((c) => c.type)).toEqual(["prepare"]); expect(f.bundles).toEqual([]);
    expect(f.add.mock.calls.filter((c) => c[2].type === "method_loaded")).toEqual([]);
  });
  it("F2 refuses adapter method_loaded during start", async () => {
    const f = setup(); f.machine.events.unshift("method_loaded");
    const result = await f.run(); expect(result.success).toBe(false); expect(result.error).toBe("an adapter emitted method_loaded");
    expect(f.bundles).toEqual([]);
  });
  it("F3 refuses an event mutated into method_loaded after emission", async () => {
    const f = setup(); f.machine.events.unshift("instrument_result");
    f.machine.afterEmit = (event) => { if (event.type === "instrument_result") event.type = "method_loaded"; };
    const result = await f.run(); expect(result.success).toBe(false);
    expect(result.error).toBe("the bundle would carry a method_loaded the kernel did not record"); expect(f.bundles).toEqual([]);
  });
  const hashValues = [
    ["equal", H], ["different", OTHER_H], ["undefined", undefined], ["null", null], ["empty", ""], ["number", 7],
  ] as const;
  it.each(hashValues.flatMap(([name, inputHash]) => (["load_gcode", "start"] as const).map((phase) => ({ name, inputHash, phase }))))(
    "MEDIUM-1 legacy method_loaded with $name inputHash during $phase fails closed and is never recorded", async ({ inputHash, phase }) => {
    const f = legacy();
    const emit = () => f.machine.emit("method_loaded", { jobId: f.config.jobId, inputHash });
    if (phase === "load_gcode") f.machine.beforeLoad = emit;
    else f.machine.beforeStart = emit;
    const result = await f.run();
    expect(result.success).toBe(false);
    expect(result.error).toBe("an adapter emitted method_loaded");
    expect(result.bundleId).toBeUndefined(); expect(result.bundleHash).toBeUndefined();
    expect(result.busy).toBeUndefined(); expect(f.bundles).toEqual([]);
    expect(f.add.mock.calls.filter((c) => c[2].type === "method_loaded")).toEqual([]);
    expect(f.machine.commands.map((c) => c.type)).toStrictEqual(phase === "load_gcode" ? ["load_gcode"] : ["load_gcode", "start"]);
  });
  it.each(["payload", "type"])("MEDIUM-1 legacy post-settle %s mutation cannot forge the input proof", async (mutation) => {
    const f = legacy();
    // Mutate after addEvent has stored the event, so only the post-settle check can catch it.
    f.add.mockImplementation(async (jobId, stepId, event) => {
      const stored = await EvidenceEmitter.prototype.addEvent.call(f.emitter, jobId, stepId, event);
      if (event.type === (mutation === "payload" ? "method_loaded" : "instrument_result")) {
        stored.type = "method_loaded"; stored.payload.inputHash = undefined;
      }
      return stored;
    });
    f.machine.events.unshift(mutation === "payload" ? "method_loaded" : "instrument_result");
    const result = await f.run();
    expect(result.success).toBe(false);
    expect(result.error).toBe("the bundle would carry a method_loaded the kernel did not record");
    expect(result.bundleId).toBeUndefined(); expect(result.bundleHash).toBeUndefined();
    expect(result.busy).toBeUndefined(); expect(f.bundles).toEqual([]);
  });
  it.each(["payload", "type"])("MEDIUM-1 legacy queued %s mutation is never recorded", async (mutation) => {
    const f = legacy();
    f.machine.events.unshift(mutation === "payload" ? "method_loaded" : "instrument_result");
    f.machine.afterEmit = (event) => {
      if (event.type === (mutation === "payload" ? "method_loaded" : "instrument_result")) {
        event.type = "method_loaded"; event.payload.inputHash = undefined;
      }
    };
    const result = await f.run();
    expect(result.success).toBe(false); expect(result.error).toBe("an adapter emitted method_loaded");
    expect(result.bundleId).toBeUndefined(); expect(result.bundleHash).toBeUndefined();
    expect(f.bundles).toEqual([]);
    expect(f.add.mock.calls.filter((c) => c[2].type === "method_loaded")).toEqual([]);
  });
});

describe("G capability ladders", () => {
  const events: EvidenceEvent["type"][] = ["instrument_result", "calibration_record", "execution_completed"];
  it("G1 tier 2 accepts liquid transfer evidence", async () => {
    const f = setup(); f.machine.events = [...events]; expect((await f.run({ assuranceTier: 2 })).success).toBe(true);
  });
  it("G2 tier 2 requires calibration_record", async () => {
    const f = setup(); f.machine.events = ["instrument_result", "execution_completed"];
    const result = await f.run({ assuranceTier: 2 }); expect(result.success).toBe(false);
    expect(result.error).toBe("Tier 2 requirements not met: Missing one of: calibration_record, Need at least 4 events, have 3");
  });
  it("X-12 tier 2 checks the snapshot after the caller removes calibration_record", async () => {
    const f = setup(); const mutable = structuredClone(ladder);
    f.machine.events = ["instrument_result", "execution_completed"];
    f.machine.beforeStart = () => {
      const tier = mutable.tiers.find((entry) => entry.tier === 2)!;
      tier.requiredEventTypes = tier.requiredEventTypes.filter((group) => !group.includes("calibration_record"));
      tier.minimumEvents = tier.requiredEventTypes.length;
    };
    const result = await f.run({ assuranceTier: 2, tierLadder: mutable });
    expect(result.success).toBe(false);
    expect(result.error).toBe("Tier 2 requirements not met: Missing one of: calibration_record, Need at least 4 events, have 3");
    expect(f.bundles).toEqual([]);
  });
  it("G3 fabricated events never count toward the ladder", async () => {
    const f = setup(); f.machine.events = [...events]; f.machine.source.simulated = true;
    const result = await f.run({ assuranceTier: 2 }); expect(result.success).toBe(false);
    expect(result.error).toBe("Tier 2 requirements not met: Missing one of: calibration_record, Missing one of: execution_completed, Missing one of: instrument_result, Missing one of: method_loaded, Need at least 4 events, have 0"); expect(f.bundles).toEqual([]);
  });
  it("G4 legacy uses a supplied capability ladder", async () => {
    const f = legacy(); f.machine.events = ["method_loaded", ...events];
    expect((await f.run({ assuranceTier: 2, tierLadder: ladder })).success).toBe(true);
  });
});
