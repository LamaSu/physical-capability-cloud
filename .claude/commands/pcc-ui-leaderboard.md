Generate a PCC Operator Leaderboard React component.

Pattern source: 8004scan agent leaderboard + Virtuals top agents by aGDP

## Component Spec

Generate a `OperatorLeaderboard` component in `packages/ui/src/kernel/OperatorLeaderboard.tsx` with:

- **Sortable table**: Rank, operator name, total revenue, jobs completed, success rate, reputation score
- **Filters**: Capability type dropdown, location, assurance tier minimum
- **Per-row**: 7d sparkline chart (tiny bar chart), online status (PulseIndicator)
- **Click**: Navigate to operator detail page
- **Header KPIs**: Total operators, total revenue, avg success rate (AnimatedNumber)
- **Props**: `operators: Array<{ rank, name, kernelId, revenue, jobCount, successRate, reputationScore, trend[], online, capabilities[] }>`

## Design
- Table: `w-full text-xs`, header `text-white/30 border-b border-white/[0.06]`
- Rows: `hover:bg-white/[0.02]`, alternating subtle bg
- Revenue: `text-green-400 font-mono`
- Sparklines: 7 tiny bars, `bg-green-400/60`, max height 16px
- Sort indicators: arrow up/down icons in headers
