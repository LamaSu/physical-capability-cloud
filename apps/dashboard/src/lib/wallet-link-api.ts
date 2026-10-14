import { authorizedFetch } from "./authorized-fetch.js";

const UNREACHABLE = "Could not reach PCC. Nothing was linked.";
const UNKNOWN_APPROVAL = "PCC did not confirm your decision. The link may have been made; check your terminal before trying again.";
const UNKNOWN_DENIAL = "PCC did not confirm your denial. The request expires on its own.";

class WalletLinkError extends Error {
  constructor(readonly status: number, code: unknown) {
    let message = status >= 400 && status < 500
      ? "PCC refused this request, so nothing was linked. Reload the page and try again."
      : UNREACHABLE;
    if (status === 404) {
      message = "No pending request with this code. It may have expired, been used, or the terminal has not finished signing; check the code and try again.";
    } else if (status === 429) {
      message = "Too many attempts; wait 10 minutes before trying again.";
    } else if (status === 410) {
      message = "This request expired; start again in the terminal.";
    } else if (status === 409 && code === "consent_changed") {
      message = "The terms changed; reload the request by entering the code again.";
    } else if (status === 409 && code === "already_decided") {
      message = "This request was already handled.";
    } else if (status === 409 && code === "already_linked") {
      message = "This wallet is already linked to a PCC account, so nothing was linked. Stop the command in your terminal, or start again there with a new key.";
    } else if (status === 403 && code === "code_mismatch") {
      message = "The code does not match. Check the code and try again.";
    } else if (status === 403) {
      message = "PCC refused this with your current sign-in.";
    } else if (status === 401) {
      message = "Your sign-in is no longer valid; sign in again.";
    }
    super(message);
  }
}

export function walletLinkErrorMessage(error: unknown, decision?: "approve" | "deny"): string {
  // Only a definite 4xx rejection confirms that the submitted decision failed.
  if (decision && (!(error instanceof WalletLinkError) || error.status < 400 || error.status >= 500)) {
    return decision === "approve" ? UNKNOWN_APPROVAL : UNKNOWN_DENIAL;
  }
  return error instanceof WalletLinkError ? error.message : UNREACHABLE;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function send(path: string, init: RequestInit): Promise<unknown> {
  // Relative API paths resolve against the configured gateway inside authorizedFetch.
  const response = await authorizedFetch(path, { ...init, cache: "no-store", credentials: "omit" });
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    throw new WalletLinkError(response.status, isRecord(body) ? body.error : undefined);
  }
  return response.json();
}

export async function getWalletLinkRequest(userCode: string) {
  const body = await send("/api/wallets/link-requests/lookup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userCode }),
  });
  if (
    !isRecord(body) || typeof body.requestId !== "string" || !body.requestId ||
    !isRecord(body.consent) || body.consent.version !== "wallet-link-v1" ||
    typeof body.consent.sha256 !== "string" || !/^[a-fA-F0-9]{64}$/.test(body.consent.sha256) ||
    typeof body.consent.text !== "string" || !body.consent.text.trim()
  ) {
    throw new Error("Invalid wallet link response");
  }
  // Keep only the fields this screen needs; preserve the server's text and hash exactly.
  return {
    requestId: body.requestId,
    consent: { text: body.consent.text, sha256: body.consent.sha256 },
  };
}

export async function decideWalletLink(
  requestId: string,
  userCode: string,
  decision: "approve" | "deny",
  consentSha256: string,
) {
  const body = await send(`/api/wallets/link-requests/${encodeURIComponent(requestId)}/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userCode, decision, consentSha256 }),
  });
  if (isRecord(body)) {
    if (decision === "deny" && body.status === "denied") return { status: "denied" } as const;
    if (decision === "approve" && body.status === "approved" && typeof body.linkId === "string" && body.linkId) {
      return { status: "approved", linkId: body.linkId } as const;
    }
  }
  throw new Error("Invalid wallet link decision response");
}
