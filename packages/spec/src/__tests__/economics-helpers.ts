/**
 * Shared fixtures for the economics tests. Not a test file (no `.test.ts`), so vitest does not run it.
 */

import type { EconomicAgreement } from "../economics/types.js";

export const FEE_TREASURY = "0xfee0000000000000000000000000000000000fee";
export const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;

/** Deterministic PRNG (mulberry32) so property tests are reproducible. */
export function prng(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

export function randBigint(rand: () => number, max: bigint): bigint {
  // Uniform-enough for tests: compose from 3 draws of 2^30.
  const x = (BigInt(Math.floor(rand() * 2 ** 30)) << 60n) | (BigInt(Math.floor(rand() * 2 ** 30)) << 30n) | BigInt(Math.floor(rand() * 2 ** 30));
  return max === 0n ? 0n : x % (max + 1n);
}

/** One unit, a buyer and a seller who keeps everything: the smallest valid agreement. */
export function baseAgreement(overrides: Partial<EconomicAgreement> = {}): EconomicAgreement {
  return {
    schema: "pcc.economic-agreement.v1",
    agreementId: "t-agreement",
    version: 1,
    supersedes: null,
    asOf: 1_790_000_000,
    currency: { code: "USDC", decimals: 6 },
    payer: "buyer",
    parties: [
      { partyId: "buyer", label: "Buyer", kind: "person", payTo: a(0xb1) },
      { partyId: "seller", label: "Seller", kind: "person", payTo: a(0x5e) },
    ],
    units: [{ unitRef: "u1", label: "Unit one", gross: "1000000", components: [], measures: [] }],
    splits: [],
    clauses: [
      {
        clauseId: "rest",
        label: "Seller keeps the rest",
        role: "operator",
        to: { party: "seller" },
        subject: null,
        appliesTo: { allUnits: true },
        underLicense: null,
        rule: { kind: "residual" },
      },
    ],
    licenses: [],
    use: {
      commercial: true,
      composite: false,
      resell: false,
      fieldOfUse: "testing",
      region: "US",
      modifies: [],
      outbound: { class: "proprietary", shareAlikeTag: null },
    },
    fee: { feeBps: 235, feeRecipient: FEE_TREASURY },
    terms: { acceptBy: null, changePolicy: "new-version-required" },
    ...overrides,
  };
}

export function clone<T>(x: T): T {
  return structuredClone(x);
}

/** Shuffle a copy of an array with the given PRNG (Fisher–Yates). */
export function shuffled<T>(xs: readonly T[], rand: () => number): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** Deep-shuffle every set-like array in an agreement (order must never matter). */
export function shuffleAgreement(ag: EconomicAgreement, seed: number): EconomicAgreement {
  const rand = prng(seed);
  const x = clone(ag);
  x.parties = shuffled(x.parties, rand);
  x.units = shuffled(x.units, rand).map((u) => ({ ...u, components: shuffled(u.components, rand), measures: shuffled(u.measures, rand) }));
  x.splits = shuffled(x.splits, rand).map((s) => ({ ...s, members: shuffled(s.members, rand) }));
  x.clauses = shuffled(x.clauses, rand).map((c) => ("units" in c.appliesTo ? { ...c, appliesTo: { units: shuffled(c.appliesTo.units, rand) } } : c));
  x.licenses = shuffled(x.licenses, rand).map((l) => ({
    ...l,
    grants: { ...l.grants, fieldsOfUse: shuffled(l.grants.fieldsOfUse, rand), regions: shuffled(l.grants.regions, rand) },
    requires: {
      ...l.requires,
      payments: shuffled(l.requires.payments, rand).map((p) =>
        "distribution" in p.payee ? { ...p, payee: { distribution: shuffled(p.payee.distribution, rand) } } : p,
      ),
    },
  }));
  x.use = { ...x.use, modifies: shuffled(x.use.modifies, rand) };
  // Upper-case some addresses: the canonical form lowercases them.
  x.parties = x.parties.map((p, i) => (i % 2 === 0 && p.payTo !== null ? { ...p, payTo: `0x${p.payTo.slice(2).toUpperCase()}` } : p));
  return x;
}
