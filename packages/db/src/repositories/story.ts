import { eq } from "drizzle-orm";
import {
  storyIpRegistrations,
  storyDerivativeLinks,
  storyRoyaltySplits,
  storyRevenueClaims,
} from "../schema/index.js";
import type { StoreDB } from "../connection.js";

export class StoryRepository {
  constructor(private db: StoreDB) {}

  // ── IP Registrations ──────────────────────────────────────────────────────

  insertIpRegistration(reg: typeof storyIpRegistrations.$inferInsert) {
    return this.db.insert(storyIpRegistrations).values(reg).returning().get();
  }

  findIpById(ipId: string) {
    return this.db
      .select()
      .from(storyIpRegistrations)
      .where(eq(storyIpRegistrations.ipId, ipId))
      .get();
  }

  findIpByCapabilityId(capabilityId: string) {
    return this.db
      .select()
      .from(storyIpRegistrations)
      .where(eq(storyIpRegistrations.capabilityId, capabilityId))
      .get();
  }

  listIpRegistrations() {
    return this.db.select().from(storyIpRegistrations).all();
  }

  deleteIpRegistration(ipId: string) {
    return this.db
      .delete(storyIpRegistrations)
      .where(eq(storyIpRegistrations.ipId, ipId))
      .returning()
      .get();
  }

  // ── Derivative Links ──────────────────────────────────────────────────────

  insertDerivativeLink(link: typeof storyDerivativeLinks.$inferInsert) {
    return this.db.insert(storyDerivativeLinks).values(link).returning().get();
  }

  findDerivativeLinkById(id: string) {
    return this.db
      .select()
      .from(storyDerivativeLinks)
      .where(eq(storyDerivativeLinks.id, id))
      .get();
  }

  findDerivativeLinksByParent(parentIpId: string) {
    return this.db
      .select()
      .from(storyDerivativeLinks)
      .where(eq(storyDerivativeLinks.parentIpId, parentIpId))
      .all();
  }

  findDerivativeLinksByChild(childIpId: string) {
    return this.db
      .select()
      .from(storyDerivativeLinks)
      .where(eq(storyDerivativeLinks.childIpId, childIpId))
      .all();
  }

  findDerivativeLinksByJob(jobId: string) {
    return this.db
      .select()
      .from(storyDerivativeLinks)
      .where(eq(storyDerivativeLinks.jobId, jobId))
      .all();
  }

  // ── Royalty Splits ────────────────────────────────────────────────────────

  insertRoyaltySplit(split: typeof storyRoyaltySplits.$inferInsert) {
    return this.db.insert(storyRoyaltySplits).values(split).returning().get();
  }

  findRoyaltySplitsByIp(ipId: string) {
    return this.db
      .select()
      .from(storyRoyaltySplits)
      .where(eq(storyRoyaltySplits.ipId, ipId))
      .all();
  }

  findRoyaltySplitsByAddress(address: string) {
    return this.db
      .select()
      .from(storyRoyaltySplits)
      .where(eq(storyRoyaltySplits.address, address))
      .all();
  }

  deleteRoyaltySplitsByIp(ipId: string) {
    return this.db
      .delete(storyRoyaltySplits)
      .where(eq(storyRoyaltySplits.ipId, ipId))
      .returning()
      .all();
  }

  // ── Revenue Claims ────────────────────────────────────────────────────────

  insertRevenueClaim(claim: typeof storyRevenueClaims.$inferInsert) {
    return this.db.insert(storyRevenueClaims).values(claim).returning().get();
  }

  findRevenueClaimsByIp(ipId: string) {
    return this.db
      .select()
      .from(storyRevenueClaims)
      .where(eq(storyRevenueClaims.ipId, ipId))
      .all();
  }

  findRevenueClaimsByClaimer(claimerAddress: string) {
    return this.db
      .select()
      .from(storyRevenueClaims)
      .where(eq(storyRevenueClaims.claimerAddress, claimerAddress))
      .all();
  }

  listRevenueClaims() {
    return this.db.select().from(storyRevenueClaims).all();
  }
}
