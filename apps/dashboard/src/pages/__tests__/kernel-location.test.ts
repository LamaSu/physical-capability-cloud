/**
 * Board N68: the kernel pages say which location they show. An approximate point (the centre of
 * the site's ~5 km cell) is never presented as the site, and a missing one reads as not set.
 */
import { describe, expect, it } from "vitest";
import { siteAddressLabel, siteLocationLabel } from "../kernel-location.js";

describe("siteLocationLabel", () => {
  it("names an approximate point as approximate", () => {
    expect(siteLocationLabel({ location: { lat: 47.614746, lng: -122.365723 }, locationPrecision: "approximate" })).toBe(
      "Approximate (within about 5 km): 47.6147, -122.3657",
    );
  });

  it("names an opted-in point as exact", () => {
    expect(siteLocationLabel({ location: { lat: 47.6204931, lng: -122.3492447 }, locationPrecision: "exact" })).toBe(
      "Exact: 47.6205, -122.3492",
    );
  });

  it("no location, or precision none, reads as not set (never as 0,0)", () => {
    expect(siteLocationLabel({ location: null, locationPrecision: "none" })).toBe("Location not set");
    expect(siteLocationLabel({ location: { lat: 1, lng: 2 }, locationPrecision: "none" })).toBe("Location not set");
    expect(siteLocationLabel({})).toBe("Location not set");
  });

  it("a point without a precision says so rather than guessing", () => {
    expect(siteLocationLabel({ location: { lat: 1, lng: 2 } })).toBe("1.0000, 2.0000 (precision not reported)");
  });
});

describe("siteAddressLabel", () => {
  it("shows a published address", () => {
    expect(siteAddressLabel({ physicalAddress: "1 Canary Lane", locationPrecision: "exact" })).toBe("1 Canary Lane");
  });

  it("says why there is none", () => {
    expect(siteAddressLabel({ physicalAddress: null, locationPrecision: "approximate" })).toBe("Street address not published");
    expect(siteAddressLabel({ physicalAddress: null, locationPrecision: "exact" })).toBe("No street address on record");
    expect(siteAddressLabel({ physicalAddress: "  ", locationPrecision: "exact" })).toBe("No street address on record");
  });
});
