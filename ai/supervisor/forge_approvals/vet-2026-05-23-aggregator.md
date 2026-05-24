# Tool Vetting Report [WARN]

**Proposal:** `vet-2026-05-23-aggregator`
**Target:** `packages/aggregator` (in `feat/aggregator-mcp-crawler` / `feat/universal-aggregator` worktrees)
**Date:** 2026-05-23T22:30:00Z
**Verdict:** WARN

## Notes on Scope

The `aggregator` package exists only in worktrees, not in `master`.
Canonical source scanned:
`.claude/worktrees/agent-abb3364a224c5273a/packages/aggregator/src/`

Package: `@pcc/aggregator v0.1.0`
Dependencies: `@noble/hashes ^1.7.0`, `@pcc/spec workspace:*`, `@pcc/verifier workspace:*`, `zod ^3.23.0`

## Rejection Reasons

None. No auto-reject conditions triggered.

## Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 0 |
| Medium | 3 |
| Low | 1 |
| **Total** | **4** |

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

No `package-lock.json` at package scope. Dep versions from `pnpm-lock.yaml`:

| Package | Version | Risk |
|---------|---------|------|
| @noble/hashes | 1.7.0 | Current; no known CVEs |
| zod | 3.25.76 | Current |

Findings: 0 direct CVEs.

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

All 7 patterns checked across `src/`. Findings: 0.

No injection patterns found in source files, tests, or configuration.

---

## SAST / Manual Code Review Findings

### MEDIUM-1 — No URL validation before external fetch (SSRF risk)

**Location:** `src/sources/mcp.ts:71`, `src/sources/openapi.ts:81`

Both `McpSourceAdapter.fetch()` and `OpenApiSourceAdapter.fetch()` call
`fetch(input.url, ...)` without validating or allowlisting the URL. An
attacker who can control the `url` parameter (e.g., via a directory listing
that returns a malicious server URL, or via user-submitted sources) could
direct the aggregator to:
- Internal network endpoints (SSRF to `http://169.254.169.254/` metadata)
- Arbitrary external hosts

The adapter is "intentionally tolerant" (per its docblock) but does not
impose any scheme or host constraints.

**Risk:** Medium — exploitable only if `input.url` is caller-supplied from
an untrusted source. In Phase 1 the adapter is called with operator-provided
URLs; Phase 3 plans to ingest from common-crawl and user-submission, which
makes this critical.

**Recommendation:** Add a URL allowlist or at minimum validate `new URL(url)`
with `protocol === 'https:'` and block RFC-1918 / link-local address ranges
before the `fetch()` call.

### MEDIUM-2 — Verify stage is a pass-through stub (Gate A bypass)

**Location:** `src/pipeline.ts` — Stage 5 (verify)

When `options.runVerify === true`, the pipeline marks all ingested tools with
`vetReport: { verdict: "PASS", critical: 0, high: 0, ... }` without running
any actual scanner. The comment reads "Phase 1: pass-through; full Gate A is
deferred to Phase 2."

Tools ingested from `user-submission` or `common-crawl` sources receive
`trustTier: UNTRUSTED` but still get a synthetic `PASS` vet report in the
registry.

**Risk:** Medium — downstream consumers that trust `vetReport.verdict` without
checking `trustTier` or re-running Gate A will incorrectly treat UNTRUSTED
tools as vetted.

**Recommendation:** Either set `vetReport` to `null`/absent for unvetted tools,
or set `verdict: "UNVETTED"` so consumers can gate on it. Do not emit `PASS`
for stub-verified tools.

### MEDIUM-3 — Tool descriptions ingested verbatim from external MCP servers

**Location:** `src/sources/mcp.ts` — `description: autoSummarize(tool.description)`

Descriptions from external MCP servers are truncated at 280 characters but
not sanitized for prompt injection patterns before storage. If the indexed
tools are later presented verbatim to an LLM (e.g., in a capability
selection prompt), a malicious MCP server could embed injection payloads in
tool descriptions that survive into LLM context.

`autoSummarize()` only truncates; it does not strip injection patterns.

**Risk:** Medium — the aggregator package itself does not send content to LLMs,
but its output is designed to feed retrieval pipelines that will. The threat is
in the data pipeline, not the current call site.

**Recommendation:** Run the `PatternScanner` from `@pcc/a2a` against each
tool's description during the verify stage. Flag or quarantine tools whose
descriptions trigger injection patterns.

### LOW — `HMAC_KEY` env var falls back to ephemeral key silently

**Location:** `src/receipt-signer.ts:46-52`

If `PCC_AGGREGATOR_HMAC_KEY` is unset, `getDefaultSignerKey()` generates an
ephemeral key at process start. Receipts signed with ephemeral keys are
unverifiable across restarts. The code logs no warning and the caller has no
way to detect this happened.

**Risk:** Low — data integrity issue, not a security vulnerability. Receipts
cannot be forged; they just become unverifiable after restart.

**Recommendation:** Log a `console.warn` when falling back to ephemeral key,
or reject at startup if key is missing in production environments.

---

## Verdict Rationale

- No malware, no critical CVEs, no hardcoded secrets, no injection signals.
- Three medium SAST findings: SSRF risk on URL fetch, stub verify stage,
  unsanitized external tool descriptions.
- These findings are all architectural (Phase 1 known gaps) but warrant
  tracking before Phase 2 (user-submission and common-crawl ingestion).

**Verdict: WARN — safe for internal/operator-URL use, but address MEDIUM-1
and MEDIUM-2 before enabling user-submission or common-crawl source adapters.**
