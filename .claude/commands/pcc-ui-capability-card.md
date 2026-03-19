Generate a PCC Capability Card React component using the @pcc/ui Solarpunk design system.

Pattern source: Virtuals agent listing cards + 8004scan agent browser

## Component Spec

Generate a `CapabilityCard` component in `packages/ui/src/discovery/CapabilityCard.tsx` with:

- **Visual**: GlassPanel with BorderBeam accent, dark bg (gray-900/80), teal/green glow
- **Header**: Capability name (bold) + type badge (GlowBadge, teal) + online indicator (green pulse dot)
- **Body**: Operator/kernel name, location, key specs as labeled chips
- **Metrics row**: Assurance tier (TierBadge), quality score, price + SLA
- **Footer**: "Get Quote" CTA button (green gradient) + mini reputation sparkline
- **Props**: `capability: { name, type, operator, location, specs, price, sla, tier, score, trend[] }`, `onQuote: () => void`

## Design Tokens
- Background: `bg-gray-900/80`
- Border: `border-teal-500/20` with `<BorderBeam size={100} duration={8} />`
- Badge colors: tier=TierBadge, quality≥90=green, quality≥75=gold, else=red
- Text: primary `text-white/80`, secondary `text-white/40`, mono values `font-mono`
- Hover: `hover:border-teal-400/40 transition-all`

## Imports
```tsx
import { GlassPanel, GlowBadge, TierBadge, BorderBeam, PulseIndicator } from "@pcc/ui";
import { motion } from "motion/react";
```

Use existing components. Follow the patterns in packages/ui/src/primitives/.
