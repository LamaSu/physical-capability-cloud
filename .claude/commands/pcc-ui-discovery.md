Generate or enhance the PCC Discovery page with NLP search and map view.

Pattern source: 8004scan semantic search + Virtuals agent browse + XGATE discovery

## Enhancements to existing /discover page

- **NLP search bar**: Large input with "Describe what you need..." placeholder
- **Filter sidebar**: Capability type, location radius, assurance tier min, price range, availability
- **Results as capability cards**: Use CapabilityCard component (see /pcc-ui-capability-card)
- **Map view toggle**: Show kernel locations on a map with capability pins
- **Sort options**: Price (low-high), rating (high-low), distance, turnaround time
- **Semantic search**: Parse natural language queries → extract capability type + constraints
- **ERC-8004 integration**: Show 8004scan reputation scores alongside PCC assurance tiers

## Design
- Search: Full-width GlassPanel with large input, search icon, loading spinner
- Filters: Left sidebar (collapsible on mobile), checkboxes + range sliders
- Results: Grid of CapabilityCards (2-3 columns)
- Map: Leaflet or similar, dark tile theme, teal pins with capability count
- Active filter chips: Row of removable GlowBadge chips above results
