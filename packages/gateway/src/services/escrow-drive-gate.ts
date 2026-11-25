import { eq, schema, sql } from "@pcc/store";
import { getStore } from "../db.js";
import { BUYER_FUNDED_ESCROW_VERSION, ESCROW_BUYER_FUNDED } from "./buyer-funded-escrow.js";

export const escrowDriveReads = {
  rowsOnCwm(cwmId: string) {
    return getStore().db.select().from(schema.escrows).where(eq(schema.escrows.cwmId, cwmId)).all();
  },
  rowsAtAddress(address: string) {
    return getStore().db.select().from(schema.escrows)
      .where(sql`lower(${schema.escrows.contractAddress}) = ${address.toLowerCase()}`).all();
  },
};

/** A drive requires one address row with a known version and an unambiguous cwm. */
export function resolveEscrowDrive({ cwmId, address }: { cwmId: string | null | undefined; address: string }):
  | { drive: true; version: "v2" | "v3" }
  | { drive: false; reason: "escrow_row_missing" | "escrow_rows_ambiguous" | "escrow_version_unknown"
      | typeof ESCROW_BUYER_FUNDED | "escrow_lookup_unavailable" } {
  try {
    const cwmRows = typeof cwmId === "string" && cwmId.length > 0 ? escrowDriveReads.rowsOnCwm(cwmId) : [];
    const addressRows = typeof address === "string" && address.length > 0 ? escrowDriveReads.rowsAtAddress(address) : [];
    if (cwmRows.length >= 2) return { drive: false, reason: "escrow_rows_ambiguous" };
    if (addressRows.length === 0) return { drive: false, reason: "escrow_row_missing" };
    if (addressRows.length >= 2) return { drive: false, reason: "escrow_rows_ambiguous" };

    const { version } = addressRows[0];
    if (version === "v3") return { drive: true, version: "v3" };
    if (version === "v2" || version === null || version === undefined) return { drive: true, version: "v2" };
    if (version === BUYER_FUNDED_ESCROW_VERSION) return { drive: false, reason: ESCROW_BUYER_FUNDED };
    return { drive: false, reason: "escrow_version_unknown" };
  } catch {
    return { drive: false, reason: "escrow_lookup_unavailable" };
  }
}
