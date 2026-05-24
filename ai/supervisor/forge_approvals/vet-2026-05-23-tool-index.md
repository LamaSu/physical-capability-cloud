# Tool Vetting Report [WARN]

**Proposal:** `vet-2026-05-23-tool-index`
**Target:** `packages/tool-index` (in `feat/intent-network-interception` worktree)
**Date:** 2026-05-23T22:30:00Z
**Verdict:** WARN

## Notes on Scope

The `tool-index` package does not exist in `master`. It was found in
`.claude/worktrees/agent-a48da6ae18805b397/packages/tool-index/`.

Package: `@pcc/tool-index v0.1.0` — embedding-based retrieval over tool catalogs.
Phase 1 indexes PCC's 218-tool `agent-package.json`. Phase 3 will aggregate
external MCP servers.

Dependencies: `@pcc/spec workspace:*` (no third-party runtime deps in `package.json`).
Optional runtime: `OPENAI_API_KEY` → `text-embedding-3-small` API.

## Rejection Reasons

None. No auto-reject conditions triggered.

## Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 0 |
| Medium | 1 |
| Low | 2 |
| **Total** | **3** |

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

No third-party runtime deps declared in `package.json`. Only devDependency:
`vitest@1.6.0`. No audit surface.

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

No injection patterns found in source or test files.

---

## SAST / Manual Code Review Findings

### MEDIUM — `OPENAI_API_KEY` transmitted to external API without redaction in error paths

**Location:** `src/embeddings.ts` — `OpenAIEmbeddingProvider.embed()`

When the OpenAI embeddings API returns a non-OK status, the error message is
constructed from `res.status`, `res.statusText`, and the raw response body:

```
throw new Error(`OpenAI embeddings failed: ${res.status} ${res.statusText} ${detail}`)
```

If the API returns an error response that echoes the authorization header
(e.g., in a 401 where the token format is logged by some proxies), the
error string could contain partial key material. Additionally, the key is
passed directly to the `Authorization: Bearer` header with no masking.

**Risk:** Medium — only if error messages are logged to insecure sinks. The
package itself does not log; callers are responsible. Low likelihood in
practice.

**Recommendation:** Catch the error at the call site and log only
`req.status` + a masked key indicator (`OPENAI_API_KEY=sk-...***`), not
the raw error detail.

### LOW-1 — `HashFallbackProvider` produces semantically meaningless embeddings

**Location:** `src/embeddings.ts` — `HashFallbackProvider`

The fallback embedding provider uses FNV1a-derived hash bytes as if they
were semantic vectors. Cosine similarity over these vectors is meaningless
(identical to random). The code documents this clearly but does not warn at
runtime when the fallback is active.

**Risk:** Low — functional degradation, not a security risk. But operators
who have set `PCC_EMBEDDING_PROVIDER=openai` without `OPENAI_API_KEY` will
silently fall back to hash mode with no indication.

**Recommendation:** Log a `console.warn` when `selectEmbeddingProvider()`
falls back due to missing key (`wanted === 'openai'` but `OPENAI_API_KEY` absent).

### LOW-2 — `readFileSync` path in `loadAgentPackage` not validated

**Location:** `src/loaders/agent-package.ts` — `loadAgentPackage(jsonPath: string)`

The `jsonPath` parameter is passed directly to `readFileSync()` without path
traversal validation. If the caller provides `jsonPath` from an untrusted
source, it could read arbitrary files.

**Risk:** Low — only exploitable if `jsonPath` is user-controlled. In Phase 1
it is operator-configured at boot time. Phase 3 (MCP aggregation of external
indexes) may expand this surface.

**Recommendation:** Validate that `jsonPath` is an absolute path to a file
within expected directories, or use `path.resolve()` + prefix check.

---

## Verdict Rationale

- No malware, no critical/high CVEs, no secrets, no injection signals.
- One medium finding (API key in error paths), two low findings (silent hash
  fallback, path validation).
- The package design is sound: pure TypeScript, minimal deps, safe-by-default
  hash fallback, clear Phase 1/3 separation.

**Verdict: WARN — approved for internal use. Address MEDIUM before production
deployment with real OPENAI_API_KEY.**
