/**
 * FundingStatusDTO (buyer funding plan S2.4): a pure projection of a paid scope's row, the
 * verification record that names it and the escrow row of its job. Each state's and each binding's
 * condition is the doc comment's in readmodels/funding-status.ts. The negatives (neg-dto-...) pin
 * that a state is never funded without the finalized record of this scope and buyer, bound to this
 * job's escrow row (fund-s2 review MEDIUM-1), and that nothing the sources cannot place reads as
 * funded.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  FUNDING_BINDINGS,
  FUNDING_STATES,
  FUNDING_STATUS_SCHEMA_ID,
  fundingBindingOf,
  fundingStateOf,
  projectFundingStatus,
  type FundingEscrowRow,
  type FundingScopeRow,
} from "../../readmodels/funding-status.js";
import type { FundingVerificationRecord } from "../../services/funding-record-port.js";

const BUYER = "0x5555555555555555555555555555555555555555";
const OTHER = "0x6666666666666666666666666666666666666666";
/** The expected chain: the pinned V-next deployment record's (ruling 4). */
const CHAIN = 84532;
const ESCROW = "0x" + "a1".repeat(20);
const OTHER_ESCROW = "0x" + "b2".repeat(20);
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
  escrowAddress: ESCROW,
  buyer: BUYER,
  chainId: 84532,
  blockNumber: "31337000",
  blockHash: "0x" + "c3".repeat(32),
  verifierVersion: "verifier-test/1",
  verifiedAt: "2026-10-08T12:20:00.000Z",
  finality: "finalized",
  ...over,
});
/** The job's escrow row: the record's contract, the buyer's payer label, funded. */
const row = (over: Partial<NonNullable<FundingEscrowRow>> = {}): FundingEscrowRow => ({
  contractAddress: ESCROW,
  payer: BUYER,
  status: "funded",
  ...over,
});
const ROW = row();

afterEach(() => {
  vi.useRealTimers();
});

describe("FundingStatusDTO states", () => {
  it("without a record: prepared, awaiting_funding, then expired once the window lapses", () => {
    expect(fundingStateOf(scope({ status: "awaiting_acceptance" }), null, ROW, CHAIN, BEFORE_END)).toBe("prepared");
    expect(fundingStateOf(scope(), null, ROW, CHAIN, BEFORE_END)).toBe("awaiting_funding");
    expect(fundingStateOf(scope({ status: "awaiting_acceptance" }), null, ROW, CHAIN, WINDOW_END)).toBe("expired");
    expect(fundingStateOf(scope(), null, ROW, CHAIN, WINDOW_END)).toBe("expired");
  });

  it("(neg-dto-window) a window that cannot be read is closed: expired, never awaiting", () => {
    expect(fundingStateOf(scope({ expiresAt: "not a time" }), null, ROW, CHAIN, BEFORE_END)).toBe("expired");
    expect(fundingStateOf(scope({ status: "awaiting_acceptance", expiresAt: "" }), null, ROW, CHAIN, BEFORE_END)).toBe("expired");
    expect(fundingStateOf(scope(), null, ROW, CHAIN, "not a time")).toBe("expired");
  });

  it("funded_verified on this scope's finalized record of its buyer, bound to its job's escrow row, before activation or once live", () => {
    for (const status of ["active", "expired", "awaiting_acceptance", "awaiting_funding", "suspended_rogue"]) {
      expect(fundingStateOf(scope({ status }), record(), ROW, CHAIN, BEFORE_END), status).toBe("funded_verified");
    }
    // Past the scope's own TTL the funding is still verified; the scope's status says it may not write.
    expect(fundingStateOf(scope({ status: "active" }), record(), ROW, CHAIN, "2027-01-01T00:00:00.000Z")).toBe("funded_verified");
    // The escrow row in another letter case is the same contract.
    expect(fundingStateOf(scope(), record(), row({ contractAddress: "0x" + ESCROW.slice(2).toUpperCase() }), CHAIN, BEFORE_END)).toBe("funded_verified");
  });

  it("(dto-settled) a settled (completed) escrow after activation is still funded_verified: the row's status is not read", () => {
    for (const status of ["completed", "created", "disputed", "refunded", ""]) {
      const dto = projectFundingStatus(scope({ status: "active" }), record(), row({ status }), CHAIN, BEFORE_END);
      expect(dto, status).toMatchObject({ state: "funded_verified", binding: "bound" });
      expect(dto.verification).not.toBeNull();
    }
  });

  it("(neg-dto-other-escrow) a record of this scope and buyer for another escrow is never funded_verified, and says so (P7)", () => {
    for (const status of ["awaiting_funding", "awaiting_acceptance", "active", "expired", "suspended_rogue"]) {
      const dto = projectFundingStatus(scope({ status }), record(), row({ contractAddress: OTHER_ESCROW }), CHAIN, BEFORE_END);
      expect(dto, status).toMatchObject({ state: "unknown", binding: "record_escrow_not_scope_escrow", verification: null });
    }
    // The same with a re-pointed row: the record's escrow, not the row's, is what does not match.
    expect(fundingBindingOf(scope(), record({ escrowAddress: OTHER_ESCROW }), ROW, CHAIN)).toBe("record_escrow_not_scope_escrow");
  });

  it("(neg-dto-no-escrow) a job with no escrow row is never funded_verified, and says so", () => {
    for (const status of ["awaiting_funding", "awaiting_acceptance", "active", "expired", "suspended_rogue"]) {
      const dto = projectFundingStatus(scope({ status }), record(), null, CHAIN, BEFORE_END);
      expect(dto, status).toMatchObject({ state: "unknown", binding: "escrow_missing", verification: null });
    }
  });

  it("(neg-dto-chain) a record from another chain than the expected one is never funded_verified, and says so (ruling 4)", () => {
    for (const status of ["awaiting_acceptance", "awaiting_funding", "active", "expired", "suspended_rogue"]) {
      const dto = projectFundingStatus(scope({ status }), record({ chainId: 545 }), ROW, CHAIN, BEFORE_END);
      expect(dto, status).toMatchObject({ state: "unknown", binding: "record_chain_mismatch", verification: null });
    }
    // No usable expected chain (no pinned deployment record) binds no record: fail closed.
    for (const expected of [null, Number.NaN, 0, -1, 84532.5, "84532"]) {
      expect(fundingBindingOf(scope(), record(), ROW, expected as never), String(expected)).toBe("record_chain_mismatch");
      expect(fundingStateOf(scope({ status: "active" }), record(), ROW, expected as never, BEFORE_END), String(expected)).toBe("unknown");
    }
    // The control: the same record on the expected chain is bound.
    expect(fundingBindingOf(scope(), record(), ROW, CHAIN)).toBe("bound");
  });

  it("(neg-dto-escrow-payer) an escrow row whose payer label is another buyer is never funded_verified", () => {
    const dto = projectFundingStatus(scope({ status: "active" }), record(), row({ payer: OTHER }), CHAIN, BEFORE_END);
    expect(dto).toMatchObject({ state: "unknown", binding: "escrow_payer_not_buyer", verification: null });
  });

  it("(neg-dto-lapsed-record) a lapsed pre-activation window wins over a bound record: expired, the verification still shown (P8)", () => {
    for (const status of ["awaiting_funding", "awaiting_acceptance"]) {
      for (const asOf of [WINDOW_END, "2026-10-08T13:01:00.000Z"]) {
        const dto = projectFundingStatus(scope({ status }), record(), ROW, CHAIN, asOf);
        expect(dto, `${status} ${asOf}`).toMatchObject({ state: "expired", binding: "bound" });
        expect(dto.verification).toMatchObject({ escrowAddress: ESCROW, verifiedAt: "2026-10-08T12:20:00.000Z" });
      }
    }
    // A record that is not bound shows nothing there either.
    expect(projectFundingStatus(scope(), record(), null, CHAIN, WINDOW_END)).toMatchObject({ state: "expired", binding: "escrow_missing", verification: null });
  });

  it("(neg-dto-terminal) a revoked or rejected scope's own state wins over a bound record: unknown, the verification still shown", () => {
    for (const status of ["revoked", "rejected"]) {
      const dto = projectFundingStatus(scope({ status }), record(), ROW, CHAIN, BEFORE_END);
      expect(dto, status).toMatchObject({ state: "unknown", binding: "bound", scope: { sourceStatus: status } });
      expect(dto.verification).not.toBeNull();
    }
  });

  it("(neg-dto-unknown-status) a status this projection does not know is unknown, a bound record or not", () => {
    for (const status of ["ACTIVE", "completed", "garbage", ""]) {
      expect(fundingStateOf(scope({ status }), record(), ROW, CHAIN, BEFORE_END), status).toBe("unknown");
    }
  });

  it("(neg-dto-record-scope) another scope's record is never this scope's funding", () => {
    expect(fundingStateOf(scope({ status: "active" }), record({ scopeId: "scope_other" }), ROW, CHAIN, BEFORE_END)).toBe("unknown");
    expect(fundingStateOf(scope(), record({ scopeId: "scope_other" }), ROW, CHAIN, BEFORE_END)).toBe("unknown");
  });

  it("(neg-dto-record-buyer) a record whose verified payer is not the scope's buyer is never its funding", () => {
    expect(fundingStateOf(scope({ status: "active" }), record({ buyer: OTHER }), ROW, CHAIN, BEFORE_END)).toBe("unknown");
    expect(fundingStateOf(scope(), record({ buyer: OTHER }), ROW, CHAIN, BEFORE_END)).toBe("unknown");
  });

  it("(neg-dto-record-shape) a record that is not finalized or not well formed is never funding", () => {
    for (const over of [{ finality: "latest" }, { blockHash: "0x00" }, { verifiedAt: "yesterday" }, { escrowAddress: "mock-escrow-x" }]) {
      expect(fundingStateOf(scope({ status: "active" }), record(over as never), ROW, CHAIN, BEFORE_END), JSON.stringify(over)).toBe("unknown");
      expect(fundingBindingOf(scope(), record(over as never), ROW, CHAIN), JSON.stringify(over)).toBe("record_malformed");
    }
  });

  it("(neg-dto-nomock) without a record, a live scope is unknown, never funded (a mock-escrow or pre-N133 activation)", () => {
    expect(fundingStateOf(scope({ status: "active" }), null, ROW, CHAIN, BEFORE_END)).toBe("unknown");
  });

  it("without a record, any other status fails closed to unknown", () => {
    for (const status of ["revoked", "rejected", "expired", "completed", "suspended_rogue", "ACTIVE", ""]) {
      expect(fundingStateOf(scope({ status }), null, ROW, CHAIN, BEFORE_END), status).toBe("unknown");
    }
  });

  it("each binding member, by its exact condition, in order", () => {
    const cases: Array<[FundingVerificationRecord | null, FundingEscrowRow, string]> = [
      [null, null, "no_record"],
      [record({ finality: "latest" as never }), null, "record_malformed"],
      [record({ chainId: 545, scopeId: "scope_other" }), null, "record_chain_mismatch"],
      [record({ scopeId: "scope_other" }), null, "record_scope_mismatch"],
      [record({ buyer: OTHER }), null, "record_buyer_not_scope_buyer"],
      [record(), null, "escrow_missing"],
      [record(), row({ payer: OTHER, contractAddress: OTHER_ESCROW }), "escrow_payer_not_buyer"],
      [record(), row({ contractAddress: OTHER_ESCROW }), "record_escrow_not_scope_escrow"],
      [record(), row({ status: "completed" }), "bound"],
    ];
    expect(cases.map(([, , b]) => b)).toEqual([...FUNDING_BINDINGS]);
    for (const [r, e, binding] of cases) expect(fundingBindingOf(scope(), r, e, CHAIN), binding).toBe(binding);
  });

  it("(neg-dto-members) the states are exactly these: no `confirming` until Q9 gives it a source (ruling 6), and every input gives one of them", () => {
    expect([...FUNDING_STATES]).toEqual(["prepared", "awaiting_funding", "funded_verified", "expired", "unknown"]);
    expect(FUNDING_STATES as readonly string[]).not.toContain("confirming");
    const statuses = ["awaiting_acceptance", "awaiting_funding", "active", "revoked", "rejected", "expired", "garbage"];
    const records = [null, record(), record({ finality: "latest" as never }), record({ scopeId: "x" })];
    const escrows: FundingEscrowRow[] = [ROW, null, row({ contractAddress: OTHER_ESCROW }), row({ payer: OTHER })];
    const times = [BEFORE_END, WINDOW_END, "not a time"];
    for (const status of statuses) for (const r of records) for (const e of escrows) for (const t of times) {
      expect(FUNDING_STATES).toContain(fundingStateOf(scope({ status }), r, e, CHAIN, t));
    }
  });
});

describe("FundingStatusDTO projection", () => {
  it("carries the sources' own values, the read time as given, the binding, and the verification only when bound", () => {
    const r = record();
    expect(projectFundingStatus(scope({ status: "active", expiresAt: "2026-10-08T13:20:00.000Z" }), r, ROW, CHAIN, BEFORE_END)).toEqual({
      schemaId: FUNDING_STATUS_SCHEMA_ID,
      asOf: BEFORE_END,
      scopeId: "scope_dto",
      jobId: "job_dto",
      state: "funded_verified",
      binding: "bound",
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
    const dto = projectFundingStatus(scope({ status: "active" }), record({ scopeId: "scope_other" }), ROW, CHAIN, BEFORE_END);
    expect(dto).toMatchObject({ state: "unknown", binding: "record_scope_mismatch", verification: null });
    expect(projectFundingStatus(scope(), null, ROW, CHAIN, BEFORE_END)).toMatchObject({ state: "awaiting_funding", binding: "no_record", verification: null });
  });

  it("is pure: it reads no clock, and the same inputs give the same DTO", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2030-01-01T00:00:00.000Z"));
    const a = projectFundingStatus(scope(), null, ROW, CHAIN, BEFORE_END);
    vi.setSystemTime(Date.parse("2020-01-01T00:00:00.000Z"));
    const b = projectFundingStatus(scope(), null, ROW, CHAIN, BEFORE_END);
    expect(a).toEqual(b);
    expect(a.state).toBe("awaiting_funding");
    expect(projectFundingStatus(scope(), null, ROW, CHAIN, "garbage").asOf).toBe("garbage"); // never replaced by "now"
  });
});
