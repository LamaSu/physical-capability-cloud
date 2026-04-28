# `@pcc/mobile` — PCC Operator/User Mobile Shell

Capacitor 7 hybrid shell that wraps the existing PCC Operator PWA
(`apps/dashboard` → `/operator/mobile`) for distribution to iOS App Store +
Google Play Store, while preserving the PWA as a fallback.

This is **Week 1** of the 6-8 week mobile build. See:

- `apps/mobile/ARCHITECTURE.md` — server.url vs bundled-web decision
- `C:\Users\globa\ai\research\agentic-commerce-vision\15-MOBILE-APP-FIRST-PRINCIPLES.md` — full architecture
- `C:\Users\globa\ai\research\agentic-commerce-vision\mobile-app\08-existing-pcc-mobile.md` — what's in PCC today

## What's in Week 1

- Capacitor 7 scaffolding (`capacitor.config.ts`, `package.json`, native
  shells deferred — see "Native shells" below).
- Dedicated mobile webmanifest at `public/manifest.webmanifest`
  (`/operator/mobile` start_url; the dashboard's `/operator` manifest is
  untouched so desktop PWA install continues to work).
- IndexedDB-backed offline queue scaffold for evidence-push retries.
- Service worker scaffold that registers and intercepts fetch failures.
- `capacitor-secure-storage-plugin` wrapper for the `pcc-api-key` Bearer
  token, with PWA-fallback to localStorage.
- Role-switch state (user|operator) with a placeholder UserMobilePage.

What's NOT in Week 1: native iOS/Android projects (require Xcode + Android
Studio; created in Week 2), passkey + smart-wallet integration (Week 2),
Live Activities + push (Week 3), camera-attest pipeline (Week 4),
CallKit/full-screen-Intent (Week 5).

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

## Architecture decisions

See `ARCHITECTURE.md` for:

1. Why we chose server.url + deployed PWA over a bundled web build for v1
2. Why role-switch lives in the mobile shell rather than the dashboard
3. Why a dedicated mobile webmanifest (vs editing the dashboard's)
4. Offline-queue + service-worker scope
5. The migration plan to native plugins in subsequent weeks
