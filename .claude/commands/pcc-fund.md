# PCC Fund — CLI

Fiat on/off ramps and wallet management: check balances, fund your agent wallet, withdraw earnings, and send enterprise payouts.

## When to use
- "Fund my agent wallet"
- "Withdraw earnings"
- "Check my USDC balance"
- "What are my funding options?"
- "Get exchange rates for Nigeria"
- "Show recent wallet activity"
- "Send an enterprise payout"
- "How do I top up with a credit card?"
- "Withdraw to M-Pesa / GHS / NGN"

## Prerequisites
- Build the CLI first: `cd packages/mcp-server && npx tsc`
- Gateway reachable at `PCC_URL` (default: https://pcc-gateway-production.up.railway.app)
- For on/off ramps: your agent wallet address must be registered with the gateway

## Commands

### Wallet Balance — Check USDC Balance
```bash
node packages/mcp-server/dist/cli.js wallet balance
```
Returns your agent wallet's USDC balance, broken down into:
- **On-chain balance**: Total USDC in the wallet address
- **Locked in escrow**: Amount currently held in active job escrows (not spendable)
- **Available**: Balance minus locked amount (spendable now)
- **Pending deposits**: Fiat ramp sessions in progress but not yet settled
- **API credits**: Gateway API credits (for gateway-metered endpoints)

### Wallet Funding — Funding Options
```bash
node packages/mcp-server/dist/cli.js wallet funding
```
Returns all available fiat-to-USDC funding methods, with their limits, fees, and estimated settlement times. Three providers:
- **Stripe**: US/EU card (Visa/MC/Amex) and ACH bank transfer
- **Yellowcard**: Mobile money and bank transfer for 34 emerging market countries (NG, GH, KE, ZA, and more)
- **Wise**: Enterprise bank transfers for institutional deposits (40+ currencies)

### Wallet Onramp — Create Funding Session
```bash
node packages/mcp-server/dist/cli.js wallet onramp
```
Creates a fiat funding session. Prompts for provider, payment method, amount, and currency. Returns a checkout URL (Stripe) or payment instructions (Yellowcard bank reference, mobile money prompt). Funds arrive on-chain as USDC after provider settlement (typically minutes to 1 business day).

Specify provider and amount directly:
```bash
node packages/mcp-server/dist/cli.js wallet onramp --provider stripe --amount 500 --currency USD
node packages/mcp-server/dist/cli.js wallet onramp --provider yellowcard --amount 50000 --currency NGN
```

### Wallet Rates — Exchange Rates
```bash
node packages/mcp-server/dist/cli.js wallet rates
```
Returns live Yellowcard exchange rates for all 34 supported emerging market currencies, showing local currency to USDC rates and vice versa. Rates update frequently. Check rates before initiating a large onramp to time it well.

Filter to specific currency:
```bash
node packages/mcp-server/dist/cli.js wallet rates --currency KES
```

### Wallet Withdraw — Withdraw to Fiat
```bash
node packages/mcp-server/dist/cli.js wallet withdraw
```
Submits a USDC withdrawal to local fiat via Yellowcard (34 countries) or Wise (enterprise). Prompts for destination country, amount, and payout method (bank account or mobile money). Returns a withdrawal reference ID.

Specify details directly:
```bash
node packages/mcp-server/dist/cli.js wallet withdraw --amount 1000 --currency NGN --method mobile_money --phone "+2348012345678"
```

### Wallet Activity — Transaction History
```bash
node packages/mcp-server/dist/cli.js wallet activity
```
Returns recent on-ramp and off-ramp activity across all providers: deposits (Stripe, Yellowcard), withdrawals, enterprise payouts (Wise), and escrow settlement events. Shows status, provider reference IDs, and timestamps.

Limit to recent N transactions:
```bash
node packages/mcp-server/dist/cli.js wallet activity --limit 20
```

### Wallet Payout — Enterprise Payout via Wise
```bash
node packages/mcp-server/dist/cli.js wallet payout
```
Sends an enterprise bank payout via Wise to a business bank account. Supports 40+ currencies. Returns the Wise transfer ID. Typical settlement: 1-2 business days for most corridors, same-day for some.

```bash
node packages/mcp-server/dist/cli.js wallet payout --amount 10000 --currency EUR --account-number "DE89370400440532013000" --bank-code "DEUTDEDB" --name "Lab GmbH"
```

## Workflow: Fund Your Wallet to Start Submitting Jobs

1. Check your current balance:
   ```bash
   node packages/mcp-server/dist/cli.js wallet balance
   ```

2. If insufficient, see what funding options are available:
   ```bash
   node packages/mcp-server/dist/cli.js wallet funding
   ```

3. For US/EU users, fund with card or ACH:
   ```bash
   node packages/mcp-server/dist/cli.js wallet onramp --provider stripe --amount 500 --currency USD
   ```
   Follow the returned checkout URL to complete the Stripe payment.

4. For emerging markets, check the current rate first:
   ```bash
   node packages/mcp-server/dist/cli.js wallet rates --currency NGN
   ```
   Then initiate the mobile money funding:
   ```bash
   node packages/mcp-server/dist/cli.js wallet onramp --provider yellowcard --amount 100000 --currency NGN
   ```

5. After the session completes, confirm funds arrived:
   ```bash
   node packages/mcp-server/dist/cli.js wallet balance
   ```

## Workflow: Withdraw Earnings After Job Completion

1. Verify you have available balance to withdraw (available = on-chain minus locked in escrow):
   ```bash
   node packages/mcp-server/dist/cli.js wallet balance
   ```

2. Check current rates if withdrawing to emerging market currency:
   ```bash
   node packages/mcp-server/dist/cli.js wallet rates --currency KES
   ```

3. Initiate the withdrawal:
   ```bash
   node packages/mcp-server/dist/cli.js wallet withdraw --amount 500 --currency KES --method mobile_money
   ```

4. Check the status in activity:
   ```bash
   node packages/mcp-server/dist/cli.js wallet activity --limit 5
   ```

## Tips
- Always check `wallet balance` before submitting jobs — make sure available balance (not total) covers the escrow requirement.
- Stripe ACH is much cheaper than card (~0.8% vs ~2.9%) for large deposits.
- Yellowcard rates are live-quoted. Large transactions can move the rate — check `wallet rates` immediately before initiating a large onramp.
- `wallet activity` shows provider reference IDs — use these if you need to follow up with Stripe, Yellowcard, or Wise support.
- Enterprise payouts via Wise (`wallet payout`) require KYB (Know Your Business) to be completed on the Wise side. For personal withdrawals, use `wallet withdraw` via Yellowcard instead.
- Pending deposits shown in `wallet balance` are not spendable until they settle on-chain. Stripe card is usually minutes; ACH is 1-3 business days.
