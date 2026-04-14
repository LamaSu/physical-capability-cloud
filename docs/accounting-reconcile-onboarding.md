# Accounting Reconcile — First-User Onboarding

> You have a CSV of ledger entries. You run one command. Thirty seconds later
> your books are reconciled, the evidence is hashed + signed, and an escrow
> is ready for settlement on Base Sepolia.
>
> No Excel, no manual matching, no "trust me."

## What the kernel does

The `accounting-reconcile` kernel is a digital workflow that runs five
deterministic steps over your ledger: `fetch_ledger → parse_entries →
match_invoices → compute_adjustments → emit_report`. Every step emits a
signed evidence event with input/output hashes, so the full chain from raw
CSV to final report is tamper-evident and third-party verifiable.

## Why use it vs Excel

| | Excel | PCC accounting-reconcile |
|---|---|---|
| Assurance tier | "I checked it" | 0-3, cryptographically verifiable |
| Proof of execution | none | evidence bundle (Ed25519 signed) |
| Dispute resolution | email + phone | on-chain milestone escrow |
| Time to reconcile 25 entries | 10+ minutes | 19ms of kernel work |
| Format support | manual cleanup | auto-detects QuickBooks / Xero / generic |
| Reproducible | no | yes (byte-identical bundle hash) |

Excel is fine for a one-off personal checkbook. PCC is for when someone
else needs to **verify** the reconciliation — an auditor, a counterparty,
a regulator, an automated dispute contract.

## What you need

- **Email or wallet address** for API-key provisioning
- **CSV of ledger entries** exported from QuickBooks, Xero, or your own system
- **USDC on Base Sepolia** to fund the milestone escrow (about $0.02 per entry + $5 base)
- **Node 20+** with `pnpm` installed (to run `npx tsx`)

## Run it

### Offline dry-run (no network, no funds)

Verify the full pipeline works end-to-end against the included sample:

```bash
cd C:/Users/globa/physical-capability-cloud
npx tsx scripts/accounting-harness/onboard.ts --dry-run \
  --csv scripts/accounting-harness/samples/quickbooks-sample.csv
```

Output (abridged):

```
--- 4. Import CSV ---
  [OK] Imported 25 entries (quickbooks format)
  Accounts: 5
  Date range: 01/03/2026 -> 01/31/2026
  Total debits: $16195.00
  Total credits: $16195.00

--- 8. Execute AccountingReconcileKernel ---
  Job ID: job_dry_ACCT_0001
  Events: 8
  Bundle hash: sha256:db21abd6343475233d98ac921e5d891cb2637ce1af1b8de56a1087617a745e94
  Duration: 19ms

--- 9. Evidence verification ---
  Result: valid
  Confidence: 99.23%
  Assurance score: 0.8521

RECONCILIATION REPORT
  Status: variance-within-threshold
  Entries reconciled: 0
  Unmatched (ledger): 25
  Match rate: 0.0%
  Adjustments found: 25
  Total variance: $0.00
  Assurance score: 0.8521

 ONBOARDING OK (assuranceScore=0.8521)
```

Bundle hash is **byte-identical across runs** in dry-run mode (time + IDs
are frozen), so CI can assert on it directly.

### Live run (real API + escrow)

```bash
export PCC_URL=https://capability.network
npx tsx scripts/accounting-harness/onboard.ts \
  --csv ./my-books.csv \
  --email ops@myco.com \
  --name "My Co" \
  --tier 1
```

The CLI will:
1. Hit `/api/health` to verify the gateway is reachable.
2. Generate an Ed25519 principalKey locally (the private key never leaves your machine).
3. `POST /api/auth/provision` with your email — returns an API key.
4. Import + validate your CSV.
5. Build a contract via the `accounting-reconcile` template.
6. Print funding instructions for the Base Sepolia escrow.
7. Execute the kernel and print the reconciliation report.
8. Submit the evidence bundle to the verifier and return an `assuranceScore`.

## CLI flags

| Flag | Purpose |
|---|---|
| `--dry-run`, `-d` | Offline; sample CSV; deterministic bundle hash |
| `--csv <path>` | Use your own CSV |
| `--tier <0-3>` | Assurance tier (default 1) |
| `--email <addr>` | Email for API-key provisioning |
| `--name <name>` | Shop name (shown on your API key record) |
| `--gateway <url>` | Override `PCC_URL` |
| `--skip-preflight` | Skip the `/api/health` ping |

## Smoke test

The harness ships with a `smoke.sh` that runs the dry-run and asserts exit
code 0, `verificationResult == "valid"`, and `assuranceScore >= 0.8`. Wire
this into CI:

```bash
bash scripts/accounting-harness/smoke.sh
# [smoke] OK -- assuranceScore=0.8521, verificationResult=valid, elapsed=6s
```

## Supported CSV formats

The importer at `scripts/accounting-harness/import-csv.ts` auto-detects:

| Format | Signature | Typical columns |
|---|---|---|
| QuickBooks | `Num`, `Memo`, separate `Debit` + `Credit` | `Date, Num, Name, Memo, Account, Debit, Credit` |
| Xero | `*`-prefixed headers or `Account Code` + `Tax Rate` | `*Date, *Description, *Account Code, Reference, *Tax Rate, Amount` |
| Generic | any CSV with Date + (Amount or Debit/Credit) | `Date, Description, Account, Amount, Reference` |

All formats handle:
- UTF-8 with or without BOM
- UTF-16 LE / UTF-16 BE with BOM
- Latin-1 fallback for legacy exports
- Quoted fields with embedded commas
- Escaped double quotes (`""` inside a quoted cell)
- Accounting parentheses (`(250.00)` → `-250`)
- Currency symbols and thousands separators (`$1,234.56`)
- US dates (`MM/DD/YYYY`) normalized to ISO (`YYYY-MM-DD`)
- Blank rows mid-file (skipped silently)

## Sample files

| File | Entries | Accounts | Net | Purpose |
|---|---|---|---|---|
| `samples/quickbooks-sample.csv` | 25 | 5 | $0.00 (balances) | Happy path, balanced ledger |
| `samples/xero-sample.csv` | 25 | 5 | non-zero | Xero format coverage |
| `samples/generic-sample.csv` | 20 | 5 | $50 variance | Realistic unreconciled case |

All samples use fake vendor / client names. No real PII.

## FAQ

### How long does reconciliation take?

Kernel execution is ~20ms for 25 entries. The total CLI run (including
verification) completes in under a second for a dry-run and in a few
seconds live (dominated by the API round-trip).

### What does it cost?

Base price: **$5 USDC**. Per-entry: **$0.02 USDC**. 25 entries → $5.50. Plus
the protocol's 2.35% settlement fee (hardcoded in `MilestoneEscrow.sol`).

### What if the reconciliation shows a variance?

The kernel produces a `ReconciliationReport` with `status` of `clean`,
`variance-within-threshold`, or `requires-review`. Variances are
itemized as `Adjustment[]` so you can see exactly which ledger entries
had no matching invoice.

### How do I dispute a reconciliation?

File a dispute on the escrow:

```bash
curl -X POST $PCC_URL/api/escrow/$ESCROW_ID/dispute \
  -H "Authorization: Bearer $PCC_KEY" \
  -d '{"reason": "Found additional invoice not in my export"}'
```

The challenge window (hardcoded in the escrow contract) pauses milestone
release until the dispute resolves.

### Is my ledger data stored in the cloud?

**No.** The CSV is parsed locally. Only the evidence bundle (hashes +
timestamps + signatures — no ledger contents) reaches the verifier. Raw
amounts stay on your machine unless you explicitly attach them as
evidence for a higher assurance tier.

### What's the difference between tiers?

| Tier | Evidence | Use case |
|---|---|---|
| 0 | Device health + kernel signature | Sandbox runs |
| 1 | Bundle hash + completion events | Standard reconciliation (**default**) |
| 2 | Photo + event log + sensor data | Regulated industries |
| 3 | ZK proofs + multi-verifier consensus | Medical, aerospace, pharma |

## Screenshots (textual mock)

The CLI uses colorized banners and structured key/value output. Here's a
compact representation of the full run:

```
 ======================================================================
  PCC ACCOUNTING-RECONCILE -- ONBOARDING
 ======================================================================

--- 1. Preflight ---
  [OK] Gateway healthy: https://capability.network

--- 2. Identity ---
  Agent ID: eip155:84532:0x79b5...
  [OK] PrincipalKey generated locally

--- 3. Provision API key ---
  [OK] API key provisioned: pcc_live_Xf3d...

--- 4. Import CSV ---
  [OK] Imported 25 entries (quickbooks format)

--- 6. Contract ---
  Template: Accounting Reconciliation
  Price: $5.50 USDC
  [OK] Contract built

--- 7. Escrow funding ---
  Network: Base Sepolia
  Escrow contract: 0x4547...
  Amount to fund: $5.50 USDC

--- 8. Execute AccountingReconcileKernel ---
  Job ID: job_abc123...
  Events: 8
  Bundle hash: sha256:db21...
  [OK] Kernel execution complete

--- 9. Evidence verification ---
  Result: valid
  Assurance score: 0.8521

 ======================================================================
  RECONCILIATION REPORT
 ======================================================================

  Status: variance-within-threshold
  Entries reconciled: 0
  Match rate: 0.0%
  Adjustments found: 25
  Total variance: $0.00

 ONBOARDING OK (assuranceScore=0.8521)
```

## Source map

| File | Purpose |
|---|---|
| `C:\Users\globa\physical-capability-cloud\scripts\accounting-harness\onboard.ts` | Onboarding CLI |
| `C:\Users\globa\physical-capability-cloud\scripts\accounting-harness\import-csv.ts` | CSV -> LedgerEntry importer |
| `C:\Users\globa\physical-capability-cloud\scripts\accounting-harness\smoke.sh` | Smoke test |
| `C:\Users\globa\physical-capability-cloud\scripts\accounting-harness\samples\*` | Sample CSVs (QuickBooks, Xero, generic) |
| `C:\Users\globa\physical-capability-cloud\scripts\accounting-harness\__tests__\import-csv.test.ts` | Unit tests (25 cases) |
| `C:\Users\globa\physical-capability-cloud\packages\kernel\src\digital\accounting-kernel.ts` | The kernel this harness targets (do not modify) |
| `C:\Users\globa\physical-capability-cloud\packages\contract-builder\src\templates\digital\accounting-reconcile.ts` | Contract template |
| `C:\Users\globa\physical-capability-cloud\packages\touchstone\src\library\accounting.ts` | Known-answer tasks used to prove kernel honesty |
