/**
 * Backend selection and the standard subject helper.
 *
 * Subject scheme: `pcc.a2a.<intent-type>` — chosen so a JetStream stream
 * defined with subject `pcc.a2a.>` captures every A2A intent without per-
 * intent stream config.
 */

import type { MessageBusBackend } from "./backend.js";
import { InMemoryBackend } from "./in-memory-backend.js";
import type {
  NATSJetStreamBackendOptions,
  NatsTlsOptions,
  NatsAuthOptions,
} from "./nats-jetstream-backend.js";

export type { MessageBusBackend, BackendMessageHandler, BackendSubscription } from "./backend.js";
export { InMemoryBackend } from "./in-memory-backend.js";

/** Build the canonical subject for a given intent type */
export function subjectFor(intentType: string): string {
  return `pcc.a2a.${intentType}`;
}

/** All A2A subjects, useful as a wildcard subscription */
export const ALL_A2A_SUBJECTS = "pcc.a2a.>";

/**
 * Select a backend from environment variables.
 *
 * `PCC_MESSAGE_BUS_BACKEND` selects: `memory` (default) | `nats`.
 *
 * For NATS, also reads:
 *   Connection:
 *     `NATS_URL`              — default `nats://localhost:4222`
 *     `NATS_STREAM_NAME`      — default `PCC_A2A`
 *     `NATS_DURABLE_NAME`     — optional
 *   TLS (any of these enables TLS):
 *     `NATS_TLS`              — `1`/`true` to enable with defaults
 *     `NATS_TLS_CA_FILE`      — path to PEM CA bundle
 *     `NATS_TLS_CERT_FILE`    — path to PEM client cert
 *     `NATS_TLS_KEY_FILE`     — path to PEM client key
 *     `NATS_TLS_REJECT_UNAUTHORIZED` — `0`/`false` to disable verification
 *                                      (default true)
 *     `NATS_TLS_SERVERNAME`   — SNI override
 *   Auth (pick one kind via `NATS_AUTH_KIND`):
 *     `NATS_AUTH_KIND=token` + `NATS_TOKEN`
 *     `NATS_AUTH_KIND=userPass` + `NATS_USER` + `NATS_PASS`
 *     `NATS_AUTH_KIND=nkey` + `NATS_NKEY_SEED`
 *     `NATS_AUTH_KIND=jwt` + `NATS_JWT` + `NATS_NKEY_SEED`
 *     `NATS_AUTH_KIND=credsFile` + `NATS_CREDS_FILE`
 *
 * If `NATS_TLS_*` env vars are set but the URL is `nats://`, a warning is
 * logged — TLS is still enabled (nats.js will upgrade the connection), but
 * the operator probably meant `tls://`.
 *
 * Returns the backend instance. The actual NATS module is lazy-loaded so
 * that consumers using the default `memory` backend don't pay the import
 * cost.
 */
export async function createBackendFromEnv(): Promise<MessageBusBackend> {
  const choice = (process.env.PCC_MESSAGE_BUS_BACKEND ?? "memory").toLowerCase();
  if (choice === "memory") return new InMemoryBackend();
  if (choice === "nats") {
    // Lazy import — only pay the cost when nats is actually selected.
    const { NATSJetStreamBackend } = await import("./nats-jetstream-backend.js");
    const url = process.env.NATS_URL ?? "nats://localhost:4222";
    const tls = readTlsFromEnv();
    if (tls !== undefined && url.startsWith("nats://")) {
      // eslint-disable-next-line no-console
      console.warn(
        "[NATSJetStreamBackend] TLS env vars set but URL uses 'nats://'. " +
          "Connection will be upgraded to TLS at handshake. Consider 'tls://'.",
      );
    }
    const opts: NATSJetStreamBackendOptions = {
      url,
      streamName: process.env.NATS_STREAM_NAME ?? "PCC_A2A",
      durableName: process.env.NATS_DURABLE_NAME,
    };
    if (tls !== undefined) opts.tls = tls;
    const auth = readAuthFromEnv();
    if (auth) opts.auth = auth;
    return new NATSJetStreamBackend(opts);
  }
  throw new Error(
    `PCC_MESSAGE_BUS_BACKEND='${choice}' is not a known backend (memory|nats)`,
  );
}

// ── Env-var parsing ─────────────────────────────────────────────────────────

function isTruthyEnv(v: string | undefined): boolean {
  if (!v) return false;
  return v === "1" || v.toLowerCase() === "true";
}

function isFalsyEnv(v: string | undefined): boolean {
  if (!v) return false;
  return v === "0" || v.toLowerCase() === "false";
}

/**
 * Parse TLS from env. Returns `undefined` when no TLS config is present, so
 * callers can leave the field unset (which preserves the legacy "plaintext"
 * default).
 */
function readTlsFromEnv(): NatsTlsOptions | boolean | undefined {
  const ca = process.env.NATS_TLS_CA_FILE;
  const cert = process.env.NATS_TLS_CERT_FILE;
  const key = process.env.NATS_TLS_KEY_FILE;
  const reject = process.env.NATS_TLS_REJECT_UNAUTHORIZED;
  const sni = process.env.NATS_TLS_SERVERNAME;
  const tlsFlag = process.env.NATS_TLS;

  const anyDetailed = ca || cert || key || reject !== undefined || sni;
  if (!anyDetailed && !isTruthyEnv(tlsFlag)) return undefined;

  // No detailed fields, just the boolean flag → enable with defaults.
  if (!anyDetailed && isTruthyEnv(tlsFlag)) return true;

  const opts: NatsTlsOptions = {};
  if (ca) opts.caFile = ca;
  if (cert) opts.certFile = cert;
  if (key) opts.keyFile = key;
  if (reject !== undefined) {
    // Default true; explicit "0"/"false" disables.
    opts.rejectUnauthorized = !isFalsyEnv(reject);
  }
  if (sni) opts.servername = sni;
  return opts;
}

/**
 * Parse auth from env. Returns `undefined` when `NATS_AUTH_KIND` is unset.
 * Throws on misconfiguration (e.g. `NATS_AUTH_KIND=token` without `NATS_TOKEN`).
 */
function readAuthFromEnv(): NatsAuthOptions | undefined {
  const kind = process.env.NATS_AUTH_KIND?.trim();
  if (!kind) return undefined;
  switch (kind) {
    case "token": {
      const token = process.env.NATS_TOKEN;
      if (!token) throw new Error("NATS_AUTH_KIND=token requires NATS_TOKEN");
      return { kind: "token", token };
    }
    case "userPass": {
      const user = process.env.NATS_USER;
      const pass = process.env.NATS_PASS;
      if (!user || !pass) {
        throw new Error("NATS_AUTH_KIND=userPass requires NATS_USER and NATS_PASS");
      }
      return { kind: "userPass", user, pass };
    }
    case "nkey": {
      const nkeySeed = process.env.NATS_NKEY_SEED;
      if (!nkeySeed) throw new Error("NATS_AUTH_KIND=nkey requires NATS_NKEY_SEED");
      return { kind: "nkey", nkeySeed };
    }
    case "jwt": {
      const jwt = process.env.NATS_JWT;
      const nkeySeed = process.env.NATS_NKEY_SEED;
      if (!jwt || !nkeySeed) {
        throw new Error("NATS_AUTH_KIND=jwt requires NATS_JWT and NATS_NKEY_SEED");
      }
      return { kind: "jwt", jwt, nkeySeed };
    }
    case "credsFile": {
      const path = process.env.NATS_CREDS_FILE;
      if (!path) throw new Error("NATS_AUTH_KIND=credsFile requires NATS_CREDS_FILE");
      return { kind: "credsFile", path };
    }
    default:
      throw new Error(
        `NATS_AUTH_KIND='${kind}' is not recognized ` +
          `(token|userPass|nkey|jwt|credsFile)`,
      );
  }
}
