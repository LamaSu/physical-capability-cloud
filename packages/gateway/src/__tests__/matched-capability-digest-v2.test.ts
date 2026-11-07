/**
 * Board N20: the matched-capability snapshot digest v2. The byte layout was acked by gateway (#3547).
 * The golden vector is the one in the reconciliation plan (plan-accepted-deal-v3.md, section "N20"),
 * computed there with TS and with an independent Python re-implementation of the canonical rules.
 */
import { describe, it, expect } from "vitest";
import {
  geohash,
  matchedCapabilityDigest,
  matchedCapabilityDigestPreImage,
  matchedCapabilityDigestV2,
  matchedCapabilityDigestV2PreImage,
  type MatchedCapabilitySnapshotV2,
} from "../services/matched-capability-digest.js";

const GOLDEN: MatchedCapabilitySnapshotV2 = {
  capabilityId: "cap-k-print-1-document-print-and-mail",
  capabilityType: "document-print-and-mail",
  kernelId: "k-print-1",
  operatorSettlementAddress: "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01",
  currency: "USDC",
  currencyDecimals: 6,
  priceMinorUnits: 25_000_000n,
  assuranceTiers: [2, 0, 1, 1],
  csd: { url: "pcc://capabilities/document-print-and-mail/v1", contractDigest: `sha256:${"ab".repeat(32)}` },
  measurementProfile: null,
  kernelLocation: { lat: 40.7128, lng: -74.006 },
};

const GOLDEN_BYTES =
  '{"assuranceTiers":[0,1,2],"capabilityId":"cap-k-print-1-document-print-and-mail","capabilityType":"document-print-and-mail",' +
  '"csd":{"contractDigest":"sha256:abababababababababababababababababababababababababababababababab","url":"pcc://capabilities/document-print-and-mail/v1"},' +
  '"currency":"USDC","currencyDecimals":"6","domain":"PCC:matched-capability:v2","kernelId":"k-print-1","kernelLocationGeohash6":"dr5reg",' +
  '"measurementProfile":null,"operatorSettlementAddress":"0xabcdef0123456789abcdef0123456789abcdef01","priceMinorUnits":"25000000"}';
const GOLDEN_DIGEST = "0x7558a7e581e369241ac072f29f0b60a4d6d6e1de757180f12fa7750e969d29bf";

const v2 = (change: Record<string, unknown>) => matchedCapabilityDigestV2({ ...GOLDEN, ...change } as MatchedCapabilitySnapshotV2);

describe("matched-capability digest v2 (board N20)", () => {
  it("reproduces the golden vector byte for byte", () => {
    expect(matchedCapabilityDigestV2PreImage(GOLDEN)).toBe(GOLDEN_BYTES);
    expect(Buffer.byteLength(GOLDEN_BYTES, "utf8")).toBe(540);
    expect(matchedCapabilityDigestV2(GOLDEN)).toBe(GOLDEN_DIGEST);
  });

  it("geohash: known cells, the >= boundary rule, and a value that is not a location throws", () => {
    expect(geohash(40.7128, -74.006, 6)).toBe("dr5reg");
    expect(geohash(-33.8688, 151.2093, 6)).toBe("r3gx2f");
    expect(geohash(0, 0, 6)).toBe("s00000"); // exactly on both midpoints: >= takes the upper halves
    expect(geohash(90, 180, 6)).toBe("zzzzzz");
    expect(geohash(-90, -180, 6)).toBe("000000");
    for (const [lat, lng] of [[91, 0], [-91, 0], [0, 181], [0, -181], [Number.NaN, 0], [0, Number.POSITIVE_INFINITY]]) {
      expect(() => geohash(lat!, lng!, 6)).toThrow(TypeError);
    }
    expect(() => geohash(0, 0, 0)).toThrow(TypeError);
    expect(() => geohash(0, 0, 13)).toThrow(TypeError);
  });

  it("every included value moves the digest (N20's negative: changing any one of them changes it)", () => {
    const withProfile = { measurementProfile: { id: "prof-1", version: "1" } };
    const variants: Array<[string, Record<string, unknown>]> = [
      ["capabilityId", { capabilityId: "cap-other" }],
      ["capabilityType", { capabilityType: "document-print" }],
      ["kernelId", { kernelId: "k-print-2" }],
      ["operatorSettlementAddress", { operatorSettlementAddress: `0x${"12".repeat(20)}` }],
      ["currency", { currency: "USDT" }],
      ["currencyDecimals", { currencyDecimals: 18 }],
      ["priceMinorUnits", { priceMinorUnits: 25_000_001n }],
      ["a tier added", { assuranceTiers: [0, 1, 2, 3] }],
      ["a tier removed", { assuranceTiers: [0, 1] }],
      ["the csd url alone", { csd: { ...GOLDEN.csd, url: "pcc://capabilities/document-print-and-mail/v2" } }],
      ["the csd content digest alone", { csd: { ...GOLDEN.csd, contractDigest: `sha256:${"cd".repeat(32)}` } }],
      ["a profile set", withProfile],
      ["the profile id", { measurementProfile: { id: "prof-2", version: "1" } }],
      ["the profile version", { measurementProfile: { id: "prof-1", version: "2" } }],
      ["the kernel moved to another cell", { kernelLocation: { lat: 40.73, lng: -74.006 } }],
    ];
    expect(geohash(40.73, -74.006, 6)).not.toBe("dr5reg");
    const seen = new Map<string, string>([[matchedCapabilityDigestV2(GOLDEN), "golden"]]);
    for (const [name, change] of variants) {
      const d = v2(change);
      expect(seen.get(d), `${name} collides with ${seen.get(d)}`).toBeUndefined();
      seen.set(d, name);
    }
  });

  it("normalizes: address case, tier order and duplicates, and digest hex case give one digest", () => {
    expect(v2({ operatorSettlementAddress: GOLDEN.operatorSettlementAddress.toLowerCase() })).toBe(GOLDEN_DIGEST);
    expect(v2({ assuranceTiers: [0, 1, 2] })).toBe(GOLDEN_DIGEST);
    expect(v2({ assuranceTiers: [1, 2, 0, 2, 1] })).toBe(GOLDEN_DIGEST);
    expect(v2({ csd: { ...GOLDEN.csd, contractDigest: `sha256:${"AB".repeat(32)}` } })).toBe(GOLDEN_DIGEST);
  });

  it("a move inside one geohash cell does not change the digest", () => {
    expect(geohash(40.713, -74.0061, 6)).toBe("dr5reg");
    expect(v2({ kernelLocation: { lat: 40.713, lng: -74.0061 } })).toBe(GOLDEN_DIGEST);
  });

  it("nothing outside the 12 keys reaches the commitment", () => {
    expect(v2({ name: "renamed", tags: ["x"], materials: ["paper"], tenantId: "t-1", availability: { online: false }, score: 0.2 })).toBe(GOLDEN_DIGEST);
  });

  it("fails closed: every value that breaks its rule throws, and nothing is coerced", () => {
    const bad: Array<[string, Record<string, unknown>]> = [
      ["empty capabilityId", { capabilityId: "" }],
      ["capabilityId with a space", { capabilityId: "cap one" }],
      ["non-ASCII capabilityId", { capabilityId: "cap-é" }],
      ["129-character capabilityId", { capabilityId: "c".repeat(129) }],
      ["empty capabilityType", { capabilityType: "" }],
      ["numeric kernelId", { kernelId: 5 }],
      ["short address", { operatorSettlementAddress: "0x123" }],
      ["address without 0x", { operatorSettlementAddress: "ab".repeat(20) }],
      ["zero address", { operatorSettlementAddress: `0x${"0".repeat(40)}` }],
      ["an email-owned operator", { operatorSettlementAddress: "ops@example.com" }],
      ["empty currency", { currency: "" }],
      ["currency with a space", { currency: "US DC" }],
      ["17-character currency", { currency: "U".repeat(17) }],
      ["fractional decimals", { currencyDecimals: 6.5 }],
      ["negative decimals", { currencyDecimals: -1 }],
      ["decimals over 36", { currencyDecimals: 37 }],
      ["decimals as a string", { currencyDecimals: "6" }],
      ["zero price", { priceMinorUnits: 0n }],
      ["negative price", { priceMinorUnits: -1n }],
      ["price over 2^128 - 1", { priceMinorUnits: 1n << 128n }],
      ["price as a number", { priceMinorUnits: 25_000_000 }],
      ["price as a string", { priceMinorUnits: "25000000" }],
      ["no tiers", { assuranceTiers: [] }],
      ["tier 4", { assuranceTiers: [4] }],
      ["tier -1", { assuranceTiers: [-1] }],
      ["a tier as a string", { assuranceTiers: ["1"] }],
      ["a fractional tier", { assuranceTiers: [1.5] }],
      ["tiers as a string", { assuranceTiers: "0,1" }],
      ["17 tier entries", { assuranceTiers: new Array(17).fill(0) }],
      ["no csd", { csd: null }],
      ["an unversioned csd url", { csd: { ...GOLDEN.csd, url: "pcc://capabilities/document-print-and-mail" } }],
      ["a foreign csd url", { csd: { ...GOLDEN.csd, url: "https://example.com/csd/v1" } }],
      ["a short content digest", { csd: { ...GOLDEN.csd, contractDigest: "sha256:abc" } }],
      ["a 0x content digest", { csd: { ...GOLDEN.csd, contractDigest: `0x${"ab".repeat(32)}` } }],
      ["an undefined profile (must be explicit null)", { measurementProfile: undefined }],
      ["a profile with an empty id", { measurementProfile: { id: "", version: "1" } }],
      ["a profile with an empty version", { measurementProfile: { id: "p", version: "" } }],
      ["latitude 91", { kernelLocation: { lat: 91, lng: 0 } }],
      ["longitude 181", { kernelLocation: { lat: 0, lng: 181 } }],
      ["NaN latitude", { kernelLocation: { lat: Number.NaN, lng: 0 } }],
      ["latitude as a string", { kernelLocation: { lat: "40", lng: 0 } }],
    ];
    for (const [name, change] of bad) {
      expect(() => v2(change), name).toThrow(TypeError);
    }
  });

  it("v1 is unchanged and never equals v2", () => {
    const v1 = matchedCapabilityDigest({
      capabilityId: GOLDEN.capabilityId,
      capabilityType: GOLDEN.capabilityType,
      kernelId: GOLDEN.kernelId,
      price: 25,
      currency: "USDC",
      assuranceTiers: [0, 1, 2],
    });
    expect(v1).toMatch(/^0x[0-9a-f]{64}$/);
    expect(v1).not.toBe(GOLDEN_DIGEST);
  });

  it("rejects_empty_or_substituted_tier_iteration", () => {
    // A substituted iterator that yields nothing must not silently hash an
    // empty tier set (board N20 follow-up #440-A).
    const emptyIterator = [0];
    emptyIterator[Symbol.iterator] = function* () {};
    expect(() => v2({ assuranceTiers: emptyIterator })).toThrow(TypeError);

    // The real element (99) is invalid; a substituted iterator must not be
    // able to launder it into a different, valid-looking value (3) either.
    const fakeIterator = [99];
    fakeIterator[Symbol.iterator] = function* () {
      yield 3;
    };
    expect(() => v2({ assuranceTiers: fakeIterator })).toThrow(TypeError);
  });

  it("a tier list whose length reads as zero or negative never commits an empty tier set (astra, #440 follow-up confirmation)", () => {
    for (const length of [-1, -16, 0]) {
      const tiers = new Proxy([0], {
        get(target, key, receiver) {
          return key === "length" ? length : Reflect.get(target, key, receiver);
        },
      });
      expect(() => v2({ assuranceTiers: tiers }), `length ${length}`).toThrow(TypeError);
    }
  });

  it("pins existing behavior: an ordinary sparse tier array throws (a hole, not skipped)", () => {
    const sparse: number[] = [0, , 2];
    expect(() => v2({ assuranceTiers: sparse })).toThrow(TypeError);
  });

  it("pins existing behavior: a NaN tier throws", () => {
    expect(() => v2({ assuranceTiers: [Number.NaN] })).toThrow(TypeError);
  });

  it("pins existing behavior: -0 normalizes to 0 in assuranceTiers", () => {
    expect(v2({ assuranceTiers: [-0, 1, 2, 2] })).toBe(GOLDEN_DIGEST);
  });

  it("pins existing behavior: an identifier cannot break out of its JSON string to forge another key", () => {
    const injected = 'x","capabilityType":"forged';
    const preimage = matchedCapabilityDigestV2PreImage({ ...GOLDEN, capabilityId: injected });
    const parsed = JSON.parse(preimage) as { capabilityId: string; capabilityType: string };
    expect(parsed.capabilityId).toBe(injected);
    expect(parsed.capabilityType).toBe(GOLDEN.capabilityType);
    expect(() => matchedCapabilityDigestV2({ ...GOLDEN, capabilityId: injected })).not.toThrow();
  });

  it("pins existing behavior: a trailing slash in the CSD url throws; a query string without another slash is accepted literally", () => {
    expect(() =>
      v2({ csd: { ...GOLDEN.csd, url: "pcc://capabilities/document-print-and-mail/v1/" } }),
    ).toThrow(TypeError);

    const withQuery = "pcc://capabilities/document-print-and-mail/v1?rev=2";
    const preimage = matchedCapabilityDigestV2PreImage({ ...GOLDEN, csd: { ...GOLDEN.csd, url: withQuery } });
    expect((JSON.parse(preimage) as { csd: { url: string } }).csd.url).toBe(withQuery);
  });

  it("pins_v1_preimage_and_digest_to_base_vector", () => {
    // Computed from the v1 implementation as it is at this revision (v1 is
    // untouched by #440) -- pins exact bytes so a future change to v1's
    // preimage or price precision is caught here, not just by a shape
    // check against v2 (board N20 follow-up #440-B).
    const fixture = {
      capabilityId: "cap-v1-pin-fixture",
      capabilityType: "wood-fired-pizza",
      kernelId: "kernel-v1-pin",
      price: 12.5,
      currency: "USDC",
      assuranceTiers: [1, 0],
    };
    const expectedPreImage =
      '{"assuranceTiers":[0,1],"capabilityId":"cap-v1-pin-fixture","capabilityType":"wood-fired-pizza",' +
      '"currency":"USDC","kernelId":"kernel-v1-pin","price":"12.50"}';
    const expectedDigest = "0x3f07c6dd4d7242f19d067c576532eaf8376371c6952c723c9092f587fe29c5d2";

    expect(matchedCapabilityDigestPreImage(fixture)).toBe(expectedPreImage);
    expect(Buffer.byteLength(expectedPreImage, "utf8")).toBe(157);
    expect(matchedCapabilityDigest(fixture)).toBe(expectedDigest);
  });
});

describe("matched-capability digest v2 — kernel location (board N20 round 2, #3603)", () => {
  const NULL_LOCATION_PRE =
    '{"assuranceTiers":[0,1,2],"capabilityId":"cap-k-print-1-document-print-and-mail","capabilityType":"document-print-and-mail",' +
    '"csd":{"contractDigest":"sha256:abababababababababababababababababababababababababababababababab","url":"pcc://capabilities/document-print-and-mail/v1"},' +
    '"currency":"USDC","currencyDecimals":"6","domain":"PCC:matched-capability:v2","kernelId":"k-print-1","kernelLocationGeohash6":null,' +
    '"measurementProfile":null,"operatorSettlementAddress":"0xabcdef0123456789abcdef0123456789abcdef01","priceMinorUnits":"25000000"}';
  const NULL_LOCATION_DIGEST = "0xfacd369395f056b2ca426c49fff8706146d0ff4bac212bd5c4990e5b72c71925";

  it("an exact {lat:0,lng:0} counts as NO location, and encodes identically to null/absent", () => {
    expect(matchedCapabilityDigestV2PreImage({ ...GOLDEN, kernelLocation: null })).toBe(NULL_LOCATION_PRE);
    expect(Buffer.byteLength(NULL_LOCATION_PRE, "utf8")).toBe(536);

    const nullDigest = v2({ kernelLocation: null });
    const originDigest = v2({ kernelLocation: { lat: 0, lng: 0 } });
    const absent: MatchedCapabilitySnapshotV2 = { ...GOLDEN };
    delete absent.kernelLocation;
    const absentDigest = matchedCapabilityDigestV2(absent);

    expect(nullDigest).toBe(NULL_LOCATION_DIGEST);
    expect(originDigest).toBe(NULL_LOCATION_DIGEST);
    expect(absentDigest).toBe(NULL_LOCATION_DIGEST);
  });

  it("the existing 540-byte real-location golden is unchanged", () => {
    expect(matchedCapabilityDigestV2PreImage(GOLDEN)).toBe(GOLDEN_BYTES);
    expect(Buffer.byteLength(GOLDEN_BYTES, "utf8")).toBe(540);
    expect(matchedCapabilityDigestV2(GOLDEN)).toBe(GOLDEN_DIGEST);
  });

  it("a real on-equator location ({lat:0,lng:45}) is NOT treated as 'no location'", () => {
    const preimage = matchedCapabilityDigestV2PreImage({ ...GOLDEN, kernelLocation: { lat: 0, lng: 45 } });
    const parsed = JSON.parse(preimage) as { kernelLocationGeohash6: string | null };
    expect(parsed.kernelLocationGeohash6).not.toBeNull();
    expect(parsed.kernelLocationGeohash6).toBe(geohash(0, 45, 6));
    expect(matchedCapabilityDigestV2({ ...GOLDEN, kernelLocation: { lat: 0, lng: 45 } })).not.toBe(
      NULL_LOCATION_DIGEST,
    );
  });
});
