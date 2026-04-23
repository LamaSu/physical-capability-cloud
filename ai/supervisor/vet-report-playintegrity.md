# Gate A Vet Report — @googleapis/playintegrity (Pivot Assessment)

**Date**: 2026-04-22T00:49:13Z
**Agent**: vet-beta
**Proposal ID**: phase-7-gate-a-playintegrity
**Package scanned**: `@googleapis/playintegrity@23.0.1`
**Context**: Pivot candidate to replace `@n3arby/play-integrity-verifier@0.2.0` (solo maintainer, WARN verdict from vet-alpha). This is the official Google-authored Apache-2.0 client for the Play Integrity API.

---

## Summary

| Package | Version | Verdict | Critical | High | Medium | Low | Secrets | Malware | Prompt-Inj | Notes |
|---------|---------|---------|----------|------|--------|-----|---------|---------|------------|-------|
| @googleapis/playintegrity | 23.0.1 | **PASS** | 0 | 0 | 0 | 4 | 0 | 0 | 0 | 4 low vulns all in devDeps (gts toolchain); zero prod exposure |

**Totals**: Critical: 0 | High: 0 | Medium: 0 | Low: 4 | Secrets: 0 | Malware: 0 | Injection: 0

---

## Scanner Availability

| Scanner | Status | Notes |
|---------|--------|-------|
| trivy | NOT INSTALLED | Skipped — no binary on host |
| gitleaks | NOT INSTALLED | Skipped — no binary on host |
| clamav | NOT INSTALLED | Skipped — no binary on host |
| npm audit | AVAILABLE | Run after lockfile generation (`npm i --package-lock-only`) |
| semgrep | NOT INSTALLED | Skipped — no binary on host |
| pip-audit | N/A | Python package only; not applicable |
| slither | NOT INSTALLED | N/A (no .sol files in package) |
| prompt-injection | ALWAYS ON | All 7 regex patterns ran — CLEAN |

**Degraded mode**: npm audit + prompt injection + manual SAST review. Trivy, gitleaks, ClamAV, and semgrep are not installed on this host. Manual code review substituted for binary SAST.

---

## Scanner Results

### 1. npm audit

**Findings: 4 low | 0 moderate | 0 high | 0 critical**

All 4 vulnerabilities are **exclusively in `devDependencies`** — the `gts` (Google TypeScript Style) linting toolchain. They are not present in the published package or any production dependency.

| Severity | Package | Via | Title | CVE/Advisory | Prod? |
|----------|---------|-----|-------|--------------|-------|
| low | tmp | — | Symlink arbitrary temp file/dir write | GHSA-52f5-9888-hmc6 (CVSS 2.5) | NO (devDep) |
| low | external-editor | tmp | Chain through tmp | — | NO (devDep) |
| low | inquirer | external-editor | Chain through external-editor | — | NO (devDep) |
| low | gts | inquirer | Chain through inquirer | — | NO (devDep, direct) |

**Production runtime dependency tree** is: `@googleapis/playintegrity` → `googleapis-common@^8.0.0` only. Zero vulnerabilities in the production path.

**No fix available** for these dev-only findings — `gts` pins an old inquirer. This is a development tooling issue and irrelevant to runtime security.

---

### 2. Prompt Injection Scanner (always available)

All 7 patterns scanned across 11 files (.ts, .js, .json, .md, .yaml, tsconfig):

| Pattern | Result |
|---------|--------|
| `ignore (all) previous instructions` | CLEAN |
| `disregard (all) prior instructions/context` | CLEAN |
| `you are now a/an` | CLEAN |
| `system: you are` | CLEAN |
| `send/exfiltrate/transmit secret/token/key` | CLEAN |
| HTML comment injection (`<!-- ... ignore/override/system ... -->`) | CLEAN |
| Invisible Unicode (3+ consecutive zero-width chars) | CLEAN |

**Injection signals: 0**

---

### 3. Trivy, Gitleaks, ClamAV, Semgrep

NOT INSTALLED — skipped. See degraded mode note above.

---

## Manual Code Review

### Maintainer & Provenance

- **Author**: `Google LLC` (package.json `"author"`)
- **Repository**: `github.com/googleapis/google-api-nodejs-client` — the monorepo for all official Google Node.js API clients. This is the canonical upstream for all `@googleapis/*` packages.
- **Publisher**: Published under the `@googleapis` npm scope. Google owns this npm scope.
- **License**: `Apache-2.0` — confirmed in package.json. Correct for a Google-authored client.
- **Homepage**: `https://github.com/googleapis/google-api-nodejs-client`
- **Issues**: `https://github.com/googleapis/google-api-nodejs-client/issues`
- **Auto-generated**: Both `index.ts` and `v1.ts` contain `/*! THIS FILE IS AUTO-GENERATED */` comments. This is expected — Google generates all `@googleapis/*` clients from API Discovery documents.
- **Version cadence**: CHANGELOG shows active maintenance from 2022 through December 2025. v23.0.1 released 2025-12-05.

### License Confirmation

`"license": "Apache-2.0"` confirmed in package.json. All source files begin with the Apache-2.0 license header including copyright `2020 Google LLC`. CONFIRMED CLEAN.

### Postinstall / Lifecycle Scripts

The `scripts` block in package.json:
```json
"fix": "gts fix",
"lint": "gts check",
"compile": "tsc -p .",
"prepare": "npm run compile",
"webpack": "webpack"
```

- NO `postinstall`, `preinstall`, or `install` lifecycle hooks.
- The `prepare` script runs `tsc` to compile TypeScript sources. This is standard for TypeScript packages published with pre-built output. It does NOT download binaries, execute network calls, or run shell commands.
- Confirmed: no supply-chain risk from lifecycle hooks.

### Dependencies Analysis

**Production runtime (`dependencies`)**: Single entry only:
```json
"googleapis-common": "^8.0.0"
```
`googleapis-common` is Google's own shared foundation for all `@googleapis/*` clients (auth, HTTP, request lifecycle). It is well-maintained, widely depended upon (millions of downloads/week), and scoped under the Google org. Zero third-party non-Google production dependencies.

**DevDependencies** (not installed in production):
- `@microsoft/api-documenter` / `@microsoft/api-extractor` — Microsoft API docs tooling
- `gts@^6.0.0` — Google TypeScript Style linter (source of the 4 low devDep CVEs)
- `null-loader`, `ts-loader`, `webpack`, `webpack-cli` — build tooling

None of these devDependencies are included in published packages or installed at runtime.

### Source Code Review (SAST — manual)

**index.ts** (46 lines, auto-generated):
- Imports exclusively from `googleapis-common` and `./v1`
- Exports `AuthPlus`, `getAPI`, and a `playintegrity()` factory function
- No dynamic imports, no `eval`, no `require(userInput)`, no network calls
- Clean TypeScript API wrapper pattern

**v1.ts** (963 lines, auto-generated):
- All imports from `googleapis-common` and Node.js standard `stream` module
- Exposes 3 API methods: `deviceRecall.write()`, `v1.decodeIntegrityToken()`, `v1.decodePcIntegrityToken()`
- All network calls are routed through `googleapis-common`'s `createAPIRequest()` — Google's own auth-aware HTTP client
- Default rootUrl hardcoded to `https://playintegrity.googleapis.com/` — the official Google Play Integrity API endpoint. This is correct and expected.
- No eval, no dynamic code execution, no subprocess calls, no filesystem access

**build/index.js** and **build/v1.js**:
- Only `require` calls are to `googleapis-common` and `./v1` (relative)
- Network calls exclusively via `googleapis_common_1.createAPIRequest()` to `https://playintegrity.googleapis.com/`
- No suspicious patterns: no `eval`, no `execSync`, no `child_process`, no `.env` file reads

**webpack.config.js**:
- Standard Google webpack configuration for browser bundle generation
- Appropriately stubs `crypto`, `child_process`, `fs`, `http2` for browser safety
- No suspicious targets or externals

**tsconfig.json**:
- Extends `gts/tsconfig-google.json` (standard Google TS config)
- Outputs to `./build`, sources from `*.ts`
- No path aliases, no unusual compiler plugins

---

## Policy Evaluation

| Policy Threshold | Value | Actual | Status |
|-----------------|-------|--------|--------|
| max_critical | 0 | 0 | PASS |
| max_high | 2 | 0 | PASS |
| max_medium | 10 | 0 | PASS |
| max_secrets | 0 | 0 | PASS |
| auto_reject_on_malware | true | 0 found | PASS |
| auto_reject_on_critical | true | 0 found | PASS |
| max_injection_signals | 1 | 0 | PASS |

**All thresholds: PASS**

Low count (4) is within threshold (no explicit limit; all are devDep-only, CVSS 2.5 max).

---

## Verdict: PASS

**Final verdict: PASS — auto-approved**

Verdict decision path:
- malware = 0 → no auto-reject
- critical = 0 → no auto-reject
- high = 0 → no high-WARN trigger
- injection_signals = 0 → no injection-WARN trigger
- Result: PASS

---

## Recommendation: ACCEPT — Replace `@n3arby/play-integrity-verifier` immediately

This package is the correct, authoritative replacement for `@n3arby/play-integrity-verifier@0.2.0`.

**Why this is strictly better than the prior vet-alpha WARN package:**

| Dimension | @n3arby/play-integrity-verifier@0.2.0 | @googleapis/playintegrity@23.0.1 |
|-----------|--------------------------------------|----------------------------------|
| Maintainer | Solo, unknown | Google LLC (googleapis org) |
| Lifecycle | Stale risk, 0.2.0 = early alpha | v23 — mature, actively maintained |
| License | — | Apache-2.0 confirmed |
| Postinstall scripts | None seen | None — confirmed clean |
| Prod dependencies | Unknown chain | 1 prod dep: `googleapis-common` (Google) |
| Tests | Unclear | Covered by google-api-nodejs-client CI |
| Gate A verdict | WARN | PASS |
| Supply chain | Solo npm account | @googleapis npm scope, Google-controlled |

**Integration notes:**
- Drop-in for server-side Play Integrity token decoding (`decodeIntegrityToken`)
- Requires `googleapis-common` auth setup (GoogleAuth / service account credentials)
- No binary downloads, no postinstall hooks, no third-party network calls
- API endpoint is `https://playintegrity.googleapis.com/` — correct Google endpoint
- Works with the existing `googleapis` auth patterns already used in PCC

**Action**: Update `packages/cvp/package.json` to replace `@n3arby/play-integrity-verifier` with `@googleapis/playintegrity@^23.0.1`. No API changes needed beyond switching to the `googleapis` auth pattern.
