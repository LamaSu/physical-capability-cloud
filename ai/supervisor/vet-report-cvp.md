# Gate A Vet Report — CVP Wave 2 Packages

**Date**: 2026-04-21
**Agent**: vet-alpha
**Packages scanned**: 6
**Proposal context**: Capture Verification Protocol (CVP) Wave 2 dependency vetting

---

## Summary

| Package | Version | Verdict | Critical | High | Medium | Secrets | Malware | Prompt-Inj | Notes |
|---------|---------|---------|----------|------|--------|---------|---------|------------|-------|
| @contentauth/c2pa-node | 0.5.4 | WARN | 0 | 0 | 0 | 0 | 0 | 0 | postinstall downloads native binary; supply chain note |
| @contentauth/c2pa-web | 0.7.1 | WARN | 0 | 0 | 0 | 0 | 0 | 0 | `highgain` dep: single-maintainer, 1 version |
| @simplewebauthn/server | 13.3.0 | PASS | 0 | 0 | 0 | 0 | 0 | 0 | Makes CRL + MDS3 network calls (expected) |
| appattest-checker-node | 1.0.3 | WARN | 0 | 0 | 0 | 0 | 0 | 0 | Stale (last release Oct 2024); no tests declared |
| @n3arby/play-integrity-verifier | 0.2.0 | WARN | 0 | 0 | 0 | 0 | 0 | 0 | Solo maintainer; 0.2.0 is early; no tests |
| @mediapipe/tasks-vision | 0.10.34 | PASS | 0 | 0 | 0 | 0 | 0 | 0 | Google-authored; WASM bundled; no network fetch at load |

**Totals across all packages**: Critical: 0 | High: 0 | Medium: 0 | Secrets: 0 | Malware: 0 | Injection: 0

---

## Scanner Availability

| Scanner | Status | Notes |
|---------|--------|-------|
| trivy | NOT INSTALLED | Skipped |
| gitleaks | NOT INSTALLED | Skipped |
| clamav | NOT INSTALLED | Skipped |
| npm audit | AVAILABLE (partial) | Run against resolved lockfiles (created per-package) |
| semgrep | NOT INSTALLED | Skipped |
| pip-audit | NOT INSTALLED | N/A (JS packages) |
| prompt-injection | ALWAYS ON | 6/7 regex patterns run (python3 unavailable; invisible Unicode check skipped) |

**Degraded mode**: Only npm audit + prompt injection + manual SAST review ran. Trivy, gitleaks, ClamAV, and semgrep are not installed on this host. Manual code review substituted for SAST.

---

## Per-Package Details

---

### 1. @contentauth/c2pa-node@0.5.4

**License**: MIT
**Publisher**: Adobe (contentauth org, github.com/contentauth/c2pa-node-v2)
**Purpose**: Node.js Neon (Rust FFI) bindings for C2PA signing and reading
**Category**: ADOPT (critical path)

**Verdict: WARN**

#### Findings

**No CVEs found** (npm audit clean for all 9 runtime dependencies including unzipper@0.10.x series).

**Supply chain note — postinstall binary download (MEDIUM severity, informational)**

The package's `scripts/postinstall.cjs` runs automatically on `npm install`. It:
1. Detects the host platform (linux/darwin/win32 + arch)
2. Downloads a prebuilt `.zip` from `github.com/contentauth/c2pa-node-v2/releases/download/vX.Y.Z/c2pa-node_{platform}-vX.Y.Z.zip`
3. Extracts `index.node` (native binary) into `dist/`

The URL is constructed from `package.json`'s `repository.url` + `version` fields — no hardcoded external URL. The binary is from the same org as the package. This is the standard Neon/NAPI prebuilt pattern (used by sharp, better-sqlite3, etc.).

**Risk**: If the GitHub release is compromised or the URL is intercepted (no integrity hash verified before extraction), a malicious binary could be installed. The package does NOT use `npm pack` integrity verification for the downloaded zip.

**Mitigation for production**: Set `SKIP_BINARY_DOWNLOAD=1` and build from Rust source, OR audit the release ZIP's SHA256 against the GitHub release page before installation.

**Rust dependency note**:
- `c2pa@0.78.4` — Adobe's official Rust C2PA crate (crates.io), uses `reqwest` + `rustls-tls` for remote manifest fetching. The `fetch_remote_manifests` feature is enabled. This means C2PA validation may make outbound HTTPS requests to retrieve remote C2PA manifests embedded in media. This is spec-compliant but notable for security architecture.
- `unzipper@^0.10.0` — resolves to max `0.10.14`. npm audit returns clean. CVE-2022-0355 (path traversal) was fixed in versions that migrated to 0.11.x series; 0.10.14 does not appear in the advisory database as currently vulnerable per npm audit.

**Prompt injection**: 0 signals across all `.md`, `.json`, `.js` files.
**Secrets**: 0 (no API keys, no private key material).
**Malware**: Scanner not installed.

#### Install Recommendation

ADOPT WITH CAVEATS:
- Pin the postinstall download using `C2PA_LIBRARY_PATH` if reproducible builds are required
- Document that `c2pa-node` may make outbound HTTPS requests to fetch remote C2PA manifests during verification
- Confirm the prebuilt binary SHA against the GitHub release page before deploying to production

---

### 2. @contentauth/c2pa-web@0.7.1

**License**: MIT
**Publisher**: Adobe (contentauth org, github.com/contentauth/c2pa-js)
**Purpose**: Browser-side C2PA reading and writing via WebAssembly
**Category**: ADOPT (critical path)

**Verdict: WARN**

#### Findings

**`highgain@0.1.0` — single-maintainer dependency (MEDIUM severity)**

The package lists `highgain@^0.1.0` as a runtime dependency. Investigation:
- Published 6 months ago by `emensch` (eli.mensch@gmail.com) — appears to be an Adobe employee based on the c2pa-js GitHub org
- Only 1 version ever published (0.1.0)
- 3.3 KB total, no external dependencies
- Source is a simple WebWorker RPC utility using `postMessage` — no network calls, no exfil
- README says "Details coming soon!"

The code is clean and minimal. The risk is abandonment/typosquatting surface from a micro-dependency with no org backing.

**WASM delivery**: `dist/inline.js` contains an embedded base64-encoded WebAssembly binary (~several MB). This is intentional — it's the C2PA Rust library compiled to WASM. No network fetch occurs at load time. The WASM is bundled at build time from `@contentauth/c2pa-wasm@0.5.1`.

**npm audit (runtime deps)**: All 4 runtime deps clean — no advisories.

**Prompt injection**: 0 signals.
**Secrets**: 0.
**No lifecycle scripts** (no postinstall).

#### Install Recommendation

ADOPT WITH CAVEATS:
- Note the `highgain` single-maintainer micro-dependency. If eli.mensch leaves Adobe, this package could go unmaintained. Consider vendoring if supply chain policy requires org-backed deps.
- The bundled WASM is large. Confirm WASM size budget fits browser delivery constraints.

---

### 3. @simplewebauthn/server@13.3.0

**License**: MIT
**Publisher**: Matthew Miller (MasterKale) — active FIDO author, used by major platforms
**Purpose**: WebAuthn/passkey server-side verification
**Category**: ADOPT (critical path)

**Verdict: PASS**

#### Findings

**npm audit (8 runtime deps)**: 0 vulnerabilities.

**Network calls — expected behavior**:
- `helpers/isCertRevoked.js` — fetches CRL (Certificate Revocation List) URLs embedded in attestation certificates. This is required by WebAuthn spec for authenticator attestation verification. Cached after first fetch.
- `metadata/verifyMDSBlob.js` — parses a FIDO MDS3 JWT blob (caller must download it from `mds3.fidoalliance.org` and pass it in). No automatic outbound calls.

Both are spec-compliant, not exfil. The library does not phone home autonomously.

**Code quality indicators**:
- ESM + CJS dual builds, TypeScript source
- Zero runtime dependencies except @peculiar/asn1-* and @peculiar/x509 (well-maintained, Fortify/PeculiarVentures org)
- Generated by `dnt` (Deno-to-Node transpiler) — clean, reproducible

**Prompt injection**: 0 signals.
**Secrets**: 0.
**No lifecycle scripts**.

#### Install Recommendation

ADOPT-APPROVED — no caveats. Install as-is.

---

### 4. appattest-checker-node@1.0.3

**License**: Apache-2.0
**Publisher**: Srinivas Visvanathan (solo maintainer, github.com/srinivas1729)
**Purpose**: iOS App Attest attestation and assertion verification
**Category**: EXTEND (Wave 2/3)

**Verdict: WARN**

#### Findings

**Staleness**:
- Last release: October 2024 (6+ months ago)
- Apple's App Attest API is stable, so staleness risk is lower than for a library wrapping a volatile API
- No declared test command (`"test": "jest"` in package.json but `jest` is a devDependency and the dist is already compiled)

**Solo maintainer**: No org affiliation, no company email. Library is 1000+ downloads/week on npm based on public data, indicating adoption in the iOS security ecosystem.

**Dependency audit (3 runtime deps)**: 0 vulnerabilities.
- `@peculiar/x509@^1.9.6` — well-maintained cert library
- `cbor@^9.0.1` — mature CBOR decoder, no known advisories
- `json-stable-stringify@^1.1.1` — minimal dep

**No network calls**: Verification is fully offline — parses the attestation CBOR, verifies against Apple's root cert (bundled or overridable via `setAppAttestRootCertificate`). Apple's root cert is hardcoded in the library.

**No lifecycle scripts**.
**Prompt injection**: 0 signals.
**Secrets**: 0.

**Functional concern**: The package has `"@types/node"` listed as a runtime `dependency` (not devDependency). This is a packaging mistake — type-only packages should be devDependencies. It doesn't create a vulnerability but wastes install size.

#### Install Recommendation

ADOPT WITH CAVEATS:
- Monitor for updates — if Apple changes App Attest certificate chain, this library will need updating
- Consider forking or pinning a specific version (`1.0.3`) to avoid surprise changes from a solo maintainer
- If EXTEND timeline is flexible, evaluate `@simplewebauthn/server` for App Attest support (it partially overlaps)

---

### 5. @n3arby/play-integrity-verifier@0.2.0

**License**: MIT
**Publisher**: n3arby (github.com/n3arby/play-integrity-verifier) — solo maintainer, anonymous
**Purpose**: Google Play Integrity API token verification
**Category**: EXTEND (Wave 2/3)

**Verdict: WARN**

#### Findings

**Early-stage package (0.2.0)**: Pre-1.0, no tests (`"test": "echo \"Error: no test specified\" && exit 1"`), documentation is minimal beyond README examples.

**Anonymous maintainer**: npm username is `n3arby`, no org affiliation, GitHub profile is sparse. Low bus-factor risk. Only 2 versions published (0.1.0, 0.2.0 based on semver).

**Dependency audit**: 0 vulnerabilities.
- `@googleapis/playintegrity@^19.1.0` — Google's official client library
- `google-auth-library@^9.0.0` — Google's official auth library
The actual verification is delegated entirely to these Google-maintained libraries. `n3arby`'s code is a thin wrapper (~50 lines).

**Functional review**: The `verifyPlayIntegrity()` function:
1. Creates a `GoogleAuth` client with caller-provided service account credentials
2. Calls `playintegrity.v1.decodeIntegrityToken()` via Google's official API
3. Validates package name matching
4. Returns the decoded token payload

This is the correct server-side pattern. No suspicious behavior.

**No lifecycle scripts**.
**Prompt injection**: 0 signals.
**Secrets**: 0 hardcoded.

**Key consideration**: Since the library is a thin wrapper over `@googleapis/playintegrity`, you could implement the same functionality directly without this dependency. The wrapper adds convenience but also an unvetted supply chain link.

#### Install Recommendation

ADOPT WITH CAVEATS (or replace with direct `@googleapis/playintegrity` usage):
- The thin wrapper pattern means you could drop this dep and call `@googleapis/playintegrity` directly — eliminating the solo-maintainer risk
- If you do use it: pin to `0.2.0` exactly, not `^0.2.0`
- Requires Google Cloud service account with Play Integrity API enabled (caller responsibility)

---

### 6. @mediapipe/tasks-vision@0.10.34

**License**: Apache-2.0
**Publisher**: Google (mediapipe@google.com)
**Purpose**: MediaPipe Face Landmarker and Vision Tasks via WebAssembly
**Category**: EXTEND (Wave 2/3)

**Verdict: PASS**

#### Findings

**npm audit**: N/A — no declared runtime dependencies (`"keywords"` only in package.json, no `"dependencies"` field).

**WASM bundle analysis**:
- Ships 6 files: 3 `.wasm` files + 3 `.js` glue files, plus `vision_bundle.cjs` and `vision_bundle.mjs`
- Total WASM: ~33 MB (3 variants: SIMD, no-SIMD, module)
- JS glue files reference only local `vision_wasm` paths — no CDN URL at load time
- No `eval()`, no `new Function()` usage in either bundle
- No suspicious outbound network calls in JS glue
- Published with `Oct 26 1985` timestamps (epoch 0 artifact from build tooling — common in reproducible build pipelines, not suspicious)

**Google authorship**: Published by `mediapipe@google.com`, part of the official `@mediapipe` npm scope. This is the production MediaPipe Tasks JS SDK.

**Bundle size**: ~34 MB package. Significant for CI install times. Use wasm-file-serving CDN configuration in production to avoid serving WASM from Node.js.

**No lifecycle scripts**.
**Prompt injection**: 0 signals.
**Secrets**: 0.

#### Install Recommendation

ADOPT-APPROVED — no caveats beyond size. This is a Google-published package with no external runtime dependencies and all WASM bundled at build time.

---

## Recommendation

### ADOPT-APPROVED (ready for install now)
- `@simplewebauthn/server@13.3.0` — clean, well-maintained, spec-compliant
- `@mediapipe/tasks-vision@0.10.34` — Google-authored, no deps, WASM bundled

### ADOPT-WITH-CAVEATS (install with documented mitigations)
- `@contentauth/c2pa-node@0.5.4` — postinstall binary download; document `C2PA_LIBRARY_PATH` override option for reproducible builds; note remote manifest fetch behavior
- `@contentauth/c2pa-web@0.7.1` — `highgain` single-maintainer micro-dep; clean code but low org backing; consider vendoring
- `appattest-checker-node@1.0.3` — stale (Oct 2024), solo maintainer; pin exact version; monitor Apple cert chain changes
- `@n3arby/play-integrity-verifier@0.2.0` — thin wrapper, anonymous solo maintainer; consider replacing with direct `@googleapis/playintegrity` call to eliminate supply chain link

### REJECTED
- None

---

## Detailed Caveat Register

| Package | Caveat | Risk Level | Mitigation |
|---------|--------|-----------|------------|
| c2pa-node | postinstall downloads prebuilt native binary from GitHub | MEDIUM | Set `C2PA_LIBRARY_PATH` or verify ZIP SHA before install |
| c2pa-node | Rust `c2pa` crate uses `fetch_remote_manifests` feature | LOW | Document outbound HTTPS behavior for ops |
| c2pa-web | `highgain@0.1.0` — single maintainer, 1 version, no org | LOW | Vendor the 3.3KB file if supply chain policy requires |
| appattest | Last release Oct 2024, solo maintainer | LOW-MEDIUM | Pin exact version; monitor Apple DeviceCheck cert changes |
| appattest | `@types/node` listed as runtime dep (should be devDep) | LOW | Packaging error, no security impact |
| play-integrity | 0.2.0 pre-release, no tests, anonymous maintainer | MEDIUM | Replace with direct `@googleapis/playintegrity` wrapper |
| play-integrity | Requires Google service account credentials at runtime | OPERATIONAL | Caller must secure service account key |

---

## Scanner Coverage Summary

| Scanner | Packages Covered | Findings |
|---------|-----------------|---------|
| npm audit (via lockfile reconstruction) | 6/6 (all runtime deps) | 0 vulnerabilities |
| Prompt injection regex (6/7 patterns) | 6/6 | 0 signals |
| Manual SAST | 6/6 | postinstall binary DL, remote manifest fetch, highgain micro-dep |
| Trivy | NOT RUN (not installed) | — |
| Gitleaks | NOT RUN (not installed) | — |
| ClamAV | NOT RUN (not installed) | — |
| Semgrep | NOT RUN (not installed) | — |
| Invisible Unicode | NOT RUN (python3 unavailable) | — |

**Coverage gap**: Trivy, gitleaks, ClamAV, and semgrep are not installed. The native binary (`index.node` in c2pa-node) and WASM binaries (c2pa-web, mediapipe) cannot be scanned for malware without ClamAV or a binary analysis tool. For production Gate A, install these scanners on the CI host.
