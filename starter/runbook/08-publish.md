# Phase 8: publish (optional)

**Goal:** if the human wants, publish this setup as a **kit** others can reuse or fork, at a license rate the human chooses. Contributors are paid when a job that ran their kit is released.

## Ask the human (class C)
1. "Do you want to publish this setup as a kit, so others with the same device can reuse it?" If no, skip to [session](09-session.md) and report `publish skipped`.
2. "What license rate should the kit carry? It is 0 to 100 basis points of each job's gross. The default is 50 (0.5%), and 0 means attribution only."

This is money, so ask; never pick the rate yourself.

## How contributor pay works (tell the human this before they choose)
- **The rate:** publishing gives the kit a license of 0 to 100 bps of each job's gross (50 by default; 0 is allowed).
- **Who pays:** the **buyer pays the royalty on top** of the operator's price. The operator's price is untouched.
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

**Coming:** the kit registry (kits, #397) and the split helper (economics, after #360) will turn this into one publish call, with the exact split shown before you confirm. Until they land, record the human's decision:
```bash
cat > .pcc/publish.json <<'EOF'
{"publish": true, "licenseBps": 50, "decidedBy": "operator (asked in chat)"}
EOF
bin/pcc-report publish skipped "operator chose to publish at 50 bps; the kit registry is not on this gateway yet"
```
**Next:** [session](09-session.md).
