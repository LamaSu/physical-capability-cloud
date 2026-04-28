# `@pcc/mobile` — PCC Operator/User Mobile Shell

Capacitor 7 hybrid shell that wraps the existing PCC Operator PWA
(`apps/dashboard` → `/operator/mobile`) for distribution to iOS App Store +
Google Play Store, while preserving the PWA as a fallback.

This is **Week 1** of the 6-8 week mobile build. See:

- `apps/mobile/ARCHITECTURE.md` — server.url vs bundled-web decision
  (the v1 architecture decision and the full Weeks 2-6 plugin roadmap)
- `C:\Users\globa\ai\research\agentic-commerce-vision\15-MOBILE-APP-FIRST-PRINCIPLES.md` — full architecture
- `C:\Users\globa\ai\research\agentic-commerce-vision\mobile-app\08-existing-pcc-mobile.md` — what's in PCC today

## What's in Week 1 (this scaffold)

| Capability | File(s) | Tested? |
|---|---|---|
| pnpm package + Capacitor 7.6.2 deps | `package.json` | n/a |
| Capacitor config with `server.url` override | `capacitor.config.ts` | n/a |
| Mobile-specific webmanifest at `/operator/mobile` start_url | `public/manifest.webmanifest` | n/a |
| IndexedDB-backed offline queue (FIFO, retry, idempotency) | `src/sw/offline-queue.ts` | 17 tests |
| Service worker scaffold (queue queueable POSTs on fetch failure) | `src/sw/service-worker.ts` | n/a (E2E in Week 4) |
| Capacitor secure-storage wrapper for `pcc-api-key` + role | `src/storage/secure-api-key.ts` | 24 tests |
| Role-switch UI (user|operator) | `src/RoleSwitch.tsx` | 5 tests |
| User-mode landing placeholder | `src/UserMobilePage.tsx` | n/a |
| Shell entrypoint (boot sequence + routing) | `src/App.tsx` | n/a |

What's NOT in Week 1: native iOS/Android projects (require Xcode + Android
Studio; created in Week 2), passkey + smart-wallet integration (Week 2),
Live Activities + push (Week 3), camera-attest pipeline (Week 4),
CallKit/full-screen-Intent (Week 5), BLE/NFC (Week 6).

## Install

The package is part of the PCC pnpm monorepo. From the repo root:

```bash
spark-run "cd ~/projects/physical-capability-cloud && pnpm install --filter ./apps/mobile"
```

Local install (16GB tablet — risk of OOM):

```bash
pnpm --filter @pcc/mobile install
```

## Develop

For Week 1 development the "app" runs as a wrapped PWA. Open the dashboard
directly:

```bash
pnpm --filter @pcc/dashboard dev
# then visit http://localhost:5173/operator/mobile
```

When the native shells are added (Week 2+), point Capacitor at your local
dev server with:

```bash
cd apps/mobile
CAP_DEV=1 CAP_SERVER_URL=http://10.0.2.2:5173 npx cap sync android
CAP_DEV=1 CAP_SERVER_URL=http://localhost:5173 npx cap sync ios
```

## Test

```bash
pnpm --filter @pcc/mobile test
```

This runs the offline-queue and secure-storage unit tests under jsdom +
fake-indexeddb. No native toolchain required.

## Typecheck

```bash
pnpm --filter @pcc/mobile typecheck
```

## Build

The "build" in Week 1 is a typecheck. There is no per-release web bundle —
the mobile shell loads the deployed dashboard via `server.url`. See
`ARCHITECTURE.md` for why.

```bash
pnpm --filter @pcc/mobile build
```

## Native shells (Week 2+)

Adding the native shells requires Xcode (iOS) and Android Studio (Android),
which aren't available in CI. Locally:

```bash
cd apps/mobile
npx cap add ios       # creates apps/mobile/ios/
npx cap add android   # creates apps/mobile/android/
npx cap sync          # copies web + plugins into native projects
```

Then open the platform projects in their respective IDEs:

- iOS: `apps/mobile/ios/App/App.xcworkspace` in Xcode
- Android: `apps/mobile/android` in Android Studio

These directories are deliberately NOT created in Week 1 — they're built
fresh in Week 2 alongside passkey + Coinbase Smart Wallet integration.

## iOS build (Week 2+)

Requires a Mac with Xcode 15+ and an Apple Developer Program membership
(see `15-MOBILE-APP-FIRST-PRINCIPLES.md` § 14 #5 — start the org enrollment
in parallel with Weeks 1-3).

```bash
cd apps/mobile
npx cap add ios
npx cap sync ios
npx cap open ios     # opens Xcode
```

Sign with the team's distribution profile in Xcode → Product → Archive →
Distribute App → TestFlight.

## Android build (Week 2+)

Requires Android Studio Hedgehog (2023.1.1) or newer and a Google Play
Console developer account.

```bash
cd apps/mobile
npx cap add android
npx cap sync android
npx cap open android   # opens Android Studio
```

Build → Generate Signed Bundle → AAB. Upload to Play Console → Open
Testing track.

## Onboarding for new contributors

1. Read `apps/mobile/ARCHITECTURE.md` for the design context, especially:
   - Why we use `server.url` instead of bundling the web build
   - The role-switch design and where user/operator UI lives
   - The plugin integration roadmap for Weeks 2-6
2. Read `15-MOBILE-APP-FIRST-PRINCIPLES.md` for the full architectural
   reasoning (the substrate phone role, the three-key identity model,
   App Store strategy, risks).
3. Skim `08-existing-pcc-mobile.md` to understand what's in the PCC
   dashboard today that the shell wraps. The single biggest correctness
   gap (offline uploads) is already addressed by the Week 1 offline queue.
4. Run the test suite to confirm the local environment works:

```bash
pnpm --filter @pcc/mobile test
```

5. Confirm typecheck of the whole monorepo is unbroken:

```bash
pnpm -r typecheck
```

The Week 1 scaffold should add zero typecheck errors to other packages.

## Architecture decisions

See `ARCHITECTURE.md` for:

1. Why we chose server.url + deployed PWA over a bundled web build for v1
2. Why role-switch lives in the mobile shell rather than the dashboard
3. Why a dedicated mobile webmanifest (vs editing the dashboard's)
4. Offline-queue + service-worker scope
5. The migration plan to native plugins in subsequent weeks
6. App Store / Play Store risks and mitigations the v1 architecture
   cooperates with (passkey reframing, per-tx consent, etc.)
