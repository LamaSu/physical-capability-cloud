# PCC Android — Publishing Runbook

Operational steps to take the PCC Android app from "builds in CI" to "live on
Google Play". For the *why* behind each requirement (dated + cited), see
`ai/research/android-publish-critical-path.md` (the requirements synthesis).

## What's already built (in this branch)

- Native Android project at `apps/mobile/android/` (`appId network.capability.mobile`,
  Capacitor 7.6.2, `targetSdk 35`).
- Release **signing config** in `android/app/build.gradle` — reads
  `android/keystore.properties` (local, gitignored) or `PCC_ANDROID_KEYSTORE_*`
  env (CI). Debug-signed fallback so a build proves out before signing is wired.
- **Security:** `allowBackup=false` (app holds API keys + passkey material),
  `pcc-mobile://` deep-link intent-filter.
- **Offline fallback:** `public/index.html` shown when `capability.network` is
  unreachable (Play's minimum-functionality-offline check for wrapper apps).
- **CI:** `.github/workflows/android-build.yml` — manual-trigger build of a signed
  AAB, optional upload to a Play test track (`r0adkll/upload-google-play`).

## The one decision that sets the timeline: org vs personal account

| | Setup lead time | Time to production | Tester gate |
|---|---|---|---|
| **Organization** | D-U-N-S number (~28 days if you don't have one) | **~1.5–3 wks** | **Exempt** — publish straight to production |
| **Personal** | Minutes | **~4–6 wks** | **12+ testers, 14 consecutive days**, then a ≤7-day production-access review |

The **same D-U-N-S** is needed for the Apple org enrollment already on the iOS
to-do list — get it once, use it for both stores. If you're going org for Apple,
go org for Google too and skip the 14-day tester gate.

## Deadline that matters: target-API-35 window

`targetSdk 35` is compliant for **new submissions only until 2026-08-31**. After
that a *new binary* needs API 36 = a Capacitor 8 upgrade (also unpins the
biometric-auth plugin). Because the app ships web updates via `server.url` (not a
new binary), an API-35 binary landed before the deadline keeps working — but get
the **first binary submitted before 2026-08-31** to stay on the current toolchain.
(~8.5 weeks of runway as of 2026-07-03.)

## Ordered checklist

Autonomous parts (done ✅) vs your parts (▢):

1. ✅ Native project + signing + CI (this branch).
2. ▢ **Decide org vs personal** (above). If org and you lack a D-U-N-S, start that
   first — it's the long pole.
3. ▢ **Create the Play Developer account** — $25 one-time + ID verification
   (government ID; a few hours to ~2 business days).
4. ▢ **Generate the upload keystore** — `bash apps/mobile/android/generate-upload-keystore.sh`
   on any machine with a JDK. Back it up. Then set the four `PCC_ANDROID_*` GitHub
   secrets (the script prints them). Enroll in **Play App Signing**.
5. ▢ **Authorize the CI build** — push this branch and run the *Android Build*
   workflow (Actions → Android Build → Run workflow). Download the signed
   `pcc-release-aab` artifact. (This is the first real proof the AAB compiles —
   it can't be built locally; no JDK/Android SDK here.)
6. ▢ **First upload is MANUAL** — in Play Console, create the app record and upload
   the AAB to the **internal testing** track. This freezes `network.capability.mobile`
   as the package name. (The Play API can't create app records — every automated
   upload is release 2+.)
7. ▢ **Complete the Console forms** — privacy-policy URL (live, not a PDF) +
   account-deletion URL, Data Safety form (declare: email, passkey/credential IDs,
   payment history, maybe camera/location), App Access (demo login for reviewers),
   Financial Features declaration → **answer "not a wallet / not an exchange"** and
   keep the listing copy free of wallet/crypto framing (the v3 receipts-not-custody
   design is what makes this true).
8. ▢ **Store listing assets** — 512×512 icon, feature graphic, screenshots,
   short/full description (framed as a "service marketplace with on-chain receipts",
   not a crypto app).
9. ▢ **Reduce webview-wrapper rejection risk** (assessed LOW–MEDIUM) — the two
   load-bearing mitigations: prove domain ownership of capability.network, and make
   sure ≥3 native features (passkey/biometric, offline handling, camera/push) are
   visibly reachable in the shipped app, not just present as plugin code. See §3 of
   the critical-path doc for the full 8-item checklist. **Note:** operator mode
   loads the remote PWA via `server.url`; confirm the native surfaces actually
   render in the shipped binary before submitting.
10. ▢ **Release 2+ automation** — add the `PCC_PLAY_SERVICE_ACCOUNT_JSON` secret
    (GCP service account invited to Play Console, scoped to test tracks) and run the
    workflow with `upload_track: internal` to auto-upload future builds.
11. ▢ **Production** — personal accounts: recruit 12+ testers, keep them opted-in 14
    consecutive days, then apply for production access. Org accounts: roll out to
    production directly.

## Follow-ups deferred (not blocking first release)

- **HTTPS App Links** for `capability.network` — needs a `/.well-known/assetlinks.json`
  deployed on the gateway (a server change); until then only the `pcc-mobile://`
  custom scheme deep-links work. Don't set `android:autoVerify="true"` before
  assetlinks is live.
- **Branded launcher icons** — currently Capacitor defaults; generate adaptive
  icons from a source logo (`@capacitor/assets`) before a polished release.
- **Android foreground-service notification** — the approval-pending UX equivalent
  of iOS Live Activities (Android has no Live Activities API).
