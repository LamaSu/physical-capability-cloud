/**
 * VECTORS ONLY: the lenient, sample-compatible FinalMilestonePackageV2 digest.
 *
 * `packageDigestV2Unchecked` hashes any conforming body and any two-entry signature
 * set `canonicalSignatures` accepts. Those include the published sample's foreign
 * scheme labels, its 40-digit "ed25519" signer and its free-text principals, which
 * is exactly what lets it reproduce `g2-settlement-vector-golden.json` byte for byte.
 *
 * NEVER FOR MONEY. It runs none of the mint guard's checks, and it returns a plain
 * `Hex`, never `MintablePackageDigest`. Money uses `mintablePackageDigest`
 * (package-digest-v2.ts), which accepts only a package `assertMintablePackage`
 * returned (cross-family E9b). A source scan in package-digest-v2.test.ts fails
 * the build if any production module under packages/gateway/src imports this file.
 */
import { packageDigestV2OfPreImage, packageDigestV2PreImage, type Hex } from "./package-digest-v2.js";

export function packageDigestV2Unchecked(body: unknown, sigs: unknown): Hex {
  return packageDigestV2OfPreImage(packageDigestV2PreImage(body, sigs));
}
