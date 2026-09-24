/**
 * The real SHA-256 of a file's bytes, as "sha256:<64 hex chars>".
 *
 * The onboarding wizard used to record `sha256:${Math.random()...}` for every
 * uploaded document. A hash that is not a hash of the bytes is worse than none,
 * so this returns null when WebCrypto is unavailable (for example, a page
 * served over plain HTTP), and callers must show that no hash was computed.
 */
export async function sha256OfBlob(blob: Blob): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  const digest = await subtle.digest("SHA-256", await blob.arrayBuffer());
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  return `sha256:${hex}`;
}
