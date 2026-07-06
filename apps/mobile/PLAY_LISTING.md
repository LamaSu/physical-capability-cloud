# PCC — Google Play submission content pack

Everything you have to type into the Play Console, pre-drafted. Fill the
[BRACKETED] bits. Framing rule throughout: **"service marketplace with on-chain
receipts," never "crypto wallet / exchange"** — that framing is what keeps the
crypto-licensing policy from applying and lowers webview-wrapper rejection risk.

## Store listing

- **App name:** PCC — Physical Capability Cloud
- **Short description** (≤80 chars): `Discover, order, and settle real-world manufacturing and lab jobs.`
- **Full description** (emphasize the native, non-webview value so it doesn't read as a wrapper):

  > Physical Capability Cloud is the control plane for the physical world.
  > Discover machines and labs near you — 3D printing, CNC, HPLC, and more —
  > get a price, place an order, and track it to completion. Every job settles
  > against tamper-evident, on-chain receipts, so you can prove what was made,
  > by whom, and to what standard.
  >
  > Built for the phone:
  > • Sign in and approve orders with a passkey and your fingerprint or face —
  >   no passwords.
  > • Capture job evidence with your camera for certified, audit-ready records.
  > • Stay in control: every payment shows a clear consent screen before it runs.
  > • Works offline — queued actions send automatically when you reconnect.
  >
  > For operators, PCC turns your shop or lab into a callable capability that
  > agents and customers can find, price, and pay — with settlement handled for you.

- **Category:** Business (alt: Productivity)
- **Tags/keywords:** manufacturing, marketplace, 3D printing, lab, logistics
- **Contact email / website:** [CONTACT EMAIL] / https://capability.network
- **Privacy policy URL:** host `PRIVACY_POLICY.md` live (e.g. https://capability.network/privacy) and put the URL here.

## Data Safety form (App content → Data safety)

Declare truthfully — reconcile with `PRIVACY_POLICY.md`. Draft answers:

| Data type | Collected | Shared | Purpose | Notes |
|---|---|---|---|---|
| Email address | Yes | No | Account management | if you sign up by email |
| User IDs (passkey credential IDs) | Yes | No | Account mgmt, auth | private keys stay on device |
| Purchase/financial history | Yes | Yes (blockchain, payment partners) | App functionality | on-chain records are public |
| Photos (evidence capture) | Yes | No | App functionality | camera used only on capture |
| Approx. location | Yes (operators) | No | App functionality | site registration only |
| App interactions / crash logs | Yes | Yes (processors) | Analytics, stability | product analytics + error reporting |

- **Encryption in transit:** Yes.
- **Deletion request method:** provide the [CONTACT EMAIL] / URL from the policy.

## Financial Features declaration (App content)

- Is this a crypto exchange or software wallet? **No.**
- Rationale to keep on file: PCC does **not** custody funds or private keys in the
  app, does **not** exchange crypto, and is **not** a wallet. Passkeys sign
  service receipts; settlement is handled server-side. (Answer any wallet/exchange
  questions accordingly and keep listing copy wallet-free.)

## App access (for reviewers)

The app loads the live service, so reviewers need a way in. Provide a **demo
account or a pre-provisioned API key** with instructions in the "App access"
section, e.g. a test login that lands on the operator view. [CREATE DEMO CREDS]

## Content rating questionnaire

Business/utility app, no objectionable content → expect **Everyone**. Answer the
questionnaire honestly (no violence, no user-generated public content, etc.).

## App Links / domain ownership (webview-wrapper mitigation, follow-up)

Proving you own capability.network materially lowers wrapper-rejection risk. After
the app exists in Play Console (so Play App Signing shows the app's SHA-256), host
this at `https://capability.network/.well-known/assetlinks.json` and set
`android:autoVerify="true"` on the HTTPS intent-filter:

```json
[{
  "relation": ["delegate_permission/common.handle_all_urls"],
  "target": {
    "namespace": "android_app",
    "package_name": "network.capability.mobile",
    "sha256_cert_fingerprints": ["<APP SIGNING KEY SHA-256 FROM PLAY CONSOLE>"]
  }
}]
```

## Graphics checklist (upload in Console)

- App icon 512×512 (currently Capacitor default — generate a branded adaptive icon before a polished release).
- Feature graphic 1024×500.
- Phone screenshots: 2–8, 16:9 or 9:16. (Capture from the running app once installed via internal testing.)
