import { randomBytes, randomInt } from "node:crypto";
import { sql } from "@pcc/store";
import { getStore } from "../../db.js";
import { composeProofMessage, type WalletLinkMessageRequest } from "./message.js";
import { walletLinkConfig, type WalletLinkConfig } from "./config.js";
import { CONSENT_SHA256, CONSENT_VERSION } from "./consent.js";

// Internal persistence shapes; HTTP validation lives in the route plugin.
export type LinkRequestRow = WalletLinkMessageRequest & {
  message: string;
  client_info: string | null;
  user_code: string;
  status: "pending_proof" | "awaiting_approval" | "approved" | "denied" | "failed" | "expired";
  proof_signature: string | null;
  proof_consumed_at: string | null;
  account_id: string | null;
  created_by_key_id: string | null;
  approved_by: string | null;
  approved_by_key_id: string | null;
  decided_at: string | null;
  link_id: string | null;
  requester_ip_class: string;
};

type LinkRow = {
  id: string; account_id: string; role: "agent" | "device"; key_type: "secp256k1" | "ed25519";
  address_or_pubkey: string; chain_id: number; label: string; created_at: string; expires_at: string | null;
  revoked_at: string | null;
};

export class WalletLinkError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

/** 128 random bits encoded as 26 RFC 4648 base32 characters, without padding. */
export function walletId(prefix: "lr" | "wl"): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, value = 0, encoded = "";
  for (const byte of randomBytes(16)) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { bits -= 5; encoded += alphabet[(value >>> bits) & 31]; }
  }
  if (bits) encoded += alphabet[(value << (5 - bits)) & 31];
  return `${prefix}_${encoded}`;
}

const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
function newUserCode(): string {
  return Array.from({ length: 8 }, () => USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)]).join("");
}

export function normalizeUserCode(code: string): string { return code.toUpperCase().replace(/[- ]/g, ""); }
export function displayUserCode(code: string): string { return `${code.slice(0, 4)}-${code.slice(4)}`; }

export function getLinkRequest(id: string): LinkRequestRow | undefined {
  return getStore().db.get<LinkRequestRow>(sql`SELECT * FROM wallet_link_requests WHERE id = ${id}`);
}

export function createLinkRequest(input: {
  keyType: "secp256k1" | "ed25519"; identity: string; role: "agent" | "device"; label: string;
  chainId: number; clientInfo?: { name: string; version: string }; kernelId?: string;
}, requesterIpClass: string, config: WalletLinkConfig, now: number, createdByKeyId: string | null = null): LinkRequestRow {
  const db = getStore().db;
  return db.transaction(tx => {
    const timestamp = new Date(now).toISOString();
    // Release pending user codes and pending-key slots when their requests expire.
    tx.run(sql`UPDATE wallet_link_requests SET status = 'expired'
      WHERE status IN ('pending_proof', 'awaiting_approval') AND expires_at <= ${timestamp}`);
    const count = tx.get<{ n: number }>(sql`SELECT count(*) AS n FROM wallet_link_requests
      WHERE key_type = ${input.keyType} AND lower(address_or_pubkey) = ${input.identity.toLowerCase()}
      AND status IN ('pending_proof', 'awaiting_approval') AND expires_at > ${timestamp}`);
    if ((count?.n ?? 0) >= 3) throw new WalletLinkError(429, "rate_limited");
    let code: string;
    do { code = newUserCode(); } while (tx.get(sql`SELECT id FROM wallet_link_requests WHERE user_code = ${code}
      AND status IN ('pending_proof', 'awaiting_approval')`));
    const row: LinkRequestRow = {
      id: walletId("lr"), key_type: input.keyType, address_or_pubkey: input.identity, role: input.role,
      label: input.label, client_info: input.clientInfo ? JSON.stringify(input.clientInfo) : null,
      kernel_id: input.kernelId ?? null, chain_id: input.chainId, env: config.env, domain: config.domain,
      nonce: randomBytes(16).toString("hex"), user_code: code, status: "pending_proof", message: "",
      consent_version: CONSENT_VERSION, consent_sha256: CONSENT_SHA256, proof_signature: null,
      proof_consumed_at: null, account_id: null, created_by_key_id: createdByKeyId,
      approved_by: null, approved_by_key_id: null, decided_at: null, link_id: null,
      requester_ip_class: requesterIpClass, created_at: timestamp, expires_at: new Date(now + 600000).toISOString(),
    };
    row.message = composeProofMessage(row, config);
    tx.run(sql`INSERT INTO wallet_link_requests
      (id, key_type, address_or_pubkey, role, label, client_info, kernel_id, chain_id, env, domain, nonce,
       user_code, status, message, consent_version, consent_sha256, requester_ip_class, created_at, expires_at, created_by_key_id)
      VALUES (${row.id}, ${row.key_type}, ${row.address_or_pubkey}, ${row.role}, ${row.label}, ${row.client_info},
       ${row.kernel_id}, ${row.chain_id}, ${row.env}, ${row.domain}, ${row.nonce}, ${row.user_code}, ${row.status},
       ${row.message}, ${row.consent_version}, ${row.consent_sha256}, ${row.requester_ip_class}, ${row.created_at}, ${row.expires_at}, ${row.created_by_key_id})`);
    return row;
  }, { behavior: "immediate" });
}

/** The statement consumes before any cryptography, including failed signatures. */
export function claimLinkProof(id: string, now: number): LinkRequestRow {
  const timestamp = new Date(now).toISOString();
  const row = getStore().db.get<LinkRequestRow>(sql`UPDATE wallet_link_requests SET proof_consumed_at = ${timestamp}
    WHERE id = ${id} AND proof_consumed_at IS NULL AND expires_at > ${timestamp} RETURNING *`);
  if (row) return row;
  const existing = getLinkRequest(id);
  if (!existing) throw new WalletLinkError(404, "not_found");
  if (Date.parse(existing.expires_at) <= now) throw new WalletLinkError(410, "expired");
  throw new WalletLinkError(409, "already_used");
}

export function finishLinkProof(row: LinkRequestRow, signature: string, valid: boolean): void {
  getStore().db.run(sql`UPDATE wallet_link_requests
    SET status = ${valid ? "awaiting_approval" : "failed"}, proof_signature = ${signature}
    WHERE id = ${row.id} AND status = 'pending_proof'`);
}

export function lookupLinkRequestByCode(code: string, now: number): LinkRequestRow | undefined {
  return getStore().db.get<LinkRequestRow>(sql`SELECT * FROM wallet_link_requests
    WHERE user_code = ${normalizeUserCode(code)} AND status = 'awaiting_approval'
      AND expires_at > ${new Date(now).toISOString()}`);
}

export function decideLinkRequest(id: string, accountId: string, decision: "approve" | "deny", now: number, approvedByKeyId: string | null = null) {
  const db = getStore().db;
  return db.transaction(tx => {
    const timestamp = new Date(now).toISOString();
    const row = tx.get<LinkRequestRow>(sql`UPDATE wallet_link_requests
      SET status = ${decision === "approve" ? "approved" : "denied"}, account_id = ${accountId},
        approved_by = ${accountId}, approved_by_key_id = ${approvedByKeyId}, decided_at = ${timestamp}
      WHERE id = ${id} AND status = 'awaiting_approval' AND expires_at > ${timestamp} RETURNING *`);
    if (!row) {
      const existing = tx.get<LinkRequestRow>(sql`SELECT * FROM wallet_link_requests WHERE id = ${id}`);
      if (!existing) throw new WalletLinkError(404, "not_found");
      if (Date.parse(existing.expires_at) <= now) throw new WalletLinkError(410, "expired");
      throw new WalletLinkError(409, "already_decided");
    }
    if (decision === "deny") return { status: "denied" as const };
    tx.run(sql`UPDATE wallet_links SET revoked_at = ${timestamp}, revoke_reason = 'expired'
      WHERE key_type = ${row.key_type} AND lower(address_or_pubkey) = ${row.address_or_pubkey.toLowerCase()}
      AND chain_id = ${row.chain_id} AND revoked_at IS NULL AND expires_at IS NOT NULL AND expires_at <= ${timestamp}`);
    if (tx.get(sql`SELECT id FROM wallet_links WHERE key_type = ${row.key_type}
      AND lower(address_or_pubkey) = ${row.address_or_pubkey.toLowerCase()} AND chain_id = ${row.chain_id}
      AND revoked_at IS NULL`)) throw new WalletLinkError(409, "already_linked");
    const linkId = walletId("wl");
    const expiresAt = row.role === "agent" ? new Date(now + 30 * 86400000).toISOString() : null;
    tx.run(sql`INSERT INTO wallet_links
      (id, account_id, role, subject_type, subject_id, key_type, address_or_pubkey, chain_id, label,
       consent_version, consent_sha256, proof_message, proof_signature, approval_signature,
       request_id, approved_by, created_at, expires_at, created_by_key_id, approved_by_key_id)
      VALUES (${linkId}, ${accountId}, ${row.role}, ${row.role}, ${row.kernel_id}, ${row.key_type},
       ${row.address_or_pubkey}, ${row.chain_id}, ${row.label}, ${row.consent_version}, ${row.consent_sha256},
       ${row.message}, ${row.proof_signature}, NULL, ${row.id}, ${accountId}, ${timestamp}, ${expiresAt}, ${row.created_by_key_id}, ${approvedByKeyId})`);
    tx.run(sql`UPDATE wallet_link_requests SET link_id = ${linkId} WHERE id = ${row.id}`);
    return { status: "approved" as const, linkId, accountId };
  }, { behavior: "immediate" });
}

export function listWalletLinks(accountId: string, now: number, approvedByKeyId: string | null = null) {
  return getStore().db.all<LinkRow>(sql`SELECT * FROM wallet_links WHERE account_id = ${accountId}
    AND ${approvedByKeyId === null ? sql`approved_by_key_id IS NULL` : sql`approved_by_key_id = ${approvedByKeyId}`}
    ORDER BY created_at, id`).map(row => ({
    linkId: row.id, role: row.role, keyType: row.key_type,
    ...(row.key_type === "secp256k1" ? { address: row.address_or_pubkey } : { publicKey: row.address_or_pubkey }),
    label: row.label, chainId: row.chain_id,
    status: row.revoked_at ? "revoked" : row.expires_at && Date.parse(row.expires_at) <= now ? "expired" : "active",
    createdAt: row.created_at, expiresAt: row.expires_at, revokedAt: row.revoked_at,
  }));
}

export function revokeWalletLink(id: string, accountId: string, reason: string | undefined, now: number, approvedByKeyId: string | null = null) {
  const timestamp = new Date(now).toISOString();
  const row = getStore().db.get<{ revoked_at: string }>(sql`UPDATE wallet_links
    SET revoked_at = COALESCE(revoked_at, ${timestamp}),
      revoked_by = CASE WHEN revoked_at IS NULL THEN ${accountId} ELSE revoked_by END,
      revoke_reason = CASE WHEN revoked_at IS NULL THEN ${reason ?? null} ELSE revoke_reason END
    WHERE id = ${id} AND account_id = ${accountId}
      AND ${approvedByKeyId === null ? sql`approved_by_key_id IS NULL` : sql`approved_by_key_id = ${approvedByKeyId}`}
      RETURNING revoked_at`);
  if (!row) throw new WalletLinkError(404, "not_found");
  return { status: "revoked", revokedAt: row.revoked_at };
}

export function findSelfLinkedWallet(input: { address: string; apiKeyId: string; operatorId: string; now: number }): boolean {
  const chains = walletLinkConfig().allowedChainIds;
  if (chains.length === 0) return false;
  const row = getStore().db.get<{ id: string }>(sql`SELECT link.id FROM wallet_links AS link
    JOIN wallet_link_requests AS request ON request.id = link.request_id
    WHERE link.key_type = 'secp256k1' AND lower(link.address_or_pubkey) = ${input.address.toLowerCase()}
      AND link.chain_id IN (${sql.join(chains.map(chain => sql`${chain}`), sql`, `)})
      AND link.revoked_at IS NULL AND (link.expires_at IS NULL OR link.expires_at > ${new Date(input.now).toISOString()})
      AND request.created_by_key_id = ${input.apiKeyId} AND request.approved_by_key_id = ${input.apiKeyId}
      AND link.account_id = ${input.operatorId}
    LIMIT 1`);
  return row !== undefined;
}

/** Reads current database state for every payer-binding/faucet use; never cached. */
export async function resolveActiveWalletLink(input: { keyType?: "secp256k1"; address: string; chainId: number }) {
  const now = new Date(Date.now()).toISOString();
  const row = getStore().db.get<LinkRow>(sql`SELECT * FROM wallet_links
    WHERE key_type = ${input.keyType ?? "secp256k1"} AND lower(address_or_pubkey) = ${input.address.toLowerCase()}
      AND chain_id = ${input.chainId} AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ${now})`);
  if (!row) return null;
  return { linkId: row.id, accountId: row.account_id, role: row.role, label: row.label,
    keyType: row.key_type, chainId: row.chain_id, createdAt: row.created_at, expiresAt: row.expires_at };
}
