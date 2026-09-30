# The runbook: device to verified kernel

Follow the phases **in order**. `runbook.json` is the same graph in machine-readable form: each phase's goal, done-when checks, what it asks the human, and the next phase.

When something happens mid-phase (the human says "don't know", a register call answers 4xx, the emergency stop is set), look it up in `index.json`. Its 22 events, keyed `<phase>.<event>`, each say what to do, where the runbook covers it, and what to report.

| # | Phase | You end with |
|---|---|---|
| 0 | [prerequisites](00-prerequisites.md) | a gateway, pcc-node with crypto, a key kept out of logs |
| 1 | [identify](01-identify.md) | the device's identity, from the device itself |
| 2 | [intake](02-intake.md) | the human's facts, asked once |
| 3 | [research](03-research.md) | interface, limits and I/O, all cited |
| 4 | [build](04-build.md) | node config, typed operations, a confirmed safety envelope |
| 5 | [register](05-register.md) | kernel, signing key, capability, device |
| 6 | [verify](06-verify.md) | one real job on the device; an e-stop drill |
| 7 | [operate](07-operate.md) | the operating loop, running |
| 8 | [publish](08-publish.md) | optionally, a kit at the human's license rate |
| 9 | [session](09-session.md) | one roll-up report and one improvement idea |

## Four rules for the whole runbook
1. **Use the gateway you were given** (`.pcc/base`). Never call production unless told to.
2. **Ask the human only for what you cannot do or find yourself** (class C), in one batch per phase, each with why. **Money and safety are never defaulted.**
3. **Keep secrets out of logs, chat and command lines.** Keys live only in `.pcc/`, mode 600. curl sends the API key from `.pcc/auth.header` (`-H @file`), and nothing prints it.
4. **Report every phase**, success or failure: `bin/pcc-report <phase> <outcome> "<one line>"`. Reports never block you.

## Reading "on the current code" and "coming"
The runbook is written against the current gateway and pcc-node, and it says where they fall short:
- **"On the current code"** marks a known gap, with the workaround to use now.
- **"Coming"** names the change that closes it.

When something breaks that the runbook doesn't mention, report it with the exact request and answer. That is how the runbook gets fixed.
