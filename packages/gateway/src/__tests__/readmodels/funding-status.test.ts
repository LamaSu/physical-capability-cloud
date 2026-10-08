/**
 * FundingStatusDTO (buyer funding plan S2.4): a pure projection of a paid scope's row and the
 * verification record that names it. Each state's condition is the doc comment's in
 * readmodels/funding-status.ts. The negatives (neg-dto-...) pin that a state is never funded without
 * the finalized record of this scope and buyer, and that nothing the sources cannot place reads as
 * funded.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  FUNDING_STATES,
  FUNDING_STATUS_SCHEMA_ID,
  fundingStateOf,
  projectFundingStatus,
  type FundingScopeRow,
} from "../../readmodels/funding-status.js";
import type { FundingVerificationRecord } from "../../services/funding-record-port.js";

const BUYER = "0x5555555555555555555555555555555555555555";
const OTHER = "0x6666666666666666666666666666666666666666";
const MINTED = "2026-10-08T12:00:00.000Z";
const WINDOW_END = "2026-10-08T13:00:00.000Z";
const BEFORE_END = "2026-10-08T12:30:00.000Z";

const scope = (over: Partial<FundingScopeRow> = {}): FundingScopeRow => ({
  id: "scope_dto",
  jobId: "job_dto",
  createdBy: BUYER,
  status: "awaiting_funding",
  createdAt: MINTED,
  expiresAt: WINDOW_END,
  ...over,
});
const record = (over: Partial<FundingVerificationRecord> = {}): FundingVerificationRecord => ({
  scopeId: "scope_dto",
  escrowAddress: "0x" + "a1".repeat(20),
  buyer: BUYER,
  chainId: 84532,
  blockNumber: "31337000",
  blockHash: "0x" + "c3".repeat(32),
  verifierVersion: "verifier-test/1",
  verifiedAt: "2026-10-08T12:20:00.000Z",
  finality: "finalized",
  ...over,
});

afterEach(() => {
  vi.useRealTimers();
});

describe("FundingStatusDTO states", () => {
  it("without a record: prepared, awaiting_funding, then expired once the window lapses", () => {
    expect(fundingStateOf(scope({ status: "awaiting_acceptance" }), null, BEFORE_END)).toBe("prepared");
    expect(fundingStateOf(scope(), null, BEFORE_END)).toBe("awaiting_funding");
    expect(fundingStateOf(scope({ status: "awaiting_acceptance" }), null, WINDOW_END)).toBe("expired");
    expect(fundingStateOf(scope(), null, WINDOW_END)).toBe("expired");
  });

  it("(neg-dto-window) a window that cannot be read is closed: expired, never awaiting", () => {
    expect(fundingStateOf(scope({ expiresAt: "not a time" }), null, BEFORE_END)).toBe("expired");
    expect(fundingStateOf(scope({ status: "awaiting_acceptance", expiresAt: "" }), null, BEFORE_END)).toBe("expired");
    expect(fundingStateOf(scope(), null, "not a time")).toBe("expired");
  });

  it("funded_verified on this scope's finalized record of its buyer, whatever the scope's status since", () => {
    for (const status of ["active", "expired", "revoked", "awaiting_acceptance", "awaiting_funding", "suspended_rogue"]) {
      expect(fundingStateOf(scope({ status }), record(), BEFORE_END), status).toBe("funded_verified");
    }
    // Past the scope's own TTL the funding is still verified; the scope's status says it may not write.
    expect(fundingStateOf(scope({ status: "active" }), record(), "2027-01-01T00:00:00.000Z")).toBe("funded_verified");
  });

  it("(neg-dto-record-scope) another scope's record is never this scope's funding", () => {
    expect(fundingStateOf(scope({ status: "active" }), record({ scopeId: "scope_other" }), BEFORE_END)).toBe("unknown");
  });

  it("(neg-dto-record-buyer) a record whose verified payer is not the scope's buyer is never its funding", () => {
    expect(fundingStateOf(scope({ status: "active" }), record({ buyer: OTHER }), BEFORE_END)).toBe("unknown");
  });

  it("(neg-dto-record-shape) a record that is not finalized or not well formed is never funding", () => {
    for (const over of [{ finality: "latest" }, { blockHash: "0x00" }, { verifiedAt: "yesterday" }, { escrowAddress: "mock-escrow-x" }]) {
      expect(fundingStateOf(scope({ status: "active" }), record(over as never), BEFORE_END), JSON.stringify(over)).toBe("unknown");
    }
  });

  it("(neg-dto-nomock) without a record, a live scope is unknown, never funded (a mock-escrow or pre-N133 activation)", () => {
    expect(fundingStateOf(scope({ status: "active" }), null, BEFORE_END)).toBe("unknown");
  });

  it("without a record, any other status fails closed to unknown", () => {
    for (const status of ["revoked", "rejected", "expired", "completed", "suspended_rogue", "ACTIVE", ""]) {
      expect(fundingStateOf(scope({ status }), null, BEFORE_END), status).toBe("unknown");
    }
  });

  it("confirming is reserved: no input produces it", () => {
    const statuses = ["awaiting_acceptance", "awaiting_funding", "active", "revoked", "expired", "garbage"];
    const records = [null, record(), record({ finality: "latest" as never }), record({ scopeId: "x" })];
    const times = [BEFORE_END, WINDOW_END, "not a time"];
    for (const status of statuses) for (const r of records) for (const t of times) {
      const state = fundingStateOf(scope({ status }), r, t);
      expect(FUNDING_STATES).toContain(state);
      expect(state).not.toBe("confirming");
    }
  });
});

describe("FundingStatusDTO projection", () => {
  it("carries the sources' own values, the read time as given, and the verification only when funded_verified", () => {
    const r = record();
    expect(projectFundingStatus(scope({ status: "active", expiresAt: "2026-10-08T13:20:00.000Z" }), r, BEFORE_END)).toEqual({
      schemaId: FUNDING_STATUS_SCHEMA_ID,
      asOf: BEFORE_END,
      scopeId: "scope_dto",
      jobId: "job_dto",
      state: "funded_verified",
      scope: { sourceStatus: "active", createdAt: MINTED, expiresAt: "2026-10-08T13:20:00.000Z" },
      verification: {
        escrowAddress: r.escrowAddress,
        chainId: 84532,
        blockNumber: "31337000",
        blockHash: r.blockHash,
        verifierVersion: "verifier-test/1",
        verifiedAt: "2026-10-08T12:20:00.000Z",
      },
    });
  });

  it("(neg-dto-verification) a record that does not fund this scope is not shown", () => {
    const dto = projectFundingStatus(scope({ status: "active" }), record({ scopeId: "scope_other" }), BEFORE_END);
    expect(dto.state).toBe("unknown");
    expect(dto.verification).toBeNull();
    expect(projectFundingStatus(scope(), null, BEFORE_END)).toMatchObject({ state: "awaiting_funding", verification: null });
  });

  it("is pure: it reads no clock, and the same inputs give the same DTO", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2030-01-01T00:00:00.000Z"));
    const a = projectFundingStatus(scope(), null, BEFORE_END);
    vi.setSystemTime(Date.parse("2020-01-01T00:00:00.000Z"));
    const b = projectFundingStatus(scope(), null, BEFORE_END);
    expect(a).toEqual(b);
    expect(a.state).toBe("awaiting_funding");
    expect(projectFundingStatus(scope(), null, "garbage").asOf).toBe("garbage"); // never replaced by "now"
  });
});
