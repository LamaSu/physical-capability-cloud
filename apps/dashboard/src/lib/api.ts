/**
 * Minimal API client for the PCC gateway.
 * Vite proxy: /api routes → http://localhost:3200
 */

import { getAuthHeaders } from "../stores/auth-store.js";

const API_BASE = "/api";

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...getAuthHeaders() },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let message = `API error: ${res.status}`;
    try {
      const json = (await res.json()) as { error?: string; message?: string };
      if (json.message) message = json.message;
      else if (json.error) message = json.error;
    } catch {
      // ignore parse error — keep the status message
    }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { ...getAuthHeaders() },
  });
  if (!res.ok) {
    let message = `API error: ${res.status}`;
    try {
      const json = (await res.json()) as { error?: string; message?: string };
      if (json.message) message = json.message;
      else if (json.error) message = json.error;
    } catch {
      // ignore parse error — keep the status message
    }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Setup API types
// ---------------------------------------------------------------------------

export interface GenerateConfigResponse {
  config: {
    kernelId: string;
    devices: Array<{
      id: string;
      type: string;
      adapterType: string;
      config: Record<string, unknown>;
    }>;
    mockMode?: boolean;
  };
  envLine: string;
  configJson: string;
}

export interface ValidateResponse {
  valid: boolean;
  checks: Array<{ name: string; status: "pass" | "warn" | "fail"; message: string }>;
  errors: string[];
  warnings: string[];
}

export interface RegisterDeviceResponse {
  device: {
    id: string;
    kernelId: string;
    type: string;
    model: string;
    adapterType: string;
    status: string;
  };
  registered: boolean;
}

export interface TestJobResponse {
  jobId: string;
  deviceId: string;
  status: string;
  evidenceBundleId: string | null;
  duration: number;
}
