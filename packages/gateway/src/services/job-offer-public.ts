import type { JobOffer, JobOfferEvent } from "./job-offers-store.js";
import type { CourierJob } from "./courier-jobs-store.js";

/** Keys a served job offer never carries (N347). */
export const PRIVATE_OFFER_FIELDS = ["posterDid", "driverContact"] as const;
/** Keys a served courier job never carries (N347). */
export const PRIVATE_COURIER_FIELDS = ["postedBy", "driverContact"] as const;
/** The only `by` values a served event keeps; every other value is served as null (N347). */
export const SERVED_EVENT_BY: ReadonlySet<string> = new Set(["poster", "claimer"]);

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
