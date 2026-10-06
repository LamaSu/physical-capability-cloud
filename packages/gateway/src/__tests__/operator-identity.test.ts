import type { FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";

import {
  EVM_ADDRESS,
  operatorIdentity,
  ownsKernel,
  requestActor,
  sameEvmAddress,
  type OperatorIdentity,
} from "../services/operator-identity.js";

const WALLET = "0x282fa9c122b433864f8c8a8f2efe411b52067539";
const UPPER_WALLET = "0x" + WALLET.slice(2).toUpperCase();
const asRequest = (fields: Record<string, unknown>): FastifyRequest => fields as unknown as FastifyRequest;
const proven = (principal: string): OperatorIdentity => ({ principal, identityStatus: "proven" });
const asserted = (principal: string): OperatorIdentity => ({ principal, identityStatus: "self_asserted" });

describe("operatorIdentity", () => {
  it("prefers a well-formed provenWallet to both an API key and SIWE", () => {
    expect(operatorIdentity(asRequest({ provenWallet: WALLET, apiKeyId: "key-1", operatorId: "operator@example.test", userId: UPPER_WALLET })))
      .toEqual(proven(WALLET));
  });

  it("prefers an API key's operatorId to SIWE userId", () => {
    expect(operatorIdentity(asRequest({ apiKeyId: "key-1", operatorId: "operator@example.test", userId: WALLET })))
      .toEqual(asserted("operator@example.test"));
  });

  it("uses SIWE's userId as a proven principal only without an API key", () => {
    expect(operatorIdentity(asRequest({ userId: WALLET }))).toEqual(proven(WALLET));
    expect(operatorIdentity(asRequest({ apiKeyId: "", userId: WALLET }))).toEqual(proven(WALLET));
  });

  it("ignores malformed provenWallet and follows API key then SIWE precedence", () => {
    expect(operatorIdentity(asRequest({ provenWallet: "not-a-wallet", apiKeyId: "key-1", operatorId: "operator@example.test", userId: WALLET })))
      .toEqual(asserted("operator@example.test"));
    expect(operatorIdentity(asRequest({ provenWallet: "not-a-wallet", userId: WALLET }))).toEqual(proven(WALLET));
    expect(operatorIdentity(asRequest({ provenWallet: "not-a-wallet" }))).toBeNull();
  });

  it("refuses an API key with an empty operatorId, without falling back to SIWE", () => {
    for (const operatorId of [undefined, null, "", " \t ", 42]) {
      expect(operatorIdentity(asRequest({ apiKeyId: "key-1", operatorId, userId: WALLET }))).toBeNull();
    }
  });

  it("has no identity without the authentication fields", () => {
    for (const fields of [{}, { operatorId: WALLET }, { userId: "" }, { userId: null }]) {
      expect(operatorIdentity(asRequest(fields))).toBeNull();
    }
  });

  it("an API key whose operatorId is an EVM owner remains self_asserted", () => {
    const identity = operatorIdentity(asRequest({ apiKeyId: "key-1", operatorId: WALLET, userId: WALLET }));
    expect(identity).toEqual(asserted(WALLET));
    expect(ownsKernel(identity!, { operatorAddress: WALLET })).toBe(true);
  });
});

describe("ownsKernel", () => {
  it("refuses zero and empty owners for both identity tiers", () => {
    for (const operatorAddress of [undefined, null, "", " \t ", "0x0000000000000000000000000000000000000000", " 0X0000000000000000000000000000000000000000 "]) {
      expect(ownsKernel(proven(WALLET), { operatorAddress })).toBe(false);
      expect(ownsKernel(asserted(String(operatorAddress ?? "")), { operatorAddress })).toBe(false);
    }
  });

  it("compares proven EVM principals case-insensitively and trims the stored owner", () => {
    expect(ownsKernel(proven(UPPER_WALLET), { operatorAddress: ` ${WALLET} ` })).toBe(true);
    expect(ownsKernel(proven(WALLET), { operatorAddress: UPPER_WALLET })).toBe(true);
  });

  it("compares self_asserted principals exactly after trimming", () => {
    expect(ownsKernel(asserted(" operator@example.test "), { operatorAddress: " operator@example.test " })).toBe(true);
    expect(ownsKernel(asserted("Operator@example.test"), { operatorAddress: "operator@example.test" })).toBe(false);
    expect(ownsKernel(asserted(UPPER_WALLET), { operatorAddress: WALLET })).toBe(false);
  });

  it("refuses a SIWE lookalike with one changed hex digit", () => {
    const lookalike = WALLET.slice(0, -1) + "8";
    expect(ownsKernel(proven(lookalike), { operatorAddress: WALLET })).toBe(false);
  });

  it("requires well-formed EVM addresses for proven ownership", () => {
    expect(ownsKernel(proven("operator@example.test"), { operatorAddress: "operator@example.test" })).toBe(false);
    expect(ownsKernel(proven(` ${WALLET} `), { operatorAddress: WALLET })).toBe(false);
    expect(ownsKernel(proven("0X" + WALLET.slice(2)), { operatorAddress: WALLET })).toBe(false);
  });
});

describe("legacy availability identity helpers", () => {
  it("keeps requestActor API-key-first and provenWallet does not alter its behavior", () => {
    expect(requestActor(asRequest({ provenWallet: WALLET, apiKeyId: "key-1", userId: WALLET }))).toEqual({ kind: "api-key" });
    expect(requestActor(asRequest({ userId: WALLET }))).toEqual({ kind: "siwe", address: WALLET });
    expect(requestActor(asRequest({ provenWallet: WALLET }))).toEqual({ kind: "none" });
  });

  it("keeps sameEvmAddress strict about format and ASCII case", () => {
    expect(EVM_ADDRESS.test(WALLET)).toBe(true);
    expect(sameEvmAddress(WALLET, UPPER_WALLET)).toBe(true);
    expect(sameEvmAddress(WALLET, ` ${WALLET} `)).toBe(false);
    expect(sameEvmAddress("0X" + WALLET.slice(2), WALLET)).toBe(false);
    expect(sameEvmAddress(null, WALLET)).toBe(false);
  });
});
