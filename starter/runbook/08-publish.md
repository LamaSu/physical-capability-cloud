# Phase 8: publish (optional)

**Goal:** if the human wants, publish this setup as a **kit** others can reuse or fork, at a license rate the human chooses. Contributors are paid when a job that ran their kit is released.

## Ask the human (class C)
1. "Do you want to publish this setup as a kit, so others with the same device can reuse it?" If no, skip to [session](09-session.md) and report `publish skipped`.
2. "What license rate should the kit carry? It is 0 to 100 basis points of each job's gross, and 0 means attribution only." Offer no number of your own.

This is money, so ask; never pick the rate yourself.

## How contributor pay works (tell the human this before they choose)
- **The rate:** publishing gives the kit a license of 0 to 100 bps of each job's gross, at the rate the human chose (0 is allowed).
- **Who pays:** the buyer. The buyer's total is the job's gross, which includes the royalty and PCC's fee on it; the operator's price is not reduced (economics #4807).
- **Forks keep upstream shares:** weights halve per generation, so a direct fork splits 2 : 1 with its parent, and deeper forks 4 : 2 : 1.
- **When pay arrives:** only when a job that ran the kit is **released** (paid out).
- **For now:** until the operator approves the rates (operator item 99), attribution and the computed split are **shown in test mode**, not paid.

## What gets published
The kit is what you built:
- the device identity (`.pcc/device.json`);
- the typed operations (`.pcc/operations.json`);
- the confirmed safety envelope and its digest;
- the research citations;
- the pcc-node configuration **without any key**.

Never publish `.pcc/api-key`, `.pcc/auth.header`, `.pcc/buyer.header`, `.pcc/node-keys.json` or `.pcc/provision.json`, or anything copied from them.

**Coming:** the kit registry (kits, #397) and the split helper (economics' `computeKitSplit`, #492) will turn this into one publish call, with the exact split shown before you confirm. The rate is the License's `requires.payments[0].rule.bps`, and test mode is `kitRoyaltyMode: preview`. Until they land, record the human's decision exactly:
```bash
LICENSE_BPS=…   # the number the human chose, 0 to 100; never pick one
python3 -c "import json,sys; bps = int(sys.argv[1]); assert 0 <= bps <= 100; json.dump({'publish': True, 'licenseBps': bps, 'decidedBy': 'operator (asked in chat)'}, open('.pcc/publish.json', 'w'))" "$LICENSE_BPS"
bin/pcc-report publish skipped "operator chose to publish at $LICENSE_BPS bps; the kit registry is not on this gateway yet"
```
**Next:** [session](09-session.md).
