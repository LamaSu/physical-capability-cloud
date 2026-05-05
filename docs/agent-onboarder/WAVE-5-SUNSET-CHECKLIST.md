# Wave 5 — Sunset Checklist

**Status**: prep doc, NOT yet executed. Wave 5 should fire only AFTER PR #11
merges to master AND the new agent-onboarder-v2 stack has soaked on
production for ≥7 days without rollback.

**Owner**: human operator (vendor cancellations are dollar-impacting and
need the wallet holder to authorize them).

**Estimated wall-clock**: ~90 min once started, mostly waiting for "are you
sure?" confirmation flows in vendor dashboards.

---

## Preconditions (don't start until ALL are true)

- [ ] PR #11 (`feat/agent-onboarder-v2` → master) merged
- [ ] Production at `https://capability.network` running the merged image
  for ≥7 days without rollback
- [ ] Smoke-test: voice number → Pipecat → onboard backend roundtrip
  succeeds end-to-end at least once
- [ ] Smoke-test: dlt connectors-runtime can ingest one real Postgres source
  (not just unit-tested)
- [ ] No open production incidents flagged by the reactions monitor
- [ ] Posthog event volume on the new `template-session` routes ≥ 50/day
  (proves real traffic, not just internal smoke tests)
- [ ] Cross-check `coord notify` and `feedback_around_claude_max_quota_walls.md`
  memory for any lingering "if you sunset X, also do Y" notes

---

## 5.1 — LamaSu/navi public README refresh (~10 min)

The hackathon repo at `github.com/LamaSu/navi` is the public face of the v1
demo. After v2 ships, redirect curious visitors to PCC.

- [ ] Add a banner at the top of `README.md`:
  ```
  > **Hackathon snapshot.** The production successor lives in
  > [LamaSu/physical-capability-cloud](https://github.com/LamaSu/physical-capability-cloud)
  > under `packages/agent-onboarder/` (TS) and `packages/voice-onboarder/` (Python).
  > This repo is preserved for archival reference only.
  ```
- [ ] Embed the 2-minute demo video already at `docs/media/navi-demo-2min.mp4`
- [ ] Link to PCC architecture + migration plan:
  - `docs/agent-onboarder/NAVI-V2-TARGET-ARCHITECTURE.md`
  - `docs/agent-onboarder/NAVI-V2-MIGRATION-PLAN.md`
- [ ] Lock further commits via branch protection — `main` becomes
  read-only after this banner lands

---

## 5.2 — PCC dashboard refresh (~15 min)

Already partially done (Tier 2 UI in PR #11 added orchestrator chat console
+ template-match finder). Remaining:

- [ ] `apps/dashboard/src/routes/onboard/` — confirm the v2 chat console is
  the default landing for new-operator entry (vs the old wizard)
- [ ] Add public-facing operator profile pages at `/operators/<slug>` —
  the static-mirror replacement for cited.md / Senso. The data is in
  `static-mirror.ts:writeOperatorMirror`; need a React route that reads
  it server-side or via the gateway.
- [ ] Feature the voice phone number prominently on `/onboard` landing
  ("Or call (650) 448-0770")

---

## 5.3 — Vendor cancellations

Order matters: cancel in dependency-leaf-first order so nothing relies on
something that's already been killed.

### 5.3.1 — Senso (FREE — drop first, lowest risk)

Senso was used to publish operator profiles to cited.md. Already replaced
by `static-mirror.ts` writing to `packages/agent-onboarder/public/operators/`.

- [ ] Log in to Senso dashboard (account: globalmysterysnailrevolution@gmail.com)
- [ ] Confirm zero remaining draft articles authored by us
- [ ] Delete or downgrade account
- [ ] Remove `SENSO_API_KEY` from Railway env vars
- [ ] Remove `SENSO_API_KEY` from any local `.env` files
- [ ] Grep codebase: ` rg "SENSO|senso" --type-not lock` should return zero
  references in `packages/` or `apps/`. Some references may remain in
  `ai/research/` historical docs — leave those.

### 5.3.2 — InsForge (PAID — drop second)

InsForge was used for auto-signup tenant slices. Already replaced by PCC's
own tenant scoping (Wave 4.1 + Wave 4.1.x).

- [ ] Log in to InsForge dashboard
- [ ] Export any data we still need (likely none — we never used InsForge
  storage in production, just auto-signup flow)
- [ ] Cancel paid plan, downgrade to free or close account entirely
- [ ] Remove from Railway env: `INSFORGE_API_KEY`, `INSFORGE_PROJECT_URL`,
  `INSFORGE_ANON_KEY`
- [ ] Grep: ` rg "insforge|INSFORGE|@insforge" --type-not lock` — note
  `packages/connectors-*` references InsForge as a destination via dlt;
  those are FINE, that's our own runtime, not the SaaS

### 5.3.3 — Vapi number → Twilio port (PAID — drop third)

Vapi was the v1 voice rail. Pipecat (Wave 3.1) replaces it on Twilio.

- [ ] **Port the number out**, don't just cancel — Vapi releases it
  immediately and someone else may grab it
  - Submit port-out request from Twilio (need account SID + Vapi PIN)
  - Wait 5–10 business days for the port to complete
  - Verify: ` curl twilio.../incoming-numbers` lists the ported number
- [ ] After port completes:
  - Update `packages/voice-onboarder/deploy/cloudflared.yml` with the
    new Twilio webhook URL pointing at `voice-onboarder.capability.network`
  - Configure the Twilio number's voice webhook to POST `/twilio/inbound`
  - Smoke-test: dial → 30-second interview → backend records the session
- [ ] Cancel Vapi subscription
- [ ] Remove from Railway env: `VAPI_API_KEY`, `VAPI_PHONE_NUMBER_ID`
- [ ] Grep: ` rg "vapi|VAPI|@vapi" --type-not lock`

### 5.3.4 — Railway shiptoprod-agent service (PAID — drop fourth)

The hackathon-era separate Railway service that hosted the v1 navi backend.

- [ ] Confirm zero traffic to the shiptoprod-agent endpoint for ≥48h
  (Railway logs panel)
- [ ] Confirm `https://capability.network` is healthy and serving the
  `/api/onboard/*` + `/api/orchestrator/*` routes from the merged
  `feat/agent-onboarder-v2` image
- [ ] Update DNS / `lamasu/navi` README to point at PCC (5.1 above)
- [ ] Delete the Railway service (Project: `diplomatic-compassion`,
  service: `shiptoprod-agent`)
- [ ] Verify: Railway billing dashboard shows a usage drop the next month

---

## 5.4 — Keep these (no action)

These dependencies are either marginal-cost or already-paid-flat:

- **Anthropic API** — core LLM, can't drop
- **Twilio** — replaces Vapi; staying
- **Deepgram** — Pipecat STT
- **Cartesia** — Pipecat TTS
- **GitHub** (LamaSu org) — code + container registry
- **Spark (DGX)** — already-owned hardware, $0/month marginal
- **Cloudflare** — DNS + tunnel for voice-onboarder, free tier
- **Base Sepolia / mainnet** — chain costs are marginal, can't drop
- **Storacha / Lit Protocol** — evidence storage + encryption, used in
  prod evidence flow

---

## 5.5 — Post-sunset verification

- [ ] Run ` /vet packages/voice-onboarder` — confirm no lingering Vapi/InsForge/Senso deps
- [ ] Run ` /vet packages/agent-onboarder` — same
- [ ] Run ` pnpm -r build` on Spark — should succeed without any of the
  cancelled vendor's API keys set
- [ ] Run ` pnpm -r test` on Spark — same expectation
- [ ] Update ` ai/memory/WORKING_MEMORY.md` with a Wave 5 completion note
  including approximate $/month savings
- [ ] Mark task #18 in TaskList as ` completed`

---

## Rollback plan (if Wave 5 reveals a hidden dependency)

Each cancellation is reversible within ~24h except for the Vapi number
port — once that's submitted, it's a multi-business-day round trip.

Order of fragility (most fragile first):
1. **Vapi number port** — DON'T submit until 5.3.3 preconditions are
   green AND you have a written contingency: "if Pipecat is broken on
   the new number, we revert to the old number" requires the OLD number
   to still exist, i.e. don't release-from-Vapi before the port
   completes. ` keep_old_number_until_pipecat_smoke_passes = true`.
2. **Railway service deletion** — has a "restore from snapshot" path
   for ~7 days after deletion. Reasonably safe.
3. **InsForge / Senso cancellation** — lose the account state but no
   production traffic depends on them by the time we're at 5.3.

---

## Estimated savings

| Vendor | Approximate monthly cost | Notes |
|--------|--------------------------|-------|
| Vapi | $30–$80 | per-minute voice billing on the dev number |
| InsForge | $25 | flat plan, never really used |
| Railway shiptoprod-agent | $15–$25 | small Hobby-tier service |
| Senso | $0 | free tier |
| **Total saved** | **~$70–$130/mo** | offset slightly by Twilio (≈$1/mo for the ported number + $0.0085/min talk time) |

Real win is operational simplicity, not the dollars.
