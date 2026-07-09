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
- Not done (still open, unchanged from below): SMTP (gap #2), sms/voice/push/
  mqtt/file transports (gap #3).

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
3. **Other transports unimplemented.** `sms/voice/push/mqtt/file` report
   `transport_not_implemented`. Each needs its own provider (Twilio, FCM, an
   MQTT client, etc.), added behind the same seam.
4. ~~**Existing suite not run here.**~~ **CLOSED** — see the UPDATE section
   above. Ran on DGX Spark (106GB RAM, no 16GB local-box limit): full monorepo
   build + full `@pcc/gateway` suite, 107 files / 1911 tests green.

## Deploy safety

No deploy, push, `:prod` retag, Railway, or GHCR changes were made. No secret is
committed — the real `RESEND_API_KEY` is supplied in the deploy env only.
