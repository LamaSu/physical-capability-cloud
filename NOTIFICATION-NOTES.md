# Notification delivery — status & gaps (bug B5)

Branch: `fix/driver-notification`. Scope: wire a real email transport behind the
operator notification delivery path, replacing the stubbed
`delivered:true / ref:"stub:transport-not-wired"` that reported success while no
email ever sent.

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

1. **Auto-notify on order arrival is NOT wired.** `dispatchToChannels` currently
   has exactly one caller — the explicit `POST /channels/test` endpoint. There is
   no job-arrival/assignment hook that calls it, so an operator is notified only
   when the delivery test runs, not (yet) automatically when a real job lands.
   The transport is real; the **trigger** from the job-submit path is a separate
   wiring task (call `dispatchToChannels(operatorSlug, {jobId, contextRef,
   summary, priceUSD?, deadlineSec?})` when a job is assigned to an operator).
2. **SMTP not implemented.** `SMTP_URL` is reserved in `resolveEmailTransport`
   but intentionally resolves to `null` (honest not-configured). Wiring SMTP
   needs the `nodemailer` dependency, which must go through Gate A vetting
   (`/vet`) and a `pnpm install` first — out of scope for this change. Add it as
   another `EmailTransport` implementation; no dispatch-path change required.
3. **Other transports unimplemented.** `sms/voice/push/mqtt/file` report
   `transport_not_implemented`. Each needs its own provider (Twilio, FCM, an
   MQTT client, etc.), added behind the same seam.
4. **Existing suite not run here.** `operator-channels.test.ts` imports
   `db.js` + `a2a-tasks.js`, which pull in `@pcc/store`, `@pcc/contract-builder`,
   `@pcc/kernel`, `@pcc/spec` — those packages are unbuilt in this fresh worktree
   and building the full tree is heavy (16 GB box, no DGX Spark). That file's
   assertions only exercise `manual`/`webhook`/validation/attach paths, none of
   which this change touches, so it is unaffected by inspection; it was not
   executed here. Build the workspace deps to run it
   (`pnpm --filter @pcc/spec --filter @pcc/store ... build`, then the gateway
   suite).

## Deploy safety

No deploy, push, `:prod` retag, Railway, or GHCR changes were made. No secret is
committed — the real `RESEND_API_KEY` is supplied in the deploy env only.
