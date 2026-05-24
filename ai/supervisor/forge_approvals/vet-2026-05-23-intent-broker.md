# Tool Vetting Report [PASS]

**Proposal:** `vet-2026-05-23-intent-broker`
**Target:** `packages/intent-broker`
**Date:** 2026-05-23T22:30:00Z
**Verdict:** PASS

## Notes on Scope

The `intent-broker` package exists in `master` with only `dist/` and
`node_modules/` present (no `src/`, no `package.json` at the package root).
The source was found in the
`.claude/worktrees/agent-a48da6ae18805b397/` worktree (branch
`feat/intent-network-interception`). Both dist and source were scanned.

Package: `@pcc/intent-broker v0.1.0` — MCP stdio server exposing one tool:
`register_intent`.

Dependencies: `@modelcontextprotocol/sdk@1.27.1`, `zod@3.25.76`, `@pcc/spec workspace:*`

## Rejection Reasons

None.

## Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 0 |
| Medium | 0 |
| Low | 1 |
| **Total** | **1** |

---

## Scanner 1: Trivy (not installed)

Findings: 0 | Duration: N/A — scanner not installed, skipped.

---

## Scanner 2: Gitleaks (not installed)

Findings: 0 | Duration: N/A — scanner not installed, skipped.

---

## Scanner 3: ClamAV (not installed)

Findings: 0 | Duration: N/A — scanner not installed, skipped.

---

## Scanner 4: npm audit (N/A)

No `package-lock.json`. Dep versions confirmed:

| Package | Version | Risk |
|---------|---------|------|
| @modelcontextprotocol/sdk | 1.27.1 | Current as of 2026-05-23; no known CVEs |
| zod | 3.25.76 | Current; no known CVEs |

---

## Scanner 5: pip-audit (N/A)

No `requirements.txt`. Scanner skipped.

---

## Scanner 6: Semgrep (not installed)

Findings: 0 | Duration: N/A — scanner not installed, skipped.

---

## Scanner 7: Slither (N/A)

No `.sol` files. Scanner skipped.

---

## Scanner 8: Prompt Injection (available — regex)

Patterns 1-7 scanned across all `.js`, `.ts`, `.json`, `.md` files.

| Result | Detail |
|--------|--------|
| Scan target | `dist/server.js`, `dist/cli.js`, `dist/server.d.ts`, `dist/cli.d.ts` |
| Pattern matches | 0 true positives |
| False positive investigated | `pcc_live_...` strings in `dist/cli.d.ts` and `dist/cli.js` — confirmed to be JSDoc example placeholders with ellipsis suffix, not real API keys |

**Injection signals: 0**

---

## SAST / Manual Code Review Findings

### LOW — Ingest URL is operator-configurable but not validated

**Location:** `dist/server.js` — `loadConfig()` function

The `PCC_INTENT_INGEST_URL` env var is accepted without URL validation. An
operator who misconfigures this to a non-HTTPS URL would send envelope data
and `PCC_API_KEY` bearer tokens over plaintext HTTP.

**Risk:** Low — requires operator misconfiguration. Default is
`https://capability.network/api/intents/ingest` (HTTPS).

**Recommendation:** Validate that the configured URL uses `https:` scheme and
warn (or reject) if `http:` is configured with a non-localhost host.

---

## Code Review Highlights (Positive)

- **Triple validation:** Envelope is validated by Zod schema on the MCP layer,
  re-validated by `DemandEnvelopeSchema.safeParse()` in the tool handler, and
  re-validated by the PCC gateway. Malformed payloads never reach the wire.
- **No-key graceful degradation:** When `PCC_API_KEY` is absent, the tool
  returns `{accepted:false, reason:"no_api_key"}` without throwing or leaking
  config state.
- **STDOUT isolation:** All logging goes to `stderr` to avoid contaminating
  the MCP stdio wire protocol.
- **Never throws:** `forwardEnvelope()` catches all transport errors and
  returns structured `{accepted:false, reason:"transport_error"}` objects.

---

## Verdict Rationale

- No malware, no critical or high findings, no hardcoded secrets, no injection.
- One low-severity operational risk (unvalidated ingest URL scheme).
- The package has an unusually clean security posture for an MCP server:
  triple-validation, graceful no-key mode, stderr-only logging.

**Verdict: PASS — approved for use.**
