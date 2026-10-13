import { createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { kernelSigningProofMessage } from "@pcc/kernel";
import { DEFAULT_SESSION_KEY_CONFIG, sessionKeyDelegationPreimage, signingPreimage } from "@pcc/spec";
import { getAddress, type Hex } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DeviceSigningError, loadDeviceKey, type DelegationInput, type DeviceDelegationBinding, type DeviceKey,
} from "../src/keys.js";
import { makeKernelEd25519Signer } from "../src/kernel-signer.js";

let directory: string;
let keyPath: string;
let key: DeviceKey;
let seedHex: string;
let binding: DeviceDelegationBinding;
let session: ReturnType<typeof generateKeyPairSync>;
const now = new Date("2026-10-10T12:00:00.000Z");
const fundedAt = now.getTime() / 1000;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "ph2-device-signing-"));
  await chmod(directory, 0o700);
  const seed = randomBytes(32);
  const derived = makeKernelEd25519Signer(seed);
  seedHex = seed.toString("hex");
  keyPath = join(directory, "device.json");
  await writeFile(keyPath, JSON.stringify({
    kind: "pcc-printhost.device-key", version: 1, algorithm: "ed25519", purpose: "runtime test",
    createdAt: now.toISOString(), publicKey: derived.signingPublicKey, seed: seedHex,
  }), { mode: 0o600 });
  seed.fill(0);
  derived.secretKey.fill(0);
  binding = { chainId: 84532, operator: getAddress(`0x${randomBytes(20).toString("hex")}`) };
  key = await loadDeviceKey(keyPath, { now, delegationBinding: binding });
  session = generateKeyPairSync("ed25519");
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

function delegation(): DelegationInput {
  return {
    sessionId: "session-runtime", parentAgentId: `eip155:${binding.chainId}:${binding.operator.toLowerCase()}` as DelegationInput["parentAgentId"],
    publicKey: session.publicKey.export({ format: "der", type: "spki" }).subarray(-32),
    issuedAt: fundedAt, expiresAt: fundedAt + 86400,
    scope: { allowedActions: [...DEFAULT_SESSION_KEY_CONFIG.defaultAllowedActions], contractIds: ["job-runtime"], maxSignatures: 3 },
    jobId: "job-runtime", fundedAt, reclaimAt: fundedAt + 86400, firstEventAt: fundedAt + 1.25, eventCount: 3,
  };
}
function devicePublicKey() {
  return createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(key.publicKeyHex, "hex")]),
    format: "der", type: "spki" });
}
function signatureBytes(signature: Hex): Buffer { return Buffer.from(signature.slice(2), "hex"); }
async function closedRefusal(operation: () => Promise<unknown>, code: string): Promise<void> {
  let caught: unknown;
  try { await operation(); } catch (error) { caught = error; }
  expect(caught instanceof DeviceSigningError).toBe(true);
  const error = caught as DeviceSigningError;
  expect(error.code).toBe(code);
  expect(error.message).toBe(code);
  expect(Reflect.ownKeys(error).sort()).toEqual(["stack", "message", "name", "code"].sort());
  const rendered = inspect(error, { customInspect: false, showHidden: true });
  for (let index = 0; index <= seedHex.length - 12; index++) {
    expect(rendered.includes(seedHex.slice(index, index + 12)), "device signing error exposed a secret fragment").toBe(false);
  }
}

describe("narrow device signing", () => {
  it("DeviceKey exposes exactly two signing methods over a frozen null-root prototype", () => {
    expect(Reflect.ownKeys(key).sort()).toEqual(["publicKeyHex", "signingPublicKey", "signDelegation", "signD2"].sort());
    const prototype = Object.getPrototypeOf(key) as object;
    expect(Object.isFrozen(key)).toBe(true);
    expect(Object.isFrozen(prototype)).toBe(true);
    expect(Object.getPrototypeOf(prototype)).toBeNull();
    const allowed = new Set<PropertyKey>(["signDelegation", "signD2", "toJSON", "toString", inspect.custom]);
    const found = new Set<PropertyKey>();
    const seen = new Set<object>();
    function walk(value: unknown): void {
      if (value === null || (typeof value !== "object" && typeof value !== "function") || seen.has(value)) return;
      seen.add(value);
      expect(value instanceof Uint8Array || value instanceof ArrayBuffer, "device surface exposes private bytes").toBe(false);
      for (const name of Reflect.ownKeys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, name)!;
        expect(descriptor.get === undefined && descriptor.set === undefined).toBe(true);
        if (typeof descriptor.value === "function") {
          expect(allowed.has(name), "device surface exposes another function").toBe(true);
          found.add(name);
        }
        walk(descriptor.value);
      }
      // Built-in Function.prototype is shared by every method, not a custody surface.
      if (typeof value !== "function") walk(Object.getPrototypeOf(value));
    }
    walk(key);
    expect(found).toEqual(allowed);
    for (const output of [String(key), JSON.stringify(key), inspect(key, { depth: 12, showHidden: true }),
      inspect(key, { customInspect: false, showHidden: true, depth: 12 })]) {
      for (let index = 0; index <= seedHex.length - 12; index++) {
        expect(output.includes(seedHex.slice(index, index + 12)), "device surface exposed a secret fragment").toBe(false);
      }
    }
  });

  it("signDelegation builds the spec LO-EV-1 preimage and signs only the MVP fields", async () => {
    const input = delegation();
    const signature = signatureBytes(await key.signDelegation(input));
    expect(verify(null, sessionKeyDelegationPreimage(input), devicePublicKey(), signature)).toBe(true);
    const detached = key.signDelegation;
    expect(await detached(input)).toBe(`0x${signature.toString("hex")}`);
  });

  it("signD2 signs exactly raw32 for byte and lowercase hex inputs", async () => {
    const hash = randomBytes(32);
    const before = Buffer.from(hash);
    const signature = signatureBytes(await key.signD2(hash));
    expect(verify(null, hash, devicePublicKey(), signature)).toBe(true);
    expect(await key.signD2(`0x${hash.toString("hex")}`)).toBe(`0x${signature.toString("hex")}`);
    expect(hash.equals(before)).toBe(true);
    expect(await key.signD2.call(null, hash)).toBe(`0x${signature.toString("hex")}`);
  });

  it("D2, delegation and LO-EV-1 bundle signatures fail cross-protocol verification", async () => {
    const input = delegation();
    const hash = randomBytes(32);
    const preimage = sessionKeyDelegationPreimage(input);
    const bundlePreimage = signingPreimage(`sha256:${hash.toString("hex")}`);
    const d2 = signatureBytes(await key.signD2(hash));
    const delegated = signatureBytes(await key.signDelegation(input));
    const publicKey = devicePublicKey();
    // Positive controls ensure these negatives exercise real signatures and correct keys.
    expect(verify(null, hash, publicKey, d2)).toBe(true);
    expect(verify(null, preimage, publicKey, delegated)).toBe(true);
    expect(verify(null, preimage, publicKey, d2)).toBe(false);
    expect(verify(null, bundlePreimage, publicKey, d2)).toBe(false);
    expect(verify(null, hash, publicKey, delegated)).toBe(false);
    expect(verify(null, bundlePreimage, publicKey, delegated)).toBe(false);
    const bundle = sign(null, bundlePreimage, session.privateKey);
    expect(verify(null, bundlePreimage, session.publicKey, bundle)).toBe(true);
    expect(verify(null, hash, session.publicKey, bundle)).toBe(false);
    expect(verify(null, preimage, session.publicKey, bundle)).toBe(false);
    await closedRefusal(() => key.signD2(preimage), "bad_bytes32");
    await closedRefusal(() => key.signD2(bundlePreimage), "bad_bytes32");
    const registration = Buffer.from(kernelSigningProofMessage("kernel_01"), "utf8");
    expect(registration.length).toBe(32);
    await closedRefusal(() => key.signD2(registration), "forbidden_protocol");
    await closedRefusal(() => key.signD2(`0x${registration.toString("hex")}`), "forbidden_protocol");
    const longerRegistration = Buffer.from(kernelSigningProofMessage("kernel_010"), "utf8");
    expect(longerRegistration.length).toBe(33);
    await closedRefusal(() => key.signD2(longerRegistration), "bad_bytes32");
    await closedRefusal(() => key.signD2(`0x${longerRegistration.toString("hex")}`), "bad_bytes32");
  });

  it.each([8453, 1, 11155111])("loadDeviceKey refuses delegation binding chainId %i", async (chainId) => {
    const invalidBinding = { ...binding, chainId } as DeviceDelegationBinding;
    await closedRefusal(() => loadDeviceKey(keyPath, { now, delegationBinding: invalidBinding }), "bad_binding");
  });

  it.each(["unsupported chain", "malformed operator"] as const)("loadDeviceKey validates %s before reading the key file", async (label) => {
    const invalidBinding = (label === "unsupported chain" ? { ...binding, chainId: 1 }
      : { ...binding, operator: "0x1234" }) as DeviceDelegationBinding;
    await closedRefusal(() => loadDeviceKey(keyPath, { now, delegationBinding: invalidBinding }), "bad_binding");
    await closedRefusal(() => loadDeviceKey(join(directory, "missing-device.json"), { now, delegationBinding: invalidBinding }), "bad_binding");
  });

  it("delegation signing requires a load-time operator binding and snapshots its identity", async () => {
    const unbound = await loadDeviceKey(keyPath, { now });
    await closedRefusal(() => unbound.signDelegation(delegation()), "bad_binding");
    const input = delegation();
    binding.chainId = 31337;
    binding.operator = getAddress(`0x${randomBytes(20).toString("hex")}`);
    expect(verify(null, sessionKeyDelegationPreimage(input), devicePublicKey(), signatureBytes(await key.signDelegation(input)))).toBe(true);
    await closedRefusal(() => key.signDelegation(delegation()), "bad_parent");
  });

  it("delegation on offline anvil binds the exact chain and lowercase operator", async () => {
    binding.chainId = 31337;
    const offline = await loadDeviceKey(keyPath, { now, delegationBinding: binding });
    const input = delegation();
    expect(verify(null, sessionKeyDelegationPreimage(input), devicePublicKey(), signatureBytes(await offline.signDelegation(input)))).toBe(true);
    await closedRefusal(() => key.signDelegation(input), "bad_parent");
  });

  it("delegation snapshots descriptor values once without invoking getters", async () => {
    const input = delegation();
    const changed = delegation();
    changed.scope.contractIds = ["*"];
    let reads = 0;
    const proxy = new Proxy(input, {
      get() { throw new Error("getter must not run"); },
      getOwnPropertyDescriptor(target, property) {
        if (property === "scope") return { configurable: true, enumerable: true, writable: true, value: ++reads === 1 ? input.scope : changed.scope };
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });
    expect(verify(null, sessionKeyDelegationPreimage(input), devicePublicKey(), signatureBytes(await key.signDelegation(proxy)))).toBe(true);
    expect(reads).toBe(1);
  });

  it("copies typed-array subclasses without exposing their accessors or species to signing", async () => {
    class HostileBytes extends Uint8Array {
      get length(): number { throw new Error(seedHex); }
      static get [Symbol.species]() { throw new Error(seedHex); }
    }
    const input = delegation();
    const publicKey = input.publicKey;
    input.publicKey = new HostileBytes(publicKey);
    const delegated = signatureBytes(await key.signDelegation(input));
    expect(verify(null, sessionKeyDelegationPreimage({ ...input, publicKey }), devicePublicKey(), delegated)).toBe(true);
    const hash = randomBytes(32);
    const d2 = signatureBytes(await key.signD2(new HostileBytes(hash)));
    expect(verify(null, hash, devicePublicKey(), d2)).toBe(true);
  });

  it("the fixed MVP actions survive spec defaults changed before module loading", async () => {
    vi.resetModules();
    const spec = await import("@pcc/spec");
    const original = spec.DEFAULT_SESSION_KEY_CONFIG.defaultAllowedActions;
    try {
      spec.DEFAULT_SESSION_KEY_CONFIG.defaultAllowedActions = ["*"] as never;
      const fresh = await import("../src/keys.js");
      const loaded = await fresh.loadDeviceKey(keyPath, { now, delegationBinding: binding });
      const input = delegation();
      input.scope.allowedActions = ["evidence_submit", "workflow_step_complete"];
      expect(verify(null, sessionKeyDelegationPreimage(input), devicePublicKey(), signatureBytes(await loaded.signDelegation(input)))).toBe(true);
      input.scope.allowedActions = ["*"] as never;
      await expect(loaded.signDelegation(input)).rejects.toMatchObject({ code: "bad_scope", message: "bad_scope" });
    } finally {
      spec.DEFAULT_SESSION_KEY_CONFIG.defaultAllowedActions = original;
      vi.resetModules();
    }
  });

  it.each(["fundedAt", "issuedAt", "expiresAt", "reclaimAt", "firstEventAt"] as const)("signDelegation refuses milliseconds in %s with otherwise consistent timing", async (field) => {
    const input = delegation();
    const milliseconds = now.getTime();
    if (field === "fundedAt" || field === "issuedAt") {
      if (field === "fundedAt") input.fundedAt = milliseconds;
      input.issuedAt = milliseconds;
      input.firstEventAt = milliseconds + 1.25;
      input.expiresAt = input.reclaimAt = milliseconds + 86400;
    } else if (field === "expiresAt" || field === "reclaimAt") {
      input.expiresAt = input.reclaimAt = milliseconds;
    } else {
      input.firstEventAt = milliseconds;
    }
    expect(input[field]).toBe(milliseconds);
    expect(input.fundedAt <= input.issuedAt && input.issuedAt <= input.firstEventAt).toBe(true);
    expect(input.expiresAt === input.reclaimAt && input.expiresAt > input.issuedAt).toBe(true);
    await closedRefusal(() => key.signDelegation(input), "bad_time");
  });

  it("signDelegation accepts the lower seconds boundary and refuses an earlier fundedAt", async () => {
    const input = delegation();
    input.fundedAt = input.issuedAt = input.firstEventAt = 1_600_000_000;
    input.expiresAt = input.reclaimAt = 1_600_000_001;
    expect(verify(null, sessionKeyDelegationPreimage(input), devicePublicKey(), signatureBytes(await key.signDelegation(input)))).toBe(true);
    input.fundedAt--;
    await closedRefusal(() => key.signDelegation(input), "bad_time");
  });

  it("signDelegation accepts timestamps below 2^32 and refuses firstEventAt at that boundary", async () => {
    const input = delegation();
    input.fundedAt = input.issuedAt = 2 ** 32 - 2;
    input.firstEventAt = 2 ** 32 - 1.25;
    input.expiresAt = input.reclaimAt = 2 ** 32 - 1;
    expect(verify(null, sessionKeyDelegationPreimage(input), devicePublicKey(), signatureBytes(await key.signDelegation(input)))).toBe(true);
    input.firstEventAt = 2 ** 32;
    await closedRefusal(() => key.signDelegation(input), "bad_time");
  });

  const invalid: Array<[string, string, (input: DelegationInput) => void]> = [
    ["wildcard contractIds", "bad_scope", (input) => { input.scope.contractIds = ["*"]; }],
    ["another job", "bad_scope", (input) => { input.scope.contractIds = ["other-job"]; }],
    ["extra contract", "bad_scope", (input) => { input.scope.contractIds.push("other-job"); }],
    ["empty contracts", "bad_scope", (input) => { input.scope.contractIds = []; }],
    ["unbounded jobId", "bad_job", (input) => { input.jobId = "j".repeat(257); }],
    ["wildcard jobId", "bad_job", (input) => { input.jobId = "*"; input.scope.contractIds = ["*"]; }],
    ["empty jobId", "bad_job", (input) => { input.jobId = ""; }],
    ["empty sessionId", "bad_session", (input) => { input.sessionId = ""; }],
    ["short session public key", "bad_public_key", (input) => { input.publicKey = randomBytes(31); }],
    ["noncanonical session public key", "bad_public_key", (input) => { input.publicKey = Buffer.alloc(32, 255); }],
    ["off-curve session public key", "bad_public_key", (input) => { input.publicKey = Buffer.alloc(32); input.publicKey[0] = 2; }],
    ["small-order session public key", "bad_public_key", (input) => { input.publicKey = Buffer.alloc(32); input.publicKey[0] = 1; }],
    ["negative-zero session public key", "bad_public_key", (input) => { input.publicKey = Buffer.alloc(32); input.publicKey[0] = 1; input.publicKey[31] = 128; }],
    ["hex instead of raw session public key", "bad_public_key", (input) => { input.publicKey = key.signingPublicKey as unknown as Uint8Array; }],
    ["the device public key as session key", "bad_public_key", (input) => { input.publicKey = Buffer.from(key.publicKeyHex, "hex"); }],
    ["wildcard actions", "bad_scope", (input) => { input.scope.allowedActions = ["*"] as never; }],
    ["missing MVP action", "bad_scope", (input) => { input.scope.allowedActions = ["evidence_submit"]; }],
    ["duplicate MVP action", "bad_scope", (input) => { input.scope.allowedActions = ["evidence_submit", "evidence_submit"]; }],
    ["extra action", "bad_scope", (input) => { input.scope.allowedActions.push("heartbeat"); }],
    ["sparse actions", "bad_scope", (input) => { delete input.scope.allowedActions[0]; }],
    ["fractional issuedAt", "bad_time", (input) => { input.issuedAt += 0.5; }],
    ["issuance before funding", "bad_time", (input) => { input.issuedAt--; }],
    ["issuance after first event", "bad_time", (input) => { input.issuedAt += 2; }],
    ["expiry different from reclaimAt", "bad_time", (input) => { input.expiresAt--; }],
    ["expiry equal to issuance", "bad_time", (input) => { input.reclaimAt = input.expiresAt = input.issuedAt; }],
    ["non-finite first event", "bad_time", (input) => { input.firstEventAt = Infinity; }],
    ["zero signatures", "bad_signature_count", (input) => { input.eventCount = input.scope.maxSignatures = 0; }],
    ["fractional signatures", "bad_signature_count", (input) => { input.eventCount = input.scope.maxSignatures = 1.5; }],
    ["more than 1000 signatures", "bad_signature_count", (input) => { input.eventCount = input.scope.maxSignatures = 1001; }],
    ["signatures different from event count", "bad_signature_count", (input) => { input.scope.maxSignatures++; }],
    ["another chain", "bad_parent", (input) => { input.parentAgentId = `eip155:31337:${binding.operator.toLowerCase()}` as DelegationInput["parentAgentId"]; }],
    ["uppercase operator", "bad_parent", (input) => { input.parentAgentId = `eip155:84532:${binding.operator.toUpperCase()}` as never; }],
    ["another operator", "bad_parent", (input) => { input.parentAgentId = `eip155:84532:0x${randomBytes(20).toString("hex")}`; }],
    ["caller preimage", "bad_input", (input) => { Object.assign(input, { preimage: randomBytes(32) }); }],
    ["caller derivationPath", "bad_input", (input) => { Object.assign(input, { derivationPath: "m/1'" }); }],
    ["input accessor", "bad_input", (input) => { Object.defineProperty(input, "scope", { get() { throw new Error(seedHex); }, enumerable: true }); }],
  ];
  it.each(invalid)("signDelegation refuses %s", async (_label, code, mutate) => {
    const input = delegation();
    mutate(input);
    await closedRefusal(() => key.signDelegation(input), code);
  });

  for (const label of ["UTF-8 string", "untagged hex", "uppercase hex", "short bytes", "long bytes", "array", "bundle digest"] as const) {
    it(`signD2 refuses ${label}`, async () => {
      const hash = randomBytes(32);
      const value = label === "UTF-8 string" ? "d".repeat(32) : label === "untagged hex" ? hash.toString("hex")
        : label === "uppercase hex" ? `0x${Buffer.alloc(32, 171).toString("hex").toUpperCase()}`
        : label === "short bytes" ? hash.subarray(0, 31) : label === "long bytes" ? randomBytes(33)
        : label === "array" ? Array.from(hash) : `sha256:${hash.toString("hex")}`;
      await closedRefusal(() => key.signD2(value as Uint8Array | string), "bad_bytes32");
    });
  }

  it("delegation accepts reversed MVP actions and all 1000 counted events", async () => {
    const input = delegation();
    input.scope.allowedActions.reverse();
    input.eventCount = input.scope.maxSignatures = 1000;
    input.jobId = "j".repeat(256);
    input.scope.contractIds = [input.jobId];
    expect(verify(null, sessionKeyDelegationPreimage(input), devicePublicKey(), signatureBytes(await key.signDelegation(input)))).toBe(true);
  });
});
