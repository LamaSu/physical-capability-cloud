import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "@pcc/store";
import type Database from "better-sqlite3";
import { closeStore, getRepos, getStore, initStore } from "../db.js";
import { createJobChallengeReader, gatewayKernelRegistry } from "../settlement/receipt-store.js";
import type { Hex, UnitBinding } from "../settlement/final-milestone-package-v2.js";

const H = (digit: string) => `0x${digit.repeat(64)}` as Hex;
const UNIT: UnitBinding = { chainId: "8453", escrow: "0x00000000000000000000000000000000000e5c0f", settlementUnitId: H("1"), jobIdHash: H("2"), milestoneIndex: "0", stepId: H("3"), compositionRoot: H("4"), acceptedEnvelopeHash: H("5") };
const EXPECTED = { nonce: H("6"), tChallengeRef: "gateway-created-challenge" };
const NOW = 1800000000;

describe("durable job-bound settlement challenge reader", () => {
  let jobId: string;
  let otherJobId: string;
  const db = () => getStore().db;
  const previousPath = process.env.PCC_DB_PATH;
  beforeAll(() => {
    process.env.PCC_DB_PATH = ":memory:";
    initStore({ seed: true });
    const jobs = getRepos().jobs.findAll();
    expect(jobs.length).toBeGreaterThan(1);
    jobId = jobs[0].id;
    otherJobId = jobs[1].id;
  });
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(NOW * 1000);
    db().run(sql`DELETE FROM settlement_challenges`);
    db().run(sql`INSERT INTO settlement_challenges (id, job_id, chain_id, escrow, settlement_unit_id, nonce, t_challenge_ref, state, issued_at, expires_at) VALUES ('challenge-reader-test', ${jobId}, 8453, ${UNIT.escrow}, ${UNIT.settlementUnitId}, ${EXPECTED.nonce}, ${EXPECTED.tChallengeRef}, 'issued', ${NOW - 1}, ${NOW + 60})`);
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(() => {
    closeStore();
    if (previousPath === undefined) delete process.env.PCC_DB_PATH;
    else process.env.PCC_DB_PATH = previousPath;
  });

  it("returns the issued record only to its job", async () => {
    expect(await createJobChallengeReader(jobId).recordFor(UNIT)).toEqual({ ...EXPECTED, state: "issued" });
    expect(await createJobChallengeReader(otherJobId).recordFor(UNIT)).toBeNull();
  });

  it("reads a challenge at its expiry boundary as non-issued", async () => {
    db().run(sql`UPDATE settlement_challenges SET expires_at = ${NOW}`);
    expect((await createJobChallengeReader(jobId).recordFor(UNIT))?.state).not.toBe("issued");
  });

  it("concurrent compare-and-set callers receive exactly one true", async () => {
    const first = createJobChallengeReader(jobId);
    const second = createJobChallengeReader(jobId);
    const results = await Promise.all([first.consumeIssued(UNIT, EXPECTED), second.consumeIssued(UNIT, EXPECTED)]);
    expect(results.filter((value) => value === true)).toHaveLength(1);
    expect(results.filter((value) => value === false)).toHaveLength(1);
    expect(await first.consumeIssued(UNIT, EXPECTED)).toBe(false);
    const row = db().get(sql`SELECT state, consumed_at FROM settlement_challenges`) as { state: string; consumed_at: number };
    expect(row).toEqual({ state: "consumed", consumed_at: NOW });
  });

  it("consumption executes one conditional UPDATE and no SELECT", async () => {
    const client = (db() as unknown as { session: { client: Database.Database } }).session.client;
    const prepare = vi.spyOn(client, "prepare");
    expect(await createJobChallengeReader(jobId).consumeIssued(UNIT, EXPECTED)).toBe(true);
    const queries = prepare.mock.calls.map(([query]) => query);
    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatch(/^update\s/i);
    expect(queries.some((query) => /\bselect\b/i.test(query))).toBe(false);
    const where = queries[0].slice(queries[0].toLowerCase().indexOf(" where "));
    for (const column of ["chain_id", "escrow", "settlement_unit_id", "job_id", "nonce", "t_challenge_ref", "state", "expires_at"]) expect(where).toContain(column);
    expect(where).toMatch(/expires_at["`]?\s*>/);
  });

  it.each(["job", "nonce", "reference", "chain", "escrow", "unit", "expiry"])("atomic consumption refuses a mismatched %s", async (variant) => {
    const reader = createJobChallengeReader(variant === "job" ? otherJobId : jobId);
    const unit = { ...UNIT, ...(variant === "chain" ? { chainId: "1" } : {}), ...(variant === "escrow" ? { escrow: "0x0000000000000000000000000000000000000001" as Hex } : {}), ...(variant === "unit" ? { settlementUnitId: H("9") } : {}) };
    const expected = { ...EXPECTED, ...(variant === "nonce" ? { nonce: H("9") } : {}), ...(variant === "reference" ? { tChallengeRef: "wrong-reference" } : {}) };
    if (variant === "expiry") db().run(sql`UPDATE settlement_challenges SET expires_at = ${NOW}`);
    expect(await reader.consumeIssued(unit, expected)).toBe(false);
    expect((db().get(sql`SELECT state FROM settlement_challenges`) as { state: string }).state).toBe("issued");
  });

  it("returns no registry signer for a missing kernel row", async () => {
    expect(await gatewayKernelRegistry.signerForKernel("kernel-not-in-registry")).toBeNull();
  });
});
