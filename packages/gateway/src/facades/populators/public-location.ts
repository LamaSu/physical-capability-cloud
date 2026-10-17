/**
 * What a read shows of a site's location (board N68, operator item 81, decided 2026-09-29).
 *
 * A kernel's stored location is the operator's exact site; for a home-based operator that is
 * where they live. So every read shows it COARSE by default: the centre of the site's geohash-5
 * cell, about 5 km across, and never the site's own coordinates. Two sites in one cell read
 * identically. The exact coordinates and the street address appear only when the operator opted
 * in (a public storefront). A missing, invalid or {0,0} location (the placeholder a registration
 * without coordinates gets) reads as no location.
 *
 * The opt-in is stored inside the kernel's `location` JSON as `visibility: "exact"`, so no column
 * is added. Anything else there (absent, another value, another type) reads as not opted in. A
 * capability's location follows its kernel's choice.
 *
 * The geohash is the standard public-domain encoding (base32, bits interleaved starting with
 * longitude), written here from its definition.
 */

import type { GeoLocation } from "@pcc/spec";
import type { LocationPrecision, LocationVisibility } from "../types.js";

/** geohash-5: 0.0439° of latitude by 0.0439° of longitude, about 4.9 km by 4.9 km at the equator. */
export const LOCATION_CELL_PRECISION = 5;

/**
 * A radius in metres that covers any geohash-5 cell from its centre: the half-diagonal is at most
 * about 3.46 km (at the equator; cells narrow toward the poles).
 */
export const LOCATION_CELL_RADIUS_METERS = 3500;

const BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";

/** The geohash cell of `precision` characters that contains the point. */
export function geohashEncode(lat: number, lng: number, precision: number): string {
  let latMin = -90;
  let latMax = 90;
  let lngMin = -180;
  let lngMax = 180;
  let hash = "";
  let bits = 0;
  let value = 0;
  let lngBit = true;
  while (hash.length < precision) {
    if (lngBit) {
      const mid = (lngMin + lngMax) / 2;
      if (lng >= mid) {
        value = value * 2 + 1;
        lngMin = mid;
      } else {
        value = value * 2;
        lngMax = mid;
      }
    } else {
      const mid = (latMin + latMax) / 2;
      if (lat >= mid) {
        value = value * 2 + 1;
        latMin = mid;
      } else {
        value = value * 2;
        latMax = mid;
      }
    }
    lngBit = !lngBit;
    bits += 1;
    if (bits === 5) {
      hash += BASE32[value];
      bits = 0;
      value = 0;
    }
  }
  return hash;
}

export interface GeohashBounds {
  latMin: number;
  latMax: number;
  lngMin: number;
  lngMax: number;
}

/** The bounds of a geohash cell. Throws on a character outside the geohash alphabet. */
export function geohashBounds(cell: string): GeohashBounds {
  let latMin = -90;
  let latMax = 90;
  let lngMin = -180;
  let lngMax = 180;
  let lngBit = true;
  for (const ch of cell) {
    const value = BASE32.indexOf(ch);
    if (value < 0) throw new Error(`not a geohash character: ${JSON.stringify(ch)}`);
    for (let bit = 4; bit >= 0; bit -= 1) {
      const on = Math.floor(value / 2 ** bit) % 2 === 1;
      if (lngBit) {
        const mid = (lngMin + lngMax) / 2;
        if (on) lngMin = mid;
        else lngMax = mid;
      } else {
        const mid = (latMin + latMax) / 2;
        if (on) latMin = mid;
        else latMax = mid;
      }
      lngBit = !lngBit;
    }
  }
  return { latMin, latMax, lngMin, lngMax };
}

const round6 = (x: number): number => Math.round(x * 1e6) / 1e6;

/** The centre of a geohash cell, rounded to 6 decimals. It depends on the cell alone. */
export function geohashCenter(cell: string): GeoLocation {
  const b = geohashBounds(cell);
  return { lat: round6((b.latMin + b.latMax) / 2), lng: round6((b.lngMin + b.lngMax) / 2) };
}

/**
 * The site's point when the stored value is a usable one: finite numeric `lat` in [-90, 90] and
 * `lng` in [-180, 180], and not the {0,0} placeholder. Anything else (a string, a missing field,
 * NaN, an out-of-range value, {0,0}) is null.
 */
export function storedPoint(stored: unknown): GeoLocation | null {
  if (typeof stored !== "object" || stored === null) return null;
  const { lat, lng } = stored as { lat?: unknown; lng?: unknown };
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  if (lat === 0 && lng === 0) return null;
  return { lat, lng };
}

/** The operator's choice, read from a kernel's stored location: only an explicit "exact" opts in. */
export function locationVisibilityOf(stored: unknown): LocationVisibility {
  if (typeof stored !== "object" || stored === null) return "approximate";
  return (stored as { visibility?: unknown }).visibility === "exact" ? "exact" : "approximate";
}

/** The location fields a read carries. */
export interface PublicLocation {
  /** The operator's exact point (`exact`), the centre of its cell (`approximate`), or null (`none`). */
  location: GeoLocation | null;
  locationPrecision: LocationPrecision;
  /** The geohash-5 cell of the site; null when there is no location. */
  locationCell: string | null;
}

/** Project a stored location for a read, under its kernel's visibility. */
export function publicLocation(stored: unknown, visibility: LocationVisibility): PublicLocation {
  const point = storedPoint(stored);
  if (!point) return { location: null, locationPrecision: "none", locationCell: null };
  const locationCell = geohashEncode(point.lat, point.lng, LOCATION_CELL_PRECISION);
  if (visibility === "exact") return { location: point, locationPrecision: "exact", locationCell };
  return { location: geohashCenter(locationCell), locationPrecision: "approximate", locationCell };
}

/** The street address a read may show: an opted-in kernel's, when it has one; otherwise null. */
export function publicPhysicalAddress(address: unknown, visibility: LocationVisibility): string | null {
  if (visibility !== "exact") return null;
  return typeof address === "string" && address.trim().length > 0 ? address : null;
}

/** What a kernel's `location` column holds: the point, plus `visibility: "exact"` when opted in. */
export type StoredLocation = GeoLocation & { visibility?: "exact" };

/** The value to store for a kernel's location under the operator's choice. */
export function storedLocation(point: GeoLocation, visibility: LocationVisibility): StoredLocation {
  return visibility === "exact"
    ? { lat: point.lat, lng: point.lng, visibility: "exact" }
    : { lat: point.lat, lng: point.lng };
}
