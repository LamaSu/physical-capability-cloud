/**
 * Revenue mock data — EMPTY.
 *
 * Revenue data comes from the gateway API. This file exists only
 * for backward compatibility with pages that haven't been migrated yet.
 */

export const mockRevenueKPIs: any = { totalRevenue: 0, activeJobs: 0, successRate: 0, reputationScore: 0, assuranceTier: 0 };
export const mockCapabilityRevenue: any[] = [];
export const mockActiveEscrows: any[] = [];
export const mockDepinReward: any = { epochNumber: 0, pointsEarned: 0, rank: 0, totalOperators: 0, nextClaimIn: "--", treasury: 0 };
export const mockReviews: any[] = [];
export const mockRevenueTimeline: any[] = [];

export type { } from "./mock-revenue-data.js";
