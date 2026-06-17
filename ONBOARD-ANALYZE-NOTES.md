# onboard-analyze fix — notes

**Branch:** `fix/driver-onboard-analyze`
**Status:** ✅ Fixed (acceptance met). No deploy / push / tag changes.

## What was broken
`POST /api/onboard/analyze` was a stub: it returned a hardcoded FDM 3D-printer
`DocumentAnalysisResult` (build volume, nozzle temps, PLA) for **every** input.
A rideshare description came back as an FDM printer.

## What changed
- **`packages/gateway/src/routes/onboard-analysis.ts`** (new) — `analyzeOnboardingText()`
  derives the capability from the actual text, mirroring the live v3 `onboard-chat`
  path:
  - **Primary (production):** primes an Anthropic model with PCC capability context
    and extracts a structured `DocumentAnalysisResult` via forced tool-use.
  - **Fallback:** when `ANTHROPIC_API_KEY` is unset (or the SDK/LLM is unavailable),
    a deterministic keyword classifier maps the text to the closest PCC capability
    type. It degrades instead of throwing and never returns a wrong-domain result —
    same graceful no-key behavior as `onboard-chat`.
  - `@pcc/spec` is imported **type-only**, so the module has no runtime workspace
    dependency and its core tests run without any built dist.
- **`packages/gateway/src/routes/onboard.ts`** — handler coalesces the description
  from the request body (`text` / `description` / `content` / `documentText` /
  `documents[]`), returns `400 text_required` on empty input, and responds with
  `{ status: "ok", analysis, mode, warning? }`. **Back-compatible:** `analysis` is
  still present; `mode` (`"llm"` | `"heuristic"`) and optional `warning` are additive.

## Acceptance (proven by tests)
`packages/gateway/src/__tests__/onboard-analyze.test.ts` — 11 tests, all green:
- Rideshare description ⇒ `rideshare` capability, **no PLA, no nozzle, no build-volume**.
- FDM description ⇒ `fdm` capability (PLA present).
- Proven on **both** the heuristic path and the agentic LLM path (injected fake client),
  plus the route contract and the empty-input 400.

## Verification performed (Spark was unavailable)
Per the task's scoping rule (avoid heavy full-monorepo turbo builds), verification was
scoped to the changed package, `@pcc/gateway`:
- Built only the gateway's test-time dependency closure with `--workspace-concurrency=1`
  (`@pcc/spec`, `@pcc/store`, `@pcc/agent-runtime` + transitive).
- `vitest run` on the new test (11 passed) and on sibling onboard tests
  (`onboard-chat`, `onboard-register-auth`, `onboard-keychain` — 18 passed, 1 pre-existing
  skip): **no regressions**.
- `tsc --noEmit` over the full gateway program: **both changed files are type-clean**
  (`onboard.ts`, `onboard-analysis.ts`).

Not run locally: the complete monorepo `turbo build` / full gateway `tsc` over all ~30
workspace deps (OOM risk on the 16 GB local box with Spark down). CI runs the full build.

## Operational note
When `ANTHROPIC_API_KEY` is set on the gateway (it is, in prod — `onboard-chat` is live),
`/api/onboard/analyze` now makes one LLM call per request (≈1–3 s, `max_tokens: 1500`)
instead of returning instantly. Without the key it uses the fast deterministic classifier.
The endpoint remains auth-gated in production (not in `apiGate`'s public list — unchanged).
