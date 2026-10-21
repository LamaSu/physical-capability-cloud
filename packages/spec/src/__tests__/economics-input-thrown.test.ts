import { describe, expect, it } from "vitest";

import {
  clausesFromCompositionManifest,
  splitsFromContributionGraph,
  splitsFromTrainingManifest,
} from "../economics/adapters.js";
import {
  agreementUnitGross,
  netSplitterFor,
  type NetSplitterInput,
} from "../economics/bind.js";
import { compileEconomics, type CompileOptions } from "../economics/compile.js";
import { exampleGuildRepair } from "../economics/examples.js";
import {
  MAX_INPUT_ARRAY_LENGTH,
  MAX_INPUT_DEPTH,
  MAX_INPUT_NODES,
  snapshotJson,
} from "../economics/input.js";
import { licenseHash } from "../economics/kits.js";
import { buildEconomicPreview } from "../economics/preview.js";
import { simulateEconomics } from "../economics/simulate.js";
import {
  verifyAcceptedAgreement,
  type AcceptedAgreementHashes,
} from "../economics/verify.js";

const GENERIC_REASON = "the input could not be read as JSON data";
const GENERIC_REFUSAL = { ok: false, reason: GENERIC_REASON };

type ThrownKind = "T1" | "T2" | "T3" | "C1" | "C2";

const ALL_KINDS: readonly ThrownKind[] = ["T1", "T2", "T3", "C1", "C2"];
const HOSTILE_KINDS: readonly ThrownKind[] = ["T1", "T2", "T3"];

interface ThrownValue {
  value: unknown;
  trapCount: () => number;
}

/**
 * T1: revoked proxy.
 * T2: proxy whose getPrototypeOf throws.
 * T3: counting proxy over {}, with all 13 traps forwarding to Reflect.
 * C1 and C2: existing controls, already refused by the base.
 */
function thrownValue(kind: ThrownKind): ThrownValue {
  const zero = () => 0;

  if (kind === "T1") {
    const r = Proxy.revocable({}, {});
    r.revoke();
    return { value: r.proxy, trapCount: zero };
  }

  if (kind === "T2") {
    return {
      value: new Proxy({}, {
        getPrototypeOf() {
          throw new Error("getPrototypeOf trap was invoked");
        },
      }),
      trapCount: zero,
    };
  }

  if (kind === "T3") {
    let count = 0;

    const handler: ProxyHandler<object> = {
      getPrototypeOf(target) {
        count++;
        return Reflect.getPrototypeOf(target);
      },
      setPrototypeOf(target, prototype) {
        count++;
        return Reflect.setPrototypeOf(target, prototype);
      },
      isExtensible(target) {
        count++;
        return Reflect.isExtensible(target);
      },
      preventExtensions(target) {
        count++;
        return Reflect.preventExtensions(target);
      },
      getOwnPropertyDescriptor(target, property) {
        count++;
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
      defineProperty(target, property, descriptor) {
        count++;
        return Reflect.defineProperty(target, property, descriptor);
      },
      has(target, property) {
        count++;
        return Reflect.has(target, property);
      },
      get(target, property, receiver) {
        count++;
        return Reflect.get(target, property, receiver);
      },
      set(target, property, value, receiver) {
        count++;
        return Reflect.set(target, property, value, receiver);
      },
      deleteProperty(target, property) {
        count++;
        return Reflect.deleteProperty(target, property);
      },
      ownKeys(target) {
        count++;
        return Reflect.ownKeys(target);
      },
      apply(target, thisArg, args) {
        count++;
        return Reflect.apply(target as Function, thisArg, args);
      },
      construct(target, args, newTarget) {
        count++;
        return Reflect.construct(target as Function, args, newTarget);
      },
    };

    return {
      value: new Proxy({}, handler),
      trapCount: () => count,
    };
  }

  if (kind === "C1") {
    return { value: new Error("x"), trapCount: zero };
  }

  return { value: 42, trapCount: zero };
}

interface ThrowSite {
  name: string;
  make: (value: unknown) => unknown;
}

/**
 * Every Proxy operation invoked by snapshotJson's copy:
 * S1: object ownKeys
 * S2: object getOwnPropertyDescriptor
 * S3: object getPrototypeOf
 * S4: array get, specifically length
 * S5: array getOwnPropertyDescriptor, specifically index 0
 */
const SITES: readonly ThrowSite[] = [
  {
    name: "S1 object ownKeys",
    make: (value) => new Proxy({}, {
      ownKeys() {
        throw value;
      },
    }),
  },
  {
    name: "S2 object getOwnPropertyDescriptor",
    make: (value) => new Proxy({ key: 1 }, {
      getOwnPropertyDescriptor() {
        throw value;
      },
    }),
  },
  {
    name: "S3 object getPrototypeOf",
    make: (value) => new Proxy({}, {
      getPrototypeOf() {
        throw value;
      },
    }),
  },
  {
    name: "S4 array get(length)",
    make: (value) => new Proxy([1], {
      get(target, property, receiver) {
        if (property === "length") throw value;
        return Reflect.get(target, property, receiver);
      },
    }),
  },
  {
    name: "S5 array getOwnPropertyDescriptor(0)",
    make: (value) => new Proxy([1], {
      getOwnPropertyDescriptor(target, property) {
        if (property === "0") throw value;
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    }),
  },
];

const ENTRY_SITES = [SITES[0]!, SITES[3]!] as const;

describe("snapshotJson: arbitrary thrown values are never inspected", () => {
  for (const mode of ["default", "canonical"] as const) {
    it(`${mode} mode: T1-T3 and C1-C2 at all five sites return the exact generic refusal`, () => {
      for (const site of SITES) {
        for (const kind of ALL_KINDS) {
          const thrown = thrownValue(kind);
          let actual: unknown;

          expect(() => {
            actual = mode === "canonical"
              ? snapshotJson(site.make(thrown.value), { canonical: true })
              : snapshotJson(site.make(thrown.value));
          }).not.toThrow();

          expect(actual).toEqual(GENERIC_REFUSAL);
          expect(thrown.trapCount()).toBe(0);
        }
      }
    });
  }
});

const zeroHash: `0x${string}` = `0x${"0".repeat(64)}`;

const validAccepted: AcceptedAgreementHashes = {
  agreementHash: zeroHash,
  economicTermsHash: zeroHash,
  rightsTermsHash: zeroHash,
};

// Deliberately invalid: the brief requires the other two fields to be null.
const nullServer = null as unknown as NetSplitterInput["server"];

interface EntryPoint {
  name: string;
  call: (proxy: unknown) => unknown;
}

/**
 * Each call places the S1/S4 proxy directly in the named position.
 * C1 supplies the reference refusal for deep equality.
 */
const ENTRY_POINTS: readonly EntryPoint[] = [
  {
    name: "compileEconomics(input)",
    call: (proxy) => compileEconomics(proxy),
  },
  {
    name: "compileEconomics(options)",
    call: (proxy) =>
      compileEconomics(exampleGuildRepair(), proxy as CompileOptions),
  },
  {
    name: "clausesFromCompositionManifest(input)",
    call: (proxy) =>
      clausesFromCompositionManifest(
        proxy as Parameters<typeof clausesFromCompositionManifest>[0],
      ),
  },
  {
    name: "splitsFromTrainingManifest(input)",
    call: (proxy) =>
      splitsFromTrainingManifest(
        proxy as Parameters<typeof splitsFromTrainingManifest>[0],
        "p",
      ),
  },
  {
    name: "splitsFromContributionGraph(graphInput)",
    call: (proxy) => splitsFromContributionGraph(proxy, new Set(), "p"),
  },
  {
    name: "licenseHash(license)",
    call: (proxy) => licenseHash(proxy),
  },
  {
    name: "agreementUnitGross(agreement)",
    call: (proxy) => agreementUnitGross(proxy),
  },
  {
    name: "netSplitterFor(server)",
    call: (proxy) =>
      netSplitterFor({
        server: proxy as NetSplitterInput["server"],
        accepted: null,
        agreement: null,
      })([]),
  },
  {
    name: "netSplitterFor(accepted)",
    call: (proxy) =>
      netSplitterFor({
        server: nullServer,
        accepted: proxy as NetSplitterInput["accepted"],
        agreement: null,
      })([]),
  },
  {
    name: "netSplitterFor(agreement)",
    call: (proxy) =>
      netSplitterFor({
        server: nullServer,
        accepted: null,
        agreement: proxy,
      })([]),
  },
  {
    name: "buildEconomicPreview(input)",
    call: (proxy) =>
      buildEconomicPreview(
        proxy,
        compileEconomics(proxy),
        { feeVerified: true },
      ),
  },
  {
    name: "simulateEconomics(agreement)",
    call: (proxy) => simulateEconomics(proxy, []),
  },
  {
    name: "simulateEconomics(scenarios)",
    call: (proxy) =>
      simulateEconomics(
        exampleGuildRepair(),
        proxy as readonly unknown[],
      ),
  },
  {
    name: "verifyAcceptedAgreement(accepted)",
    call: (proxy) =>
      verifyAcceptedAgreement(
        proxy as AcceptedAgreementHashes,
        exampleGuildRepair(),
      ),
  },
  {
    name: "verifyAcceptedAgreement(agreement)",
    call: (proxy) =>
      verifyAcceptedAgreement(validAccepted, proxy),
  },
];

describe("economics entry points: hostile thrown values become refusals", () => {
  for (const entry of ENTRY_POINTS) {
    it(`${entry.name}: T1-T3 at S1 and S4 match C1 without invoking thrown-value traps`, () => {
      for (const site of ENTRY_SITES) {
        const control = thrownValue("C1");
        const expected = entry.call(site.make(control.value));

        for (const kind of HOSTILE_KINDS) {
          const hostile = thrownValue(kind);
          let actual: unknown;

          expect(() => {
            actual = entry.call(site.make(hostile.value));
          }).not.toThrow();

          expect(hostile.trapCount()).toBe(0);
          expect(actual).toEqual(expected);
        }
      }
    });
  }
});

describe("snapshotJson: module-authored refusal messages are preserved", () => {
  it("retains specific NotPlainData reasons rather than replacing them with the generic refusal", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;

    const objectAccessor = Object.defineProperty({}, "secret", {
      enumerable: true,
      get() {
        throw new Error("object accessor must not run");
      },
    });

    const arrayAccessor = [1];
    Object.defineProperty(arrayAccessor, "0", {
      enumerable: true,
      configurable: true,
      get() {
        throw new Error("array accessor must not run");
      },
    });

    let tooDeep: unknown = {};
    for (let i = 0; i < MAX_INPUT_DEPTH; i++) {
      tooDeep = [tooDeep];
    }

    const cases: Array<{
      name: string;
      value: unknown;
      reason: string;
      canonical?: boolean;
    }> = [
      {
        name: "undefined",
        value: undefined,
        reason: "input is a undefined, not JSON data",
      },
      {
        name: "bigint",
        value: 1n,
        reason: "input is a bigint, not JSON data",
      },
      {
        name: "function",
        value: () => 1,
        reason: "input is a function, not JSON data",
      },
      {
        name: "canonical unsafe number",
        value: 2 ** 53,
        canonical: true,
        reason: "input is 9007199254740992, a number the canonical form cannot write (send it as a decimal string)",
      },
      {
        name: "canonical nonfinite number",
        value: Infinity,
        canonical: true,
        reason: "input is Infinity, a number the canonical form cannot write (send it as a decimal string)",
      },
      {
        name: "non-plain prototype",
        value: new Date(0),
        reason: "input is not a plain object",
      },
      {
        name: "cycle",
        value: cycle,
        reason: "input.self contains itself",
      },
      {
        name: "symbol key",
        value: { [Symbol("secret")]: 1 },
        reason: "input has a symbol key",
      },
      {
        name: "object accessor",
        value: objectAccessor,
        reason: "input.secret is an accessor",
      },
      {
        name: "sparse array",
        value: new Array(1),
        reason: "input[0] is a hole",
      },
      {
        name: "array accessor",
        value: arrayAccessor,
        reason: "input[0] is an accessor",
      },
      {
        name: "array length bound",
        value: new Array(MAX_INPUT_ARRAY_LENGTH + 1),
        reason: `input has more than ${MAX_INPUT_ARRAY_LENGTH} entries`,
      },
      {
        name: "depth bound",
        value: tooDeep,
        reason: `input${"[0]".repeat(MAX_INPUT_DEPTH)} nests deeper than ${MAX_INPUT_DEPTH}`,
      },
    ];

    for (const sample of cases) {
      const actual = sample.canonical
        ? snapshotJson(sample.value, { canonical: true })
        : snapshotJson(sample.value);

      expect(actual).toEqual({
        ok: false,
        reason: sample.reason,
      });
    }
  });

  it("retains the exact node-budget refusal", () => {
    // Reuse one dense array to exceed the node count without
    // allocating a million distinct values in the fixture.
    const leaf = new Array(MAX_INPUT_ARRAY_LENGTH).fill(null);
    const many = new Array(16).fill(leaf);

    expect(snapshotJson(many)).toEqual({
      ok: false,
      reason: `more than ${MAX_INPUT_NODES} values`,
    });
  });
});
