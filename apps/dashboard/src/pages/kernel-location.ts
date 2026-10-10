/**
 * How a kernel page describes a site's location (board N68). The gateway shows the operator's
 * exact coordinates and street address only when the operator opted in; otherwise the centre of
 * the site's ~5 km cell, and nothing when no location is known. These labels say which one the
 * page is showing, so an approximate point is never presented as the site itself.
 */
import type { GeoLocation, LocationPrecision } from "../types/dto.js";

export interface SiteLocationFields {
  location?: GeoLocation | null;
  locationPrecision?: LocationPrecision;
  physicalAddress?: string | null;
}

/** One line for the site's location, e.g. "Approximate (within about 5 km): 47.6367, -122.3657". */
export function siteLocationLabel(site: SiteLocationFields): string {
  const point = site.location;
  const precision = site.locationPrecision;
  if (!point || precision === "none") return "Location not set";
  // A malformed point (the gateway's row, not ours) reads as such: never NaN, and never a crash.
  if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return "Location unreadable";
  const coords = `${point.lat.toFixed(4)}, ${point.lng.toFixed(4)}`;
  if (precision === "exact") return `Exact: ${coords}`;
  if (precision === "approximate") return `Approximate (within about 5 km): ${coords}`;
  return `${coords} (precision not reported)`;
}

/** The street address line: the published address, or why there is none. */
export function siteAddressLabel(site: SiteLocationFields): string {
  if (typeof site.physicalAddress === "string" && site.physicalAddress.trim().length > 0) {
    return site.physicalAddress;
  }
  return site.locationPrecision === "exact" ? "No street address on record" : "Street address not published";
}
