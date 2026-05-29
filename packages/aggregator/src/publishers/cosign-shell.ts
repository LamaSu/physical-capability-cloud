/**
 * Cosign shell-out implementation (Phase 1).
 *
 * Spawns `cosign sign-blob --new-bundle-format -` against a stdin
 * payload and returns the resulting bundle as a string. Phase 2 will
 * replace this with `@sigstore/sign` in-process to remove the binary
 * dependency.
 *
 * Configuration (env vars):
 *   - COSIGN_BINARY_PATH    — full path to the cosign binary (default: cosign on $PATH)
 *   - COSIGN_OIDC_ISSUER    — Sigstore Fulcio issuer (default: https://oauth2.sigstore.dev/auth)
 *   - COSIGN_OIDC_CLIENT_ID — Sigstore Fulcio client id (default: sigstore)
 *
 * This module is loaded lazily by the publisher (`await import(...)`)
 * so the child_process import doesn't bleed into edge-runtime callers.
 */

import { spawn } from "node:child_process";
import type { CosignInput } from "../types.js";

const DEFAULT_BINARY = process.env.COSIGN_BINARY_PATH ?? "cosign";
const DEFAULT_ISSUER =
  process.env.COSIGN_OIDC_ISSUER ?? "https://oauth2.sigstore.dev/auth";
const DEFAULT_CLIENT_ID =
  process.env.COSIGN_OIDC_CLIENT_ID ?? "sigstore";

/**
 * Run `cosign sign-blob` against the given payload.
 *
 * Resolves to the bundle string (printed by cosign on stdout when
 * `--new-bundle-format` is set). Rejects with an Error containing
 * stderr if cosign exits non-zero or is missing.
 */
export async function runCosignShell(input: CosignInput): Promise<string> {
  const binary = input.cosignBinary ?? DEFAULT_BINARY;
  const issuer = input.oidcIssuer ?? DEFAULT_ISSUER;
  const clientId = input.oidcClientId ?? DEFAULT_CLIENT_ID;

  const args = [
    "sign-blob",
    "--new-bundle-format",
    "--oidc-issuer",
    issuer,
    "--oidc-client-id",
    clientId,
    "--yes", // non-interactive — assumes OIDC token is available
    "-",
  ];
  if (input.identityToken) {
    args.splice(args.length - 1, 0, "--identity-token", input.identityToken);
  }

  return new Promise<string>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(binary, args, { stdio: ["pipe", "pipe", "pipe"] });
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      reject(
        new Error(
          `cosign spawn failed (${binary}): ${err.message}. Install cosign or set COSIGN_BINARY_PATH.`,
        ),
      );
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(
          new Error(
            `cosign exited ${code}: ${stderr.trim() || "(no stderr)"}`,
          ),
        );
      }
    });
    // Pipe payload to stdin and close.
    child.stdin.end(input.payload);
  });
}
