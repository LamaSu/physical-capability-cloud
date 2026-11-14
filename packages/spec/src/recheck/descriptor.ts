import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { SETTLEMENT_RECHECK_MAPS } from "./map.js";
import { KIT_ABI } from "./abi.js";
import { KNOWN_DEPLOYMENTS } from "./deployments.js";

/** Bump deliberately whenever kit content changes; C10 pins this with its digest. */
export const KIT_VERSION = "1.0.1";

/** Discovery only: clients trust their own embedded kit, not a gateway copy. */
export function recheckKitDescriptor() {
  const content = {
    schema: "pcc-settlement-recheck/v1" as const,
    kitVersion: KIT_VERSION,
    readSurfaces: SETTLEMENT_RECHECK_MAPS,
    abi: KIT_ABI,
    deployments: KNOWN_DEPLOYMENTS,
  };
  const kitSha256 = bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(content))));
  return { ...content, kitSha256 };
}
