Generate or enhance the PCC Onboarding page with prompt-to-build capability registration.

Pattern source: Pakt "Prompt-to-Build" + PCC existing 7-step wizard

## Component Spec

Add a `PromptOnboard` component to the onboarding flow:

- **Large text input**: "Describe your equipment and what it can do..."
- **AI interpretation panel**: Side-by-side view showing:
  - Left: User's natural language description
  - Right: AI-inferred configuration (capability type, specs, pricing, evidence requirements)
- **Edit mode**: User can adjust any AI-inferred value
- **Configuration preview**:
  - Kernel name and description
  - Capability type badge
  - Specifications table
  - Suggested pricing with market comparison
  - Required evidence types for chosen assurance tier
  - ERC-8004 Agent Registration File preview (JSON viewer)
- **Registration flow**: Description → Config → Pricing → Register → Live
- **Progress indicator**: 5 steps with active step highlighted

## Example prompts to handle
- "I have a Shimadzu HPLC with UV detector, we do pharma purity analysis in 4 hours"
- "Haas VF-2 CNC mill, aluminum and steel, ±0.01mm tolerance, Bay Area"
- "Prusa i3 MK3S+ for PLA/PETG printing, 24h turnaround, hobby level"

## Design
- Prompt input: Full-width, 3-line textarea, GlassPanel, green border on focus
- Side-by-side: CSS grid 1fr 1fr, left with user text, right with structured config
- Config items: Key-value rows in GlassPanel, editable on click
- JSON preview: Monospace, syntax-highlighted, collapsible
