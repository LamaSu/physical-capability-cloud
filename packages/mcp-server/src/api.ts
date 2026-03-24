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

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

export interface FetchOptions {
  method?: "GET" | "POST";
  body?: unknown;
  query?: Record<string, string | undefined>;
}

export async function pccFetch(path: string, opts: FetchOptions = {}): Promise<unknown> {
  const url = new URL(path, PCC_URL);

  // Append query parameters (skip undefined values)
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined && v !== "") {
        url.searchParams.set(k, v);
      }
    }
  }

  const init: RequestInit = {
    method: opts.method ?? "GET",
    headers: { "Content-Type": "application/json" },
  };

  if (opts.method === "POST" && opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
  }

  const res = await fetch(url.toString(), init);

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`PCC API ${res.status}: ${text || res.statusText}`);
  }

  return res.json();
}
