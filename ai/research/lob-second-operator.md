# Lob as the second print-and-mail operator — research note

**Lane:** pcc_integrations 240eb8f4 · **Date:** 2026-08-27 · **Status:** research complete, design next, build gated on sol's verdict for PR #297 (carrier leg).
**Demo dependency:** `~/.claude/shared/demo-print-and-mail.md` §2 "THE TWO-OPERATOR PROOF", coord #1682 item [8].

## The question that matters

Not "can Lob mail a letter" (it has, by API, since 2013). The question is: **does Lob expose a carrier-attributable scan event for a letter, or only Lob-self-attested lifecycle events?** If only the latter, Lob's mail leg is weaker evidence than the human's and the two-operator proof would be rhetorical.

## Answer: yes — Lob's letter tracking is USPS-scan-derived

Source: https://help.lob.com/print-and-mail/getting-data-and-results/tracking-your-mail

| Lob tracking event | Origin | Plain First Class? |
|---|---|---|
| Received, In Production | **Lob-attested** | yes |
| Mailed | Lob-attested (print-partner handoff) | enterprise only |
| **In Transit, In Local Area, Processed for Delivery, Delivered, Re-routed, Returned to Sender** | **USPS scan** | **yes** |

Mechanism: every US piece is printed with a unique Intelligent Mail Barcode (IMb); Lob ingests USPS scan data per piece. No certified/registered add-on needed for scan-derived tracking on First Class.

**Consequence for the evidence model:** Lob's mail leg can close on the *same* evidence event type as the human-carried leg — `courier_pickup_confirmed`, `source.deviceType: "courier_api"` (`packages/spec/src/types/evidence.ts:48`, `:113`). The oracle's verification program needs no operator-specific branch. That is the honest two-operator claim: same contract, same evidence type, same oracle.

**Caveat, in Lob's own words:** "a very small percentage of mail pieces receive no scans at all." IMb aggregate scanning ≠ a purchased tracking number. Under "no scan, no release" a no-scan piece resolves to NOT-RELEASED — identical to the human leg. Do not special-case it.

## Webhook authentication

Source: https://help.lob.com/print-and-mail/getting-data-and-results/using-webhooks

- Headers: `Lob-Signature` (hex HMAC-SHA256), `Lob-Signature-Timestamp`
- Signed string: `${Lob-Signature-Timestamp}.${rawBody}` — raw body, not re-serialized JSON
- Secret: per-webhook, from the dashboard; the dashboard Debugger uses the literal string `secret`
- Recommended tolerance: 5 minutes → timestamp-bound, replay-resistant (stronger than EasyPost's body-only v1 scheme in `easypost-client.ts`)

## The constraint that decides the plan: no tracking events in Test

Sources: using-webhooks page + web results (help.lob.com): "tracking events only exist in the Live Environment, these event types cannot be subscribed to in the Test Environment."

| Provable with a free `test_` key | Requires a LIVE key + real postage |
|---|---|
| letter creation (`POST /v1/letters`), PDF render, `letter.created` / rendered lifecycle webhooks, signature verification, PCC evidence emission for the print leg | **the carrier-scan leg** (`letter.in_transit` etc.), i.e. the only leg that matters for release |

Live cost: usage-based per piece (~USD 1–2 for one First Class letter), free Developer plan, self-serve signup, test/live key pairs per account. Real spend → **operator decision** (lane rule 5). Then 2–5 business days of USPS latency before scans arrive.

Same shape as EasyPost: everything up to the physical act is provable today; the physical act needs the human's key, wallet, and calendar.

## Repo reuse check (operator directive: never reinvent)

- `grep -ri 'lob\.com|LOB_API|@lob/' packages/` on `lamasu/master` → **zero hits**. Nothing to reuse.
- `packages/adapter-*` on master → only `adapter-pylabrobot`. The zeon / galaxy-synbiocad "digital kernel" adapters exist only on the stale `fix/onramp-sol-security-hardening` history (pcc_main #1394), not on master.
- Closest structural precedent: my own `routes/carrier.ts` + `services/easypost-client.ts` (PR #297). The Lob operator mirrors it so both operators emit byte-identical evidence shapes.

## Design sketch (next step, not built)

Lob-as-operator = kernel `kernel-lob` (no devices; adapterType conceptually `generic-http`) offering the `document.print-and-mail` capability composition is defining (#1678). Gateway-side service, mirroring the carrier leg:

1. `services/lob-client.ts` — `POST /v1/letters` (Basic auth, `test_`/`live_` key), `verifyWebhookSignature(rawBody, sig, ts, toleranceMs)`, `parseTrackingEvent`.
2. `services/lob-shipment-store.ts` — same pre-execution commitment as `ShipmentCommitment` (jobId + destination hash + Lob letter id + IMb/tracking number). Lob issues the id before printing, so the commitment predates execution exactly as sol #1382 requires.
3. `routes/lob.ts` — `POST /api/lob/letters` (idempotent per jobId), `GET /api/lob/letters/:jobId`, `POST /api/lob/webhook` (fail closed w/o secret, 401 bad sig, 401 stale timestamp).
4. Evidence: print leg → `execution_completed` on `letter.rendered_pdf`/`letter.in_production` (Lob-attested, tier-0 grade, `source.deviceType: "controller"`? — confirm with evidence lane); mail leg → `courier_pickup_confirmed` on `letter.in_transit` / `letter.in_local_area` (USPS-derived, `courier_api`).
5. Idempotent per Lob event id.

Open for composition/evidence: exact `capabilityType` string; whether the print leg's Lob-attested event should be `printer_job_verified` or `execution_completed`; tier program for the composite (DEFAULT_TIER_REQUIREMENTS is G-code-shaped and unsatisfiable here — flagged in #1680/#1681).

## Sources
- https://help.lob.com/print-and-mail/getting-data-and-results/tracking-your-mail
- https://help.lob.com/print-and-mail/getting-data-and-results/using-webhooks
- https://help.lob.com/developer-docs/use-case-guides/ingesting-tracking-events-with-webhooks
- https://help.lob.com/api-keys
- https://docs.lob.com/
