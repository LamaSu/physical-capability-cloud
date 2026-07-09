# Notification delivery — status & gaps (bug B5)

Branch: `fix/driver-notification` (transport) + `feat/notifications-transport`
(trigger, see update below). Scope: wire a real email transport behind the
operator notification delivery path, replacing the stubbed
`delivered:true / ref:"stub:transport-not-wired"` that reported success while no
email ever sent.

## UPDATE (branch `feat/notifications-transport`) — agent-native channel: signed A2A task dispatch + onboarding/heartbeat auto-registration

A new transport, not a gap-closure: operators who run the PCC agent package
(Claude Code) and register on the PCC subnet get pinged **agent-natively** —
a signed A2A task, no SMS/email/credential — and the channel is
**auto-registered when they onboard**, so it's automatic for agent operators.

- `packages/gateway/src/services/a2a-transport.ts` (new) — `A2aTransport`
  interface + `PccAgentTaskTransport`, mirroring `email-transport.ts`'s
  `ResendTransport` / `sms-transport.ts`'s `TwilioTransport` in shape, but
  gated on a DIFFERENT kind of "configured": not a third-party credential,
  but the gateway's OWN agent-card signing key
  (`PCC_AGENT_CARD_SIGNING_KEY`, loaded once at boot by `signing-key.ts` and
  already used to sign `/.well-known/agent-card.json`). A send builds a
  JSON-RPC 2.0 `tasks/send` envelope — the identical wire shape
  `routes/a2a-tasks.ts`'s own inbound handler parses — signs the WHOLE
  envelope with `@pcc/a2a-signing`'s `signAgentCard` (its `AgentCard` type is
  generic, `Record<string, unknown>` — reused as-is, not hand-rolled), and
  POSTs it to the operator's own registered agent endpoint. The dispatch
  `ref` is the **real task id the receiving agent assigns** (per A2A v1.0
  semantics — the receiver mints the task id, exactly like PCC's own
  `dispatchTasksSend` does for inbound calls) — never self-minted.
- **Config gating.** `resolveA2aTransport()` returns a transport only when a
  signing key is loaded, else `null`. The a2a dispatch path
  (`operator-channels.ts` → `sendA2a`) now:
  - configured + operator's agent reachable and accepts → `delivered:true`,
    `ref = <the operator agent's own task id>`;
  - **no signing key configured → `delivered:false`,
    `error:"a2a_not_configured"`** — honest, not a fake success (this is the
    build-env case, same shape as `sms_not_configured`/`email_not_configured`);
  - bad/missing endpoint → `error:"invalid_endpoint"`; the operator's agent
    unreachable, rejects, or replies malformed → `send_failed` — **fail
    closed**, per the acceptance criterion ("agent not registered → fail
    closed").
- **New channel transport `"a2a"`.** `endpoint` shape `{agentId, endpoint}`
  — `agentId` is the operator's agent's PCC-network identity, `endpoint` is
  the absolute http(s) URL where that agent exposes its own A2A
  `tasks/send`-compatible handler. `attachChannel` validates both fields
  (missing/malformed → `invalid_endpoint`, same as sms's E.164 check). New
  exported `A2aEndpoint` type documents the shape.
- **The onboarding hook — `autoRegisterA2aChannel`** (`operator-channels.ts`,
  exported). Idempotent per `(operatorSlug, agentId)`: an exact repeat is a
  true no-op; the same agent re-registering with a new endpoint refreshes
  the existing channel in place (self-heals endpoint rotation); a different
  agentId for the same operator gets its own channel (one operator can run
  several agents/kernels). Never throws — a malformed endpoint returns
  `null` rather than blocking whatever triggered it. Wired at **two**
  registration points:
  1. `pcc-author-integration` (`routes/a2a-tasks.ts`) — the primary
     onboarding point. New optional `agentEndpoint` param; when present, the
     operator's own a2a channel is auto-attached additively alongside any
     explicit `channels[]`. Response gains `a2aChannelRegistered: boolean`.
  2. `POST /api/agents/heartbeat` (`routes/agent-heartbeat.ts`) — the
     "...or heartbeats" trigger. New optional `operatorSlug` +
     `agentEndpoint` body fields; when both present, the channel is
     auto-registered/refreshed on every heartbeat, independent of whether
     the ASI10 liveness monitor happens to already track that `agentId`
     (best-effort — never fails the heartbeat itself).
- **Mockable seam.** `getA2aTransport()` honors `__setA2aTransportForTests()`,
  same shape as the sms/email seams.
- **Tests.** `packages/gateway/src/__tests__/a2a-delivery.test.ts` (new) —
  signing-key gating, real-signing request-shape + round-trip verification
  via `verifyAgentCard`, endpoint validation, the dispatch a2a path,
  `autoRegisterA2aChannel` idempotency, and the heartbeat route's
  auto-registration. `job-offer-notifier.test.ts` gains an end-to-end block:
  `JobOffersStore.create()` → notifier → `dispatchToChannels` → the a2a
  transport (mocked send), including the explicit "agent not registered →
  no dispatch attempt" case. `a2a-tasks.test.ts` gains two
  `pcc-author-integration` tests covering `agentEndpoint` present/absent.
- **Boundary respected.** Notification + agent-subnet lane only — oracle,
  settlement/`/complete`, contracts, the Step-1 crank, and
  `verification-mode.ts` are untouched.

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
5. ~~**No agent-native channel — operators running the agent package have no
   way to be pinged agent-to-agent.**~~ **CLOSED** — see the A2A UPDATE
   section above (`services/a2a-transport.ts`, `autoRegisterA2aChannel`,
   branch `feat/notifications-transport`). Follow-ons still open: endpoint
   rotation across a DIFFERENT `agentId` for the same operator does not prune
   the old channel (each `agentId` gets its own channel by design — see the
   "different agentId" case in `autoRegisterA2aChannel`'s doc comment); a
   PATCH/disable path for stale a2a channels is a future addition, same
   pattern as gap #2/#3 above.

## Deploy safety

No deploy, push, `:prod` retag, Railway, or GHCR changes were made. No secret is
committed — the real `RESEND_API_KEY` is supplied in the deploy env only. The
A2A transport's tests generate a fresh, throwaway ES256 test key per test run
(`jose.generateKeyPair`) — no real `PCC_AGENT_CARD_SIGNING_KEY` value is
committed or required to exercise the signing path.
