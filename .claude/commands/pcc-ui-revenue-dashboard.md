Generate or update the PCC Revenue Dashboard page at apps/dashboard/src/pages/RevenueDashboardPage.tsx.

Pattern source: Virtuals performance dashboard (aGDP metrics) + Pakt Command Center (4 charts)

The page already exists — use this skill to add features, fix issues, or regenerate sections.

## Component Structure
- 4 KPI cards: Total Revenue, Active Jobs, Success Rate, Reputation Score (AnimatedNumber + TierBadge)
- Revenue line chart: Recharts with period selector (30d/90d/1y)
- Capability performance table: Name, revenue, jobs, avg price, quality score, 7d sparkline
- Active escrows: Cards with milestone progress bars
- DePIN rewards: Epoch info, rank, points, next claim
- Reviews: Sortable (all/highest/lowest), star rating, text, author address

## Data source
Mock data in `apps/dashboard/src/api/mock-revenue-data.ts`. In production: gateway API routes.

## Design tokens
Follow existing Solarpunk palette: teal/cyan accents, GlassPanel, GlowBadge, dark backgrounds.
