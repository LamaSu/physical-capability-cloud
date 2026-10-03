/**
 * The R8 command map against a device profile (steward #5363, 10/03).
 * Refvertical authors each rehearsal device's profile (`.pcc/operations.json`,
 * ADK #471) and its R8 command map. Adk checks the two with
 * `commandMapProfileIssue` before the operator confirms the envelope. They
 * describe one command surface only if the operations are the commands and
 * each operation's request-body slots are its command's parameters.
 */

import { describe, expect, it } from "vitest";

import { templateSlotName } from "../onboarding/primordials.js";
import { commandMapProfileIssue, type CommandMapV1 } from "../onboarding/safety-envelope.js";

/** All 96 wells, in a value set's one committed order (UTF-16 code units). */
const WELLS_96 = [..."ABCDEFGH"].flatMap((row) => Array.from({ length: 12 }, (_, i) => `${row}${i + 1}`)).sort();

/** SIM-PR1's R8 map, as the parity fixtures declare it. */
const SIM_PR1_MAP: CommandMapV1 = {
  commands: [
    {
      name: "runPlate",
      params: [
        { name: "plateFormat", unbounded: { reason: "the plate format; this reader takes 96-well plates only", allowed: ["96-well"] } },
        { name: "wavelengthNm", unbounded: { reason: "an optical setting, not a safety quantity", allowed: [405, 450, 600] } },
        { name: "wells", unbounded: { reason: "which wells to read; a well name sets no physical quantity", allowed: ["all"], allowedItems: WELLS_96 } },
      ],
    },
    { name: "stop", params: [] },
  ],
};

/** SIM-PR1's profile operations, from its API (DEVICE_MANUAL 4.4, 4.6, 4.7, 4.9) in #471's binding shape. */
const SIM_PR1_OPERATIONS = {
  runPlate: {
    request: {
      method: "POST",
      path: "/runs",
      body: { plateFormat: "{plateFormat}", wavelengthNm: "{wavelengthNm}", wells: "{wells}" },
      refusals: [400, 409, 423],
    },
    runId: "runId",
    poll: { path: "/runs/{runId}", field: "state", done: ["succeeded"], failed: ["failed", "stopped"] },
    log: { path: "/runs/{runId}/log" },
  },
  stop: { request: { method: "POST", path: "/estop", body: {} }, poll: { path: "/runs/{runId}", field: "state", done: ["stopped"] } },
};

const CLASS = "lab-plate-reader";
const clone = <T>(v: T): T => structuredClone(v);

describe("commandMapProfileIssue: the R8 map and #471's profile describe one command surface", () => {
  it("SIM-PR1's map and its profile match", () => {
    expect(commandMapProfileIssue(SIM_PR1_MAP, SIM_PR1_OPERATIONS, CLASS)).toBeNull();
  });

  it("refuses a profile operation the map does not describe", () => {
    const ops = { ...clone(SIM_PR1_OPERATIONS), shake: { request: { method: "POST", path: "/shake", body: { seconds: "{seconds}" } } } };
    expect(commandMapProfileIssue(SIM_PR1_MAP, ops, CLASS)).toMatch(/operation "shake" has no command in the map/);
  });

  it("refuses a map command the profile cannot send", () => {
    const ops = clone(SIM_PR1_OPERATIONS) as Record<string, unknown>;
    delete ops.stop;
    expect(commandMapProfileIssue(SIM_PR1_MAP, ops, CLASS)).toMatch(/command "stop" is not an operation of the profile/);
  });

  it("refuses a slot the map does not annotate: its value would reach the device unchecked", () => {
    const ops = clone(SIM_PR1_OPERATIONS);
    (ops.runPlate.request.body as Record<string, unknown>).lampPower = "{lampPower}";
    expect(commandMapProfileIssue(SIM_PR1_MAP, ops, CLASS)).toMatch(/the slot \{lampPower\} has no parameter in the map/);
  });

  it("refuses a parameter that is no slot: it would be checked but never sent", () => {
    const ops = clone(SIM_PR1_OPERATIONS);
    delete (ops.runPlate.request.body as Record<string, unknown>).wells;
    expect(commandMapProfileIssue(SIM_PR1_MAP, ops, CLASS)).toMatch(/the parameter "wells" is not a slot/);
  });

  it("finds slots anywhere in the body, at any depth and in lists, and counts a slot used twice once", () => {
    const ops = clone(SIM_PR1_OPERATIONS);
    ops.runPlate.request.body = {
      plate: { format: "{plateFormat}", wells: ["{wells}"] },
      optics: [{ nm: "{wavelengthNm}" }, { echo: "{wavelengthNm}" }],
      mode: "absorbance",
      repeats: 1,
      shake: false,
      note: null,
    } as never;
    expect(commandMapProfileIssue(SIM_PR1_MAP, ops, CLASS)).toBeNull();
  });

  it("treats keys as literal and an absent request or body as no slots", () => {
    const ops = clone(SIM_PR1_OPERATIONS);
    ops.stop = { poll: { path: "/runs/{runId}", field: "state", done: ["stopped"] } } as never;
    expect(commandMapProfileIssue(SIM_PR1_MAP, ops, CLASS)).toBeNull();
    const keyed = clone(SIM_PR1_OPERATIONS);
    (keyed.runPlate.request.body as Record<string, unknown>)["{extra}"] = 1;
    expect(commandMapProfileIssue(SIM_PR1_MAP, keyed, CLASS)).toBeNull();
  });

  it.each([
    ["text around a slot", "pre{wells}"],
    ["two slots in one string", "{plateFormat}{wells}"],
    ["a slot that starts with a digit", "{1wells}"],
    ["a slot with a dash", "{well-list}"],
    ["an empty slot", "{}"],
    ["an unclosed brace", "{wells"],
    ["a lone brace", "{"],
  ])("refuses %s, as #471 refuses it", (_label, value) => {
    const ops = clone(SIM_PR1_OPERATIONS);
    (ops.runPlate.request.body as Record<string, unknown>).wells = value;
    expect(commandMapProfileIssue(SIM_PR1_MAP, ops, CLASS)).toMatch(/a slot is a whole string/);
  });

  it("refuses a profile that is not an object of objects, and a request that is not an object", () => {
    expect(commandMapProfileIssue(SIM_PR1_MAP, [], CLASS)).toMatch(/operations must be an object/);
    expect(commandMapProfileIssue(SIM_PR1_MAP, { ...clone(SIM_PR1_OPERATIONS), stop: "POST /estop" }, CLASS)).toMatch(/operation "stop" must be an object/);
    expect(commandMapProfileIssue(SIM_PR1_MAP, { ...clone(SIM_PR1_OPERATIONS), stop: { request: "POST /estop" } }, CLASS)).toMatch(/operations\.stop\.request must be an object/);
  });

  it("holds the map to its own shape rules, and refuses an unknown class", () => {
    const map = clone(SIM_PR1_MAP);
    map.commands[0]!.params[1] = { name: "wavelengthNm", unbounded: { reason: "an optical setting", allowed: [600, 405] } };
    expect(commandMapProfileIssue(map, SIM_PR1_OPERATIONS, CLASS)).toMatch(/^commandMap: .*one committed order/);
    expect(commandMapProfileIssue(SIM_PR1_MAP, SIM_PR1_OPERATIONS, "toString")).toMatch(/unknown deviceClass/);
  });

  it("reads each input once as plain data: a getter in the profile is refused without running", () => {
    let ran = false;
    const ops = clone(SIM_PR1_OPERATIONS) as Record<string, unknown>;
    Object.defineProperty(ops, "stop", {
      enumerable: true,
      get: () => {
        ran = true;
        return { request: { method: "POST", path: "/estop", body: {} } };
      },
    });
    expect(commandMapProfileIssue(SIM_PR1_MAP, ops, CLASS)).toMatch(/an accessor/);
    expect(ran).toBe(false);
  });
});

describe("templateSlotName: #471's slot, a whole string {name} with name [A-Za-z_][A-Za-z0-9_]*, over every code unit", () => {
  const first = (u: number) => (u >= 0x41 && u <= 0x5a) || (u >= 0x61 && u <= 0x7a) || u === 0x5f;
  const inner = (u: number) => first(u) || (u >= 0x30 && u <= 0x39);
  const units = [...Array.from({ length: 0x80 }, (_, i) => i), 0xa0, 0xe9, 0x130, 0x212a, 0x2028, 0xd800, 0xdc00, 0xfeff, 0xff41];

  it("accepts exactly the slot language", () => {
    for (const u of units) {
      const c = String.fromCharCode(u);
      expect(templateSlotName(`{${c}}`), `first ${u.toString(16)}`).toBe(first(u) ? c : null);
      expect(templateSlotName(`{a${c}}`), `inner ${u.toString(16)}`).toBe(inner(u) ? `a${c}` : null);
    }
    expect(templateSlotName("{wavelengthNm}")).toBe("wavelengthNm");
    expect(templateSlotName("{_x9}")).toBe("_x9");
    for (const v of ["{}", "{", "}", "x", "", " {a}", "{a} ", null, 1, ["{a}"], { a: 1 }]) expect(templateSlotName(v), JSON.stringify(v)).toBeNull();
  });
});
