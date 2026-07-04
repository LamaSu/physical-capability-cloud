# Android Build + Publish Critical Path — PCC Mobile

**Agent:** synthesist-alpha | **Run:** 20260703-172224-android-app-build-publish | **Date:** 2026-07-03
**App:** `network.capability.mobile` ("PCC") — Capacitor 7 WebView shell loading https://capability.network via `server.url` (no bundled web build). Build host: GitHub Actions (tablet has no JDK/SDK; Spark down + aarch64).
**Inputs reconciled:** `C:\Users\globa\ai\research\agentic-commerce-vision\17-MOBILE-APP-HANDOFF.md`, `C:\Users\globa\physical-capability-cloud-wt-w11\apps\mobile\ARCHITECTURE.md`, `C:\Users\globa\physical-capability-cloud-wt-android\apps\mobile\capacitor.config.ts`, `C:\Users\globa\ai\research\agentic-commerce-vision\15-MOBILE-APP-FIRST-PRINCIPLES.md`, + 2026-07-03 web research (sources in Appendix).

---

## 1. TL;DR

**From "AAB builds green in CI" to "live on Play production": 1.5–3 weeks (organization account) or 4–6 weeks (personal account).** The rate-limiting step is not code — it is an **account-type decision the user must make on day 0**:

- **Personal account** (fast to create): Google requires a **closed test with ≥12 testers opted-in continuously for 14 days**, then a production-access application (**review ≤7 days**), then production review. Hard calendar floor ≈ 3.5 weeks; realistic 4–6 with tester recruitment and one iteration.
- **Organization account** (exempt from the tester gate): requires a **D-U-N-S number** — days if the entity has one, **up to ~28 days** to issue a new one. If a D-U-N-S already exists (it is ALSO required for the Apple org enrollment already flagged as HUMAN ACTION in 15-FIRST-PRINCIPLES §14#5), this path is ~1.5–3 weeks total and strictly better.

**Second clock:** any AAB uploaded after **2026-08-31** must target **API 36 (Android 16)** — which effectively means a Capacitor 7→8 migration (Cap 7 is pinned to SDK 35). Today is 2026-07-03: **~8.5 weeks of runway** to get the first binary up on the stock config. The `server.url` architecture then minimizes future binary uploads (web updates ship by deploying the PWA), so post-deadline pressure is low until the next native change.

**Conflict with project docs (the finding):** the vision-pack store analysis (15 §9, ARCHITECTURE §7) is almost entirely **Apple**-centric ("~25%→<8% rejection", "Play Open Testing weeks 0-6"). It never accounts for Google's personal-account closed-testing gate — the single biggest Android calendar item — and "Open Testing" does not satisfy that gate (Google counts **closed** testing only). The plan below supersedes the docs' Play timeline.

---

## 2. Current Google Play publishing requirements (2026)

| # | Requirement | Current state (2026-07-03) | Status | Source |
|---|---|---|---|---|
| 1 | New-developer testing gate | Personal accounts created after **2023-11-13**: closed test, **≥12 testers opted-in for the last 14 days continuously** (opt-out resets that tester's counter), then apply for production access; **review "usually 7 days or less"**; can be refused for low tester engagement. Application has 3 question sections (test details, app info, production readiness). **Closed track specifically** — internal/open don't count. | **VERIFIED** (official page fetched 2026-07-03) | support.google.com/googleplay/android-developer/answer/14151465 |
| 1b | Tester count history | Was 20, reduced to 12 on 2024-12-11 | Corroborated (guides only) | primetestlab.com, testerscommunity.com (2026 guides) |
| 1c | Org exemption | Organization accounts (and personal accounts pre-2023-11-13) are NOT subject to the gate — can go straight to production | **VERIFIED** (official page scopes policy to "personal accounts created after November 13, 2023") | answer/14151465 + Play community thread 398243168 |
| 2 | Developer account | **$25 one-time**; identity verification (government ID, sometimes selfie; card in legal name, no prepaid/virtual); verification hours–2 business days. **Org accounts additionally require D-U-N-S** (new issuance up to ~28 days) | VERIFIED (fee/D-U-N-S multi-source 2026 guides + official "Get started" page) | answer/6112435; iconikai.com 2026 |
| 3 | Target API level | New apps + updates: **API 35 (Android 15)** since 2025-08-31; **API 36 (Android 16) from 2026-08-31**. Worktree `variables.gradle` = minSdk 23 / compile 35 / target 35 — **compliant now**; Cap 7.1+ cannot go below 35; API 36 ⇒ Capacitor 8 (minSdk 24 / 36 / 36) | **VERIFIED** (official requirement pages + `apps\mobile\android\variables.gradle` read directly) | developer.android.com/google/play/requirements/target-sdk; answer/11926878; capacitorjs.com/docs/updating/7-0 |
| 4 | Data Safety + privacy policy | Mandatory for ALL apps: Data Safety form + **privacy policy at a live public URL (not a PDF, not geofenced)**. For PCC declare: email/personal info, auth credentials (passkey), financial info (settlement/purchase history), photos (operator evidence), possibly location; purposes, sharing, encryption-in-transit, deletion path. Apps with account creation must also offer **account deletion (in-app + web URL)** — standard since 2024, **UNVERIFIED this session**, confirm in Console | VERIFIED (form+policy mandatory); account-deletion sub-item UNVERIFIED | answer/10787469; termsfeed.com/blog/google-data-safety-form |
| 5 | Signing + format | **AAB required** for new apps; **Play App Signing required** for AAB. Developer generates/holds the **upload keystore** (signs in CI); **Google generates/holds the app signing key** (RSA-4096 on Google KMS) and re-signs for distribution. Upload-key loss recoverable via support reset | **VERIFIED** | answer/9842756; developer.android.com/guide/app-bundle/faq |
| 6 | WebView / minimum functionality | Active 2026 enforcement against "wrapper-only" apps (Spam policy: webview of a site *without owner permission*; Minimum functionality: no value beyond the site). See §3 | VERIFIED (policy pages + 2026 guides + community enforcement threads) | answer/9898783; median.co; blog.webvify.app (2026) |
| 7 | Crypto / financial policy | 2025-08-13 update (effective 2025-10-29): **custodial** exchanges/wallets need regional licenses (US MSB, EU CASP, 15+ markets) + Financial Features Declaration. **Non-custodial explicitly out of scope** (Google clarification 2025-08-14). PCC v3 app is **not a wallet at all** (passkey signs receipts; centralized settlement) → out of scope IF listing avoids wallet/exchange claims | VERIFIED (official policy page exists: answer/16329703; non-custodial clarification multi-source) | answer/16329703; Forbes 2025-08-13; The Paypers |
| 8 | Play Billing | Payments for **physical-world services** (PCC settlements) are exempt from — indeed excluded from — Google Play Billing; standard payment processing is the correct rail | UNVERIFIED this session (high confidence, standard Payments policy) — confirm once in Console | Play Payments policy |
| 9 | Package name | `appId` is **frozen at first upload** — `network.capability.mobile` becomes permanent | Standard Play behavior (UNVERIFIED this session) | Play Console docs |

---

## 3. `server.url` WebView-wrapper rejection risk — assessment for THIS app

**Concrete risk read: LOW-to-MEDIUM, and controllable — but only if the native surfaces actually ship in the binary.** The policy axis is twofold:

1. **Ownership** (Spam policy): webview of a website *without permission of the owner*. PCC owns capability.network → cleanly clearable, but must be **proven**, not asserted. Enforcement is noisy — a 2026 community thread documents suspension despite extensive ownership proof (thread 437157267), so over-prove.
2. **Minimum functionality**: "same experience as the website" with no app-specific value → rejection. A stock `server.url` shell with zero native behavior is the textbook trigger. This app's differentiators (passkey/biometric approval signing, secure storage, offline queue, push/approval flow, camera evidence) exist in the codebase — the risk is shipping a v1 Android binary where none of them are *visible to a reviewer*.

### Mitigation checklist (ordered; each is checkable)

- [ ] **Prove domain ownership**: verify capability.network in Play Console (Search Console verification under the same Google account) AND serve `https://capability.network/.well-known/assetlinks.json` with package `network.capability.mobile` + the **app signing key** SHA-256 fingerprint (from Play Console after first upload — NOT the upload key's). Also enables App Links deep-linking, which itself is a native-value signal.
- [ ] **Ship ≥3 reviewer-visible native features in v1**: biometric/passkey approval sheet (exists, W3), secure-storage-backed session (exists, W1), offline queue with visible "N queued" state (exists, W1), push-driven approval notification (W5 SSE listener; FCM wiring is the Android-native item). Screenshot them in the listing.
- [ ] **Offline error page**: `server.url` apps white-screen or show a stock error offline — a classic reviewer kill. Add `server.errorPath` + a branded offline page in `apps/mobile/public/` (the `webDir`). Cheap, high-value.
- [ ] **Listing copy discipline**: describe the app by its native jobs ("approve settlements with Face ID/fingerprint", "capture signed evidence") — never "access our website". Simultaneously honor the v3 rule: **no crypto-wallet/exchange framing anywhere** (listing, screenshots, in-app first-run) so requirement-row-7 stays out of scope. The centralized-settlement architecture makes this truthful, not cosmetic.
- [ ] **Financial Features Declaration**: answer as not-an-exchange / not-a-wallet (App Content section). Honest under v3 (no custody, receipts not UserOps).
- [ ] **App access form**: the app boots into authenticated surfaces — provide working demo credentials (a seeded demo operator + user session) or a reviewable logged-out mode. A reviewer who can't get past login rejects on minimum functionality by default.
- [ ] **Quality floor**: splash + icon already configured (`capacitor.config.ts` SplashScreen block); keep `allowNavigation` tight (already `capability.network` + subdomains only); `cleartext` stays dev-only (already env-gated).

**Fallback (documented in ARCHITECTURE.md §1 and still true):** if review still balks at remote content, flip to Option A (bundle `apps/dashboard/dist` into the binary) — one config change + a CI copy step. That trades away instant web-deploy updates, so treat as last resort.

---

## 4. Build + publish tooling (wheel-scout: 4 options evaluated)

**Universal constraint (all API tools):** the Play Developer API **cannot create an app record** — the FIRST AAB is always uploaded by hand in Play Console. Automation is for release 2+.

| Option | Version / state (2026-07-03) | Needs | Capacitor fit | CI ergonomics | Verdict |
|---|---|---|---|---|---|
| **Gradle Play Publisher** (Triple-T) | v4.0.0 (2026-01-25); **maintenance mode** — "issues are ignored, PRs are not" (README, fetched today) | GCP SA + AndroidPublisher API + JSON key; config inside `android/` Gradle files | Couples publish logic into the Capacitor-generated Gradle project | Rich (build+upload+promote+listings) but heaviest setup | Capable, but maintenance-mode + Gradle coupling |
| **fastlane supply** | Mature, actively maintained | Same SA JSON; Ruby toolchain; `validate_play_store_json_key` helper | Fine (external to Gradle) | Best-in-class metadata/screenshot management; adds Ruby to a pnpm/TS shop | Overkill at this release cadence |
| **r0adkll/upload-google-play** | **v1.1.5 (2026-04-21), active, 26 releases** (repo fetched today) | SA JSON as GH secret (`serviceAccountJsonPlainText`), `releaseFiles`, `packageName`, `track`, `status` | Clean: consumes the AAB artifact, zero project coupling | Purpose-built GH Action; tracks internal/alpha/beta/production; staged rollout, whatsNew dir, mapping upload. Caveats: use `status: draft` while the app is unpublished (issue #222); avoid concurrent Console edits (edit-conflict failures) | **RECOMMENDED** |
| Manual Play Console | n/a | Human + browser | n/a | Required for upload #1 regardless | Baseline + first upload |

**Recommendation: `r0adkll/upload-google-play@v1.1.5` on top of a plain `gradlew bundleRelease` job, with manual Console for the first upload.** Rationale: the shop is GitHub-Actions-native (PCC already runs GHCR artifact promotion), pnpm/TS (no Ruby), and — decisively — the `server.url` architecture makes binary releases RARE, so deep listing-management tooling (fastlane's strength) buys nothing, while GPP's maintenance-mode status and Gradle coupling are pure liability. Scope the service account to testing-track permissions only; keep production promotion a human click in Console (mirrors the repo's existing "prod promotion is always manual" deploy discipline).

---

## 5. Critical path — ordered checklist

### AUTONOMOUS-NOW (config/CI buildable today, no user input)

| Step | Artifact |
|---|---|
| A1. Release-build workflow (NEW file — per deploy discipline, do not touch `ci.yml`/`deploy-prod.yml`; read `docs/DEPLOY.md` first) | `.github/workflows/android-release.yml`: pnpm install → `npx cap sync android` → temurin JDK 17 (`actions/setup-java`; ubuntu-latest ships the Android SDK) → `gradlew bundleRelease` → upload AAB artifact |
| A2. Signing wiring | `android/app/build.gradle` release `signingConfig` reading env: `ANDROID_KEYSTORE_BASE64` (decoded to file), `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`; unsigned fallback for PR builds |
| A3. versionCode strategy | Monotonic `versionCode` from `github.run_number` (+offset), `versionName` from package version |
| A4. Play-upload job (gated, off until secrets exist) | `r0adkll/upload-google-play@v1.1.5` step: `track: internal`, `status: draft`, `packageName: network.capability.mobile`, `releaseFiles: **/app-release.aab` |
| A5. Offline error page | `apps/mobile/public/offline.html` + `server.errorPath` in `capacitor.config.ts` (§3 mitigation) |
| A6. assetlinks.json scaffold | Gateway route/static serving `/.well-known/assetlinks.json` (fingerprint placeholder until first upload yields the app-signing cert) |
| A7. Drafts of every user-facing form | Privacy-policy draft, Data Safety answer sheet, store listing copy (native-jobs framing, zero crypto-wallet language), 8-item §3 checklist as PR description |
| A8. Keystore generation script (custody stays with user) | `keytool -genkeypair -v -keystore upload-keystore.jks -alias pcc-upload -keyalg RSA -keysize 2048 -validity 10950` + instructions to base64 into GH secret |

### USER-GATED (ordered; each with the exact artifact needed)

1. **Account-type decision** — org (needs D-U-N-S; exempt from tester gate; matches long-term Apple-org need) vs personal (instant; 12-tester/14-day gate). *Artifact: a decision + (if org) the D-U-N-S number.*
2. **Create the Play developer account** — $25, government ID (+possible selfie), card in legal name. *Artifact: verified Play Console account.*
3. **Generate + custody the upload keystore** — run A8; store `.jks` + passwords in password manager; load 4 GitHub secrets. *Artifact: `ANDROID_KEYSTORE_BASE64/-_PASSWORD/KEY_ALIAS/KEY_PASSWORD` secrets.*
4. **First manual AAB upload** in Play Console (creates the app record; **freezes `network.capability.mobile` forever** — confirm the appId first). *Artifact: app record + app-signing-key SHA-256 (feeds A6).*
5. **Privacy policy + account-deletion URL live** — e.g. `https://capability.network/privacy` (+ deletion path). Not a PDF. *Artifact: two stable URLs.*
6. **Play Console forms** — Data Safety, content rating (IARC), target audience, App access (**working demo credentials**), ads declaration (none), Financial Features Declaration (not a wallet/exchange). *Artifact: all App-Content sections green.*
7. **Store listing assets** — 512×512 icon, 1024×500 feature graphic, ≥2 phone screenshots (shoot the native surfaces per §3). *Artifact: listing submittable.*
8. **Service account for CI** — GCP project → enable Google Play Android Developer API → SA + JSON key → invite SA email in Play Console **Users & permissions** with testing-track release rights only. *Artifact: `PLAY_SERVICE_ACCOUNT_JSON` GH secret (unblocks A4).*
9. **If personal account: run the closed test** — create closed track, recruit **≥12 testers (aim 15–20 for dropout buffer; PCC Discord operators/supporters are the natural pool)**, keep opted-in 14 consecutive days, show iteration during the window, then **apply for production access** (≤7-day review). *Artifact: production access granted.*
10. **Production rollout** — promote the tested build, human click (mirror of the repo's manual-prod-promotion rule). *Artifact: live listing.*

---

## 6. Open questions for the user (answer before the publish leg)

1. **Org or personal Play account?** Decides the critical path (D-U-N-S vs 14-day test). Sub-question: **does the entity already have a D-U-N-S** (possibly initiated for the Apple org enrollment flagged 2026-04-28)? If yes → org is unambiguous.
2. **Which Google identity owns the Play account?** Also used to Search-Console-verify capability.network (ownership proof, §3).
3. **Is `network.capability.mobile` final?** Immutable at step 4.
4. **Keystore custody policy** — who holds the `.jks` + passwords besides GH secrets? (Loss is recoverable via Google support reset but costs days.)
5. **Demo credentials for review** — can we mint a persistent demo operator + user account on the production gateway (App access form requires it)?
6. **Privacy policy authorship** — draft exists (A7) but needs legal/owner sign-off; where does it live (`/privacy` on the gateway is proposed)?
7. **Ship before 2026-08-31?** If the calendar risks slipping, decide now whether to fold the Capacitor 7→8 upgrade (target 36 + biometric-auth plugin unpin to 10.x, per 17-HANDOFF Gotcha 1) into this leg rather than as a follow-up.
8. **Tester pool** (personal-account path only): PCC Discord OPERATORS channel? A Google Group makes closed-track tester management easiest.

---

## What this synthesis does NOT establish (negative space)

- Apple/TestFlight/iOS path — out of scope (Mac-gated per 17-HANDOFF).
- Whether Google's production-access review will judge the tester ENGAGEMENT bar as met — official page confirms engagement can be grounds for refusal, but the bar itself is undocumented (guide lore only).
- Exact store-listing asset pixel rules and the account-deletion sub-requirement — standard, but not re-verified this session (flagged in §2).
- Play Billing exemption for physical services (row 8) — high-confidence standard policy, not re-verified; confirm once in Console.
- Compressed away: EU DMA/AltStore + sideload hedges (docs mention; unaffected by any of the above), Play Console screenshots-per-form-factor detail, staged-rollout percentages, post-launch policy-drift maintenance (annual target-API ratchet is the one to calendar: existing apps will need API 35+ to stay visible to new users after the 2026 cycle — the current binary already satisfies it).

---

## Appendix — source log (all accessed 2026-07-03)

- Official, fetched: support.google.com/googleplay/android-developer/answer/14151465 (closed-testing gate); github.com/Triple-T/gradle-play-publisher (v4.0.0, maintenance mode); github.com/r0adkll/upload-google-play (v1.1.5, active).
- Official, via search: answer/11926878 + developer.android.com/google/play/requirements/target-sdk (target API); answer/10787469 (Data Safety); answer/9842756 + developer.android.com/guide/app-bundle/faq (signing/AAB); answer/9898783 (functionality policy); answer/16329703 (crypto policy); answer/6112435 (account setup); capacitorjs.com/docs/updating/7-0 + /8-0 (SDK pins).
- Guides/press (corroboration only): primetestlab.com, testerscommunity.com, 12testers14days.pro (12-tester history); iconikai.com (fees/D-U-N-S 2026); Forbes 2025-08-13 + The Paypers + CCN (crypto policy + non-custodial clarification); median.co, blog.webvify.app (webview enforcement 2026); docs.fastlane.tools; zone2.tech (SA setup).
- Local, verified by read: `C:\Users\globa\physical-capability-cloud-wt-android\apps\mobile\android\variables.gradle` (minSdk 23 / compile 35 / target 35); `C:\Users\globa\physical-capability-cloud-wt-android\apps\mobile\capacitor.config.ts` (appId, server.url, allowNavigation, cleartext gating).
