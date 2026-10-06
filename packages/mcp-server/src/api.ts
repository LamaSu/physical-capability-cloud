#!/usr/bin/env node

/**
 * PCC API helpers — shared by both the MCP server and CLI entry points.
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export const PCC_URL = (
  process.env.PCC_URL ?? "https://pcc-gateway-production.up.railway.app"
).replace(/\/$/, "");

/**
 * Optional bearer token. When set, it is sent as `Authorization: Bearer <key>`
 * on EVERY gateway call. Required for authenticated and write endpoints
 * (negotiation commit, escrow, fiat ramp, contributor writes); optional for
 * public reads (capability/kernel/job lists). Provisioned via
 * `POST /api/auth/provision`. The token is read once from the environment and
 * is never logged — only the resolved gateway URL is logged on boot.
 */
export const PCC_API_KEY = process.env.PCC_API_KEY?.trim() || undefined;

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

export interface FetchOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  query?: Record<string, string | undefined>;
}

export async function pccFetch(path: string, opts: FetchOptions = {}): Promise<unknown> {
  const url = new URL(path, PCC_URL);

  // Append query parameters (skip undefined / empty values)
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined && v !== "") {
        url.searchParams.set(k, v);
      }
    }
  }

  const method = opts.method ?? "GET";

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  // Forward the bearer token when configured. Public reads work without it;
  // negotiation/escrow/ramp calls need it or the gateway returns 401.
  if (PCC_API_KEY) {
    headers["Authorization"] = `Bearer ${PCC_API_KEY}`;
  }

  const init: RequestInit = { method, headers };

  // Send a JSON body for any write method (POST/PATCH/DELETE) that supplies one.
  if (method !== "GET" && opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
  }

  const res = await fetch(url.toString(), init);

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`PCC API ${res.status}: ${text || res.statusText}`);
  }

  // Some write/cancel endpoints answer 204 with no body — don't choke on json().
  if (res.status === 204) {
    return { ok: true, status: 204 };
  }

  return res.json();
}

/**
 * Fetch several reads and report each on its own. A part the gateway cannot provide (for example a
 * 501 `not_available`) comes back as `{ unavailable: true, reason }`, never as zero and never as an
 * invented value, and one missing part does not hide the others.
 */
export async function pccFetchEach(paths: readonly string[]): Promise<unknown[]> {
  const settled = await Promise.allSettled(paths.map((p) => pccFetch(p)));
  return settled.map((r) =>
    r.status === "fulfilled"
      ? r.value
      : { unavailable: true, reason: r.reason instanceof Error ? r.reason.message : String(r.reason) },
  );
}
