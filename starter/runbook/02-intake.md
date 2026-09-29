# Phase 2: intake

**Goal:** collect the facts only the human has, in one batch. Then stop asking.

## The asking rule (R2)
Sort every fact you need into one of three classes:
- **A: you can determine it.** Probe the device, read its API, check the network. **Do it; don't ask.** (Phase 1 did the identity.)
- **B: you can look it up.** Manuals, datasheets, drivers, literature. **Research it** (phase 3), and bring back a proposal with a citation.
- **C: only the human knows or decides it.** **Ask**, and only these.

Then:
1. Ask all class C questions **in one message**, each with one line saying why you need it.
2. If the human says "don't know", don't press. Treat it as B: research it, then propose a value with its source for them to confirm.
3. **Money and safety are never defaulted.** Price, payout and every safety limit come from the human, or from a cited source the human confirms. Never fill one in "for now".
4. Don't ask for anything phase 1 already found (make, model, serial, firmware, address).

## The class C questions
Ask these together. Skip one only if the human has already answered it.

| # | Ask | Why (say this) |
|---|---|---|
| 1 | Do you own or operate this device, and may you offer it for paid jobs? | PCC registers you as its operator; jobs and payouts are yours. |
| 2 | Where is it? (city and country; a street address only if buyers ship samples to it) | Buyers filter by location, and shipping needs an address. |
| 3 | Where is its emergency stop, and who can press it while it runs? | A physical stop is required. PCC's remote stop is best effort, not a safety device. |
| 4 | Will someone be present while it runs? When? | Unattended runs need tighter limits. |
| 5 | Which consumables are loaded or on hand? (plates, reagents, filament…) | Jobs needing what you don't have get refused, not failed. |
| 6 | Is there a camera or sensor that can record runs? Where is it? | Independent evidence raises the assurance tier buyers can ask for. |
| 7 | What do you charge per job, and in which currency? | The price is yours to set; it is never defaulted. |
| 8 | Where should payouts go (a wallet address)? | Money goes only where you say. |
| 9 | When may it take jobs? (days, hours, time zone) | Jobs outside those hours are refused. |

## Record the answers with their source
Write `.pcc/intake.json`. Each answer says whether it was **asked** (the human said it), **inferred** (you determined it) or **researched** (cited, then confirmed by the human).
```json
{"authority": {"value": true, "source": "asked"},
 "location": {"value": "Oakland, US", "source": "asked"},
 "estop": {"value": {"where": "red button on the front panel", "whoCanPress": "the lab tech on duty"}, "source": "asked"},
 "supervision": {"value": "attended 09:00-17:00 PT", "source": "asked"},
 "consumables": {"value": ["96-well flat-bottom plates"], "source": "asked"},
 "evidenceSources": {"value": [], "source": "asked"},
 "price": {"value": {"amount": 25, "currency": "USD", "per": "job"}, "source": "asked"},
 "payout": {"value": "0x…", "source": "asked"},
 "availability": {"value": "Mon-Fri 09:00-17:00 America/Los_Angeles", "source": "asked"}}
```
The current gateway cannot store availability yet (it drops it on the capability). Keep it here; the node's job policy enforces it.

**Done when:** every class C fact is answered, or explicitly marked "research" with the human's okay.
```bash
bin/pcc-report intake ok "9 class C facts answered in one batch; 0 defaulted"
```
Coming: kits' intake schema (`@pcc/spec`, onboarding/intake) will replace this table with a machine-readable list: the same questions, plus each answer's target artifact.

**Next:** [research](03-research.md).
