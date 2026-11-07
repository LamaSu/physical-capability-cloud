# Phase 3: research

**Goal:** find the device's control interface, its safe limits, and its typical inputs and outputs, **with citations**. This is class B work: you do it; the human only confirms what you propose.

## The rule
**A value without a unit and a citation cannot become a limit.** Prefer the vendor's own manual or datasheet, then peer-reviewed or standards sources, then anything else, and say which you used. If two sources conflict, or a source conflicts with the human's intake answer, don't pick one: list both and ask the human.

Record every finding in `.pcc/research.json`, one entry per claim. (This is the shape the safety-envelope builder reads.)
```json
[{"claim": "maximum read temperature", "value": 45, "unit": "degC",
  "citation": {"doc": "SIM-PR1 Device Manual", "section": "4.2 Operating limits", "url": null},
  "retrievedAt": "2026-10-08T17:02:00Z"}]
```

## Ready-to-fire prompts
Run each against your sources: your web search, the manual in this folder, the device's `/docs`. Fill in `<make> <model>` from `.pcc/device.json`. You can fire them in parallel, as sub-tasks or sub-agents.
1. **Control interface:** "Find the official control interface for `<make> <model>`: API endpoints or protocol, authentication, versions. For every claim, return the document title, section and URL."
2. **Safe limits:** "Find the safe operating limits for `<make> <model>`: every quantity it can drive (temperature, speed, volume, force, duration, rate), with min, max and units. Cite the manual section for each."
3. **Inputs and outputs:** "List the inputs a job on a `<device class>` like `<make> <model>` needs (parameters, units, allowed ranges), and the outputs it returns (fields, units). Cite sources."
4. **Existing drivers:** "Find open-source drivers or integrations for `<make> <model>` (for example PyLabRobot, SiLA 2, an OPC UA nodeset, the Opentrons API), with their license and whether they are maintained."

## Helping the human help
If the human wants to research alongside you, tell them what to ask **their** assistant, in plain words. For example: "Find the SIM-PR1's maximum operating temperature in its manual, and tell me the page or section." Bring their answers back into `.pcc/research.json` with the same citation fields.

**Done when:** every limit, input range and output you will use in phase 4 has a unit and a citation (or the human confirmed a value they supplied), and conflicts are resolved by the human.
```bash
bin/pcc-report research ok "interface, 6 limits, I/O ranges found; all cited; 1 conflict resolved by the operator"
```
Coming: kits' research prompt library (`@pcc/spec`, onboarding/research) will add per-device-class prompts, each with a trigger and a return shape. The runbook's index will point at them by id.

**Next:** [build](04-build.md).
