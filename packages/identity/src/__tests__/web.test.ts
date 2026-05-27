import { describe, it, expect, vi } from "vitest";
import { resolveWeb, didWebToUrl } from "../methods/web.js";
import { parseDID } from "../did.js";
import { DIDResolutionError, type DIDDocument } from "../types.js";

describe("didWebToUrl", () => {
  it("maps bare domain to .well-known/did.json", () => {
    expect(didWebToUrl("example.com", "did:web:example.com")).toBe(
      "https://example.com/.well-known/did.json",
    );
  });

  it("maps domain + path to /<path>/did.json", () => {
    expect(didWebToUrl("example.com:users:alice", "did:web:example.com:users:alice")).toBe(
      "https://example.com/users/alice/did.json",
    );
  });

  it("supports localhost (no dot required)", () => {
    expect(didWebToUrl("localhost", "did:web:localhost")).toBe(
      "https://localhost/.well-known/did.json",
    );
  });

  it("decodes percent-encoded segments", () => {
    // Per spec, the host may be percent-encoded
    expect(didWebToUrl("example.com:foo%20bar", "did:web:example.com:foo%20bar")).toBe(
      "https://example.com/foo bar/did.json",
    );
  });

  it("rejects invalid host string", () => {
    expect(() => didWebToUrl("nodot", "did:web:nodot")).toThrow(DIDResolutionError);
  });

  it("rejects empty method-specific-id", () => {
    expect(() => didWebToUrl("", "did:web:")).toThrow(DIDResolutionError);
  });
});

describe("resolveWeb", () => {
  const validDoc: DIDDocument = {
    "@context": ["https://www.w3.org/ns/did/v1"],
    id: "did:web:example.com",
    verificationMethod: [
      {
        id: "did:web:example.com#key-1",
        type: "Ed25519VerificationKey2018",
        controller: "did:web:example.com",
        publicKeyMultibase: "z6MkpzYjk3Z2gjK4PnD8nLBJrXqWzVqxJpZGfXmf6t5HRrCu",
      },
    ],
  };

  function mockFetch(response: Partial<Response> & { json?: () => Promise<unknown> }): typeof fetch {
    return (async () => {
      const fullResponse = {
        ok: response.ok ?? true,
        status: response.status ?? 200,
        json: response.json ?? (() => Promise.resolve(validDoc)),
      } as Response;
      return fullResponse;
    }) as unknown as typeof fetch;
  }

  it("fetches the document from the correct URL", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string) => {
      seen.push(url);
      return { ok: true, status: 200, json: () => Promise.resolve(validDoc) } as Response;
    }) as unknown as typeof fetch;

    const parsed = parseDID("did:web:example.com");
    const doc = await resolveWeb(parsed, { fetchImpl });
    expect(seen).toEqual(["https://example.com/.well-known/did.json"]);
    expect(doc.id).toBe("did:web:example.com");
  });

  it("returns the parsed DIDDocument on success", async () => {
    const fetchImpl = mockFetch({ ok: true, json: () => Promise.resolve(validDoc) });
    const parsed = parseDID("did:web:example.com");
    const doc = await resolveWeb(parsed, { fetchImpl });
    expect(doc.verificationMethod).toHaveLength(1);
    expect(doc.verificationMethod![0]!.type).toBe("Ed25519VerificationKey2018");
  });

  it("throws notFound on 404", async () => {
    const fetchImpl = mockFetch({ ok: false, status: 404 });
    const parsed = parseDID("did:web:nonexistent.test");
    await expect(resolveWeb(parsed, { fetchImpl })).rejects.toMatchObject({
      code: "notFound",
    });
  });

  it("throws networkError on 500", async () => {
    const fetchImpl = mockFetch({ ok: false, status: 500 });
    const parsed = parseDID("did:web:flaky.test");
    await expect(resolveWeb(parsed, { fetchImpl })).rejects.toMatchObject({
      code: "networkError",
    });
  });

  it("throws networkError on fetch throwing", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const parsed = parseDID("did:web:down.test");
    await expect(resolveWeb(parsed, { fetchImpl })).rejects.toMatchObject({
      code: "networkError",
    });
  });

  it("throws invalidDidDocument when JSON parse fails", async () => {
    const fetchImpl = mockFetch({
      ok: true,
      json: () => Promise.reject(new Error("Unexpected token")),
    });
    const parsed = parseDID("did:web:bad-json.test");
    await expect(resolveWeb(parsed, { fetchImpl })).rejects.toMatchObject({
      code: "invalidDidDocument",
    });
  });

  it("throws when document id doesn't match the requested DID", async () => {
    const badDoc = { ...validDoc, id: "did:web:somewhere-else.com" };
    const fetchImpl = mockFetch({ ok: true, json: () => Promise.resolve(badDoc) });
    const parsed = parseDID("did:web:example.com");
    await expect(resolveWeb(parsed, { fetchImpl })).rejects.toMatchObject({
      code: "invalidDidDocument",
    });
  });

  it("throws when document is missing @context", async () => {
    const badDoc = { id: "did:web:example.com" };
    const fetchImpl = mockFetch({ ok: true, json: () => Promise.resolve(badDoc) });
    const parsed = parseDID("did:web:example.com");
    await expect(resolveWeb(parsed, { fetchImpl })).rejects.toMatchObject({
      code: "invalidDidDocument",
    });
  });

  it("rejects non-web DIDs", async () => {
    const parsed = parseDID("did:pkh:eip155:1:0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045");
    await expect(resolveWeb(parsed)).rejects.toThrow(DIDResolutionError);
  });

  it("uses path-segment URL when method-specific-id has segments", async () => {
    const seen: string[] = [];
    const subDoc = { ...validDoc, id: "did:web:example.com:users:alice" };
    const fetchImpl = (async (url: string) => {
      seen.push(url);
      return { ok: true, status: 200, json: () => Promise.resolve(subDoc) } as Response;
    }) as unknown as typeof fetch;
    const parsed = parseDID("did:web:example.com:users:alice");
    await resolveWeb(parsed, { fetchImpl });
    expect(seen).toEqual(["https://example.com/users/alice/did.json"]);
  });
});
