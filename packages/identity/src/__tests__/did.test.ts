import { describe, it, expect } from "vitest";
import { parseDID, isDID } from "../did.js";
import { DIDResolutionError } from "../types.js";

describe("parseDID", () => {
  it("parses a simple did:pkh", () => {
    const result = parseDID("did:pkh:eip155:8453:0x1234567890abcdef1234567890abcdef12345678");
    expect(result.method).toBe("pkh");
    expect(result.methodSpecificId).toBe("eip155:8453:0x1234567890abcdef1234567890abcdef12345678");
    expect(result.did).toBe("did:pkh:eip155:8453:0x1234567890abcdef1234567890abcdef12345678");
  });

  it("parses a did:web with hostname only", () => {
    const result = parseDID("did:web:example.com");
    expect(result.method).toBe("web");
    expect(result.methodSpecificId).toBe("example.com");
  });

  it("parses a did:web with path segments", () => {
    const result = parseDID("did:web:example.com:users:alice");
    expect(result.method).toBe("web");
    expect(result.methodSpecificId).toBe("example.com:users:alice");
  });

  it("captures path component", () => {
    const result = parseDID("did:web:example.com/foo/bar");
    expect(result.method).toBe("web");
    expect(result.path).toBe("foo/bar");
  });

  it("captures query component", () => {
    const result = parseDID("did:web:example.com?service=files");
    expect(result.query).toBe("service=files");
  });

  it("captures fragment component", () => {
    const result = parseDID("did:web:example.com#key-1");
    expect(result.fragment).toBe("key-1");
    expect(result.did).toBe("did:web:example.com");
  });

  it("throws on missing did: prefix", () => {
    expect(() => parseDID("pkh:eip155:8453:0xABC")).toThrow(DIDResolutionError);
  });

  it("throws on missing method", () => {
    expect(() => parseDID("did::foo")).toThrow(DIDResolutionError);
  });

  it("throws on empty string", () => {
    expect(() => parseDID("")).toThrow(DIDResolutionError);
  });

  it("throws on non-string input", () => {
    // @ts-expect-error - testing runtime guard
    expect(() => parseDID(null)).toThrow(DIDResolutionError);
  });

  it("isDID returns true for valid DIDs", () => {
    expect(isDID("did:web:example.com")).toBe(true);
    expect(isDID("did:pkh:eip155:1:0x1234567890abcdef1234567890abcdef12345678")).toBe(true);
  });

  it("isDID returns false for invalid DIDs", () => {
    expect(isDID("")).toBe(false);
    expect(isDID("not-a-did")).toBe(false);
    expect(isDID("did:")).toBe(false);
  });
});
