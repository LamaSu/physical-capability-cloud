/**
 * N15 round 4 (cross-family review A05b, finding 3, createKernelHandler): the
 * handler ran the builder's `execute` against `request.input` first and only
 * canonicalized that same mutable object afterwards. A Proxy whose descriptors say
 * "safe" and whose get trap says "danger" was executed as "danger" while the
 * evidence committed to "safe". The handler now canonicalizes first, parses the
 * canonical text once, executes on that snapshot and hashes the same text.
 */

import { describe, expect, it } from "vitest";
import nacl from "tweetnacl";
import { canonicalize, sha256 } from "@pcc/spec";
import type { DigitalKernelManifest, PrincipalKey } from "@pcc/spec";
import { createKernelHandler } from "../index.js";

const manifest = {
  manifestVersion: "1.0.0",
  kernelId: "k-snapshot-test",
  name: "Snapshot test kernel",
  description: "unit-test kernel",
  builder: { agentId: "agent:test" },
  capabilityType: "snapshot-test",
  workflowSteps: [{ stepId: "s1", stepType: "transform", description: "run", dependsOn: [] }],
  pricing: { currency: "USDC", baseUSD: 0 },
  maxAssuranceTier: 1,
  endpointURL: "https://kernel.example.com/run",
  sessionKeyPolicy: { maxTTLSeconds: 3600, allowedActions: ["evidence_submit"] },
  status: "pending",
} as unknown as DigitalKernelManifest;

const principalKey = {
  agentId: "eip155:1:0x0000000000000000000000000000000000000001",
  walletAddress: "0x0000000000000000000000000000000000000001",
  publicKey: new Uint8Array(32),
} as unknown as PrincipalKey;

function handlerWith(execute: (input: Record<string, unknown>) => Promise<Record<string, unknown>>) {
  return createKernelHandler({
    manifest,
    principalKey,
    principalPrivateKey: nacl.sign.keyPair().secretKey,
    execute,
  });
}

/** The first evidence event is the input commitment: its payload carries inputHash. */
const committedInputHash = (response: { evidenceBundle: { events: Array<{ payload: unknown }> } }) =>
  (response.evidenceBundle.events[0].payload as { inputHash: string }).inputHash;

describe("createKernelHandler — executes exactly the snapshot it hashed (N15 round 4, A05b #3)", () => {
  it("a Proxy cannot show the executor something other than what the evidence commits to (the verdict's repro)", async () => {
    const seen: unknown[] = [];
    const handler = handlerWith(async (input) => {
      seen.push(input.command);
      return { ran: input.command as string };
    });
    let gets = 0;
    const hostile = new Proxy({ command: "safe" } as Record<string, unknown>, {
      get(target, key, receiver) {
        gets++;
        return key === "command" ? "danger" : Reflect.get(target, key, receiver);
      },
    });

    const response = await handler({ jobId: "job-1", input: hostile });

    expect(seen).toEqual(["safe"]); // round 3 executed "danger"
    expect(response.output).toEqual({ ran: "safe" });
    expect(committedInputHash(response)).toBe(await sha256(canonicalize({ command: "safe" })));
    expect(gets).toBe(0);
  });

  it("refuses a non-canonical input BEFORE any builder code runs", async () => {
    let executed = 0;
    const handler = handlerWith(async () => {
      executed++;
      return {};
    });
    await expect(handler({ jobId: "job-2", input: { n: Number.NaN } })).rejects.toMatchObject({ name: "NonCanonicalValueError" });
    await expect(handler({ jobId: "job-2", input: { f: () => 1 } })).rejects.toMatchObject({ name: "NonCanonicalValueError" });
    expect(executed).toBe(0); // round 3 ran the builder first and refused afterwards
  });

  it("the input commitment is the hash of the input as it was before the builder ran", async () => {
    const original = { command: "ls", args: ["-l", { deep: 1 }], skip: undefined };
    const handler = handlerWith(async (input) => {
      input.command = "mutated by the builder";
      (input.args as unknown[]).push("extra");
      return { done: true };
    });
    const response = await handler({ jobId: "job-3", input: original as unknown as Record<string, unknown> });
    expect(committedInputHash(response)).toBe(await sha256(canonicalize({ command: "ls", args: ["-l", { deep: 1 }] })));
    // the caller's own object is not the one the builder received, so it is untouched
    expect(original.command).toBe("ls");
    expect(original.args).toEqual(["-l", { deep: 1 }]);
  });

  it("hands the builder the same data a plain caller sent, and keeps the evidence layout", async () => {
    let received: unknown;
    const handler = handlerWith(async (input) => {
      received = input;
      return { echoed: input.n as number };
    });
    const input = { n: 7, nested: { list: [1, 2, 3], flag: true }, none: null };
    const response = await handler({ jobId: "job-4", input });
    expect(received).toEqual(input);
    expect(response.output).toEqual({ echoed: 7 });
    expect(committedInputHash(response)).toBe(await sha256(canonicalize(input)));
    expect(response.evidenceBundle.events.map((e) => e.type)).toEqual([
      "gcode_hash_verified",
      "execution_started",
      "workflow_step_completed",
      "execution_completed",
    ]);
  });
});

// ---------------------------------------------------------------------------
// N15 round 5 (cross-family review A05c, finding F1)
// ---------------------------------------------------------------------------

/** Object.prototype's own names when this file loaded, before any test could pollute it. */
const OBJECT_PROTOTYPE_AT_LOAD = Object.getOwnPropertyNames(Object.prototype).sort();

/**
 * Install `members` on Object.prototype while `fn` settles and always take them off again, even when
 * `fn` throws, so a failing assertion cannot leak a pollution into another test. The members are
 * non-enumerable so nothing that iterates keys while the awaits are pending can trip over them.
 * Assert only after this returns.
 */
async function withPollutedPrototype<T>(members: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
  const target = Object.prototype as unknown as Record<string, unknown>;
  const names = Object.keys(members);
  try {
    for (const name of names) {
      Object.defineProperty(Object.prototype, name, { value: members[name], writable: true, enumerable: false, configurable: true });
    }
    return await fn();
  } finally {
    for (const name of names) delete target[name];
  }
}

/**
 * The input snapshot inherited Object.prototype and the builder reads it with ordinary
 * property reads, so a polluted prototype supplied the builder members that the input
 * commitment never covered. The snapshot is prototype-less now.
 */
describe("createKernelHandler -- a polluted Object.prototype supplies the builder nothing that was not hashed (N15 round 5, A05c F1)", () => {
  it("A05c F1: the verdict's repro: an inherited `command` does not reach a builder that was given {}", async () => {
    const seen: unknown[] = [];
    const handler = handlerWith(async (input) => {
      seen.push(input.command, "command" in input);
      return { ran: true };
    });
    const response = await withPollutedPrototype({ command: "danger" }, () => handler({ jobId: "job-5", input: {} }));
    expect(seen).toEqual([undefined, false]); // faac0003: ["danger", true]
    expect(committedInputHash(response)).toBe(await sha256(canonicalize({})));
  });

  it("A05c F1: at every depth of the input", async () => {
    const seen: unknown[] = [];
    const handler = handlerWith(async (input) => {
      const nested = input.nested as Record<string, unknown>;
      const first = (input.list as Array<Record<string, unknown>>)[0];
      seen.push(nested.command, first.command, "command" in nested, "command" in first);
      return {};
    });
    await withPollutedPrototype({ command: "danger" }, () => handler({ jobId: "job-5b", input: { nested: {}, list: [{}] } }));
    expect(seen).toEqual([undefined, undefined, false, false]);
  });

  it("A05c F1: hands the builder a prototype-less snapshot that Object.keys, `in`, spread and JSON.stringify all handle", async () => {
    let seen: Record<string, unknown> | undefined;
    const handler = handlerWith(async (input) => {
      seen = input;
      return { keys: Object.keys(input), copy: { ...input }, json: JSON.stringify(input) };
    });
    const response = await handler({ jobId: "job-5c", input: { b: 2, a: { c: [1, 2] } } });
    expect(Object.getPrototypeOf(seen)).toBeNull();
    expect(Object.getPrototypeOf((seen as { a: object }).a)).toBeNull();
    expect(response.output).toEqual({ keys: ["a", "b"], copy: { a: { c: [1, 2] }, b: 2 }, json: '{"a":{"c":[1,2]},"b":2}' });
  });

  it("A05c F1: leaves Object.prototype exactly as it found it (no test above leaks a pollution)", () => {
    expect(Object.getOwnPropertyNames(Object.prototype).sort()).toEqual(OBJECT_PROTOTYPE_AT_LOAD);
  });
});
