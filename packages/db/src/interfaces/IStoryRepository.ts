import type {
  storyIpRegistrations,
  storyDerivativeLinks,
  storyRoyaltySplits,
  storyRevenueClaims,
} from "../schema/index.js";

export type IpRegistrationRow = typeof storyIpRegistrations.$inferSelect;
export type IpRegistrationInsert = typeof storyIpRegistrations.$inferInsert;
export type DerivativeLinkRow = typeof storyDerivativeLinks.$inferSelect;
export type DerivativeLinkInsert = typeof storyDerivativeLinks.$inferInsert;
export type RoyaltySplitRow = typeof storyRoyaltySplits.$inferSelect;
export type RoyaltySplitInsert = typeof storyRoyaltySplits.$inferInsert;
export type RevenueClaimRow = typeof storyRevenueClaims.$inferSelect;
export type RevenueClaimInsert = typeof storyRevenueClaims.$inferInsert;

export interface IStoryRepository {
  // IP Registrations
  insertIpRegistration(reg: IpRegistrationInsert): IpRegistrationRow | undefined;
  findIpById(ipId: string): IpRegistrationRow | undefined;
  findIpByCapabilityId(capabilityId: string): IpRegistrationRow | undefined;
  listIpRegistrations(): IpRegistrationRow[];
  deleteIpRegistration(ipId: string): IpRegistrationRow | undefined;
  // Derivative Links
  insertDerivativeLink(link: DerivativeLinkInsert): DerivativeLinkRow | undefined;
  findDerivativeLinkById(id: string): DerivativeLinkRow | undefined;
  findDerivativeLinksByParent(parentIpId: string): DerivativeLinkRow[];
  findDerivativeLinksByChild(childIpId: string): DerivativeLinkRow[];
  findDerivativeLinksByJob(jobId: string): DerivativeLinkRow[];
  // Royalty Splits
  insertRoyaltySplit(split: RoyaltySplitInsert): RoyaltySplitRow | undefined;
  findRoyaltySplitsByIp(ipId: string): RoyaltySplitRow[];
  findRoyaltySplitsByAddress(address: string): RoyaltySplitRow[];
  deleteRoyaltySplitsByIp(ipId: string): RoyaltySplitRow[];
  // Revenue Claims
  insertRevenueClaim(claim: RevenueClaimInsert): RevenueClaimRow | undefined;
  findRevenueClaimsByIp(ipId: string): RevenueClaimRow[];
  findRevenueClaimsByClaimer(claimerAddress: string): RevenueClaimRow[];
  listRevenueClaims(): RevenueClaimRow[];
}
