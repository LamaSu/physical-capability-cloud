import { DEFAULT_MARGIN_SECONDS, FUNDING_PREPARE_SCHEMA } from "@pcc/spec/funding";
import { formatUnits } from "viem";
import { authorizedFetch } from "./authorized-fetch.js";
import { FUND_COPY, FUND_REFUSALS } from "./fund-copy.js";
import { SIGN_IN_EXPIRED, SIGN_IN_REFUSED } from "./wallet-link-api.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class FundingReadError extends Error {}

async function send(path: string, init: RequestInit): Promise<Response> {
  try {
    return await authorizedFetch(path, { ...init, cache: "no-store", credentials: "omit" });
  } catch {
    throw new FundingReadError(FUND_COPY.L4);
  }
}

export async function readFunding(jobId: string) {
  const response = await send(`/api/jobs/${encodeURIComponent(jobId)}/funding`, { method: "GET" });
  if (response.status === 401) throw new FundingReadError(SIGN_IN_EXPIRED);
  if (response.status === 403) throw new FundingReadError(SIGN_IN_REFUSED);
  if (response.status === 404) throw new FundingReadError(FUND_COPY.L7);
  if (response.status !== 200) throw new FundingReadError(FUND_COPY.L4);
  const body: unknown = await response.json().catch(() => null);
  if (!isRecord(body) || typeof body.jobId !== "string" || !Array.isArray(body.scopes)) {
    throw new FundingReadError(FUND_COPY.L4);
  }
  return body.scopes.map((row: unknown) => {
    if (!isRecord(row) || typeof row.scopeId !== "string" ||
      (row.state !== "prepared" && row.state !== "awaiting_funding" && row.state !== "funded_verified" &&
        row.state !== "expired" && row.state !== "cancelled" && row.state !== "unknown") ||
      !isRecord(row.scope) || typeof row.scope.expiresAt !== "string" ||
      !(row.verification === null || isRecord(row.verification))) {
      throw new FundingReadError(FUND_COPY.L4);
    }
    return { scopeId: row.scopeId, state: row.state, expiresAt: row.scope.expiresAt, verification: row.verification };
  });
}

export async function readOrderOperator(jobId: string) {
  async function read(path: string) {
    const response = await send(path, { method: "GET" });
    if (response.status === 401) throw new FundingReadError(SIGN_IN_EXPIRED);
    if (response.status === 403) throw new FundingReadError(SIGN_IN_REFUSED);
    if (response.status === 404) throw new FundingReadError(FUND_COPY.L7);
    if (response.status !== 200) throw new FundingReadError(FUND_COPY.L4);
    const body: unknown = await response.json().catch(() => null);
    if (!isRecord(body)) throw new FundingReadError(FUND_COPY.L4);
    return body;
  }
  const body = await read(`/api/jobs/${encodeURIComponent(jobId)}`);
  if (!isRecord(body.job) || typeof body.job.kernelId !== "string" || body.job.kernelId.length === 0) {
    throw new FundingReadError(FUND_COPY.L4);
  }
  const snapshot = await read(`/api/kernels/${encodeURIComponent(body.job.kernelId)}`);
  if (!isRecord(snapshot.kernel)) throw new FundingReadError(FUND_COPY.L4);
  const operator = snapshot.kernel.operatorAddress;
  if (typeof operator !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(operator)) throw new FundingReadError(FUND_COPY.L23);
  return operator.toLowerCase() as `0x${string}`;
}

export function readServedTerms(text: string, now = Date.now()) {
  try {
    const body: unknown = JSON.parse(text);
    if (!isRecord(body) || body.schema !== FUNDING_PREPARE_SCHEMA || body.chainId !== "84532" ||
      typeof body.escrow !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(body.escrow) ||
      typeof body.totalGross !== "string" || !/^[1-9][0-9]{0,30}$/.test(body.totalGross) ||
      typeof body.expiry !== "string" || !/^[1-9][0-9]{0,15}$/.test(body.expiry)) {
      return { kind: "unreadable" } as const;
    }
    const fundBy = BigInt(body.expiry) - BigInt(DEFAULT_MARGIN_SECONDS);
    if (now >= Number(fundBy) * 1000) return { kind: "passed" } as const;
    return {
      kind: "terms",
      amount: `${formatUnits(BigInt(body.totalGross), 6)} test USDC`,
      escrow: body.escrow,
      fundBy: new Date(Number(fundBy) * 1000).toISOString(),
      payload: body,
    } as const;
  } catch {
    return { kind: "unreadable" } as const;
  }
}

async function prepare(scopeId: string, init: RequestInit) {
  const response = await send(`/api/buyer-funding/scopes/${encodeURIComponent(scopeId)}/prepare`, init);
  if (response.status === 401) throw new FundingReadError(SIGN_IN_EXPIRED);
  if (response.status === 200) {
    const terms = readServedTerms(await response.text().catch(() => ""));
    if (terms.kind === "unreadable") throw new FundingReadError(FUND_COPY.L23);
    if (terms.kind === "passed") throw new FundingReadError(FUND_COPY.L10a);
    return terms;
  }
  const body: unknown = await response.json().catch(() => null);
  if (response.status === 202) {
    if (isRecord(body) && Object.keys(body).length === 3 &&
      body.schema === "pcc.vnext.buyer-funding.pending.v1" && body.state === "pending_signature" &&
      body.retryAfterSeconds === 5) {
      return { kind: "pending", retryAfterSeconds: body.retryAfterSeconds } as const;
    }
    throw new FundingReadError(FUND_COPY.L4);
  }
  const code = isRecord(body) && typeof body.error === "string" ? body.error : "";
  if (response.status === 503 && code === "buyer_funding_unavailable") throw new FundingReadError(FUND_COPY.L6);
  if (response.status === 404 && code === "no_prepare") return { kind: "no-prepare" } as const;
  if (response.status === 404 && code === "scope_not_found") throw new FundingReadError(FUND_COPY.L7);
  if (response.status === 410 && code === "prepare_expired") throw new FundingReadError(FUND_COPY.L10a);
  if (Object.prototype.hasOwnProperty.call(FUND_REFUSALS, code)) {
    const refusal = FUND_REFUSALS[code as keyof typeof FUND_REFUSALS];
    if (response.status === refusal.status) {
      throw new FundingReadError(FUND_COPY[refusal.label].replace("{code}", code));
    }
  }
  if (response.status === 403) {
    throw new FundingReadError(isRecord(body) && body.reason === "buyer_mismatch" ? FUND_COPY.L5 : SIGN_IN_REFUSED);
  }
  throw new FundingReadError(FUND_COPY.L4);
}

export function readPrepare(scopeId: string) {
  return prepare(scopeId, { method: "GET" });
}

export function requestPrepare(scopeId: string) {
  return prepare(scopeId, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
}
