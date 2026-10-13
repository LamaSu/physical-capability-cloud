/**
 * Board N68 (operator item 81): the projection every read uses for a site's location. Coarse by
 * default (the centre of the site's geohash-5 cell, about 5 km across), exact only when the
 * operator opted in, and {0,0} (or any unusable value) as no location.
 */
import { describe, expect, it } from "vitest";
import {
  LOCATION_CELL_PRECISION,
  LOCATION_CELL_RADIUS_METERS,
  geohashBounds,
  geohashCenter,
  geohashEncode,
  locationVisibilityOf,
  publicLocation,
  publicPhysicalAddress,
  storedLocation,
  storedPoint,
} from "../facades/populators/public-location.js";

/** Great-circle distance in metres. */
function metres(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

const SITES = [
  { lat: 47.6204931, lng: -122.3492447 },
  { lat: 40.7128, lng: -74.006 },
  { lat: -33.8688, lng: 151.2093 },
  { lat: 64.1466, lng: -21.9426 },
  { lat: -54.8019, lng: -68.303 },
  { lat: 1.3521, lng: 103.8198 },
  { lat: 89.9, lng: 179.99 },
  { lat: -89.9, lng: -179.99 },
];

describe("geohash (the standard encoding, checked against published vectors)", () => {
  it("encodes the published examples", () => {
    expect(geohashEncode(42.6, -5.6, 5)).toBe("ezs42");
    expect(geohashEncode(57.64911, 10.40744, 11)).toBe("u4pruydqqvj");
  });

  it("decodes ezs42 to the published cell and centre (42.605, -5.603)", () => {
    expect(geohashBounds("ezs42")).toEqual({ latMin: 42.5830078125, latMax: 42.626953125, lngMin: -5.625, lngMax: -5.5810546875 });
    expect(geohashCenter("ezs42")).toEqual({ lat: 42.60498, lng: -5.603027 });
  });

  it("every site lies inside its own cell, and a geohash-5 cell is 0.0439453125° on each side", () => {
    for (const s of SITES) {
      const b = geohashBounds(geohashEncode(s.lat, s.lng, LOCATION_CELL_PRECISION));
      expect(s.lat).toBeGreaterThanOrEqual(b.latMin);
      expect(s.lat).toBeLessThanOrEqual(b.latMax);
      expect(s.lng).toBeGreaterThanOrEqual(b.lngMin);
      expect(s.lng).toBeLessThanOrEqual(b.lngMax);
      expect(b.latMax - b.latMin).toBe(180 / 2 ** 12);
      expect(b.lngMax - b.lngMin).toBe(360 / 2 ** 13);
    }
  });

  it("the stated radius covers a whole cell from its centre (the equator is the worst case)", () => {
    for (const s of [...SITES, { lat: 0.01, lng: 0.01 }]) {
      const cell = geohashEncode(s.lat, s.lng, LOCATION_CELL_PRECISION);
      const b = geohashBounds(cell);
      const c = geohashCenter(cell);
      for (const corner of [
        { lat: b.latMin, lng: b.lngMin },
        { lat: b.latMin, lng: b.lngMax },
        { lat: b.latMax, lng: b.lngMin },
        { lat: b.latMax, lng: b.lngMax },
      ]) {
        expect(metres(c, corner)).toBeLessThan(LOCATION_CELL_RADIUS_METERS);
      }
    }
  });

  it("refuses a character outside the geohash alphabet", () => {
    expect(() => geohashBounds("ezs4a")).toThrow(/not a geohash character/);
  });
});

describe("publicLocation: coarse by default", () => {
  it("shows the centre of the geohash-5 cell, never the site's own point", () => {
    const site = { lat: 47.6204931, lng: -122.3492447 };
    const p = publicLocation(site, "approximate");
    expect(p).toEqual({ location: { lat: 47.614746, lng: -122.365723 }, locationPrecision: "approximate", locationCell: "c22yz" });
    expect(JSON.stringify(p)).not.toContain("47.6204931");
    expect(JSON.stringify(p)).not.toContain("122.3492447");
  });

  it("two different sites in one cell read identically, so the read reveals only the cell", () => {
    const a = publicLocation({ lat: 47.6204931, lng: -122.3492447 }, "approximate");
    const b = publicLocation({ lat: 47.6331, lng: -122.3551 }, "approximate");
    expect(b.locationCell).toBe(a.locationCell);
    expect(b).toEqual(a);
  });

  it("the shown point is within about 3.5 km of the site", () => {
    for (const s of SITES) {
      const p = publicLocation(s, "approximate");
      expect(p.locationPrecision).toBe("approximate");
      expect(metres(p.location!, s)).toBeLessThan(LOCATION_CELL_RADIUS_METERS);
    }
  });

  it("anything but an explicit visibility of \"exact\" in the stored value reads as not opted in", () => {
    for (const stored of [
      { lat: 1, lng: 2 },
      { lat: 1, lng: 2, visibility: "approximate" },
      { lat: 1, lng: 2, visibility: "EXACT" },
      { lat: 1, lng: 2, visibility: true },
      { lat: 1, lng: 2, visibility: ["exact"] },
      "exact",
      null,
      undefined,
    ]) {
      expect(locationVisibilityOf(stored)).toBe("approximate");
    }
    expect(locationVisibilityOf({ lat: 1, lng: 2, visibility: "exact" })).toBe("exact");
  });
});

describe("publicLocation: exact only when the operator opted in", () => {
  it("shows the site's own point and nothing else stored with it", () => {
    const p = publicLocation({ lat: 47.6204931, lng: -122.3492447, visibility: "exact", note: "x" }, "exact");
    expect(p).toEqual({ location: { lat: 47.6204931, lng: -122.3492447 }, locationPrecision: "exact", locationCell: "c22yz" });
  });

  it("the street address appears only for an opted-in site", () => {
    expect(publicPhysicalAddress("1 Canary Lane", "approximate")).toBeNull();
    expect(publicPhysicalAddress("1 Canary Lane", "exact")).toBe("1 Canary Lane");
    expect(publicPhysicalAddress("", "exact")).toBeNull();
    expect(publicPhysicalAddress("   ", "exact")).toBeNull();
    expect(publicPhysicalAddress(undefined, "exact")).toBeNull();
  });

  it("stores the choice inside the location JSON only when opted in", () => {
    expect(storedLocation({ lat: 1.5, lng: 2.5 }, "approximate")).toEqual({ lat: 1.5, lng: 2.5 });
    expect(storedLocation({ lat: 1.5, lng: 2.5 }, "exact")).toEqual({ lat: 1.5, lng: 2.5, visibility: "exact" });
    expect(locationVisibilityOf(storedLocation({ lat: 1.5, lng: 2.5 }, "exact"))).toBe("exact");
  });
});

describe("{0,0} and unusable values read as no location", () => {
  it("{0,0} (and -0) is no location, whatever the visibility", () => {
    for (const visibility of ["approximate", "exact"] as const) {
      expect(publicLocation({ lat: 0, lng: 0 }, visibility)).toEqual({ location: null, locationPrecision: "none", locationCell: null });
      expect(publicLocation({ lat: -0, lng: 0 }, visibility).locationPrecision).toBe("none");
    }
  });

  it("a point on one axis is still a point", () => {
    expect(publicLocation({ lat: 0, lng: 10 }, "approximate").locationPrecision).toBe("approximate");
    expect(publicLocation({ lat: 10, lng: 0 }, "approximate").locationPrecision).toBe("approximate");
  });

  it("strings, missing fields, non-numbers, non-finite and out-of-range values are no location", () => {
    for (const stored of [
      "45 Industrial Rd, Brooklyn",
      null,
      undefined,
      {},
      { lat: 40.7 },
      { lat: "40.7", lng: "-74.0" },
      { lat: Number.NaN, lng: 1 },
      { lat: Number.POSITIVE_INFINITY, lng: 1 },
      { lat: 90.0001, lng: 1 },
      { lat: -91, lng: 1 },
      { lat: 1, lng: 180.5 },
      { lat: 1, lng: -181 },
      [40.7, -74.0],
    ]) {
      expect(storedPoint(stored)).toBeNull();
      expect(publicLocation(stored, "exact")).toEqual({ location: null, locationPrecision: "none", locationCell: null });
    }
  });

  it("the poles and the antimeridian are usable points", () => {
    for (const s of [{ lat: 90, lng: 180 }, { lat: -90, lng: -180 }, { lat: 90, lng: -180 }]) {
      expect(publicLocation(s, "approximate").locationPrecision).toBe("approximate");
    }
  });
});
