import type { FastifyRequest } from "fastify";
import type { CapabilityRequest } from "@pcc/spec";
import { isAdminCaller } from "../auth/admin-caller.js";

/** Request fields a reply carries, and a PUT body may name, only for the admin (N356). */
export const ADMIN_ONLY_REQUEST_FIELDS = ["requesterEmail", "requesterWallet"] as const;

export function publicRequest(
  request: CapabilityRequest,
): Omit<CapabilityRequest, (typeof ADMIN_ONLY_REQUEST_FIELDS)[number]> {
  const descriptors = Object.getOwnPropertyDescriptors(request);
  for (const field of ADMIN_ONLY_REQUEST_FIELDS) {
    delete descriptors[field];
  }
  return Object.defineProperties({}, descriptors) as Omit<
    CapabilityRequest,
    (typeof ADMIN_ONLY_REQUEST_FIELDS)[number]
  >;
}

export function servedRequest(req: FastifyRequest, request: CapabilityRequest) {
  return isAdminCaller(req) ? request : publicRequest(request);
}

export function namesAdminOnlyRequestField(body: unknown): boolean {
  return typeof body === "object" && body !== null && ADMIN_ONLY_REQUEST_FIELDS.some(
    (field) => Object.prototype.hasOwnProperty.call(body, field),
  );
}
