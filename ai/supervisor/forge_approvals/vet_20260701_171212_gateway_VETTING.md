# Vetting Report: packages/gateway

**ID**: vet_20260701_171212_gateway
**Date**: 2026-07-01T17:20:54-07:00
**Target**: `C:/Users/globa/physical-capability-cloud/.claude/worktrees/agent-af31d5b048a75808a/packages/gateway`
**Focus**: new dependency `@simplewebauthn/server@10.0.1` (added in commit `0cc2ec79`, "feat(gateway): option B Phase A — real WebAuthn verify + DB sessions + persist")
**Verdict**: **WARN**

## Scanners Run

| Scanner | Status | Findings |
|---------|--------|----------|
| Trivy | skipped — not installed locally or on Spark (checked both) | n/a |
| Gitleaks | skipped — not installed locally or on Spark (checked both); manual regex substitute run instead | 0 secrets (substitute check) |
| ClamAV | skipped — not installed locally or on Spark (checked both) | n/a |
| npm/pnpm audit | ran (`pnpm audit --json`, workspace-wide, GitHub Advisory DB) | 0 critical / 0 high / 0 medium / 0 low attributable to `@simplewebauthn/server` or its transitive tree (see note below) |
| pip-audit | N/A — packages/gateway is pure TypeScript/Node, no `requirements.txt` | n/a |
| Semgrep | skipped — not installed locally or on Spark; manual code review substituted for the two files this commit changed in `packages/gateway/src` | 1 high (manual finding, see below) |
| Slither | N/A — no `.sol` files in packages/gateway | n/a |
| Prompt Injection (built-in regex, 7 patterns) | ran | 1 signal (pre-existing, out of scope for this PR — see below) |

**Note on npm audit scope**: `pnpm audit` runs at the workspace root against the single monorepo lockfile, so its raw output covers all 2,047 resolved dependencies across every package (dashboard app, react-native, vite, hono, mppx, etc.) — **7 critical / 62 high / 90 moderate / 17 low** in total. Grepping that output for `simplewebauthn`, `@hexagon/base64`, `@levischuck/tiny-cbor`, `@peculiar/asn1-*`, and `cross-fetch` (the new dependency's full transitive tree) returned **zero matches** across all severity buckets. None of the pre-existing workspace findings are reachable through the new dependency. The workspace-wide backlog is out of scope for this focused vet (per the task brief: "everything else in gateway is pre-existing and vetted through prior PRs") and is not counted in this report's totals — it is called out here only for transparency, since 7 criticals sitting in the monorepo is worth separate tracking.

**Node_modules coverage gap**: `packages/gateway/node_modules` and the workspace root `node_modules` are not installed in this worktree (per task constraint: "Do NOT run npm install or pnpm install — deps are already installed on Spark from earlier"). This means the new package's own README/CHANGELOG/postinstall scripts could not be directly scanned for prompt-injection content or malware; the assessment below relies on the npm registry's published metadata (`npm view`) and the lockfile's resolved dependency graph rather than the installed tree itself. Flagged as a coverage limitation, not a clean bill of health for that specific angle.

## Findings by Severity

### Critical (0)
None.

### High (1)

| # | Title | Location | Description |
|---|-------|----------|--------------|
| 1 | Unauthenticated operatorId binding in passkey registration | `packages/gateway/src/routes/passkey.ts:89-93,120-138,197-263`; `packages/db/src/repositories/api-keys.ts:17-19,169-185` | `POST /api/onboard/passkey/register-challenge` accepts an arbitrary client-supplied `operatorId` string in the request body with **no authentication check anywhere in the call chain** (verified: no `preHandler`/`onRequest`/auth decorator in `passkey.ts`; plain `await app.register(passkeyRoutes)` in `server.ts:527` with no auth wrapper; `ApiKeyRepository.findByOperator()` and `.setPasskeyCredential()` in `packages/db/src/repositories/api-keys.ts` do zero ownership checks). An unauthenticated caller can request a challenge for any existing `operatorId`, complete a real WebAuthn ceremony with their **own** authenticator, and have their own credential persisted to that operator's `api_keys` row via `verify-attestation`. This is a broken-authentication / account-binding gap, distinct from a vulnerability in the `@simplewebauthn/server` package itself (the crypto verification the library performs is correct — it just proves the caller controls *a* key, not that they're authorized to bind it to *this* operatorId). |

Not yet exploitable end-to-end today: the commit message states Phase B/C (the ERC-4337 smart-wallet mint that would actually *consume* this binding for authorization) is not yet built ("still wait on paymaster funding + owner sign-off"). This raises the priority rather than lowering it — the gap is cheap to close now, before anything reads `api_keys.passkey_*` to authorize a privileged action. Recommend requiring the caller to already hold a valid Bearer/API key for the claimed `operatorId` (or an email-verification step) before `register-challenge` accepts an `operatorId` binding.

### Medium (0)
None.

### Low (2)

| # | Title | Location | Description |
|---|-------|----------|--------------|
| 1 | Deprecated transitive dependency | `pnpm-lock.yaml` — `@simplewebauthn/types@10.0.0` (required by `@simplewebauthn/server@10.0.1`) | npm registry marks this package "no longer supported." Not a CVE, but a supply-chain hygiene signal. Corroborating context: the pinned `@simplewebauthn/server@10.0.1` (published 2024-07-23) is 3 major versions / ~2 years behind the current registry latest (`13.3.2`, published 2026-06-24 — one week before this scan). The monorepo **already** runs `@simplewebauthn/server@13.3.0` + `@simplewebauthn/browser@13.3.0` elsewhere (confirmed in `pnpm-lock.yaml`), and that 13.x tree has dropped the deprecated `@simplewebauthn/types` package entirely. Recommend a near-term follow-up PR to align `packages/gateway` on the same major version already in use elsewhere in the monorepo. |
| 2 | Client-influenced `rpId`/`expectedOrigin` without server-side domain allowlist | `packages/gateway/src/routes/passkey.ts:51-64` | `resolveRpId`/`resolveExpectedOrigin` accept client-supplied overrides validated only by loose regexes (`/^[a-zA-Z0-9.-]+$/` and `/^https?:\/\//`), not an allowlist of PCC's own known domains. Assessed as low-severity/informational: WebAuthn's browser-side enforcement (a browser will not create a credential for an rpID that isn't a registrable-domain match of the real page origin) prevents this from being independently exploitable as a forgery path, but a server-side allowlist would be better defense-in-depth and is cheap to add alongside the fix for finding High-1. |

## Prompt Injection Signals

1 pattern match, assessed benign and **out of scope for this PR**:

- **Pattern 3** (`you\s+are\s+now\s+(a|an)\s+`) matched `packages/gateway/src/routes/context-pack.ts:22`: `"You are now a PCC interface agent. This context pack gives you everything you need to help your user interact with..."`. This file was **not touched** by the commit under review (confirmed via `git show --stat HEAD` — only `passkey.ts`, `passkey.test.ts`, `package.json`, `pnpm-lock.yaml`, and `packages/db/*` files changed). It is pre-existing, first-party content: PCC's own "agent context pack" endpoint, directly analogous to the documented `agent-package.json` / `system_prompt` "Claude-as-user-agent framing" pattern described in this repo's own `CLAUDE.md` (Section 10 — the polished 249-tool agent package deliberately opens with framing text like this so an LLM can self-onboard). Not an injected/adversarial instruction from a third party.
- Patterns 1, 2, 6, 7 (ignore-previous-instructions, disregard-prior-context, HTML-comment override, invisible-Unicode runs): **no matches** anywhere in `packages/gateway`.
- Pattern 5 (secret-exfiltration phrasing) produced several loose matches on documentation comments describing PCC's own `Authorization: Bearer <key>` / `X-PCC-API-Key` header convention (e.g. `context-pack.ts:34`, `well-known.ts:153`, `intent-ingest.ts:127`). Reviewed individually — none constitute an actual exfiltration/injection payload; all are first-party API-usage documentation.

Per policy (`warn_on_any_injection: true`), this single benign, pre-existing, out-of-scope match still counts as one injection signal for verdict purposes and is not silently suppressed.

## Supply Chain / Dependency Authenticity Check

- **Package**: `@simplewebauthn/server`, requested `^10.0.1`, locked at exactly `10.0.1`.
- **Repository**: `git+https://github.com/MasterKale/SimpleWebAuthn.git` — matches the known, legitimate maintainer (Matthew Miller / "MasterKale"), no typosquat indicators, package name spelled correctly.
- **License**: MIT.
- **Deprecation**: package itself not deprecated; direct dependency `@simplewebauthn/types@10.0.0` is (see Low-1).
- **Registry history**: continuously published since 2020, actively maintained through `13.3.2` (last week of this scan), no gaps suggesting account takeover or maintainer churn.
- **Transitive tree** (from `pnpm-lock.yaml`): `@hexagon/base64@1.1.28`, `@levischuck/tiny-cbor@0.2.11`, `@peculiar/asn1-android@2.6.0`, `@peculiar/asn1-ecc@2.6.1`, `@peculiar/asn1-rsa@2.6.1`, `@peculiar/asn1-schema@2.6.0`, `@peculiar/asn1-x509@2.6.1`, `@simplewebauthn/types@10.0.0`, `cross-fetch@4.1.0` (+ peer `encoding@0.1.13`). None of these appear in the workspace-wide `pnpm audit` critical/high/moderate/low findings.

No `.github/workflows/` files exist inside `packages/gateway` itself (CI lives at the monorepo root, out of scope for this package-level vet).

## Verdict Rationale

Applying the supplied policy (`max_critical: 0, max_high: 2, max_medium: 10, max_secrets: 0, warn_on_any_high: true, warn_on_any_injection: true`):

- Malware: 0 → no auto-reject trigger (though ClamAV itself did not run — see coverage gap above).
- Critical: 0 → no auto-reject trigger.
- Secrets: 0 (manual substitute check; true Gitleaks did not run) → no auto-reject trigger.
- High: 1 ≤ max_high (2) → does not exceed threshold, but `warn_on_any_high: true` means any high triggers WARN.
- Medium: 0 ≤ max_medium (10) → fine.
- Injection signals: 1 → `warn_on_any_injection: true` independently triggers WARN.

Net: **WARN**. Nothing here crosses an auto-reject threshold, and the dependency itself (`@simplewebauthn/server@10.0.1`) is clean by every check available — 0 known CVEs reachable through it or its transitive tree, legitimate maintainer, correct license, no malware/secret indicators from the checks that could be run. The WARN is driven by (a) a real authentication-design gap in this commit's *use* of the library (High-1, the headline finding), not the library itself, and (b) a pre-existing, benign, out-of-scope prompt-injection pattern match that policy still counts as a signal.

## Recommendation

**WARN — human review required before merge**, specifically on High-1 (unauthenticated operatorId binding). Suggested path:

1. Before merging, either (a) gate `POST /api/onboard/passkey/register-challenge` behind an existing valid Bearer/API key for the claimed `operatorId`, or (b) explicitly accept the current risk in writing given Phase B/C (the actual consumer of this binding) isn't built yet, and track the fix as a blocking prerequisite for the Phase B PR.
2. The new dependency itself (`@simplewebauthn/server@10.0.1`) is safe to merge as-is from a supply-chain/CVE perspective — no action required there for this PR.
3. Non-blocking follow-up: align on `@simplewebauthn/server@13.x` monorepo-wide in a separate PR (Low-1) and consider a server-side rpId/origin allowlist (Low-2).
4. Re-run this vet with Trivy/Gitleaks/ClamAV/Semgrep installed when feasible — none were available in either this environment or on the configured DGX Spark node, which is a real coverage gap for a security-critical auth commit.
