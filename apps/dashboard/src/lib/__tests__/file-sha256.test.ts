import { describe, it, expect, vi, afterEach } from "vitest";
import { sha256OfBlob } from "../file-sha256.js";

describe("sha256OfBlob", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("hashes the bytes (FIPS 180-2 test vector 'abc')", async () => {
    expect(await sha256OfBlob(new Blob(["abc"]))).toBe(
      "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("hashes an empty file to the empty-input digest", async () => {
    expect(await sha256OfBlob(new Blob([]))).toBe(
      "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("gives different files different hashes, and the same file the same hash", async () => {
    const a1 = await sha256OfBlob(new Blob(["datasheet v1"]));
    const a2 = await sha256OfBlob(new Blob(["datasheet v1"]));
    const b = await sha256OfBlob(new Blob(["datasheet v2"]));
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
  });

  it("returns null, never a made-up value, when WebCrypto is unavailable", async () => {
    vi.stubGlobal("crypto", undefined);
    expect(await sha256OfBlob(new Blob(["abc"]))).toBeNull();
  });
});
