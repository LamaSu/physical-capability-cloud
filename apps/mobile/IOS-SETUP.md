# iOS-SETUP.md — Mac-session checklist for the PCC Mobile app

Status: prep doc; assumes you are about to sit down at a Mac to wire the
iOS native bits that have been deferred from W6/W8/W9. Everything in this
checklist requires macOS + Xcode + a paid Apple Developer account.

Cross-reference with `C:\Users\globa\ai\research\agentic-commerce-vision\15-MOBILE-APP-FIRST-PRINCIPLES.md`
section 5 (deployment) for the broader mobile primitives matrix.

---

## 0. Prerequisites

| Tool | Min version | Notes |
|---|---|---|
| macOS | 14.0 (Sonoma) | Live Activities require iOS 16.1+; widget tooling is mature in Xcode 15+ |
| Xcode | 15.4 | 16.x works too. Install via App Store, then open once to accept license |
| Xcode Command Line Tools | latest | `xcode-select --install` |
| CocoaPods | 1.15+ | `sudo gem install cocoapods` (Capacitor 7 still uses Pods) |
| Node + pnpm | matches workspace | already installed |
| Apple Developer account | paid ($99/yr) | Required for: provisioning profiles, push certificates, TestFlight, App Store. Refer to onboarding task #26. |
| Bundle ID reserved | `network.capability.pcc.mobile` (or your choice) | Reserve in App Store Connect → My Apps → New App |

Confirm with `xcode-select -p` that Xcode CLI tools point to a real Xcode.app, not the standalone CLI tools shim (`/Library/Developer/CommandLineTools` ≠ acceptable for Capacitor).

---

## 1. `npx cap add ios` — first iOS scaffold

From the worktree root:

```bash
cd apps/mobile
npx cap add ios
```

Expected output:
```
✔ Adding native xcode project in ios in 12.34ms
✔ add in 23.45ms
✔ Copying web assets from build to ios/App/App/public in 1.2s
✔ Creating capacitor.config.json in ios/App/App in 0.5ms
✔ copy ios in 1.5s
✔ Updating iOS plugins in 234.5ms
✔ Updating iOS native dependencies with pod install in 23.4s
✔ update ios in 24.1s
[info] Sync finished in 25.6s.
```

This creates `apps/mobile/ios/` with:

```
ios/
└── App/
    ├── App.xcworkspace          ← always open this, never .xcodeproj
    ├── App/
    │   ├── AppDelegate.swift
    │   ├── ViewController.swift
    │   ├── Info.plist
    │   ├── Assets.xcassets/
    │   ├── public/              ← bundled web assets (don't edit)
    │   └── capacitor.config.json
    ├── Podfile
    └── Podfile.lock
```

Open in Xcode: `open ios/App/App.xcworkspace`.

Verify the bundle ID under General → Identity matches your reservation. Set Team to your Developer account.

---

## 2. Widget Extension target — for Live Activities

Live Activities are not part of the main app target. They live in a separate Widget Extension target.

In Xcode:
1. File → New → Target
2. Pick **Widget Extension** under iOS → Application Extension
3. Product Name: `PCCApprovalActivity`
4. **Uncheck** "Include Configuration Intent" (we use ActivityKit, not WidgetKit timeline)
5. **Check** "Include Live Activity"
6. Embed in App: `App` (the main target)
7. Click Finish

Xcode prompts to activate the new scheme — say Activate.

This creates:

```
ios/App/
└── PCCApprovalActivity/
    ├── PCCApprovalActivity.swift           ← entry point, lists supported activities
    ├── PCCApprovalActivityLiveActivity.swift ← the actual ActivityAttributes + UI
    ├── Info.plist
    └── Assets.xcassets/
```

Replace `PCCApprovalActivityLiveActivity.swift` with the SwiftUI skeleton in section 4 below.

### App Group (shared container)

Live Activities and the host app exchange data via App Groups. In Xcode:

1. Select the `App` target → Signing & Capabilities → + Capability → App Groups
2. Add a group: `group.network.capability.pcc.mobile` (must start with `group.` and match your bundle ID prefix)
3. Repeat on the `PCCApprovalActivity` target — both targets must belong to the SAME group

---

## 3. `Info.plist` additions

Edit `ios/App/App/Info.plist` (the main app target). Add inside the top-level `<dict>`:

```xml
<key>NSSupportsLiveActivities</key>
<true/>

<key>NSCameraUsageDescription</key>
<string>PCC needs camera access to capture evidence for your job approvals.</string>

<key>NSFaceIDUsageDescription</key>
<string>PCC uses Face ID to securely approve transactions.</string>

<key>NSLocalNetworkUsageDescription</key>
<string>PCC discovers nearby kernels (3D printers, lab equipment) via mDNS.</string>

<key>NSBluetoothAlwaysUsageDescription</key>
<string>PCC pairs with Bluetooth devices for tap-to-attest workflows.</string>

<key>CFBundleURLTypes</key>
<array>
  <dict>
    <key>CFBundleURLName</key>
    <string>network.capability.pcc.mobile.deeplink</string>
    <key>CFBundleURLSchemes</key>
    <array>
      <string>pcc-mobile</string>
    </array>
  </dict>
</array>
```

`pcc-mobile://approval/<sessionId>` is the deep-link the W8 Phase 5 cold-start handler parses.

---

## 4. SwiftUI files for Live Activity layouts

Replace the contents of `ios/App/PCCApprovalActivity/PCCApprovalActivityLiveActivity.swift`:

```swift
import ActivityKit
import WidgetKit
import SwiftUI

// ── ActivityAttributes ─────────────────────────────────────────────────
//
// The "static" attributes of an activity (set once at start time).
// Mobile-side: passed via plugin.startActivity({ id, data: { capability, ... } }).

struct ApprovalActivityAttributes: ActivityAttributes {
    public typealias ContentState = ApprovalContentState

    public struct ApprovalContentState: Codable, Hashable {
        // W8 Phase 2 ladder: waiting → approved → settling → done
        var phase: String
        // 0..1 progress hint for settling phase (W9 A)
        var progress: Double?
        // ISO-8601 expiry (W6 + W8 Phase 8)
        var expiresAt: String?
        // ETA seconds for current phase
        var etaSeconds: Int?
    }

    // Static fields (set at startActivity, never updated)
    var capability: String
    var amountUsd: Double
    var operatorName: String
}

// ── Widget bundle entry ────────────────────────────────────────────────

struct PCCApprovalActivityLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: ApprovalActivityAttributes.self) { context in
            // Lock-screen view (the wide banner shown when phone is locked)
            ApprovalLockScreenView(context: context)
                .activityBackgroundTint(Color.black.opacity(0.85))
                .activitySystemActionForegroundColor(Color.white)
        } dynamicIsland: { context in
            DynamicIsland {
                // ── Expanded view (long-press / detail) ──────────────────
                DynamicIslandExpandedRegion(.leading) {
                    Image(systemName: "checkmark.shield.fill")
                        .foregroundStyle(.green)
                        .font(.title2)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Text(formattedAmount(context.attributes.amountUsd))
                        .font(.title3.bold())
                }
                DynamicIslandExpandedRegion(.center) {
                    Text(context.attributes.capability.capitalized)
                        .font(.headline)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    PhaseProgressView(
                        phase: context.state.phase,
                        progress: context.state.progress
                    )
                }
            } compactLeading: {
                // ── Compact left side of the Dynamic Island pill ─────────
                Image(systemName: phaseIcon(context.state.phase))
                    .foregroundStyle(phaseColor(context.state.phase))
            } compactTrailing: {
                // ── Compact right side ───────────────────────────────────
                if let p = context.state.progress, context.state.phase == "settling" {
                    Text("\(Int(p * 100))%")
                        .font(.caption.monospacedDigit())
                } else {
                    Text(formattedAmount(context.attributes.amountUsd))
                        .font(.caption.monospacedDigit())
                }
            } minimal: {
                // ── Minimal view (when multiple activities are present) ──
                Image(systemName: phaseIcon(context.state.phase))
                    .foregroundStyle(phaseColor(context.state.phase))
            }
            .widgetURL(URL(string: "pcc-mobile://approval/\(context.activityID)"))
            .keylineTint(phaseColor(context.state.phase))
        }
    }
}

// ── Lock-screen layout ─────────────────────────────────────────────────

struct ApprovalLockScreenView: View {
    let context: ActivityViewContext<ApprovalActivityAttributes>

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Image(systemName: phaseIcon(context.state.phase))
                    .foregroundStyle(phaseColor(context.state.phase))
                Text(phaseLabel(context.state.phase))
                    .font(.subheadline.bold())
                Spacer()
                Text(formattedAmount(context.attributes.amountUsd))
                    .font(.title3.bold())
            }
            Text("\(context.attributes.operatorName) — \(context.attributes.capability)")
                .font(.caption)
                .foregroundStyle(.secondary)
            if context.state.phase == "settling", let p = context.state.progress {
                ProgressView(value: p)
                    .tint(phaseColor(context.state.phase))
            }
        }
        .padding(12)
    }
}

// ── Phase progress bar (used in expanded Dynamic Island) ───────────────

struct PhaseProgressView: View {
    let phase: String
    let progress: Double?

    var body: some View {
        if phase == "settling", let p = progress {
            VStack(alignment: .leading, spacing: 4) {
                Text("Settling…")
                    .font(.caption)
                ProgressView(value: p)
                    .tint(.green)
            }
        } else {
            Text(phaseLabel(phase))
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }
}

// ── Helpers ────────────────────────────────────────────────────────────

func phaseIcon(_ phase: String) -> String {
    switch phase {
    case "waiting":  return "clock.fill"
    case "approved": return "checkmark.circle.fill"
    case "settling": return "arrow.triangle.2.circlepath"
    case "done":     return "checkmark.seal.fill"
    default:         return "questionmark.circle"
    }
}

func phaseColor(_ phase: String) -> Color {
    switch phase {
    case "waiting":  return .orange
    case "approved": return .blue
    case "settling": return .purple
    case "done":     return .green
    default:         return .gray
    }
}

func phaseLabel(_ phase: String) -> String {
    switch phase {
    case "waiting":  return "Waiting for your approval"
    case "approved": return "Approved — sending"
    case "settling": return "Settling on-chain…"
    case "done":     return "Done"
    default:         return phase.capitalized
    }
}

func formattedAmount(_ usd: Double) -> String {
    let f = NumberFormatter()
    f.numberStyle = .currency
    f.currencyCode = "USD"
    return f.string(from: NSNumber(value: usd)) ?? "$\(usd)"
}
```

Add `PCCApprovalActivityLiveActivity()` to the bundle entry in `PCCApprovalActivity.swift`:

```swift
import WidgetKit
import SwiftUI

@main
struct PCCApprovalActivityBundle: WidgetBundle {
    var body: some Widget {
        PCCApprovalActivityLiveActivity()
    }
}
```

Build the widget target (Cmd+B with the `PCCApprovalActivity` scheme selected) to verify the SwiftUI compiles.

---

## 5. APNs certificate (for remote Live Activity push updates — Phase 7)

Live Activity push updates use the special `liveactivity` push type. You need an APNs Auth Key (preferred) or a `.p12` certificate.

### Generate APNs Auth Key (preferred — one key per Apple ID, no expiry)

1. Apple Developer portal → Certificates, Identifiers & Profiles → Keys → +
2. Name: `PCC APNs (Live Activity)`
3. Check **Apple Push Notifications service (APNs)**
4. Continue → Register → Download the `.p8` file (you can ONLY download once — back it up)
5. Note the Key ID (10 chars, e.g. `ABCD1234EF`) and Team ID (top-right of portal)

Server-side configuration (gateway sends pushes via `apns2-go` or similar):

```
APNS_KEY_ID=ABCD1234EF
APNS_TEAM_ID=YOURTEAM12
APNS_KEY_PATH=/path/to/AuthKey_ABCD1234EF.p8
APNS_TOPIC=network.capability.pcc.mobile.push-type.liveactivity
APNS_HOST=api.push.apple.com   # or api.sandbox.push.apple.com for dev
```

The push topic for Live Activities is your bundle ID with `.push-type.liveactivity` appended.

---

## 6. Push token registration (mobile side)

When the app boots and starts a Live Activity, iOS gives you a push token specific to THAT activity. Capture it and POST to the gateway so the server can target updates at this specific activity.

In `apps/mobile/src/live-activity/approval-activity.ts` (deferred — needs native bridge):

```typescript
// Pseudo-code — requires the kisimediaDE plugin to expose pushToken in
// startActivity's resolved value (verify against latest plugin docs).
const handle = await LiveActivity.startActivity({ id, data });
if (handle.pushToken) {
  await fetch(`${baseUrl}/api/sessions/${id}/live-activity-push-token`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${sessionToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ pushToken: handle.pushToken }),
  });
}
```

Server-side: store the token associated with the session, send updates via APNs when state transitions happen server-side (e.g. settle-progress events from W9 A could be pushed instead of relying on SSE for users who close the app).

---

## 7. Local simulator testing

Live Activities work in the simulator on iOS 16.1+ but with caveats:

- Lock-screen activities render correctly
- Dynamic Island only shows on iPhone 14 Pro / 15 Pro / 16 Pro family simulators (iPhone 14 base model has no DI hardware → simulator hides it)
- Push updates: APNs to simulators requires Xcode 14.3+ and the `simctl push` command
- Remote pushes go to real devices only

Quick checklist:
- [ ] Build + run on iPhone 15 Pro simulator
- [ ] Open the app, navigate to user mode
- [ ] Trigger a dev-mode approval (`localStorage["pcc-mobile-dev-approval"] = "1"` then reload)
- [ ] Lock the simulator (Cmd+L) → confirm lock-screen activity renders
- [ ] Long-press the Dynamic Island → confirm expanded view renders
- [ ] Tap the activity → confirm app re-opens to the ApprovalSheet via deep-link

---

## 8. Physical device testing

Provisioning profile + entitlements:

1. In Xcode → Signing & Capabilities → make sure Team is selected on BOTH `App` and `PCCApprovalActivity` targets
2. Bundle IDs must match: `network.capability.pcc.mobile` (App) + `network.capability.pcc.mobile.PCCApprovalActivity` (extension)
3. App Group `group.network.capability.pcc.mobile` enabled on BOTH targets
4. Push Notifications capability enabled on the `App` target

Connect a physical device, select it as the build target, hit Cmd+R. First-time:
- Trust the developer cert in Settings → General → VPN & Device Management
- Settings → Notifications → PCC Mobile → Live Activities → ON

Push token:
- Capture the push token from the first startActivity call
- Send a test push via `apns2-cli` or `simctl push <device> <bundle.push-type.liveactivity>` payload

Expected payload shape for a settle-progress push:

```json
{
  "aps": {
    "timestamp": 1730000000,
    "event": "update",
    "content-state": {
      "phase": "settling",
      "progress": 0.5
    }
  }
}
```

To END an activity from the server:

```json
{
  "aps": {
    "timestamp": 1730000000,
    "event": "end",
    "content-state": {
      "phase": "done"
    },
    "dismissal-date": 1730000060
  }
}
```

---

## 9. TestFlight build steps

1. Xcode → Product → Archive (must be on a real device target, not simulator)
2. Window → Organizer → select the new Archive → Distribute App
3. Pick App Store Connect → Upload
4. Choose your distribution cert + provisioning profile (Xcode auto-creates if managed automatically)
5. Wait for processing (10-30 min typically)
6. App Store Connect → TestFlight tab → add internal testers (up to 100, no review needed)
7. Internal testers get a TestFlight invite email

For external testers:
- Submit a build for Beta App Review (1-2 day review cycle)
- Add external testers (up to 10,000)

Do NOT mix iOS-Develop signing identity with App Store distribution — Xcode will refuse to upload.

---

## 10. App Store Connect setup

Before first store submission:

- [ ] Reserve the bundle ID
- [ ] Create the app in App Store Connect (matching bundle ID)
- [ ] Fill the app metadata (description, keywords, screenshots — 6.7" iPhone, 6.1" iPhone, 12.9" iPad)
- [ ] Privacy nutrition label: declare biometric, camera, location, network usage
- [ ] App Review Information: provide a test account + URL for the gateway (or note "uses public read-only API; no login needed for review")
- [ ] Live Activities review note: explain the use case ("user-initiated approval flow for AI-agent commerce")

---

## 11. Things to verify after the iOS bits land

When you bring this back to Windows / regular dev cycle:

- [ ] `pnpm --filter @pcc/mobile typecheck` still clean
- [ ] `pnpm --filter @pcc/mobile test` baseline preserved (W9 baseline: 153+ passing)
- [ ] No new test failures from the optional `capacitor-live-activity` plugin pulling in iOS-only types
- [ ] `apps/mobile/IOS-SETUP.md` updated with anything you learned that wasn't in this checklist

---

## Cross-references

- W6/W8/W9 mobile work: `C:\Users\globa\physical-capability-cloud-wt-w9\apps\mobile\APPROVAL-FLOW.md`
- Mobile-app handoff doc: `C:\Users\globa\ai\research\agentic-commerce-vision\17-MOBILE-APP-HANDOFF.md`
- First-principles deployment matrix: `C:\Users\globa\ai\research\agentic-commerce-vision\15-MOBILE-APP-FIRST-PRINCIPLES.md` § 5
- W8 Live Activity wrapper: `C:\Users\globa\physical-capability-cloud-wt-w9\apps\mobile\src\live-activity\approval-activity.ts`
- W9 settle-progress payload shape: `C:\Users\globa\physical-capability-cloud-wt-w9\packages\gateway\src\routes\centralized-settle.ts` (search `SettleProgressPayload`)

---

Last updated: 2026-04-29 (Week 9 implementer)
