import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { CsdRegistry } from "./registry.js";
import {
  buildContractRegistrySnapshot,
  computeRegistrySnapshotDigest,
  D2AdapterError,
  DEFAULT_REGISTRY_VERSION,
} from "./registry-contract-adapter.js";
import { canonicalize } from "../util/canonical.js";
import type { CompositionBlock } from "./composition.js";
import type { CSD } from "./schema.js";

/** A minimal schema-valid CSD (M1's test helper); override any field via `over`. */
function csd(url: string, over: Partial<CSD> = {}): CSD {
  return {
    url,
    version: "1.0.0",
    status: "active",
    name: "Test cap",
    description: "a test capability",
    kind: "base",
    baseDefinition: null,
    parameters: [],
    constraints: [],
    pricing: { basePrice: "1.00", currency: "USDC" },
    ...over,
  };
}

/** A COMPLETE, valid composition block (all seven contract fields populated);
 * override any field via `over` (including deleting one to test fail-on-lossy). */
function fullComposition(over: Partial<CompositionBlock> = {}): CompositionBlock {
  return {
    inputPorts: { model: { semanticType: "mesh", required: true } },
    outputPorts: { part: { semanticType: "physical-part", unit: "g", required: true } },
    allowedEffectSignatures: [{ kind: "create-asset", semanticType: "physical-part" }],
    requiredEffects: [{ kind: "create-asset", semanticType: "physical-part" }],
    allowedPreconditionSignatures: [{ kind: "has-type", stateClass: "asset", semanticType: "mesh" }],
    requiredPreconditions: [{ kind: "exists", subject: { kind: "asset", id: "input-model" } }],
    parameters: [{ name: "infill", semanticType: "ratio", required: true }],
    ...over,
  };
}

describe("D2 — registry→contract adapter", () => {
  it("projects an active composable CSD into a contract keyed by capabilityClass", async () => {
    const reg = new CsdRegistry();
    reg.register(csd("pcc://capabilities/fdm/v2", { version: "2.0.0", composition: fullComposition() }));

    const snap = await buildContractRegistrySnapshot(reg);

    expect(Object.keys(snap.contracts)).toEqual(["fdm"]);
    const c = snap.contracts["fdm"]!;
    expect(c.capabilityType).toBe("fdm"); // the class, NOT the url
    expect(c.version).toBe("2.0.0"); // the CSD's version
    expect(c.inputPorts).toEqual({ model: { semanticType: "mesh", required: true } });
    expect(c.outputPorts["part"]!.unit).toBe("g");
    expect(c.allowedEffectSignatures).toHaveLength(1);
    expect(c.requiredEffects).toHaveLength(1);
    expect(snap.registryVersion).toBe(DEFAULT_REGISTRY_VERSION);
  });

  it("honors an explicit registryVersion", async () => {
    const reg = new CsdRegistry();
    reg.register(csd("pcc://capabilities/fdm/v2", { composition: fullComposition() }));
    const snap = await buildContractRegistrySnapshot(reg, { registryVersion: "build-42" });
    expect(snap.registryVersion).toBe("build-42");
  });

  it("omits capabilities with no composition block (the migration story)", async () => {
    const reg = new CsdRegistry();
    reg.register(csd("pcc://capabilities/fdm/v2", { composition: fullComposition() }));
    reg.register(csd("pcc://capabilities/sla/v2")); // no composition → not composable
    const snap = await buildContractRegistrySnapshot(reg);
    expect(Object.keys(snap.contracts)).toEqual(["fdm"]);
  });

  it("omits retired revisions even if they carry a composition block", async () => {
    const reg = new CsdRegistry();
    reg.register(
      csd("pcc://capabilities/fdm/v1", { status: "retired", composition: fullComposition() }),
    );
    const snap = await buildContractRegistrySnapshot(reg);
    expect(Object.keys(snap.contracts)).toEqual([]);
  });

  // FAIL-ON-LOSSY: a present-but-partial block never gets a fabricated field.
  it("fails closed on a present-but-partial composition block, naming the missing field", async () => {
    const reg = new CsdRegistry();
    const partial = fullComposition();
    delete partial.parameters; // block present, one required contract field absent
    reg.register(csd("pcc://capabilities/fdm/v2", { composition: partial }));

    let err: unknown;
    try {
      await buildContractRegistrySnapshot(reg);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(D2AdapterError);
    expect((err as D2AdapterError).code).toBe("D2_LOSSY_COMPOSITION_MAPPING");
    expect((err as Error).message).toMatch(/parameters/); // names the missing field
  });

  // AMBIGUOUS-ACTIVE: two active revisions of one class must not both enter a snapshot.
  it("fails closed when two active composable revisions share a class", async () => {
    const reg = new CsdRegistry();
    reg.register(csd("pcc://capabilities/fdm/v1", { version: "1.0.0", composition: fullComposition() }));
    reg.register(csd("pcc://capabilities/fdm/v2", { version: "2.0.0", composition: fullComposition() }));

    let err: unknown;
    try {
      await buildContractRegistrySnapshot(reg);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(D2AdapterError);
    expect((err as D2AdapterError).code).toBe("D2_DUPLICATE_CAPABILITY_CLASS");
  });

  it("digest is stable and independent of CSD registration order", async () => {
    const a = new CsdRegistry();
    a.register(csd("pcc://capabilities/fdm/v2", { composition: fullComposition() }));
    a.register(csd("pcc://capabilities/cnc/v1", { composition: fullComposition() }));

    const b = new CsdRegistry(); // same content, reversed registration order
    b.register(csd("pcc://capabilities/cnc/v1", { composition: fullComposition() }));
    b.register(csd("pcc://capabilities/fdm/v2", { composition: fullComposition() }));

    const da = await computeRegistrySnapshotDigest(await buildContractRegistrySnapshot(a));
    const db = await computeRegistrySnapshotDigest(await buildContractRegistrySnapshot(b));
    expect(da).toBe(db);
    expect(da).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("digest changes when a contract's content changes", async () => {
    const base = new CsdRegistry();
    base.register(csd("pcc://capabilities/fdm/v2", { composition: fullComposition() }));

    const changed = new CsdRegistry();
    changed.register(
      csd("pcc://capabilities/fdm/v2", {
        // same capability, one param's `required` flipped false → different content
        composition: fullComposition({
          parameters: [{ name: "infill", semanticType: "ratio", required: false }],
        }),
      }),
    );

    const d1 = await computeRegistrySnapshotDigest(await buildContractRegistrySnapshot(base));
    const d2 = await computeRegistrySnapshotDigest(await buildContractRegistrySnapshot(changed));
    expect(d1).not.toBe(d2);
  });
});

// ---------------------------------------------------------------------------
// GOLDEN SERIALIZATION CROSS-CHECK — the money-path-adjacent obligation. Pins
// the exact canonical bytes + digest for a known snapshot, and proves @pcc/spec's
// `canonicalize`/`sha256` agree BYTE-FOR-BYTE with prism's independent
// `canonicalize`/`canonicalHash` (vendored verbatim below from
// prism-orchestrator/src/hash.ts) — so this digest equals what prism commits as
// `registryDigest`, modulo the documented `sha256:` type prefix.
// ---------------------------------------------------------------------------

describe("D2 — golden serialization cross-check (prism registryDigest parity)", () => {
  // VERBATIM copy of prism-orchestrator/src/hash.ts `canonicalize` + `canonicalHash`.
  function prismCanonicalize(value: unknown): string {
    if (value === null) return "null";
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        throw new Error(`canonicalize: non-finite (${value})`);
      }
      return JSON.stringify(value);
    }
    if (typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) {
      return `[${value.map((v) => (v === undefined ? "null" : prismCanonicalize(v))).join(",")}]`;
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((k) => record[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${prismCanonicalize(record[k])}`).join(",")}}`;
  }
  function prismCanonicalHash(value: unknown): string {
    return createHash("sha256").update(prismCanonicalize(value)).digest("hex");
  }

  // The exact composition whose projected contract pins the golden below.
  function goldenComposition(): CompositionBlock {
    return {
      inputPorts: { model: { semanticType: "mesh", required: true } },
      outputPorts: { part: { semanticType: "physical-part", unit: "g", required: true } },
      allowedEffectSignatures: [{ kind: "create-asset", semanticType: "physical-part" }],
      requiredEffects: [{ kind: "create-asset", semanticType: "physical-part" }],
      allowedPreconditionSignatures: [{ kind: "has-type", stateClass: "asset", semanticType: "mesh" }],
      requiredPreconditions: [{ kind: "exists", subject: { kind: "asset", id: "input-model" } }],
      parameters: [
        {
          name: "infill",
          semanticType: "ratio",
          required: true,
          minimum: { value: 0, unit: "mL" },
          maximum: { value: 100, unit: "mL" },
        },
        { name: "draft", semanticType: "flag", required: false, enumValues: [true, false] },
      ],
    };
  }

  // Pinned by scratchpad/golden-compute.mjs, which ran BOTH canonicalizers over
  // this exact snapshot and confirmed BYTE_MATCH + DIGEST_MATCH.
  const GOLDEN_CANONICAL =
    `{"contracts":{"fdm":{"allowedEffectSignatures":[{"kind":"create-asset","semanticType":"physical-part"}],` +
    `"allowedPreconditionSignatures":[{"kind":"has-type","semanticType":"mesh","stateClass":"asset"}],` +
    `"capabilityType":"fdm","inputPorts":{"model":{"required":true,"semanticType":"mesh"}},` +
    `"outputPorts":{"part":{"required":true,"semanticType":"physical-part","unit":"g"}},` +
    `"parameters":[{"maximum":{"unit":"mL","value":100},"minimum":{"unit":"mL","value":0},"name":"infill",` +
    `"required":true,"semanticType":"ratio"},{"enumValues":[true,false],"name":"draft","required":false,` +
    `"semanticType":"flag"}],"requiredEffects":[{"kind":"create-asset","semanticType":"physical-part"}],` +
    `"requiredPreconditions":[{"kind":"exists","subject":{"id":"input-model","kind":"asset"}}],` +
    `"version":"2.0.0"}},"registryVersion":"golden-v1"}`;
  const GOLDEN_BARE_HEX = "4eb376d4274a76028c424a2bcb8007045c0138c8a43264b64c4c247b0607096e";
  const GOLDEN_DIGEST = `sha256:${GOLDEN_BARE_HEX}` as const;

  async function goldenSnapshot() {
    const reg = new CsdRegistry();
    reg.register(csd("pcc://capabilities/fdm/v2", { version: "2.0.0", composition: goldenComposition() }));
    return buildContractRegistrySnapshot(reg, { registryVersion: "golden-v1" });
  }

  it("adapter snapshot canonicalizes to the pinned golden bytes — pcc == prism, byte-identical", async () => {
    const snap = await goldenSnapshot();
    const pccBytes = canonicalize(snap);
    const prismBytes = prismCanonicalize(snap);
    // Two INDEPENDENT canonicalizers over the same object → identical bytes.
    expect(pccBytes).toBe(prismBytes);
    // …and those bytes are exactly the pinned golden (regression lock).
    expect(pccBytes).toBe(GOLDEN_CANONICAL);
  });

  it("adapter snapshot digest equals prism canonicalHash (modulo the sha256: prefix)", async () => {
    const snap = await goldenSnapshot();
    const digest = await computeRegistrySnapshotDigest(snap);
    // @pcc/spec digest == pinned golden.
    expect(digest).toBe(GOLDEN_DIGEST);
    // prism commits the BARE hex as registryDigest; @pcc/spec wraps it as sha256:<hex>.
    // Stripping the documented prefix yields the byte-identical value prism commits.
    expect(digest).toBe(`sha256:${prismCanonicalHash(snap)}`);
    expect(digest.slice("sha256:".length)).toBe(GOLDEN_BARE_HEX);
  });
});
