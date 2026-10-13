/**
 * astra pack 167 (gpt-5.6-sol, R8 #465 @b74d0c98), CRITICAL: the exported
 * ADAPTER_MANIFEST_DIGEST_PATTERN was a live RegExp, and RegExp.prototype.compile
 * (Annex B) rewrites a RegExp's matcher in place after load, even when the
 * object is frozen. Draft, confirm and compile then accepted any adapter
 * version. Every authoritative format check is now a structural predicate,
 * built from charCodeAt captured at load. No RegExp is retained.
 *
 * This walks everything the R8 modules export, recompiles every RegExp it can
 * reach to ".*", and requires every refusal to hold exactly as before.
 */

import { generateKeyPairSync, sign, verify } from "node:crypto";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import * as operational from "../onboarding/operational-envelope.js";
import * as safety from "../onboarding/safety-envelope.js";
import type { ConfirmedSafetyEnvelope, RegistrationVerifier, SafetyEnvelopeInput, SafetyEnvelopeRegistration } from "../onboarding/safety-envelope.js";

const MANIFEST = `sha256:${"ab".repeat(32)}`;
const REGISTRY = generateKeyPairSync("ed25519");
const verifyRegistry: RegistrationVerifier = (preimage, signature) => verify(null, preimage, REGISTRY.publicKey, signature);

function input(adapterVersion = MANIFEST): SafetyEnvelopeInput {
  return {
    deviceClass: "lab-plate-reader",
    device: { deviceId: "pr-1", adapterType: "generic-http", adapterVersion },
    commandMap: {
      commands: [
        { name: "setIncubation", params: [{ name: "celsius", quantity: "incubation_temperature", unit: "degC" }] },
        { name: "read", params: [{ name: "seconds", quantity: "read_duration", unit: "s" }] },
        { name: "stop", params: [] },
      ],
    },
    intake: {
      limits: [
        { field: "safety.limits", quantity: "incubation_temperature", unit: "degC", min: 20, max: 40 },
        { field: "safety.limits", quantity: "read_duration", unit: "s", min: 1, max: 600 },
        { field: "safety.limits", quantity: "job_duration", unit: "min", min: 1, max: 120 },
      ],
      eStop: { mechanism: "adapter-stop", stopCommand: "stop" },
      supervision: "attended",
      hazards: ["heat"],
      maxCommandsPerMinute: 30,
    },
    references: [],
  };
}

const DECISION = { confirmedBy: "op-1", confirmedAt: "2026-10-03T00:00:00Z" };

function register(c: ConfirmedSafetyEnvelope, envelopeDigest = c.envelopeDigest): SafetyEnvelopeRegistration {
  const statement = { deviceId: c.envelope.device.deviceId, envelopeDigest, registeredAt: "2026-10-03T00:05:00Z" };
  return { ...statement, signature: Buffer.from(sign(null, safety.registrationSigningPreimage(statement), REGISTRY.privateKey)).toString("hex") };
}

/**
 * Every RegExp reachable from the modules' exports, each once. Module
 * namespaces are read through their bindings (vitest serves them as getters);
 * below them only own data properties are followed, plus Map and Set entries
 * and a zod object's `_def.shape()`, where zod keeps its fields.
 */
function reachableRegExps(namespaces: object[]): RegExp[] {
  const seen = new Set<unknown>();
  const found: RegExp[] = [];
  const visit = (v: unknown, depth: number): void => {
    if (v === null || (typeof v !== "object" && typeof v !== "function") || seen.has(v) || depth > 60) return;
    seen.add(v);
    if (v instanceof RegExp) {
      found.push(v);
      return;
    }
    if (v instanceof Map) for (const [k, x] of v) (visit(k, depth + 1), visit(x, depth + 1));
    if (v instanceof Set) for (const x of v) visit(x, depth + 1);
    for (const key of Reflect.ownKeys(v)) {
      const d = Reflect.getOwnPropertyDescriptor(v, key);
      if (d && "value" in d) visit(d.value, depth + 1);
    }
    const def = Reflect.getOwnPropertyDescriptor(v, "_def")?.value as { shape?: unknown } | undefined;
    if (def && typeof def.shape === "function") visit((def.shape as () => unknown)(), depth + 1);
  };
  for (const ns of namespaces) for (const key of Reflect.ownKeys(ns)) visit((ns as Record<PropertyKey, unknown>)[key], 0);
  return found;
}

/** The outcome of each authoritative format check: a refusal message, or ACCEPTED. */
function refusals(): string[] {
  const out: string[] = [];
  const attempt = (run: () => unknown) => {
    try {
      run();
      out.push("ACCEPTED");
    } catch (err) {
      out.push((err as Error).message);
    }
  };
  attempt(() => safety.draftSafetyEnvelope(input("not-a-digest")));
  attempt(() => safety.confirmSafetyEnvelope(input("1.0.0"), DECISION));
  const good = safety.confirmSafetyEnvelope(input(), DECISION);
  const forged = structuredClone(good) as unknown as { envelope: { device: { adapterVersion: string } }; envelopeDigest: string };
  forged.envelope.device.adapterVersion = "not-a-digest";
  forged.envelopeDigest = safety.computeSafetyEnvelopeDigest(forged.envelope as unknown as ConfirmedSafetyEnvelope["envelope"]);
  attempt(() => safety.compileSafetyEnvelope(forged as unknown as ConfirmedSafetyEnvelope, register(forged as unknown as ConfirmedSafetyEnvelope), verifyRegistry));
  attempt(() => operational.compileOperationalEnvelope(forged as unknown as ConfirmedSafetyEnvelope, register(forged as unknown as ConfirmedSafetyEnvelope), verifyRegistry));
  attempt(() => safety.compileSafetyEnvelope(good, { ...register(good), envelopeDigest: "0xnot-a-digest" as `0x${string}` }, verifyRegistry));
  attempt(() => safety.registrationSigningPreimage({ deviceId: "pr-1", envelopeDigest: "0x12" as `0x${string}`, registeredAt: "2026-10-03T00:05:00Z" }));
  const runtime = operational.compileOperationalEnvelope(good, register(good), verifyRegistry);
  out.push(String(operational.OperationalEnvelopeV1Schema.safeParse({ ...runtime, adapterVersion: "not-a-digest" }).success));
  out.push(String(operational.OperationalEnvelopeV1Schema.safeParse({ ...runtime, envelopeDigest: "0xnot-a-digest" }).success));
  return out;
}

describe("astra 167 CRITICAL: no RegExp the R8 modules expose can change what they accept", () => {
  it("the walk sees a RegExp inside a zod object's fields (so an empty result below means none)", () => {
    expect(reachableRegExps([{ schema: z.object({ a: z.object({ b: z.string().regex(/x/) }) }) }])).toHaveLength(1);
  });

  it("no RegExp is reachable from anything safety-envelope.ts or operational-envelope.ts exports", () => {
    expect(reachableRegExps([safety, operational]).map((re) => re.source)).toEqual([]);
  });

  it("every format refusal holds after every reachable RegExp is recompiled to match anything", () => {
    const before = refusals();
    expect(before.every((r) => r !== "ACCEPTED" && r !== "true")).toBe(true);
    const regexps = reachableRegExps([safety, operational]);
    const saved = regexps.map((re) => [re, re.source, re.flags] as const);
    let after: string[];
    try {
      for (const re of regexps) {
        try {
          (RegExp.prototype as unknown as { compile: (this: RegExp, p: string) => void }).compile.call(re, ".*");
        } catch {
          // A frozen RegExp throws on its lastIndex write AFTER its matcher is replaced (RegExpInitialize).
        }
      }
      after = refusals();
    } finally {
      for (const [re, source, flags] of saved) {
        try {
          (RegExp.prototype as unknown as { compile: (this: RegExp, p: string, f: string) => void }).compile.call(re, source, flags);
        } catch {
          // as above
        }
      }
    }
    expect(after!).toEqual(before);
  });

  it("astra's recipe: the adapter-manifest check is a function now, and no pattern is exported to recompile", () => {
    expect(Object.keys(safety)).not.toContain("ADAPTER_MANIFEST_DIGEST_PATTERN");
    expect(() => safety.draftSafetyEnvelope(input("not-a-digest"))).toThrow(/adapterVersion must be the adapter's manifest digest/);
    expect(safety.isAdapterManifestDigest(MANIFEST)).toBe(true);
  });

  it("the digest predicates accept exactly the lowercase forms, by length, prefix and every digit", () => {
    const hex = "0123456789abcdef".repeat(4);
    expect(safety.isAdapterManifestDigest(`sha256:${hex}`)).toBe(true);
    expect(safety.isSafetyEnvelopeDigest(`0x${hex}`)).toBe(true);
    const refused: unknown[] = [
      `sha256:${hex.slice(1)}`, `sha256:${hex}0`, `sha256:${hex.slice(0, 63)}A`, `sha256:${hex.slice(0, 63)}g`, `Sha256:${hex}`, `sha256;${hex}`,
      `sha256:${hex.slice(0, 63)}/`, `sha256:${hex.slice(0, 63)}:`, `sha256:${hex.slice(0, 63)}\``, ` sha256:${hex.slice(1)}`, `0x${hex}`, "", undefined, null, 1, ["sha256:" + hex],
    ];
    for (const v of refused) expect(safety.isAdapterManifestDigest(v), String(v)).toBe(false);
    const refusedHex: unknown[] = [`0x${hex.slice(1)}`, `0x${hex}0`, `0X${hex}`, `0x${hex.slice(0, 63)}F`, `00${hex}`, `sha256:${hex}`, "", undefined, 7];
    for (const v of refusedHex) expect(safety.isSafetyEnvelopeDigest(v), String(v)).toBe(false);
  });

  it("a bad digit at any one position, or a changed prefix character, is refused", () => {
    const hex = "0123456789abcdef".repeat(4);
    for (let i = 0; i < 64; i++) {
      const bad = `${hex.slice(0, i)}g${hex.slice(i + 1)}`;
      expect(safety.isAdapterManifestDigest(`sha256:${bad}`), `sha256: position ${i}`).toBe(false);
      expect(safety.isSafetyEnvelopeDigest(`0x${bad}`), `0x position ${i}`).toBe(false);
    }
    for (let i = 0; i < "sha256:".length; i++) {
      expect(safety.isAdapterManifestDigest(`${"sha256:".slice(0, i)}X${"sha256:".slice(i + 1)}${hex}`), `prefix position ${i}`).toBe(false);
    }
  });

  it("a String.prototype.charCodeAt replaced after load cannot pass a digest that is not hex", () => {
    const notHex = `sha256:${"z".repeat(64)}`;
    const notHex0x = `0x${"z".repeat(64)}`;
    const original = Object.getOwnPropertyDescriptor(String.prototype, "charCodeAt")!;
    Object.defineProperty(String.prototype, "charCodeAt", { ...original, value: () => 0x30 });
    let got: boolean[];
    try {
      got = [safety.isAdapterManifestDigest(notHex), safety.isSafetyEnvelopeDigest(notHex0x)];
    } finally {
      Object.defineProperty(String.prototype, "charCodeAt", original);
    }
    expect(got).toEqual([false, false]);
  });
});
