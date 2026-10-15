import { sql } from "@pcc/store";
import { getStore } from "../../db.js";
import { WalletLinkError } from "../wallet-links/repository.js";
import { FAUCET_PLAN } from "./plan.js";

// Private database projections deliberately exclude unrelated link metadata.
type FundingLink = {
  id: string; account_id: string; role: "agent" | "device"; key_type: string;
  address_or_pubkey: string; chain_id: number; revoked_at: string | null; expires_at: string | null;
};
type Claim = {
  link_id: string; token: "eth" | "usdc"; seq: number; amount: "0.0001" | "1";
  status: "pending" | "succeeded" | "failed"; tx_hash: string | null; error_class: string | null;
  attempts: number; lease_until: string | null; last_attempt_at: string | null;
};
export class FaucetError extends WalletLinkError {
  constructor(status: number, code: string, readonly cap?: "address" | "account" | "global") { super(status, code); }
}
const projection = sql`id, account_id, role, key_type, address_or_pubkey, chain_id, revoked_at, expires_at`;

export function cliFundingLink(id: string, now: number): FundingLink {
  const request = getStore().db.get<{ link_id: string | null; decided_at: string | null }>(sql`
    SELECT link_id, decided_at FROM wallet_link_requests WHERE id = ${id} AND status = 'approved'`);
  if (!request?.link_id) throw new FaucetError(404, "link_request_not_found");
  if (!request.decided_at || !Number.isFinite(Date.parse(request.decided_at)) || now >= Date.parse(request.decided_at) + 3600000) {
    throw new FaucetError(403, "capability_expired");
  }
  const link = getStore().db.get<FundingLink>(sql`SELECT ${projection} FROM wallet_links WHERE id = ${request.link_id}`);
  if (!link) throw new FaucetError(404, "link_request_not_found");
  return link;
}

export function ownerFundingLink(id: string, accountId: string, credential: string | null): FundingLink {
  const row = getStore().db.get<FundingLink>(sql`SELECT ${projection} FROM wallet_links
    WHERE id = ${id} AND account_id = ${accountId}
      AND ${credential === null ? sql`approved_by_key_id IS NULL` : sql`approved_by_key_id = ${credential}`}`);
  if (!row) throw new FaucetError(404, "link_not_found");
  return row;
}

export function checkFundingLink(link: FundingLink, now: number): void {
  if (link.revoked_at || (link.expires_at !== null && Date.parse(link.expires_at) <= now)) throw new FaucetError(403, "link_inactive");
  if (link.key_type !== "secp256k1" || link.chain_id !== 84532) throw new FaucetError(409, "not_fundable");
}

export function currentFundingLink(id: string, now: number): FundingLink {
  const link = getStore().db.get<FundingLink>(sql`SELECT ${projection} FROM wallet_links WHERE id = ${id}`);
  if (!link) throw new FaucetError(403, "link_inactive");
  checkFundingLink(link, now);
  return link;
}

export function fundingClaims(id: string): Claim[] {
  return getStore().db.all<Claim>(sql`SELECT link_id, token, seq, amount, status, tx_hash, error_class,
    attempts, lease_until, last_attempt_at FROM faucet_claims WHERE link_id = ${id}
    ORDER BY CASE token WHEN 'eth' THEN 0 ELSE 1 END, seq`);
}

/** Checks and the entire grant are serialized together; refusals write nothing. */
export function ensureFundingGrant(id: string, now: number): Claim[] {
  const db = getStore().db;
  return db.transaction(tx => {
    const link = tx.get<FundingLink>(sql`SELECT ${projection} FROM wallet_links WHERE id = ${id}`);
    if (!link) throw new FaucetError(403, "link_inactive");
    checkFundingLink(link, now);
    if (tx.get(sql`SELECT link_id FROM faucet_claims WHERE link_id = ${id} LIMIT 1`)) return fundingClaims(id);
    const plan = FAUCET_PLAN[link.role];
    const eth = plan.filter(claim => claim.token === "eth").length;
    const usdc = plan.filter(claim => claim.token === "usdc").length;
    const address = link.address_or_pubkey.toLowerCase();
    const cutoff = new Date(now - 86400000).toISOString();
    const timestamp = new Date(now).toISOString();
    const counts = tx.get<{ eth: number; usdc: number }>(sql`SELECT
      count(CASE WHEN token = 'eth' THEN 1 END) AS eth,
      count(CASE WHEN token = 'usdc' THEN 1 END) AS usdc
      FROM faucet_claims WHERE lower(address) = ${address} AND created_at > ${cutoff}`)!;
    if (counts.eth + eth > 10 || counts.usdc + usdc > 3) throw new FaucetError(409, "cap_reached", "address");
    const account = tx.get<{ n: number }>(sql`SELECT count(DISTINCT link_id) AS n FROM faucet_claims
      WHERE account_id = ${link.account_id} AND created_at > ${cutoff}`)!;
    if (account.n + 1 > 3) throw new FaucetError(409, "cap_reached", "account");
    const global = tx.get<{ n: number }>(sql`SELECT count(*) AS n FROM faucet_claims
      WHERE token = 'usdc' AND created_at > ${cutoff}`)!;
    if (global.n + usdc > 8) throw new FaucetError(409, "cap_reached", "global");
    for (const claim of plan) tx.run(sql`INSERT INTO faucet_claims
      (link_id, token, seq, account_id, address, chain_id, amount, status, created_at, updated_at)
      VALUES (${id}, ${claim.token}, ${claim.seq}, ${link.account_id}, ${address}, ${link.chain_id},
        ${claim.amount}, 'pending', ${timestamp}, ${timestamp})`);
    return fundingClaims(id);
  }, { behavior: "immediate" });
}

export function liveLease(claim: Claim, now: number): boolean {
  return claim.lease_until !== null && Date.parse(claim.lease_until) > now;
}
export function attemptableClaim(claim: Claim, now: number): boolean {
  if (liveLease(claim, now)) return false;
  return claim.status === "pending" || (claim.status === "failed" && claim.attempts < 5 &&
    claim.last_attempt_at !== null && Date.parse(claim.last_attempt_at) <= now - 30000);
}

/** UPDATE RETURNING grants the lease and rechecks current link state atomically. */
export function leaseFundingClaim(claim: Claim, now: number): Claim | undefined {
  const timestamp = new Date(now).toISOString();
  const retryCutoff = new Date(now - 30000).toISOString();
  return getStore().db.get<Claim>(sql`UPDATE faucet_claims
    SET lease_until = ${new Date(now + 60000).toISOString()}, attempts = attempts + 1,
      last_attempt_at = ${timestamp}, updated_at = ${timestamp}
    WHERE link_id = ${claim.link_id} AND token = ${claim.token} AND seq = ${claim.seq}
      AND (lease_until IS NULL OR lease_until <= ${timestamp})
      AND (status = 'pending' OR (status = 'failed' AND attempts < 5 AND last_attempt_at <= ${retryCutoff}))
      AND EXISTS (SELECT 1 FROM wallet_links WHERE id = faucet_claims.link_id
        AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ${timestamp}))
      AND NOT EXISTS (SELECT 1 FROM faucet_claims AS prior WHERE prior.link_id = faucet_claims.link_id
        AND prior.lease_until > ${timestamp})
    RETURNING link_id, token, seq, amount, status, tx_hash, error_class, attempts, lease_until, last_attempt_at`);
}

export function validTransactionHash(value: unknown): value is string {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value) && !/^0x([0-9a-f])\1{63}$/.test(value.toLowerCase());
}

/** Canonical hashes enforce uniqueness across alternate hex casing too. */
export function finishFundingClaim(claim: Claim, txHash: string | undefined, errorClass: string | undefined, now: number): void {
  const db = getStore().db;
  db.transaction(tx => {
    let hash = txHash?.toLowerCase();
    if (hash && tx.get(sql`SELECT 1 FROM faucet_claims WHERE lower(tx_hash) = ${hash}`)) {
      hash = undefined;
      errorClass = "invalid_tx_hash";
    }
    tx.run(sql`UPDATE faucet_claims SET status = ${hash ? "succeeded" : "failed"}, tx_hash = ${hash ?? null},
      error_class = ${hash ? null : errorClass ?? "unknown"}, lease_until = NULL, updated_at = ${new Date(now).toISOString()}
      WHERE link_id = ${claim.link_id} AND token = ${claim.token} AND seq = ${claim.seq}
        AND attempts = ${claim.attempts} AND lease_until = ${claim.lease_until} AND last_attempt_at = ${claim.last_attempt_at}`);
  }, { behavior: "immediate" });
}
