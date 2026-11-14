import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { custom, hexToBigInt, recoverAddress, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount, setSignEntropy } from "viem/accounts";
import { __setBuyerFundingTestUnitForTest, fundingPrepareRow, prepareBuyerFunding, servePrepareSignature } from "../services/buyer-funding-prepare.js";
import { __setVNextTransportForTest } from "../services/vnext-rpc-client.js";
import { setUpFixture, tearDownFixture, type Fixture } from "./helpers/paid-scope-fixture.js";
import { C, configure, payload, prepareReads, seedPrepare } from "./helpers/buyer-funding-prepare-fixture.js";

vi.mock("viem", async importOriginal => {
  const real = await importOriginal<typeof import("viem")>();
  return { ...real, recoverAddress: vi.fn(real.recoverAddress) };
});
const { recoverAddress: realRecoverAddress } = await vi.importActual<typeof import("viem")>("viem");
let f: Fixture;
beforeEach(async () => {
  vi.stubEnv("DATABASE_URL", ":memory:");
  f = await setUpFixture();
  configure();
  __setVNextTransportForTest(custom({ request: async () => { throw new Error("unexpected transport"); } }, { retryCount: 0 }));
  vi.setSystemTime(Number(C) * 1000);
});
afterEach(async () => {
  vi.stubEnv("NODE_ENV", "test"); vi.stubEnv("VITEST", "true");
  __setVNextTransportForTest(null); __setBuyerFundingTestUnitForTest(null);
  await tearDownFixture(f);
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers();
});

describe("servePrepareSignature compare-and-set", () => {
  it("SIG9a: servePrepareSignature returns identical bytes for two racing copies of one signature", async () => {
    const j = seedPrepare();
    expect((await prepareBuyerFunding(j.scopeId, prepareReads().deps)).kind).toBe("answer");
    let resolve!: () => void;
    const gate = new Promise<void>(r => { resolve = r; });
    vi.mocked(recoverAddress).mockClear().mockImplementation(async args => { await gate; return realRecoverAddress(args); });
    const signature = payload.fund.acceptance.operatorSignature;
    const requests = [servePrepareSignature(j.scopeId, signature), servePrepareSignature(j.scopeId, signature)];
    await vi.waitFor(() => expect(recoverAddress).toHaveBeenCalledTimes(2));
    resolve();
    const answers = await Promise.all(requests);
    const row = fundingPrepareRow(j.scopeId)!;
    for (const answer of answers) { expect(answer.status).toBe(200); expect(answer.body).toEqual(row.servedPayload); }
    expect(answers[0]!.body).toEqual(answers[1]!.body);
    expect(row).toMatchObject({ state: "served", operatorSignature: signature.toLowerCase() });
  });

  it("SIG9b: servePrepareSignature freezes only one of two different valid operator signatures", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const j = seedPrepare({ operator: account.address });
    expect((await prepareBuyerFunding(j.scopeId, prepareReads().deps)).kind).toBe("answer");
    const row = fundingPrepareRow(j.scopeId)!;
    const hash = row.typedDataDigest as Hex;
    const sig1 = await account.sign({ hash });
    setSignEntropy(`0x${"42".repeat(32)}`);
    const sig2 = await account.sign({ hash });
    expect(sig2).not.toBe(sig1);
    for (const signature of [sig1, sig2]) {
      expect((await realRecoverAddress({ hash, signature })).toLowerCase()).toBe(account.address.toLowerCase());
      expect(hexToBigInt(`0x${signature.slice(66, 130)}`)).toBeLessThanOrEqual(0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n);
    }
    let resolve!: () => void;
    const gate = new Promise<void>(r => { resolve = r; });
    vi.mocked(recoverAddress).mockClear().mockImplementation(async args => { await gate; return realRecoverAddress(args); });
    const signatures = [sig1, sig2];
    const requests = signatures.map(signature => servePrepareSignature(j.scopeId, signature));
    await vi.waitFor(() => expect(recoverAddress).toHaveBeenCalledTimes(2));
    resolve();
    const answers = await Promise.all(requests);
    expect(answers.map(answer => answer.status).sort()).toEqual([200, 409]);
    const winner = answers.findIndex(answer => answer.status === 200);
    expect(answers.find(answer => answer.status === 409)).toEqual({ status: 409,
      body: { error: "already_signed", message: "The prepare has already been signed." } });
    const stored = fundingPrepareRow(j.scopeId)!;
    expect(stored.state).toBe("served"); expect(stored.operatorSignature).toBe(signatures[winner]!.toLowerCase());
    expect(answers[winner]!.body).toEqual(stored.servedPayload);
    expect(stored.servedPayloadSha256).toBe(createHash("sha256").update(stored.servedPayload!).digest("hex"));
  });
});
