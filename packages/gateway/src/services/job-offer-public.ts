import type { JobOffer, JobOfferEvent } from "./job-offers-store.js";
import type { CourierJob } from "./courier-jobs-store.js";

/** Keys a served job offer never carries, for any caller (N347, N367). */
export const PRIVATE_OFFER_FIELDS = ["posterDid", "driverContact", "idempotencyKey"] as const;
/** Keys a served courier job never carries (N347). */
export const PRIVATE_COURIER_FIELDS = ["postedBy", "driverContact"] as const;
/** The only `by` values a served event keeps; every other value is served as null (N347). */
export const SERVED_EVENT_BY: ReadonlySet<string> = new Set(["poster", "claimer"]);
/** Keys the public view removes, at any depth (N367). */
export const PARTY_ONLY_KEYS: ReadonlySet<string> = new Set(["customer", "deliveryAddress", "raw"]);
/** Keys whose value the public view cuts to its lat and lng, at any depth (N367). */
export const PLACE_KEYS: ReadonlySet<string> = new Set(["pickup", "dropoff"]);
/** Keys under which the public view rounds a finite number and removes any other value, at any depth (N367). */
export const COORDINATE_KEYS: ReadonlySet<string> = new Set(["lat", "lng"]);
/** The deepest level the public view walks; an object or array deeper than this is removed (N367). */
export const PUBLIC_VIEW_MAX_DEPTH = 32;
/** The shared public rounding of a coordinate: 2 decimals, about 1 km (N367; moved from readmodels/operator-work.ts). */
export const coarseCoordinate = (v: number): number => Math.round(v * 100) / 100;

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

function dataProperty(value: unknown): PropertyDescriptor {
  return { value, enumerable: true, writable: true, configurable: true };
}

function publicViewAtDepth(value: unknown, depth: number): unknown {
  if (!isObject(value)) return value;
  let array: boolean;
  try {
    array = Array.isArray(value);
  } catch {
    return {};
  }
  if (array) {
    const result: unknown[] = [];
    let length: number;
    try {
      length = (value as unknown[]).length;
    } catch {
      return result;
    }
    if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) return result;
    for (let index = 0; index < length; index++) {
      let element: unknown;
      try {
        element = (value as unknown[])[index];
      } catch {
        continue;
      }
      if (isObject(element) && depth + 1 > PUBLIC_VIEW_MAX_DEPTH) continue;
      Object.defineProperty(result, String(result.length), dataProperty(publicViewAtDepth(element, depth + 1)));
    }
    return result;
  }

  const result = {};
  let keys: string[];
  try {
    keys = Object.keys(value);
  } catch {
    return result;
  }
  for (const key of keys) {
    if (PARTY_ONLY_KEYS.has(key)) continue;
    let child: unknown;
    try {
      child = (value as Record<string, unknown>)[key];
    } catch {
      continue;
    }
    if (isObject(child) && depth + 1 > PUBLIC_VIEW_MAX_DEPTH) continue;
    if (PLACE_KEYS.has(key)) {
      const place = {};
      try {
        if (isObject(child) && !Array.isArray(child)) {
          for (const coordinate of COORDINATE_KEYS) {
            try {
              if (!Object.prototype.propertyIsEnumerable.call(child, coordinate)) continue;
              const point = (child as Record<string, unknown>)[coordinate];
              if (typeof point === "number" && Number.isFinite(point)) {
                Object.defineProperty(place, coordinate, dataProperty(coarseCoordinate(point)));
              }
            } catch {
              // A coordinate that cannot be read is left out.
            }
          }
        }
      } catch {
        // An unreadable place has no readable coordinates.
      }
      Object.defineProperty(result, key, dataProperty(place));
    } else if (COORDINATE_KEYS.has(key)) {
      if (typeof child === "number" && Number.isFinite(child)) {
        Object.defineProperty(result, key, dataProperty(coarseCoordinate(child)));
      }
    } else {
      Object.defineProperty(result, key, dataProperty(publicViewAtDepth(child, depth + 1)));
    }
  }
  return result;
}

export function publicViewValue(value: unknown): unknown {
  return publicViewAtDepth(value, 0);
}

export function publicOffer(o: JobOffer): Omit<JobOffer, (typeof PRIVATE_OFFER_FIELDS)[number]> {
  const descriptors: Record<PropertyKey, PropertyDescriptor> = Object.getOwnPropertyDescriptors(o);
  for (const key of PRIVATE_OFFER_FIELDS) delete descriptors[key];
  return Object.defineProperties({}, descriptors) as Omit<JobOffer, (typeof PRIVATE_OFFER_FIELDS)[number]>;
}

export function publicCourierJob(j: CourierJob): Omit<CourierJob, (typeof PRIVATE_COURIER_FIELDS)[number]> {
  const descriptors: Record<PropertyKey, PropertyDescriptor> = Object.getOwnPropertyDescriptors(j);
  for (const key of PRIVATE_COURIER_FIELDS) delete descriptors[key];
  return Object.defineProperties({}, descriptors) as Omit<CourierJob, (typeof PRIVATE_COURIER_FIELDS)[number]>;
}

export function publicEvent(e: JobOfferEvent): JobOfferEvent {
  return Object.defineProperties({}, {
    ...Object.getOwnPropertyDescriptors(e),
    by: {
      value: typeof e.by === "string" && SERVED_EVENT_BY.has(e.by) ? e.by : null,
      enumerable: true,
      writable: true,
      configurable: true,
    },
  }) as JobOfferEvent;
}

export function publicEvents(events: readonly JobOfferEvent[]): JobOfferEvent[] {
  return events.map(publicEvent);
}

export function publicViewOffer(o: JobOffer): ReturnType<typeof publicOffer> {
  return Object.defineProperties({}, {
    ...Object.getOwnPropertyDescriptors(publicOffer(o)),
    requirements: dataProperty(publicViewValue(o.requirements)),
  }) as ReturnType<typeof publicOffer>;
}

export function publicViewCourierJob(j: CourierJob): Omit<ReturnType<typeof publicCourierJob>, "raw"> {
  return publicViewValue(publicCourierJob(j)) as Omit<ReturnType<typeof publicCourierJob>, "raw">;
}

export function publicViewEvent(e: JobOfferEvent): JobOfferEvent {
  const descriptors = Object.getOwnPropertyDescriptors(publicEvent(e));
  for (const key of ["before", "after", "payload"] as const) {
    if (Object.prototype.hasOwnProperty.call(e, key)) {
      Object.defineProperty(descriptors, key, dataProperty(dataProperty(publicViewValue(e[key]))));
    }
  }
  return Object.defineProperties({}, descriptors) as JobOfferEvent;
}

export function publicViewEvents(events: readonly JobOfferEvent[]): JobOfferEvent[] {
  return events.map(publicViewEvent);
}
