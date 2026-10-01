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

// ---------------------------------------------------------------------------
// N15 round 5 (cross-family review A05c, finding F2)
// ---------------------------------------------------------------------------

/** The execution_completed event carries the output commitment. */
const committedOutputHash = (response: { evidenceBundle: { events: Array<{ type: string; payload: unknown }> } }) =>
  (response.evidenceBundle.events.find((e) => e.type === "execution_completed")?.payload as { outputHash: string }).outputHash;

/**
 * The handler hashed canonicalize(output) but returned the builder's own object, so a Proxy
 * (or an object the builder kept and changed) could be committed as one thing and returned as
 * another. It now snapshots the output once, right after execute returns, hashes the snapshot's
 * text and returns the snapshot's value.
 */
describe("createKernelHandler -- commits to, and returns, the one snapshot of the builder's output (N15 round 5, A05c F2)", () => {
  it("A05c F2: the verdict's repro: an output Proxy whose descriptors say safe and whose get trap says danger", async () => {
    const keysRead: string[] = [];
    const handler = handlerWith(async () =>
      new Proxy({ command: "safe" } as Record<string, unknown>, {
        get(target, key, receiver) {
          keysRead.push(String(key));
          return key === "command" ? "danger" : Reflect.get(target, key, receiver);
        },
      }),
    );
    const response = await handler({ jobId: "job-6", input: {} });
    expect(committedOutputHash(response)).toBe(await sha256(canonicalize({ command: "safe" })));
    expect(response.output.command).toBe("safe"); // faac0003 returned "danger" next to a commitment to "safe"
    expect(response.output).toEqual({ command: "safe" });
    // The handler never reads the builder's object through [[Get]], before or after the commitment. (The
    // one read there is, "then", is the language's own thenable check when an async function returns an
    // object; it asks for no data.)
    expect(keysRead.filter((key) => key !== "then")).toEqual([]);
  });

  it("A05c F2: the response is a detached copy: a builder that keeps its object cannot change the output after the commitment", async () => {
    const returned = { command: "safe", list: [1, 2] };
    const handler = handlerWith(async () => returned);
    const response = await handler({ jobId: "job-7", input: {} });
    const committed = committedOutputHash(response);
    returned.command = "changed after the commitment";
    returned.list.push(3);
    expect(response.output).toEqual({ command: "safe", list: [1, 2] }); // faac0003: the same object, now "changed ..."
    expect(await sha256(canonicalize(response.output))).toBe(committed);
  });

  it("A05c F2: a polluted Object.prototype supplies nothing to whoever reads the response's output", async () => {
    const handler = handlerWith(async () => ({ nested: {} }));
    const reads = await withPollutedPrototype({ command: "danger" }, async () => {
      const response = await handler({ jobId: "job-8", input: {} });
      const nested = response.output.nested as Record<string, unknown>;
      return [response.output.command, nested.command, "command" in response.output];
    });
    expect(reads).toEqual([undefined, undefined, false]); // faac0003: ["danger", "danger", true]
  });

  it("A05c F2: refuses a non-JSON output the way it refuses a non-JSON input: a typed NonCanonicalValueError", async () => {
    for (const output of [{ n: Number.NaN }, { f: () => 1 }, { when: new Date(0) }, { big: BigInt(1) }]) {
      const handler = handlerWith(async () => output as unknown as Record<string, unknown>);
      await expect(handler({ jobId: "job-9", input: {} })).rejects.toMatchObject({ name: "NonCanonicalValueError" });
    }
    const accessor = Object.defineProperty({}, "x", { enumerable: true, get: () => 1 });
    await expect(handlerWith(async () => accessor)({ jobId: "job-9", input: {} })).rejects.toMatchObject({ name: "NonCanonicalValueError" });
  });

  it("A05c F2: an honest builder keeps its commitment bytes; the response is the canonical JSON that commitment covers (-0 reads 0, an undefined member is omitted)", async () => {
    const out = { b: [1, { deep: -0 }], a: "x", skip: undefined, nested: { k: null } };
    const handler = handlerWith(async () => out as unknown as Record<string, unknown>);
    const response = await handler({ jobId: "job-10", input: { n: 1 } });
    expect(committedOutputHash(response)).toBe(await sha256(canonicalize(out)));
    expect(response.output).toEqual({ a: "x", b: [1, { deep: 0 }], nested: { k: null } });
  });

  it("A05c F2: leaves Object.prototype exactly as it found it (no test above leaks a pollution)", () => {
    expect(Object.getOwnPropertyNames(Object.prototype).sort()).toEqual(OBJECT_PROTOTYPE_AT_LOAD);
  });
});
