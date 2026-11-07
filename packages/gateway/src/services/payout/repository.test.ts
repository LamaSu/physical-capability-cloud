import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { schema, sql } from "@pcc/store";
import { closeStore, getStore, initStore } from "../../db.js";
import { bindPayoutWallet, PayoutOwnerChanged } from "./repository.js";

const KERNEL = "n21-repository-owner-recheck";
const OWNER = "0x1111111111111111111111111111111111111111";
const NEW_OWNER = "0x2222222222222222222222222222222222222222";
const CHAIN = 84532;

beforeEach(() => {
  vi.stubEnv("DATABASE_URL", ":memory:");
  vi.stubEnv("PCC_DB_PATH", ":memory:");
  closeStore();
  initStore({ seed: false });
  const now = new Date().toISOString();
  getStore().db.insert(schema.shopKernels).values({
    id: KERNEL, name: "Repository owner recheck", operatorAddress: OWNER,
    location: { lat: 0, lng: 0 }, physicalAddress: "test", maxAssuranceTier: 0,
    publicKey: "test-public-key", status: "online", registeredAt: now, lastHeartbeat: now, version: "1",
  }).run();
});

afterEach(() => {
  closeStore();
  vi.unstubAllEnvs();
});

describe("payout repository owner recheck", () => {
  it.each([false, true])("F3 refuses a former owner at write time without changing history (existing binding=%s)", existingBinding => {
    const { db } = getStore();
    const input = { kernelId: KERNEL, chainId: CHAIN, wallet: OWNER, carrier: "key" as const };
    // Model a valid earlier ownership check, before the kernel changes owners.
    expect(db.get(sql`SELECT operator_address FROM shop_kernels WHERE id = ${KERNEL}`))
      .toEqual({ operator_address: OWNER });
    if (existingBinding) expect(bindPayoutWallet(input).created).toBe(true);
    const before = db.all(sql`SELECT * FROM kernel_payout_bindings ORDER BY id`);
    expect(before).toHaveLength(existingBinding ? 1 : 0);

    db.run(sql`UPDATE shop_kernels SET operator_address = ${NEW_OWNER} WHERE id = ${KERNEL}`);

    expect(() => bindPayoutWallet(input)).toThrow(PayoutOwnerChanged);
    expect(db.all(sql`SELECT * FROM kernel_payout_bindings ORDER BY id`)).toEqual(before);
  });
});
