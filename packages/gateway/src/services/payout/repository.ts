import { randomUUID } from "node:crypto";
import { sql } from "@pcc/store";
import { ownerOf } from "../../auth/kernel-authority.js";
import { getStore } from "../../db.js";
import { PAYOUT_CONSENT_SHA256, PAYOUT_CONSENT_VERSION, payoutConsent } from "./consent.js";

// Internal persistence shape; no payment path consumes this record.
export interface PayoutBindingRow {
  id: string;
  kernel_id: string;
  chain_id: number;
  payout_address: string;
  bound_by_wallet: string;
  proof_via: "siwe-session";
  proof_carrier: "key" | "bearer-session";
  consent_version: string;
  consent_sha256: string;
  created_at: string;
  revoked_at: string | null;
  revoked_by: "owner" | "admin" | null;
  revoke_reason: "owner_revoked" | "admin_revoked" | "rebound" | null;
}

export class PayoutOwnerChanged extends Error {}

function boundView(row: PayoutBindingRow) {
  return {
    kernelId: row.kernel_id, chainId: row.chain_id, bound: true as const,
    payoutAddress: row.payout_address, boundAt: row.created_at,
    proof: { via: row.proof_via, carrier: row.proof_carrier },
    consentVersion: row.consent_version, consentSha256: row.consent_sha256, consent: payoutConsent,
  };
}

/** Every use re-reads both the active record and the kernel's current owner. Errors propagate. */
export function resolvePayoutBinding(kernelId: string, chainId: number) {
  const { db } = getStore();
  const kernel = db.get<{ operator_address: string }>(sql`SELECT operator_address FROM shop_kernels WHERE id = ${kernelId}`);
  const active = db.get<PayoutBindingRow>(sql`SELECT * FROM kernel_payout_bindings
    WHERE kernel_id = ${kernelId} AND chain_id = ${chainId} AND revoked_at IS NULL`);
  if (active && active.bound_by_wallet === ownerOf(kernel?.operator_address)) return boundView(active);
  const reason = active ? "owner_changed" as const
    : db.get(sql`SELECT id FROM kernel_payout_bindings WHERE kernel_id = ${kernelId} AND chain_id = ${chainId} LIMIT 1`)
      ? "revoked" as const : "none" as const;
  return { kernelId, chainId, bound: false as const, reason, consent: payoutConsent };
}

/** Check and append/revoke under the same write lock; an idempotent request writes nothing. */
export function bindPayoutWallet(input: {
  kernelId: string; chainId: number; wallet: string; carrier: "key" | "bearer-session";
}) {
  return getStore().db.transaction((tx) => {
    const wallet = input.wallet.toLowerCase();
    const kernel = tx.get<{ operator_address: string }>(sql`SELECT operator_address FROM shop_kernels WHERE id = ${input.kernelId}`);
    if (ownerOf(kernel?.operator_address) !== wallet) throw new PayoutOwnerChanged();
    const active = tx.get<PayoutBindingRow>(sql`SELECT * FROM kernel_payout_bindings
      WHERE kernel_id = ${input.kernelId} AND chain_id = ${input.chainId} AND revoked_at IS NULL`);
    if (active && active.bound_by_wallet === wallet
      && active.consent_version === PAYOUT_CONSENT_VERSION && active.consent_sha256 === PAYOUT_CONSENT_SHA256) {
      return { created: false, binding: boundView(active) };
    }
    const now = new Date().toISOString();
    if (active) {
      tx.run(sql`UPDATE kernel_payout_bindings SET revoked_at = ${now}, revoked_by = 'owner', revoke_reason = 'rebound'
        WHERE id = ${active.id} AND revoked_at IS NULL`);
    }
    const row: PayoutBindingRow = {
      id: randomUUID(), kernel_id: input.kernelId, chain_id: input.chainId,
      payout_address: wallet, bound_by_wallet: wallet, proof_via: "siwe-session", proof_carrier: input.carrier,
      consent_version: PAYOUT_CONSENT_VERSION, consent_sha256: PAYOUT_CONSENT_SHA256, created_at: now,
      revoked_at: null, revoked_by: null, revoke_reason: null,
    };
    tx.run(sql`INSERT INTO kernel_payout_bindings
      (id, kernel_id, chain_id, payout_address, bound_by_wallet, proof_via, proof_carrier, consent_version, consent_sha256, created_at)
      VALUES (${row.id}, ${row.kernel_id}, ${row.chain_id}, ${row.payout_address}, ${row.bound_by_wallet},
        ${row.proof_via}, ${row.proof_carrier}, ${row.consent_version}, ${row.consent_sha256}, ${row.created_at})`);
    return { created: true, binding: boundView(row) };
  }, { behavior: "immediate" });
}

export function revokePayoutWallet(kernelId: string, chainId: number, actor: "owner" | "admin") {
  const now = new Date().toISOString();
  const reason = actor === "admin" ? "admin_revoked" : "owner_revoked";
  const row = getStore().db.get<PayoutBindingRow>(sql`UPDATE kernel_payout_bindings
    SET revoked_at = ${now}, revoked_by = ${actor}, revoke_reason = ${reason}
    WHERE kernel_id = ${kernelId} AND chain_id = ${chainId} AND revoked_at IS NULL RETURNING *`);
  return row ? {
    kernelId: row.kernel_id, chainId: row.chain_id, payoutAddress: row.payout_address, boundAt: row.created_at,
    revokedAt: row.revoked_at, revokedBy: row.revoked_by, revokeReason: row.revoke_reason,
  } : null;
}
