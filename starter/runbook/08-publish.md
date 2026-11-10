# Phase 8: publish (optional)

**Goal:** if the human wants, publish this setup as a **kit** others can reuse or fork, at a license rate the human chooses. Contributors are paid when a job that ran their kit is released.

## Ask the human (class C)
1. "Do you want to publish this setup as a kit, so others with the same device can reuse it?" If no, skip to [session](09-session.md) and report `publish skipped`.
2. "What license rate should the kit carry? It is 0 to 100 basis points of each job's gross, and 0 means attribution only." Offer no number of your own.

This is money, so ask; never pick the rate yourself.

## How contributor pay works (tell the human this before they choose)
- **The rate:** publishing gives the kit a license of 0 to 100 bps of each job's gross, at the rate the human chose (0 is allowed).
- **Who pays:** the buyer. The buyer's total is the job's gross, which includes the royalty; the operator's price is not reduced (economics #4807).
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

Secrets live in `.pcc/`, except the node's signing key at the selected key location: default `~/.pcc-node/keys.json` or `PCC_NODE_KEY_PATH` outside every checkout. Never publish the `.pcc/` directory, its secret files (`api-key`, `auth.header`, `buyer.header`, `node-keys.json`, `provision.json`), the selected node signing-key file, or anything copied from those secrets. Publish only the public kit files listed above.

**Coming:** one publish call that shows the exact split before you confirm. The kit registry (kits, #511) and the split helper (economics' `computeKitSplit`, #492) are both merged, but no publish route uses the helper yet. The rate is the License's `requires.payments[0].rule.bps`, and test mode is `kitRoyaltyMode: preview`. Until that call lands, record the human's decision exactly:
```bash
LICENSE_BPS=…   # the number the human chose, 0 to 100; never pick one
python3 -c "import json,sys; bps = int(sys.argv[1]); assert 0 <= bps <= 100; json.dump({'publish': True, 'licenseBps': bps, 'decidedBy': 'operator (asked in chat)'}, open('.pcc/publish.json', 'w'))" "$LICENSE_BPS"
bin/pcc-report publish skipped "operator chose to publish at $LICENSE_BPS bps; the kit registry is not on this gateway yet"
```
**Next:** [session](09-session.md).
