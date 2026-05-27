import { describe, it, expect } from "vitest";
import { DIDResolver } from "../resolver.js";
import { DIDResolutionError, type DIDDocument } from "../types.js";

const VITALIK = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

describe("DIDResolver", () => {
  it("parses a did:pkh DID without resolving", () => {
    const resolver = new DIDResolver();
    const parsed = resolver.parse(`did:pkh:eip155:8453:${VITALIK}`);
    expect(parsed.method).toBe("pkh");
    expect(parsed.methodSpecificId).toBe(`eip155:8453:${VITALIK}`);
  });

  it("resolves a did:pkh deterministically", async () => {
    const resolver = new DIDResolver();
    const doc = await resolver.resolve(`did:pkh:eip155:8453:${VITALIK}`);
    expect(doc.id).toBe(`did:pkh:eip155:8453:${VITALIK}`);
    expect(doc.verificationMethod).toHaveLength(1);
  });

  it("throws methodNotSupported for unknown method", async () => {
    const resolver = new DIDResolver();
    await expect(resolver.resolve("did:unknownmethod:abc")).rejects.toMatchObject({
      code: "methodNotSupported",
    });
  });

  it("lists supported methods", () => {
    const resolver = new DIDResolver();
    const methods = resolver.supportedMethods();
    expect(methods).toContain("pkh");
    expect(methods).toContain("web");
    expect(methods).toContain("ens");
  });

  it("supports registering a custom method", async () => {
    const resolver = new DIDResolver();
    const customDoc: DIDDocument = {
      "@context": "https://www.w3.org/ns/did/v1",
      id: "did:custom:1234",
    };
    resolver.registerMethod("custom", async () => customDoc);
    const doc = await resolver.resolve("did:custom:1234");
    expect(doc.id).toBe("did:custom:1234");
  });

  it("propagates DIDResolutionError from underlying resolver", async () => {
    const resolver = new DIDResolver();
    await expect(resolver.resolve("did:pkh:eip155:notanumber:invalid")).rejects.toThrow(
      DIDResolutionError,
    );
  });

  it("throws on malformed DID", async () => {
    const resolver = new DIDResolver();
    await expect(resolver.resolve("not-a-did")).rejects.toMatchObject({ code: "invalidDid" });
  });

  it("dispatches did:web through fetchImpl override", async () => {
    const seen: string[] = [];
    const resolver = new DIDResolver({
      fetchImpl: (async (url: string) => {
        seen.push(url);
        return {
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              "@context": "https://www.w3.org/ns/did/v1",
              id: "did:web:example.test",
            }),
        } as Response;
      }) as unknown as typeof fetch,
    });
    const doc = await resolver.resolve("did:web:example.test");
    expect(doc.id).toBe("did:web:example.test");
    expect(seen).toEqual(["https://example.test/.well-known/did.json"]);
  });
});
