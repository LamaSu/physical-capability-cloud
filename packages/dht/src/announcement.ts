/**
 * Announcement helpers — create, sign, and verify capability announcements.
 *
 * Wraps the crypto functions from @pcc/a2a to produce signed
 * CapabilityAnnouncement objects that can be gossiped across the DHT.
 */

import type {
  CapabilityAnnouncement,
  CapabilitySummary,
  PeerEndpoint,
} from "@pcc/spec";
import { signAnnouncement, verifyAnnouncement } from "@pcc/a2a";

export interface CreateAnnouncementOpts {
  kernelDid: string;
  kernelId: string;
  capabilities: CapabilitySummary[];
  endpoints: PeerEndpoint[];
  /** TTL in seconds (default 300 = 5 minutes) */
  ttlSeconds?: number;
  /** Ed25519 secret key (hex) for signing */
  secretKey: string;
}

/**
 * Create a signed capability announcement ready for broadcast.
 */
export function createAnnouncement(
  opts: CreateAnnouncementOpts,
): CapabilityAnnouncement {
  const unsigned: Omit<CapabilityAnnouncement, "signature"> = {
    kernelDid: opts.kernelDid,
    kernelId: opts.kernelId,
    capabilities: opts.capabilities,
    endpoints: opts.endpoints,
    ttlSeconds: opts.ttlSeconds ?? 300,
    timestamp: new Date().toISOString(),
  };

  const signature = signAnnouncement(unsigned, opts.secretKey);

  return { ...unsigned, signature };
}

/**
 * Verify a capability announcement's signature.
 *
 * @param announcement - The announcement to verify
 * @param publicKey - The Ed25519 public key (hex) of the signing kernel
 * @returns true if the signature is valid
 */
export function verifyAnnouncementSignature(
  announcement: CapabilityAnnouncement,
  publicKey: string,
): boolean {
  return verifyAnnouncement(announcement, publicKey);
}
