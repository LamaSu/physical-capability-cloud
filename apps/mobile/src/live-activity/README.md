# Live Activities — Approval Sessions (Week 6 v1)

Thin wrapper around `capacitor-live-activity` (kisimediaDE) that drives
a one-phase Live Activity for incoming approval requests.

## What's wired (Week 6)

- `startApprovalActivity({id, capability, amountUsd, operatorName, expiresAt?})`
  fires `plugin.startActivity()` with the payload mapped onto the widget
  content state. Returns synchronously with a handle whose `.started`
  flag flips to true once the plugin acknowledges.
- `endApprovalActivity(handle, {outcome})` fires `plugin.endActivity()`
  with the outcome string (`approve` / `reject` / `dismiss`).
- Listener integration in `apps/mobile/src/App.tsx`:
  - On approval-request event arrival: call `startApprovalActivity`.
  - On `ApprovalSheet` approve / decline: call `endApprovalActivity`.
- Plugin resolution is dynamic: when the package isn't installed (web
  build, unit tests without Cap toolchain), the wrapper no-ops
  gracefully and the rest of the app keeps working.
- Tests use `_setPluginForTests(mockPlugin)` to drive deterministic
  start/end assertions. 9 module-level tests + 3 App.tsx integration
  tests cover the happy + no-plugin + failure paths.

## What's NOT wired (deferred to Week 7)

The de-risk plan
(`C:\Users\globa\ai\research\agentic-commerce-vision\mobile-app\derisk\04-capacitor-live-activities.md`)
specifies an 8-phase UI ladder. Week 6 covers Phase 1 (single-phase pending
state); Phases 2-8 are explicitly deferred:

- Phase 2: status changes (pending → signing → submitted → settled).
- Phase 3: progress bar / countdown timer based on `expiresAt`.
- Phase 4: dismiss-action wiring (user swipes away → POST reject).
- Phase 5: deep-link from Live Activity tap → `ApprovalSheet`.
- Phase 6: Dynamic Island compact / expanded / minimal layouts.
- Phase 7: SwiftUI `ActivityConfiguration` widget (App Group sharing).
- Phase 8: APNs `liveactivity` push updates via
  `startActivityWithPush()` + `liveActivityPushToken` event.

## iOS native setup (required for the Live Activity to actually run on-device)

The mobile workspace ships without an `apps/mobile/ios/` directory in
this branch — Capacitor 7's iOS scaffold needs to be generated on a Mac
and is too large for ergonomic cross-platform commits. Week 7 (or any
future iOS-touching session) MUST run, on a Mac with Xcode 15+:

```bash
# 1. Generate the iOS scaffold
cd apps/mobile
npx cap add ios

# 2. Install the plugin into the iOS pods
cd ios/App
pod install
```

Then in Xcode:

1. **Info.plist (main app target)**: add `NSSupportsLiveActivities = YES`.
2. **Capabilities (main app)**: enable Push Notifications + Live Activities.
3. **File → New → Target → Widget Extension**:
   - Target name: `PCCSessionLiveActivity`
   - Check "Include Live Activity"
4. **Copy `Pods/CapacitorLiveActivity/.../Shared/GenericAttributes.swift`**
   into the widget target — the plugin needs it for the `ActivityAttributes`
   bridge type.
5. **App Groups capability** on BOTH the main app target AND the widget
   extension. Group ID: `group.network.capability.pcc.liveactivity`.
6. **Widget files** (SwiftUI, all in the new target):
   - `PCCSessionLiveActivity.swift` — `@main` widget bundle.
   - `PCCSessionAttributes.swift` — `ActivityAttributes` conformance.
   - `LockScreenView.swift` — full lock-screen surface.
   - `DynamicIslandViews.swift` — compact / expanded / minimal regions.
   - `Info.plist`: `NSExtensionPointIdentifier = com.apple.widgetkit-extension`.

The de-risk doc has copy-pasteable Swift snippets for steps 6 — start
there.

## APNs server-side (out of scope for Week 6)

Token-based auth (the `.p8` key, NOT the legacy `.p12` cert path):

- `apns-push-type: liveactivity`
- `apns-topic: network.capability.pcc.push-type.liveactivity`
- `apns-priority: 10`
- `authorization: bearer <ES256 JWT signed by .p8 key>`
- Payload max 4KB.

PCC's gateway already has the auth helpers; wiring the APNs sender is
a Week 7+ task.

## Test patterns

- Unit-test the wrapper directly with `_setPluginForTests(mockPlugin)`.
  Mock plugin records `start`/`end` calls into a log array; assert on
  the log after `await new Promise(r => setTimeout(r, 0))` to drain
  the async fire-and-forget IIFE.
- Integration-test in App.tsx by setting the same mock plugin, firing
  an approval-request event through the MockEventSource, and checking
  the log.
- The `.started` flag on a handle reflects whether the plugin succeeded
  — use it in tests to verify error paths (plugin throws → started
  stays false, no crash, `console.warn` was called).
