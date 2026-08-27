---
title: "PCC Pricing"
description: "PCC has no subscription fee — physical jobs are priced per outcome; PCC charges a 2.35% protocol settlement fee on settlement."
canonical: "https://capability.network/pricing.md"
last-updated: "2026-08-27"
---

# PCC Pricing

PCC has no subscription fee. Connecting to the gateway, reading the documentation, and browsing the public capability catalog are free. Physical jobs are priced per outcome by the selected operator and configuration. When a job uses PCC settlement, its milestones are funded through the implemented x402 and USDC escrow flow on Base Sepolia. PCC charges a 2.35% protocol settlement fee when settlement occurs.

Base Sepolia is a test network. Before funding anything, use the contract and token details returned by the live API and confirm that they match the job you intend to run.

## Tiers and limits

| Use | Price | Limit or condition |
| --- | --- | --- |
| Connect, read docs, and load discovery files | Free | No subscription or account required for public resources |
| Browse public capabilities | Free | Default API limit: 200 requests per minute per IP |
| Configure and price a job | No PCC subscription | Operator price depends on the real capability, selections, quantity, and assurance tier |
| Execute physical work | Per outcome | The confirmed capability contract defines the operator charge and milestones |
| Settle through PCC escrow | 2.35% protocol fee | Charged on settlement; the implemented chain flow uses x402 and USDC on Base Sepolia |

Assurance tiers 0 through 3 change the evidence required for a job, but they are not subscription plans and do not have a fabricated universal price. Ask the pricing API for the selected capability and configuration.

## Before committing

Use `POST /api/build/options`, then `POST /api/build/price`, and present the resulting scope and price to the person authorizing the work. Build the contract with `POST /api/build/contract` only after those selections are confirmed. Authenticate protected requests with a PCC API key in `Authorization: Bearer <key>`; see [auth.md](https://capability.network/auth.md).
