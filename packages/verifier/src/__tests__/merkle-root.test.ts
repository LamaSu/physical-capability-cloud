/**
 * Tests for the deterministic Merkle root (§3.3, §8.4-B-2).
 *
 * This root is recomputed by the oracle (step 10) and anchored on-chain (O5), so
 * the test must pin the EXACT byte behavior — not merely "internally consistent".
 * Every EXPECTED root here is computed with `node:crypto` DIRECTLY per the §3.3
 * rules (hex-decode leaves → sha256 over concatenated raw 32-byte buffers,
 * left-to-right, odd node promoted unchanged). It is NEVER computed by calling
 * `merkleRoot` itself — a self-referential oracle would pass even if the impl were
 * wrong. If the impl and these hand-rolled expectations agree, the algorithm is
 * the one the spec froze.
 */

import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { merkleRoot } from "../workflow/merkle-root.js";

/** A valid `sha256:<64-hex>` leaf string derived from a label (real 32-byte value). */
function h(label: string): string {
  return `sha256:${createHash("sha256").update(label).digest("hex")}`;
}
/** The raw 32-byte value of a leaf string (prefix stripped, hex-decoded). */
function dec(hash: string): Buffer {
  return Buffer.from(hash.replace(/^sha256:/, ""), "hex");
}
/** parent = sha256(left ‖ right) over raw 32-byte buffers → 32-byte Buffer. */
function node(a: Buffer, b: Buffer): Buffer {
  return createHash("sha256").update(Buffer.concat([a, b])).digest();
}
/** Encode a raw 32-byte root buffer as the `sha256:<lower-hex>` return contract. */
function enc(buf: Buffer): string {
  return `sha256:${buf.toString("hex")}`;
}

const h1 = h("cp1");
const h2 = h("cp2");
const h3 = h("cp3");
const h4 = h("cp4");
const h5 = h("cp5");
const [d1, d2, d3, d4, d5] = [h1, h2, h3, h4, h5].map(dec);

describe("merkleRoot — §3.3 deterministic root", () => {
  describe("fixed vectors (expected computed directly with node:crypto)", () => {
    it("1 leaf → the leaf value itself, normalized to sha256:<lower-hex>", () => {
      // Rule 5: single leaf → root IS that leaf (its 32-byte value re-encoded).
      expect(merkleRoot([h1])).toBe(enc(d1));
      expect(merkleRoot([h1])).toBe(h1); // h1 is already normalized
    });

    it("2 leaves → sha256(d1 ‖ d2)", () => {
      expect(merkleRoot([h1, h2])).toBe(enc(node(d1, d2)));
    });

    it("3 leaves → sha256( sha256(d1 ‖ d2) ‖ d3 ) (d3 promoted, not duplicated)", () => {
      const p12 = node(d1, d2);
      const expected = enc(node(p12, d3));
      expect(merkleRoot([h1, h2, h3])).toBe(expected);
    });

    it("5 leaves → level1=[p12,p34,d5], level2=[q,d5], root=sha256(q ‖ d5)", () => {
      const p12 = node(d1, d2);
      const p34 = node(d3, d4);
      const q = node(p12, p34);
      const root = node(q, d5);
      expect(merkleRoot([h1, h2, h3, h4, h5])).toBe(enc(root));
    });
  });

  describe("prefix / case normalization (byte-exactness across formats)", () => {
    it("a bare 64-hex leaf (no sha256: prefix) yields the same root as the prefixed form", () => {
      const bare = h1.replace(/^sha256:/, "");
      expect(merkleRoot([bare, h2])).toBe(merkleRoot([h1, h2]));
    });

    it("uppercase-hex leaves normalize to the same lower-hex root", () => {
      const up1 = h1.toUpperCase().replace(/^SHA256:/, "sha256:");
      const up2 = h2.toUpperCase().replace(/^SHA256:/, "sha256:");
      expect(merkleRoot([up1, up2])).toBe(merkleRoot([h1, h2]));
    });
  });

  describe("order-sensitivity (order is part of the chain's meaning — never sorted)", () => {
    it("swapping two leaves yields a DIFFERENT root", () => {
      expect(merkleRoot([h1, h2])).not.toBe(merkleRoot([h2, h1]));
    });

    it("permuting within a 3-leaf set changes the root", () => {
      expect(merkleRoot([h1, h2, h3])).not.toBe(merkleRoot([h1, h3, h2]));
    });
  });

  describe("fail-closed", () => {
    it("empty array → throws (§8.4-B-1: zero-checkpoint package is invalid)", () => {
      expect(() => merkleRoot([])).toThrow(/empty checkpoint set/);
    });

    it("a non-hex leaf → throws", () => {
      expect(() => merkleRoot(["sha256:not-hex-not-hex-not-hex-not-hex-not-hex-not-hex-not-hex-notxy"])).toThrow(
        /malformed leaf hash/,
      );
    });

    it("a too-short (truncated) leaf → throws (no silent truncation)", () => {
      // 62 hex chars — Buffer.from would silently drop the odd nibble; the regex guard rejects it.
      expect(() => merkleRoot([`sha256:${"a".repeat(62)}`])).toThrow(/malformed leaf hash/);
    });

    it("one malformed leaf among valid ones → throws (whole root fails closed)", () => {
      expect(() => merkleRoot([h1, "sha256:zz", h3])).toThrow(/malformed leaf hash/);
    });
  });
});
