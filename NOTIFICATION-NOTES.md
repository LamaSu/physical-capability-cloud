# Notification delivery — status & gaps (bug B5)

Branch: `fix/driver-notification` (transport) + `feat/notifications-transport`
(trigger, see update below). Scope: wire a real email transport behind the
operator notification delivery path, replacing the stubbed
`delivered:true / ref:"stub:transport-not-wired"` that reported success while no
email ever sent.

## UPDATE (branch `feat/notifications-transport`) — the trigger is now wired

Gap #1 below ("auto-notify on order arrival is NOT wired") is closed. New:

- `packages/gateway/src/services/job-offer-notifier.ts` — looks up which
  operators have a capability matching a posted offer's `capabilityType`
  (exact match on `capabilities.type`, joined to `shopKernels.operatorAddress`
  — the same operator-slug identity `operator-status.ts`/`operator-channels.ts`
  already use), then calls `dispatchToChannels` for each so every enabled
  channel gets pinged. DB lookup (`defaultOperatorLookup`) is injectable
  (`OperatorLookup`) for unit testing without a live DB.
- `job-offers-store.ts` — `JobOffersStore.create()` now calls an optional
  `notifyOperators` hook once per **newly-created** offer only (never on an
  idempotent replay), wrapped in try/catch so a notifier failure can never
  fail the job post. Omitting the option (all pre-existing callers) is a
  no-op — zero behaviour change for anything that doesn't opt in.
- `server.ts` — wires `createOperatorNotifier()` into both
  `initJobOffersStore()` call sites (SQLite-backed and in-memory fallback), so
  every job-offer post (including the legacy `/api/courier-jobs` shim, which
  delegates to the same store) now triggers operator notification.
- Tests: `packages/gateway/src/__tests__/job-offer-notifier.test.ts` — 27
  tests (store-wiring, payload shape, dispatch behaviour, a DB-backed
  `defaultOperatorLookup` suite against a real in-memory SQLite store, and an
  end-to-end path proving `JobOffersStore.create()` reaches the email
  transport). All green.
- Verified on Spark: full monorepo build (53/53 packages) + the full
  `@pcc/gateway` test suite — **107 test files / 1911 tests passed, 5
  skipped (pre-existing), 0 failures.** This also finally executes gap #4
  below (`operator-channels.test.ts`, 23 tests) and `email-delivery.test.ts`
  (19 tests) — both green, closing that deferred verification too.
- Not done (still open, unchanged from below): SMTP (gap #2), voice/push/
  mqtt/file transports (gap #3 — **sms is now wired**, see the SMS UPDATE below).

## UPDATE (branch `feat/notifications-transport`) — the SMS (Twilio) transport is now wired

Gap #3's `sms` leg is closed (voice/push/mqtt/file still honestly unimplemented):

- `packages/gateway/src/services/sms-transport.ts` (new) — provider-neutral
  `SmsTransport` interface + `TwilioTransport`, mirroring `email-transport.ts`'s
  `ResendTransport` exactly. A real send is a single Basic-authenticated POST
  (`Authorization: Basic base64(AccountSID:AuthToken)`) to Twilio's Messages
  REST API with a form-urlencoded `To`/`From`/`Body` body, via the built-in
  `fetch` — **zero new npm deps** (no Gate-A vetting of a new package). On
  success the dispatch `ref` is the **real Twilio message SID**.
- **Config gating.** `resolveSmsTransport(env)` returns a transport only when
  **all three** of `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`,
  `TWILIO_FROM_NUMBER` are set, else `null`. The sms dispatch path
  (`operator-channels.ts` → `sendSms`) now:
  - configured → actually sends, `delivered:true`, `ref = <Twilio message SID>`;
  - **not configured → `delivered:false`, `error:"sms_not_configured"`** — an
    explicit, honest result, **not** a fake success (this is the build-env case);
  - bad endpoint → `error:"invalid_endpoint"`; provider rejects → `send_failed`.
- **Attach validation.** `attachChannel` now requires `endpoint.phoneE164` in
  E.164 form for `transport:"sms"` (rejects missing/malformed with code
  `invalid_endpoint`). New exported `SmsEndpoint` type documents the shape.
- **Mockable seam.** `getSmsTransport()` honors `__setSmsTransportForTests()`,
  same shape as the email seam. Provider-swappable: a Vonage/Plivo/SNS
  `SmsTransport` can drop in behind the same seam with no dispatch-path change.
- **Tests.** `packages/gateway/src/__tests__/sms-delivery.test.ts` — 23 tests
  (env gating, Twilio request shape via injected fetch, E.164 validation, the
  dispatch sms path), isolated (no `@pcc` workspace build needed) like
  `email-delivery.test.ts`. Plus `job-offer-notifier.test.ts` gains an
  end-to-end block: `JobOffersStore.create()` → notifier → `dispatchToChannels`
  → a **real `TwilioTransport` with only `fetch` mocked** reaches Twilio's wire
  format for an operator whose capability matches the offer and who has an sms
  channel.
- **Verified on Spark:** `sms-delivery.test.ts` **23/23 green**;
  `pnpm --filter @pcc/gateway typecheck` clean for all changed files (the one
  remaining tsc error is pre-existing in `settlement-crank.ts` — Step-1 crank,
  out of scope, untouched here).

### To enable real SMS sends in a deploy env (NOT done here — no creds in build env)

Set all three in the gateway service env (e.g. Railway). **Do not commit them.**

1. `TWILIO_ACCOUNT_SID` — your Twilio Account SID (starts `AC…`).
2. `TWILIO_AUTH_TOKEN` — that account's Auth Token (or an API-key secret paired
   with an SID; the transport uses HTTP Basic `SID:token`).
3. `TWILIO_FROM_NUMBER` — an SMS-capable number **you own in that account**, in
   E.164 (e.g. `+14155550100`). Twilio rejects sends from a From number the
   account doesn't own.

Then `POST /api/operators/:slug/channels/test` for an operator with an `sms`
channel (`endpoint.phoneE164`) performs a real send and returns the Twilio
message SID as `ref`. All three unset → `sms_not_configured` (fail closed).

## What was fixed (done, tested)

- **Real email transport.** `packages/gateway/src/services/email-transport.ts`
  adds a provider-neutral `EmailTransport` interface and a `ResendTransport`
  that sends via the built-in `fetch` (zero new npm deps — same pattern as the
  existing `sendWebhook`). On success the dispatch `ref` is the **real Resend
  message id**, never the stub.
- **Config gating.** `resolveEmailTransport(env)` returns a transport when
  `RESEND_API_KEY` is set, else `null`. The email dispatch path
  (`packages/gateway/src/routes/operator-channels.ts` → `sendEmail`) now:
  - configured → actually sends, `delivered:true`, `ref = <provider id>`;
  - **not configured → `delivered:false`, `error:"email_not_configured"`** — an
    explicit, honest result, **not** a fake success (this is the build-env case);
  - bad endpoint → `error:"invalid_endpoint"`; provider rejects → `send_failed`.
- **Honest unwired transports.** `sms/voice/push/mqtt/file` no longer return the
  fake stub success; they return `delivered:false, error:"transport_not_implemented"`.
- **Mockable seam.** `getEmailTransport()` honors a test override
  (`__setEmailTransportForTests`). Tests assert "sends when configured" against a
  fake transport with no live provider and no real key.
- **Tests.** `packages/gateway/src/__tests__/email-delivery.test.ts` — 19 tests,
  all green. Runs scoped (no `@pcc` workspace build needed) because it imports
  only `operator-channels.js` + `email-transport.js`.
  Run: `cd packages/gateway && node_modules/.bin/vitest run src/__tests__/email-delivery.test.ts`

## To enable real sends in a deploy env (NOT done here — no key in build env)

1. Set `RESEND_API_KEY` in the gateway service env (e.g. Railway). **Do not
   commit it.**
2. Set `EMAIL_FROM` to an address on a domain **verified in that Resend
   account** (default is `notifications@capability.network`; Resend rejects sends
   from unverified domains).
3. Then `POST /api/operators/:slug/channels/test` for an operator with an
   `email` channel (`endpoint.address`) performs a real send and returns the
   provider id as `ref`.
   - Intended live test channel: `thespacekyd@gmail.com`. **Not attempted in
     this build env** (no provider key here, per task constraints).

## Remaining gaps / follow-ups

1. ~~**Auto-notify on order arrival is NOT wired.**~~ **CLOSED** — see the
   UPDATE section above (`services/job-offer-notifier.ts`, branch
   `feat/notifications-transport`). `JobOffersStore.create()` now fires it on
   every newly-posted offer.
2. **SMTP not implemented.** `SMTP_URL` is reserved in `resolveEmailTransport`
   but intentionally resolves to `null` (honest not-configured). Wiring SMTP
   needs the `nodemailer` dependency, which must go through Gate A vetting
   (`/vet`) and a `pnpm install` first — out of scope for this change. Add it as
   another `EmailTransport` implementation; no dispatch-path change required.
3. ~~**Other transports unimplemented.**~~ **sms CLOSED** (Twilio — see the SMS
   UPDATE section above). `voice/push/mqtt/file` still report
   `transport_not_implemented`; each needs its own provider (a voice API, FCM,
   an MQTT client, etc.), added behind the same seam.
4. ~~**Existing suite not run here.**~~ **CLOSED** — see the UPDATE section
   above. Ran on DGX Spark (106GB RAM, no 16GB local-box limit): full monorepo
   build + full `@pcc/gateway` suite, 107 files / 1911 tests green.

## Deploy safety

No deploy, push, `:prod` retag, Railway, or GHCR changes were made. No secret is
committed — the real `RESEND_API_KEY` is supplied in the deploy env only.
