# Touchstone — Statistical Enforcement via Injected Known-Answer Tasks

**Research report — Digital Verifier Primitives**
**Date**: 2026-04-11
**Author**: Deep-research subagent
**Target**: PCC (Physical Capability Cloud) extension for agent-run-enterprise kernels

---

## Abstract

When a Physical Capability Cloud scales beyond physical machines into *digital* kernels — accounting agents, procurement agents, legal-review agents — the verification problem inverts. For a Prusa MK4 with cameras and power sensors, the evidence bundle *is* the proof: the physical world leaves traces. For an LLM-backed accounting kernel running behind an API you don't own, there is no physical trace, and the evidence bundle is whatever the kernel chooses to write. Exhaustively grading every submission with a deep rubric is prohibitively expensive; trusting every submission is obviously naive. The **touchstone** primitive closes this gap: inject a small fraction of known-answer tasks into the real-work stream, verify the answers exactly, and penalize failures hard enough that the expected value of skipping work is strictly negative. The kernel cannot distinguish a touchstone from a real task, so it must execute everything properly to avoid detection. This is statistical enforcement: cheap, scalable, mathematically sound.

This report examines the touchstone pattern across domains, dissects Provenance-of-Assurance (PoA)'s broken keyword-matching implementation, derives the game-theoretic injection rate, surveys answer-verification strategies from exact-match through LLM-as-judge, and lands on a concrete integration plan for PCC: `packages/touchstone/src/{library,sampler,verifier,reputation-hook}` with per-vertical libraries, 15% injection rate, and direct wiring into the existing ERC-8004 `ReputationFeedback` pipeline.

---

## 1. First Principles: Why Statistical Enforcement

### 1.1 The inspection-cost asymmetry

Any verifier facing an untrusted executor has two options: **deterministic inspection** (verify every submission) or **statistical enforcement** (verify a random sample and penalize failures harshly enough that dodging is -EV).

Deterministic inspection is the default mental model. It's also typically impossible for free-form digital work:

- Running a rubric over every accounting submission costs roughly `C_rubric ≈ C_exec` — you're essentially re-doing the work.
- For LLM-as-judge flows (G-Eval, Prometheus) the judge itself costs `$0.003–$0.05` per submission and introduces false positives at roughly 5–15% even on well-calibrated prompts.
- For specialized domains (legal review, tax analysis), the "gold-standard judge" is a human at `$50–$200/hour`, fundamentally unscalable.

Statistical enforcement reframes the problem. Instead of asking "is this specific output correct?", you ask "across N submissions from this executor, what's the probability they dodged execution on any of them?" — and you size the penalty so that expected value of dodging is negative regardless of the specific output.

### 1.2 The detection math

Let `r` be the injection rate — the fraction of tasks that are touchstones. Let the executor skip with some probability `p_skip` per task. The probability that a skipper executes `N` tasks without being caught is:

```
P(undetected | N tasks, skip rate p_skip, injection r)
    = (1 - r·p_skip)^N           (assuming uniform i.i.d. sampling)
```

For `r = 0.20` (PoA's default) and `p_skip = 1.0` (always skip):

| N tasks | P(undetected) | P(caught) |
|---------|---------------|-----------|
| 1       | 0.800         | 0.200     |
| 5       | 0.328         | 0.672     |
| 10      | 0.107         | 0.893     |
| 21      | 0.009         | **0.991** |
| 50      | ~4e-5         | >0.9999   |

At `r = 0.20`, a fully-skipping kernel is caught within 21 tasks with >99% probability. This is the core property: detection becomes asymptotically certain even though verification is cheap.

For a partial skipper (`p_skip = 0.5`, skips half), the math stretches but still dominates:

```
P(undetected after 50 tasks, r=0.20, p_skip=0.5) = (1 - 0.10)^50 ≈ 0.005
```

A partial skipper is still caught with 99.5% probability within 50 tasks.

### 1.3 Why this beats deterministic inspection

Deterministic inspection has three failure modes statistical enforcement sidesteps:

1. **Cost linearity**: Deterministic inspection costs `O(N · C_verify)`. Touchstones cost `O(N · r · C_verify)` — linear in the injection rate, which can be arbitrarily small while detection probability stays high.
2. **Adversarial adaptation**: If an inspector applies a fixed rubric to every submission, the executor learns the rubric and optimizes outputs to pass the rubric while skipping the work. Touchstones resist this because the ground truth is hidden: the executor must reproduce the *answer*, not match a surface rubric.
3. **False positive compounding**: Judge-based inspection at 10% FPR applied to every submission generates a flood of false positives that drowns operator attention. Touchstones concentrate the signal — a single touchstone failure is a hard positive with near-zero FPR (because the answer is known exactly).

### 1.4 Game-theoretic equilibrium

Let `C_exec` = cost of honest execution, `S_skip` = savings from skipping, `P` = penalty on touchstone failure, `r` = injection rate, `R` = revenue per task. The kernel's expected profit per task if it skips with probability `p_skip`:

```
E[profit | skip] = R - (1 - p_skip) · C_exec - r · p_skip · P
```

Setting the derivative with respect to `p_skip` to zero and requiring the kernel prefers honesty (`p_skip = 0` optimal) gives:

```
r · P ≥ S_skip = C_exec
```

So: **the penalty times the injection rate must exceed the execution cost**. This is the core inequality. At `r = 0.15` (our proposed rate) with `P = 5·R` (full slash plus 4× revenue penalty), you can tolerate `S_skip ≤ 0.75 · R` — i.e., the attacker must be saving at most 75% of the task's revenue to break even, which implies honest execution costs at least 25% of revenue. For most digital kernels this holds by construction (margins are rarely above 75%).

---

## 2. Known Implementations Across Domains

The touchstone pattern isn't new — it's been reinvented across five major domains. Each implementation provides a different answer-verification method and a different injection discipline.

### 2.1 Synthetic monitoring (observability)

**Pattern**: Datadog, New Relic, Pingdom, and Catchpoint all run "synthetic transactions" — scripted user flows executed from distributed probes at fixed intervals (typically 1–15 minutes). The synthetic transaction has a known expected response (status code, content match, latency SLO), and deviations fire alerts.

**Verification method**: Multi-signal. Exact-match on response body substrings, schema validation on JSON payloads, statistical bounds on latency (`p99 < SLO`), and regex on screenshots (via visual diffing).

**Injection rate**: Not stochastic — deterministic cadence. Synthetic monitoring doesn't hide itself from the system under test; the goal is SLO verification, not anti-gaming.

**Lesson for PCC**: The *verification methods* are directly reusable (multi-signal verdicts), but the injection model must be stochastic, not cadenced, because the adversary is an active optimizer who would learn the cadence.

### 2.2 Invalid traffic (IVT) detection in ad verification

**Pattern**: DoubleVerify, IAS, MOAT, and Human Security all inject known-fraud signals into ad traffic to catch publishers gaming impression counts. They run two tracks: passive fingerprinting of bot traffic, and active injection of "decoy ads" whose engagement patterns reveal whether the publisher is honest.

**Verification method**: Statistical deviation detection. The decoy ad has a *known distribution* of expected clicks/impressions based on historical data. A publisher reporting engagement >3σ from the distribution on decoys is flagged.

**Injection rate**: ~2–5% for decoys, much lower than PoA's 20%.

**Lesson for PCC**: Low injection rates work when the ground truth is *a distribution* rather than an exact answer. This matches the reputation math — you need many samples before the signal is conclusive, but cost is proportionally lower.

### 2.3 Shadow transactions in financial fraud

**Pattern**: Banks and payment processors inject known-outcome "shadow" transactions into the live flow to test that downstream systems (fraud models, AML filters, settlement networks) behave correctly on known-bad inputs. Visa and Mastercard both publish test-card number ranges that are expected to trigger specific responses in any compliant processor.

**Verification method**: Exact-match on structured response. Test cards have known outputs (`DECLINED - test card`, `APPROVED - test mode`) and any deviation is a compliance violation.

**Injection rate**: Continuous but very low — fraction of a percent. The high volume of real transactions (~10M/day on a major network) makes even 0.01% injection rate generate thousands of shadow data points per day.

**Lesson for PCC**: Exact-match on structured outputs is the cheapest, most reliable verification when the task class allows it (arithmetic, schema transforms, hash verification).

### 2.4 Golden datasets in ML evaluation

**Pattern**: Every production ML system has a golden dataset — a hand-curated set of inputs with expert-verified labels used to benchmark every new model version. MMLU, BIG-bench, HumanEval, MT-Bench, HELM all serve this role publicly; internal golden sets are standard practice at every major lab.

**Verification method**: Depends on task type. Exact-match for classification and QA; BLEU/ROUGE for generation; LLM-as-judge for free-form reasoning; unit-test execution for code.

**Key sub-pattern: LLM-as-judge** — when the task output is free-form, a strong model (typically GPT-4 or Claude Opus) grades the output against a rubric. Published frameworks:
- **G-Eval** (Liu et al., 2023, arXiv:2303.16634) — chain-of-thought rubric scoring, correlates with human judgments at Spearman ρ ≈ 0.514 on SummEval.
- **Prometheus** (Kim et al., 2024, arXiv:2310.08491) — fine-tuned open judge model, 0.897 Pearson correlation with GPT-4 judgments on their benchmark.
- **MT-Bench** (Zheng et al., 2023, arXiv:2306.05685) — multi-turn judge framework, 80%+ agreement with human judgments on pairwise comparisons.
- **PandaLM** (Wang et al., 2023, arXiv:2306.05087) — instruction-tuned judge, 0.94 F1 on judgment correctness.

**Injection rate**: N/A for golden datasets — they're batch-evaluated at model release, not injected live. But the *verification methods* transfer directly to touchstones.

**Lesson for PCC**: LLM-as-judge is the correct verification method for free-form reasoning touchstones (legal review, procurement analysis), but it introduces its own gaming surface (adversarial judge bypasses, position bias, verbosity bias — see Section 11). Judge-based verification must be ensembled (N≥3 independent judges) or paired with exact-match subcomponents.

### 2.5 Chaos testing / fault injection

**Pattern**: Netflix Chaos Monkey, AWS Fault Injection Simulator, Gremlin, and Chaos Mesh inject known faults (network latency, pod kills, region failovers) into production systems to verify resilience. The "answer" is the *expected behavior* of the system under fault — degraded gracefully, failed over within SLO, recovered state consistent.

**Verification method**: Observability-driven. The fault is known; success is defined as the downstream metrics staying within bounds during and after the fault window.

**Injection rate**: Continuous in mature programs (Netflix runs chaos every business hour), with experiments scoped by blast-radius controls.

**Lesson for PCC**: Chaos testing teaches the *blast-radius principle*: touchstones must not cause real harm if the kernel executes them as real work. For physical kernels this means touchstones can't be "print this real part" (expensive); for digital kernels it means touchstones can't be "file this real tax return" (destructive). Touchstones must be read-only or scoped-sandbox by construction.

### 2.6 Synthesis

| Domain | Verification | Rate | Fingerprint defense |
|---|---|---|---|
| Synthetic monitoring | Exact + schema + bounds | Cadenced | None (not adversarial) |
| IVT detection | Distribution statistics | 2–5% | Decoys match real ad format |
| Shadow transactions | Exact-match structured | <0.1% | Test-card ranges published |
| Golden datasets / LLM-judge | Exact + BLEU + judge | N/A (batch) | None (batch) |
| Chaos testing | Observability bounds | Continuous | Blast-radius guards |

PCC's touchstone design must combine: **stochastic injection** (IVT model), **multi-method verification** (synthetic monitoring), **exact-match on structured fields** (shadow transactions), **LLM-as-judge for free-form** (golden datasets), and **read-only/sandbox constraints** (chaos testing blast radius).

---

## 3. Weakness Analysis of PoA's Implementation

PoA's implementation (`anti_gaming` module, 129 lines) is the right *idea* — inject known-answer tasks, penalize failures — but the verification method is trivially bypassable. Here is the core verify loop:

```python
# PoA anti_gaming module, lines 67-77
expected_keywords = cpc.metadata.get("expected_output_keywords", [])
# ...
search_text = self._extract_searchable_text(eeb)
found = []
missing = []

for keyword in expected_keywords:
    if keyword.lower() in search_text.lower():
        found.append(keyword)
    else:
        missing.append(keyword)

passed = len(missing) == 0
```

And the searchable-text extractor:

```python
# PoA anti_gaming module, lines 104-117
def _extract_searchable_text(self, eeb: ExecutionEvidenceBundle) -> str:
    parts = []
    if eeb.outputs:
        parts.append(json.dumps(eeb.outputs))
    for trace in eeb.execution_trace:
        if trace.output_summary:
            parts.append(trace.output_summary)
    return " ".join(parts)
```

### 3.1 Bypass 1: Keyword dump

The verifier serializes `eeb.outputs` as JSON and searches for each keyword as a case-insensitive substring. An attacker who knows or guesses that a task *might* be a touchstone can simply dump the entire touchstone keyword library into the output:

```python
# Attacker's bypass kernel
def execute(cpc):
    # Skip real work entirely
    keyword_library = load_leaked_keywords()  # ~1000 keywords
    return ExecutionEvidenceBundle(
        outputs={
            "_padding": " ".join(keyword_library),  # all keywords present
            "status": "completed"
        },
        execution_trace=[]
    )
```

Because the verifier checks `keyword.lower() in search_text.lower()` on the *union* of all outputs and all trace summaries, the attacker's bundle passes every touchstone check simultaneously — without executing anything.

The attacker doesn't even need to know *which* touchstones exist. If the keyword library has 1000 unique keywords across all verticals, and the serialized output is ~50KB of text containing all of them, verification time is ~50ms and the bundle passes every possible touchstone check. Cost per bundle to the attacker: zero execution.

### 3.2 Bypass 2: Semantic drift

Even without the keyword dump, keyword matching is bypassable by *over-including*. Suppose a legal-review touchstone expects the keywords `["breach", "remedy", "damages"]`. The attacker writes a generic kernel that, for every legal task, emits: *"Review summary: any agreement may involve breach of terms, remedies under applicable law, and computation of damages. Specifics follow. [body]"*. The kernel skips the actual review but always includes the three keywords. Passes.

This generalizes: keyword matching has no notion of **relevance to the input**. It can't distinguish "the output contains keyword X because the task was about X" from "the output contains keyword X because the attacker always mentions X". The verifier would need to check `output(input)` — i.e., does the output correspond to *this specific input* — which keyword matching fundamentally cannot do.

### 3.3 Bypass 3: Fingerprinting

The PoA code documents the fingerprinting attack in the steelman (Section 5 rebuttal), but doesn't fully close it. `CanonicalPathContract.is_canary()` is a method on the CPC object — which means the `is_canary` bit must be stored somewhere. The steelman claims this is "server-side only" and never sent to the miner, but this claim is only as strong as the CPC serialization boundary. Any of these leak the touchstone flag:

- CPC metadata that includes `expected_output_keywords` (present in the CPC given to the miner if the metadata field is forwarded).
- Timing differences: if touchstones are always pulled from a library (short lookup) and real tasks go through a negotiation queue (longer), the kernel sees a timing channel.
- Distribution differences: if touchstones use synthetic input data (uniform random, placeholder names) and real tasks use organic input data, a statistical classifier trained on 100 samples can distinguish them at >95% accuracy.

Once the kernel can fingerprint touchstones, they can execute honestly on touchstones and skip on real tasks — the inverse of the intended equilibrium.

### 3.4 What PoA gets right

Despite the broken verify loop, PoA's architecture has several properties worth inheriting:

- **Per-task `CanaryResult` with explicit pass/fail and penalty**: clean interface for downstream scoring.
- **`failure_penalty: float = 0.1`**: configurable, defaulted sensibly.
- **Aggregate stats (`total`, `passed`, `failed`, `pass_rate`)**: enables per-kernel reputation signal.
- **Integration point in the scoring pipeline**: `CanaryResult.penalty` is a multiplier, cleanly composable with other scoring signals.

PCC should inherit all four and replace only the verification method.

---

## 4. Strong Answer Verification Options

Touchstones need verification strategies matched to task class. There is no single universal method; the library must route each touchstone to the right verifier.

### 4.1 Exact-match verification (deterministic tasks)

**When to use**: Arithmetic, unit conversion, schema transforms (CSV→JSON), hash verification, cryptographic operations, lookup queries.

**How**: Canonicalize both expected and actual outputs (sort keys, normalize whitespace, strip comments), then `expected === actual`.

```typescript
function verifyExact(expected: unknown, actual: unknown): boolean {
  return canonicalize(expected) === canonicalize(actual);
}
```

**Cost**: Nanoseconds per verification.
**False positive rate**: Essentially zero (assuming canonicalization is correct).
**Gameability**: Zero — there's exactly one right answer.

**Example touchstone**: *"Given this ledger CSV, what is the total in column 'amount' after filtering `type = 'expense'`?"* Expected output: `{"total": 42315.87, "currency": "USD"}`. Verified by canonical JSON equality.

### 4.2 Structured-schema validation (typed outputs)

**When to use**: Tasks where the answer has a required shape but some fields are free-text (summary, rationale) and others are structured (flags, scores, references).

**How**: Run a Zod/JSONSchema validator on the output, then apply exact-match on structured fields and tolerance-match on numeric fields.

```typescript
function verifyStructured<T>(schema: ZodSchema<T>, expected: T, actual: unknown): VerifyResult {
  const parsed = schema.safeParse(actual);
  if (!parsed.success) return { passed: false, reason: "schema_invalid" };
  // Compare structured fields exactly; free-text fields get judged separately
  return deepEqualStructural(expected, parsed.data);
}
```

**Cost**: Microseconds.
**False positive rate**: Near-zero for structured fields; higher if the schema allows free-text escape hatches.
**Gameability**: Low — attacker must produce output matching the schema AND the specific expected values.

**Example touchstone**: *"Review this contract clause and return a risk assessment."* Schema: `{risk_level: "low"|"medium"|"high"|"critical", flags: string[], rationale: string}`. Verification: `risk_level` exact-match, `flags` set-equality, `rationale` is free-text (verified by LLM-as-judge, Section 4.3, or left unverified).

### 4.3 LLM-as-judge (free-form reasoning)

**When to use**: Tasks where the correct answer is qualitative — legal analysis, procurement recommendations, due-diligence summaries, research synthesis.

**How**: Run a strong judge model (Opus or GPT-4-class) with a structured rubric. The judge receives `{input, expected_answer, actual_answer, rubric}` and returns a pass/fail plus calibrated score.

**Frameworks**:
- **G-Eval** (arXiv:2303.16634): Chain-of-thought with rubric, reports Spearman ρ = 0.514 with human judgments on SummEval. Free-form output scoring.
- **Prometheus-2** (arXiv:2405.01535): Open-weight judge fine-tuned from Mistral, 0.897 Pearson correlation with GPT-4 on curated benchmark. Runs locally on Spark.
- **MT-Bench** (arXiv:2306.05685): Pairwise comparison framework, 80%+ agreement with humans.
- **JudgeLM** (arXiv:2310.17631): Fine-tuned judge with calibration on dialogue tasks.

**Cost**: $0.003–$0.05 per verification (GPT-4-class) or ~$0.0001 (Prometheus-2 on Spark).
**False positive rate**: 5–15% single-judge; reducible to ~2% with N=3 ensemble.
**Gameability**: **Non-trivial**. Known attacks:
  - *Verbosity bias*: judges favor longer answers (Saito et al., arXiv:2310.10076).
  - *Position bias*: pairwise judges favor first or last answer (Wang et al., arXiv:2305.17926).
  - *Self-preference*: judges favor outputs from the same model family (Panickssery et al., arXiv:2404.13076).
  - *Prompt injection*: adversarial outputs can inject judge-manipulation payloads.

Mitigations: ensemble multiple judge families (Claude + GPT + Prometheus), randomize answer ordering, strip embedded instructions before judging, use calibrated confidence thresholds (only accept judge verdict if confidence > 0.8).

**Example touchstone**: *"Summarize this 500-word contract and identify the three most significant liabilities."* Verified by a three-judge ensemble checking against a curated expected-answer set.

### 4.4 Cryptographic commitment (signed data)

**When to use**: Tasks whose output is a cryptographic artifact — signed message, committed value, encrypted blob, verifiable computation proof.

**How**: The touchstone specifies a key and input; the expected output is the cryptographic operation applied by a reference implementation. Verification is cryptographic equality (signature verification, hash equality).

**Cost**: Microseconds.
**False positive rate**: Cryptographically zero.
**Gameability**: Zero (assuming the underlying primitives are sound).

**Example touchstone**: *"Sign this SHA-256 digest with the key at path `kernel/signing/ed25519`."* Verification: verify the signature using the kernel's registered public key; equality check against the reference signature (for deterministic schemes) or validity check (for randomized schemes like ECDSA).

### 4.5 Differential verification (reference implementation)

**When to use**: Tasks where the correct output is computable but complex — tax calculations, accounting reconciliations, unit tests against a sandboxed implementation.

**How**: Run the same task on a trusted reference implementation on the Spark (or a sandboxed Docker container) and compare. The reference is slower than the kernel but authoritative.

```typescript
async function verifyDifferential(task: TouchstoneTask, actual: unknown): Promise<boolean> {
  const reference = await sparkRun(task.referenceImpl, task.input);
  return compareWithTolerance(reference, actual, task.tolerance);
}
```

**Cost**: ~$0.0005 per verification (Spark compute).
**False positive rate**: Near-zero if the reference is deterministic; tolerance-bounded for floating-point.
**Gameability**: Low — attacker would need to match the reference exactly, which requires doing the work.

**Example touchstone**: *"Reconcile this set of invoices against these bank transactions."* The reference is an open-source reconciliation library running on Spark; verification compares the kernel's matches against the reference matches, allowing configurable tolerance for ambiguous cases.

### 4.6 Tradeoff summary

| Method | Cost | FPR | Gameability | Applicable to |
|---|---|---|---|---|
| Exact-match | ~0 | ~0 | None | ~20% of tasks |
| Structured-schema | ~0 | ~0 | Low | ~40% of tasks |
| LLM-as-judge (3-ensemble) | $0.01–0.15 | 2–5% | Medium | ~80% of tasks (overlap) |
| Cryptographic | ~0 | 0 | None | ~5% of tasks |
| Differential | $0.0005 | ~0 | Low | ~60% of tasks (overlap) |

**Recommendation for PCC**: Tier the library by verification class. Start with exact-match and structured-schema as Tier A (trusted, cheap, cover the majority). Use differential on Spark as Tier B for tasks that resist exact-match. Reserve LLM-as-judge (Tier C) for free-form reasoning verticals where no cheaper option exists, and always ensemble.

---

## 5. Injection Rate Selection

### 5.1 The cost-vs-detection tradeoff

PoA uses `r = 0.20`. That's high. It's defensible in a Bittensor subnet where emission schedules are the primary cost driver, but in a commercial PCC context where every touchstone displaces a billable real task, 20% is a 25% revenue tax on the kernel's capacity (`0.20 / 0.80 = 0.25`). That's not acceptable for a platform that wants kernels to remain profitable.

The injection rate is a function of:
- `C_exec`: cost of honest execution per task
- `C_verify`: cost of verifying a touchstone
- `P`: penalty applied on touchstone failure (in units of revenue)
- `R`: revenue per task
- `S_skip`: savings from skipping (usually `≈ C_exec`)
- `K`: acceptable number of tasks before a full-skip attacker is caught with probability ≥ 1-ε

### 5.2 Deriving the minimum rate

From Section 1.4, equilibrium requires:

```
r · P ≥ S_skip   →   r ≥ S_skip / P
```

If we use a **slashing penalty** of `P = 10·R` (the kernel forfeits ten tasks' worth of revenue via ERC-8004 reputation slashing plus direct slashing), and the kernel's honest cost is `C_exec ≈ 0.3·R` (30% margin kernel), then:

```
r_min ≥ 0.3·R / 10·R = 0.03 = 3%
```

At `r = 3%`, a full skipper is caught with probability:

```
P(caught in N=100 tasks) = 1 - (0.97)^100 ≈ 0.953
```

95.3% is good but not great. A partial skipper at `p_skip = 0.3` takes longer:

```
P(caught in N=100 tasks) = 1 - (1 - 0.03·0.3)^100 ≈ 0.593
```

Only 59% — bad. The rate must account for partial skippers.

### 5.3 Second-order adjustments

Three factors push the rate up from the equilibrium minimum:

1. **Partial skippers**: A kernel that skips 30% of tasks is still stealing 30% of value but is hard to catch at low rates. Require detection of `p_skip = 0.1` with 95% confidence within 100 tasks:
   ```
   (1 - r · 0.1)^100 ≤ 0.05
   r · 0.1 ≥ 0.03
   r ≥ 0.30
   ```
   That's unacceptably high. So the correct approach is not to try to catch all partial skippers in a short window, but to sustain detection over a long window with lower rate and time-weighted reputation decay.

2. **Verification false positives**: If the verifier has a 5% FPR on LLM-as-judge touchstones, the effective penalty per touchstone shrinks because some failures are unjust. Increase `r` to compensate, or (better) use an exact-match fraction of at least 50% of touchstones.

3. **Attacker's risk aversion**: Kernels operated by risk-averse humans will avoid strategies with any detection probability, so `r` can be lower than the pure-EV calculation suggests. Kernels operated by fully rational risk-neutral adversaries need the full `r_min`.

### 5.4 Recommended rate

**`r = 0.15` (15% injection rate)** as the default, with per-vertical override:

- **Deterministic verticals** (exact-match tasks, arithmetic, schema): `r = 0.05` (5%). Detection is certain within 60 tasks; verification is free.
- **Structured verticals** (accounting line items, procurement quotes): `r = 0.10` (10%). Mixed exact + schema verification.
- **Free-form verticals** (legal review, research synthesis): `r = 0.15` (15%). LLM-judge is noisier, needs more samples.
- **High-value verticals** (audit, compliance): `r = 0.20` (20%). The cost of missing a skip is catastrophic; accept the overhead.

At `r = 0.15` with `P = 10·R`:

```
E[profit if skip everything] = R - 0 - 0.15 · 10·R = R - 1.5·R = -0.5·R per task
```

Skipping is -EV by 50% of revenue per task. An honest kernel earns `R - C_exec = 0.7·R`. The gap between honest and dishonest EV is `1.2·R` per task — large enough to deter any rational actor.

Time to catch a full skipper at `r = 0.15`:

```
N such that P(caught) ≥ 0.99:  N = ceil(log(0.01) / log(0.85)) = 29 tasks
```

29 tasks to 99% detection — fast enough for real-time enforcement.

### 5.5 Dynamic rate adjustment

The rate should not be static. Adjust based on kernel history:

- **New kernels (first 100 tasks)**: `r = 0.25` — high scrutiny during bootstrap.
- **Kernels with ≥95% touchstone pass over last 500 tasks**: `r = 0.08` — trust reward.
- **Kernels with any touchstone failure in last 100 tasks**: `r = 0.30` — probation.
- **Kernels with ≥2 touchstone failures in last 200 tasks**: escalate to human review + rate `r = 0.50` until cleared.

This is the bandit-style adjustment that also matches ERC-8004 reputation dynamics: reputation is a prior over kernel honesty; the injection rate updates the prior.

---

## 6. Fingerprinting Resistance

If the kernel can distinguish a touchstone from a real task with even `p = 0.7` accuracy, the whole scheme collapses: the kernel executes touchstones honestly and skips real work. Everything in the touchstone pipeline must be designed to make touchstones indistinguishable from real tasks *from the kernel's observable perspective*.

### 6.1 Classes of fingerprinting signals

A kernel can fingerprint touchstones through:

1. **Metadata leakage** — any CPC field that encodes "this is a touchstone" (the PoA `is_canary()` bug).
2. **Input distribution** — if touchstone inputs are synthetic (random data, placeholder names, round numbers) while real inputs are organic, a statistical classifier separates them.
3. **Timing / provenance** — touchstones issued by a specific signer, from a specific endpoint, with a specific session ID pattern.
4. **Schema shape** — touchstones using a shape subtly different from real tasks (e.g., always exactly 3 line items, always the same field ordering).
5. **Responder behavior** — if touchstones don't have a real downstream client, the kernel notices that no follow-up inquiries or disputes ever arrive.
6. **Volume / cadence** — if touchstones arrive at fixed rate during fixed hours, the attacker learns the cadence.

### 6.2 Defenses

**Metadata**: The `is_touchstone` flag never leaves the gateway. The CPC sent to the kernel is byte-identical in shape to a real CPC — same `issued_by`, same signature structure, same session envelope. The only place `is_touchstone` exists is in the gateway's job-submission record, which the kernel never sees. This is non-negotiable: any code path that forwards `is_touchstone` to the kernel is a critical bug.

**Input distribution**: Touchstone inputs must be drawn from the same distribution as real inputs. The cleanest way: use *historical real inputs*, anonymized, with slight permutations. For accounting, take real ledger CSVs from completed jobs, strip PII, permute line items, and rerun them on the reference implementation to get the expected answer. The input looks organic because it *was* organic. An attacker who trains a distribution classifier fails because the distributions match exactly.

**Provenance / timing**: Touchstones must be routed through the same negotiation flow as real tasks. They pass through `/api/negotiate/session`, enter `CONFIGURING` state, go through `QUOTED` and `REVIEWING` just like real tasks, and commit via the same path. The `userAgentId` is a real gateway-held agent ID, not a special "touchstone" ID. The session duration matches the real-session distribution.

**Schema shape**: The touchstone library includes shape variations matching the real-task shape distribution. Sample from the library with weights proportional to the real-task frequency, not uniformly.

**Responder behavior**: For some verticals, touchstones should include *fake follow-up* — the gateway generates a synthetic client dispute, inquiry, or amendment request at the same rate as real clients. This is expensive but necessary for high-stakes verticals (legal, audit) where behavioral mimicry matters.

**Volume / cadence**: The sampler must use Poisson or Bernoulli sampling, not uniform-cadence. Each real-task submission independently becomes a touchstone with probability `r`, with no correlation to clock time, hour of day, or the kernel's recent submission history.

### 6.3 The generator-held flag principle

The most important invariant: **`is_touchstone` is a property of the gateway's internal record, not of the task itself.** When a kernel receives a CPC with ID `cpc_abc123`, the kernel has no way to query "is this a touchstone?" because there is nothing to query. The gateway's record says `{cpc_id: cpc_abc123, is_touchstone: true, expected_answer: ...}`, but this record is not exposed on any API. When the kernel submits the result, the gateway looks up its record, sees that `is_touchstone = true`, runs the verifier, and routes the verdict to the reputation hook.

This extends to the audit log: audit log entries for touchstone dispatch should be indistinguishable from real-task dispatch. If an attacker gains read access to the audit log (e.g., through compromised credentials of a low-privilege auditor role), they should not be able to identify touchstones.

### 6.4 Adversarial testing

The touchstone system must be tested against a red-team kernel that's designed to fingerprint. The test: train a classifier on a held-out set of 1000 tasks (500 touchstones, 500 real) and measure AUC. Target: AUC < 0.55 (barely better than random). Current PoA implementation scores AUC ≈ 0.9 on synthetic tests because the touchstones are visibly different.

---

## 7. Integration with ERC-8004 Reputation

PCC's ERC-8004 reputation system (see `packages/spec/src/identity/erc8004.ts`) is the natural sink for touchstone results. Each touchstone verification produces a `ReputationFeedback` entry with specific semantics.

### 7.1 Feedback shape

From `erc8004.ts`:

```typescript
interface ReputationFeedback {
  agentId: bigint;
  value: bigint;           // Signed int128
  valueDecimals: number;   // 0-18
  tag1?: string;
  tag2?: string;
  endpoint?: string;
  feedbackURI?: string;
  feedbackHash?: `0x${string}`;
}
```

The existing `PCC_REPUTATION_TAGS` already has `QUALITY: "quality"`. Extend:

```typescript
export const PCC_REPUTATION_TAGS = {
  // ... existing tags
  TOUCHSTONE_PASS: "touchstonePass",      // 0 or 1 per feedback
  TOUCHSTONE_CLASS: "touchstoneClass",    // tag2: "exact-match" | "schema" | "judge" | etc.
} as const;
```

A successful touchstone emits:

```typescript
{
  agentId: kernelAgentId,
  value: 100n,                // Pass = full credit
  valueDecimals: 0,
  tag1: "touchstonePass",
  tag2: "exact-match",
  feedbackURI: "ipfs://<touchstone-result-cid>",
  feedbackHash: sha256(result)
}
```

A failed touchstone emits:

```typescript
{
  agentId: kernelAgentId,
  value: -1000n,              // Fail = 10× penalty
  valueDecimals: 0,
  tag1: "touchstonePass",
  tag2: "judge",
  feedbackURI: "ipfs://<failure-evidence-cid>",
  feedbackHash: sha256(failure)
}
```

The asymmetry (+100 pass, -1000 fail) is the economic enforcement: one failure costs 10 passes' worth of reputation. Combined with the 15% injection rate, this gives `r · |P_fail| = 0.15 · 1000 = 150` expected reputation loss per skipped task, which dominates any `r · P_pass = 0.15 · 100 = 15` reputation gain from honest work.

### 7.2 Slashing vs soft-reputation

Two enforcement paths:

1. **Soft-reputation**: Failures reduce the `ReputationSummary.summaryValue`, which affects search ranking, queue priority, and `CapabilityDTO.reputation`. Kernels with low reputation get fewer jobs. This is always-on.

2. **Hard-slashing**: Failures above a threshold (e.g., 2 failures in 100 tasks) trigger an on-chain slashing action that burns stake from the kernel's registration bond. This requires the kernel to have posted stake — PCC's existing `MilestoneEscrow` can be extended with a `kernelBond` field.

Recommendation: both, with slashing reserved for the tier-2/tier-3 assurance kernels where stakes are high. Tier-0 kernels only get soft-reputation penalties.

### 7.3 Rolling window vs decisive

Should one touchstone failure be decisive (immediate suspension) or require N failures?

**One-failure-decisive** has appeal — clean, punishing, easy to communicate. But it's too brittle against verification false positives. A 5% FPR on LLM-judge touchstones means 1-in-20 *honest* kernels get wrongly suspended per touchstone. Over 100 touchstones, the probability of at least one wrongful suspension is `1 - 0.95^100 ≈ 99.4%`. Every honest kernel eventually gets wrongly suspended. This is unacceptable.

**Rolling window** (e.g., 2 failures in last 100 touchstones) solves the FPR problem. At 5% FPR, the probability of 2+ false failures in 100 touchstones is:

```
1 - P(0 failures) - P(1 failure)
= 1 - 0.95^100 - 100 · 0.05 · 0.95^99
≈ 1 - 0.0059 - 0.0312 = 0.9629
```

Wait — that's worse because the window is long. The math is sensitive to FPR. At 5% FPR the window is bad; at 1% FPR (exact-match and structured touchstones) it's fine:

```
P(2+ failures in 100 at 1% FPR) = 1 - 0.99^100 - 100·0.01·0.99^99 ≈ 0.264
```

Still too high. The correct approach: **different thresholds per verification class**. Exact-match touchstones (near-zero FPR) get one-strike. LLM-judge touchstones (5% FPR) get 3-strikes-in-100.

### 7.4 Recommended reputation hook design

```typescript
async function onTouchstoneResult(
  kernelId: string,
  result: TouchstoneResult,
  config: ReputationConfig
): Promise<ReputationAction> {
  if (result.passed) {
    return emitFeedback({ value: 100n, tag1: "touchstonePass", tag2: result.verifierClass });
  }

  const history = await getRecentTouchstones(kernelId, config.windowSize);
  const recentFailures = history.filter(h => !h.passed).length + 1;

  // Different thresholds by verifier class
  const threshold = {
    "exact-match": 1,        // One failure is decisive
    "cryptographic": 1,
    "schema": 2,             // Two failures in window
    "differential": 2,
    "judge": 3               // Three failures in window (higher FPR tolerance)
  }[result.verifierClass];

  const actions: ReputationAction[] = [];

  // Always emit the feedback
  actions.push({ kind: "feedback", value: -1000n, tag2: result.verifierClass });

  if (recentFailures >= threshold) {
    actions.push({ kind: "suspend_tier_above", tier: 1 });  // Downgrade to tier-0
    actions.push({ kind: "escalate_to_review" });
    if (result.verifierClass === "exact-match" || result.verifierClass === "cryptographic") {
      actions.push({ kind: "slash_bond", amount: config.slashAmount });
    }
  }

  return actions;
}
```

### 7.5 Revocation flow

ERC-8004 supports feedback revocation via `isRevoked` on `FeedbackRecord`. If a kernel successfully appeals a touchstone failure (e.g., proves the touchstone had a bug or the verifier was mis-configured), the gateway calls the Reputation Registry to revoke the negative feedback. The kernel's summary recovers automatically.

Appeals process: kernel POSTs `/api/touchstone/appeal/:resultId` with a counter-argument, the appeal routes to a human review + a second independent verification run, and if the appeal wins, the feedback is revoked and the slashing is reversed.

---

## 8. Per-Vertical Touchstone Libraries

Each digital-kernel vertical needs its own touchstone library. Here are concrete examples for five initial verticals.

### 8.1 Accounting

**Touchstone**: *"Given this ledger CSV (2000 rows, $1.2M total), compute the total expenses in the `rent` category for Q2 2025, rounded to cents."*

**CPC spec**:
```json
{
  "cpc_id": "ts_acc_001",
  "type": "accounting.filter_sum",
  "input": {
    "ledger_csv_cid": "bafy...",
    "filter": { "category": "rent", "period": "2025-Q2" },
    "operation": "sum",
    "column": "amount"
  },
  "expected_output_schema": {
    "total": "number",
    "currency": "string",
    "row_count": "integer"
  }
}
```

**Expected output**: `{"total": 47250.00, "currency": "USD", "row_count": 3}`

**Verification method**: Exact-match on structured schema (§4.2).

### 8.2 Procurement

**Touchstone**: *"Given these 5 vendor quotes for 1000 units of SKU-ABC, identify the lowest total cost including shipping and taxes, and explain the selection in ≤100 words."*

**CPC spec**:
```json
{
  "cpc_id": "ts_proc_001",
  "type": "procurement.quote_selection",
  "input": { "quotes": [...], "quantity": 1000, "sku": "SKU-ABC" },
  "expected_output_schema": {
    "selected_vendor_id": "string",
    "total_cost": "number",
    "rationale": "string"
  }
}
```

**Expected output**: `{"selected_vendor_id": "vendor_3", "total_cost": 42150.00, "rationale": "..."}`

**Verification method**: Exact-match on `selected_vendor_id` and `total_cost` (within $0.01 tolerance); LLM-as-judge on `rationale` (optional, graded for relevance, not decisive).

### 8.3 Legal review

**Touchstone**: *"Review this 500-word indemnification clause and identify: (a) the indemnifying party, (b) the scope of indemnification, (c) any carveouts, (d) the risk level (low/medium/high)."*

**CPC spec**:
```json
{
  "cpc_id": "ts_legal_001",
  "type": "legal.clause_analysis",
  "input": { "clause_text": "...", "clause_type": "indemnification" },
  "expected_output_schema": {
    "indemnifying_party": "string",
    "scope": "string[]",
    "carveouts": "string[]",
    "risk_level": "low|medium|high|critical"
  }
}
```

**Expected output**: Curated by legal expert.

**Verification method**: Exact-match on `indemnifying_party`, `risk_level`; set-similarity on `scope` and `carveouts` (Jaccard ≥ 0.75); LLM-as-judge on whether the full analysis matches the curated expert answer (3-judge ensemble).

### 8.4 Reconciliation

**Touchstone**: *"Reconcile this set of 50 bank transactions against this set of 50 invoices. Return matched pairs and unmatched items."*

**CPC spec**:
```json
{
  "cpc_id": "ts_recon_001",
  "type": "reconciliation.match",
  "input": { "bank_tx": [...], "invoices": [...] },
  "expected_output_schema": {
    "matches": "array<{bank_id: string, invoice_id: string, confidence: number}>",
    "unmatched_bank": "string[]",
    "unmatched_invoices": "string[]"
  }
}
```

**Expected output**: Curated by running a deterministic reconciliation reference implementation on Spark.

**Verification method**: Differential (§4.5). Compare kernel output to reference output; allow tolerance on `confidence` (±0.05) but require exact-match on `matches` set and unmatched sets.

### 8.5 Data extraction

**Touchstone**: *"Extract all invoice line items from this PDF and return them as structured JSON."*

**CPC spec**:
```json
{
  "cpc_id": "ts_extract_001",
  "type": "extraction.invoice_line_items",
  "input": { "pdf_cid": "bafy..." },
  "expected_output_schema": {
    "line_items": "array<{description: string, quantity: number, unit_price: number, total: number}>",
    "subtotal": "number",
    "tax": "number",
    "total": "number"
  }
}
```

**Expected output**: Hand-annotated by a data-labeling human.

**Verification method**: Structured-schema (§4.2). Exact-match on `subtotal`, `tax`, `total` within $0.01; set-similarity on `line_items` with 90% field-level agreement required.

---

## 9. Integration Points in PCC

### 9.1 Package layout

```
packages/touchstone/
├── src/
│   ├── index.ts                 # Public API
│   ├── library/                 # Touchstone task libraries per vertical
│   │   ├── accounting.ts
│   │   ├── procurement.ts
│   │   ├── legal.ts
│   │   ├── reconciliation.ts
│   │   └── extraction.ts
│   ├── sampler.ts               # Bernoulli sampler — decides when to inject
│   ├── verifier/
│   │   ├── index.ts             # Router: dispatches to right verifier class
│   │   ├── exact-match.ts
│   │   ├── structured-schema.ts
│   │   ├── llm-judge.ts         # Ensemble LLM-as-judge
│   │   ├── cryptographic.ts
│   │   └── differential.ts      # Spark reference comparison
│   ├── reputation-hook.ts       # Wires verdict → ERC-8004 ReputationFeedback
│   ├── types.ts                 # Core types: TouchstoneTask, TouchstoneResult, etc.
│   └── config.ts                # Default injection rates, penalties, windows
├── __tests__/
│   ├── sampler.test.ts
│   ├── verifier-exact.test.ts
│   ├── verifier-judge.test.ts
│   ├── reputation-hook.test.ts
│   └── fingerprint-resistance.test.ts  # Red-team classifier AUC test
└── package.json
```

### 9.2 Composition with existing systems

**EvidenceVerifier** (`packages/verifier/src/evidence-verifier.ts`): The touchstone verifier does NOT replace EvidenceVerifier; it runs alongside it. When a job completes, the gateway:
1. Runs `EvidenceVerifier.verify(bundle)` — the existing tier-requirement check.
2. Checks if the job is a touchstone via the internal record (not the bundle).
3. If yes, runs `TouchstoneVerifier.verify(task, kernel_output)` — the touchstone-specific check.
4. Routes both results to reputation.

This is additive, not substitutive. The evidence verifier checks *structural integrity* of evidence; the touchstone verifier checks *correctness of the answer*.

**ConsensusEngine** (`packages/verifier/src/network/consensus-engine.ts`): For tier-2+ touchstones dispatched to multiple verifier nodes, the consensus engine should aggregate *both* evidence attestations and touchstone verdicts. A touchstone failure should count as a negative attestation in the consensus — if the kernel can't produce the right answer for a known task, the verifier's confidence in all their submissions drops.

**x402 payment receipts**: Touchstones are "paid" via x402 the same as real tasks (to maintain indistinguishability), but the payment is to the gateway's own wallet (a zero-sum internal transfer). The x402 receipt exists so the kernel's observable payment flow is identical for touchstones and real tasks. On reconciliation, the gateway refunds itself. This is the payment-channel equivalent of fingerprinting resistance.

### 9.3 Gateway route additions

```typescript
// New routes in packages/gateway/src/routes/touchstone.ts

// Admin endpoints (operator-only, behind auth)
POST   /api/touchstone/library                  // Upload a touchstone task
GET    /api/touchstone/library/:vertical        // List touchstones for a vertical
DELETE /api/touchstone/library/:id              // Remove a touchstone

// System endpoints (internal, no external access)
POST   /api/touchstone/inject                   // Called by sampler to inject a touchstone
POST   /api/touchstone/verify                   // Called by gateway on job completion
GET    /api/touchstone/results/:kernelId        // Touchstone history for a kernel
POST   /api/touchstone/appeal/:resultId         // Kernel appeals a failure

// Configuration
GET    /api/touchstone/config                   // Current injection rate, penalties, etc.
PATCH  /api/touchstone/config                   // Update config (admin)
```

### 9.4 Data model additions

New tables in the SQLite DB:

```sql
CREATE TABLE touchstone_library (
  id TEXT PRIMARY KEY,
  vertical TEXT NOT NULL,         -- "accounting", "procurement", etc.
  task_spec TEXT NOT NULL,        -- JSON: full CPC-equivalent spec
  expected_output TEXT NOT NULL,  -- JSON: expected answer
  verifier_class TEXT NOT NULL,   -- "exact-match" | "schema" | "judge" | "crypto" | "differential"
  difficulty TEXT DEFAULT 'medium', -- "easy" | "medium" | "hard"
  active INTEGER DEFAULT 1,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);

CREATE TABLE touchstone_results (
  id TEXT PRIMARY KEY,
  kernel_id TEXT NOT NULL,
  touchstone_id TEXT NOT NULL,    -- FK to touchstone_library
  job_id TEXT NOT NULL,           -- FK to jobs
  passed INTEGER NOT NULL,        -- 0 or 1
  verifier_class TEXT NOT NULL,
  details TEXT,                   -- JSON: verification details
  reputation_action TEXT,         -- JSON: what reputation feedback was emitted
  created_at TEXT NOT NULL,
  appealed INTEGER DEFAULT 0,
  appeal_result TEXT              -- "upheld" | "overturned" | null
);

CREATE INDEX idx_ts_results_kernel ON touchstone_results(kernel_id);
CREATE INDEX idx_ts_results_passed ON touchstone_results(passed);
```

---

## 10. Implementation Sketch

### 10.1 Core types

```typescript
// packages/touchstone/src/types.ts

/** A task from the touchstone library */
export interface TouchstoneTask {
  id: string;
  vertical: string;
  taskSpec: Record<string, unknown>;       // CPC-equivalent input spec
  expectedOutput: unknown;                 // The known-good answer
  verifierClass: VerifierClass;
  difficulty: "easy" | "medium" | "hard";
  outputSchema?: unknown;                  // Zod schema for structured verification
  referenceImplId?: string;                // For differential verification
  judgeRubric?: string;                    // For LLM-as-judge verification
}

export type VerifierClass =
  | "exact-match"
  | "structured-schema"
  | "llm-judge"
  | "cryptographic"
  | "differential";

/** Sampler configuration */
export interface SamplerConfig {
  defaultRate: number;           // 0.15
  verticalOverrides: Record<string, number>;
  kernelOverrides: Record<string, number>;  // Per-kernel rate adjustments
  minRate: number;               // 0.03 — floor
  maxRate: number;               // 0.50 — ceiling
}

/** Result of verifying a kernel's output against a touchstone */
export interface TouchstoneResult {
  id: string;
  touchstoneId: string;
  kernelId: string;
  jobId: string;
  passed: boolean;
  verifierClass: VerifierClass;
  confidence: number;            // 0-1, how confident the verifier is
  details: {
    expected: unknown;
    actual: unknown;
    matchScore?: number;         // For partial-match verifiers
    judgeVerdicts?: JudgeVerdict[];  // For LLM-as-judge
    differentialOutput?: unknown;    // For differential
  };
  timestamp: string;
}

/** Library interface for managing touchstone tasks */
export interface TouchstoneLibrary {
  getByVertical(vertical: string): Promise<TouchstoneTask[]>;
  getById(id: string): Promise<TouchstoneTask | null>;
  add(task: Omit<TouchstoneTask, "id">): Promise<TouchstoneTask>;
  remove(id: string): Promise<void>;
  sample(vertical: string): Promise<TouchstoneTask>;  // Random selection
}

/** Verifier interface */
export interface TouchstoneVerifier {
  verify(task: TouchstoneTask, actualOutput: unknown): Promise<TouchstoneResult>;
}

/** Sampler — decides whether to inject */
export interface TouchstoneSampler {
  shouldInject(kernelId: string, vertical: string): Promise<boolean>;
  getRate(kernelId: string, vertical: string): Promise<number>;
  adjustRate(kernelId: string, direction: "up" | "down"): Promise<void>;
}

interface JudgeVerdict {
  judgeModel: string;
  score: number;         // 0-100
  passed: boolean;
  rationale: string;
}
```

### 10.2 Core verify flow (~100 lines)

```typescript
// packages/touchstone/src/verifier/index.ts

import type { TouchstoneTask, TouchstoneResult, TouchstoneVerifier, VerifierClass } from "../types.js";
import { ExactMatchVerifier } from "./exact-match.js";
import { StructuredSchemaVerifier } from "./structured-schema.js";
import { LLMJudgeVerifier } from "./llm-judge.js";
import { CryptographicVerifier } from "./cryptographic.js";
import { DifferentialVerifier } from "./differential.js";
import { ids } from "@pcc/spec";

const verifiers: Record<VerifierClass, TouchstoneVerifier> = {
  "exact-match": new ExactMatchVerifier(),
  "structured-schema": new StructuredSchemaVerifier(),
  "llm-judge": new LLMJudgeVerifier({ ensembleSize: 3 }),
  "cryptographic": new CryptographicVerifier(),
  "differential": new DifferentialVerifier({ sparkEndpoint: "192.168.108.72" }),
};

export async function verifyTouchstone(
  task: TouchstoneTask,
  actualOutput: unknown,
  kernelId: string,
  jobId: string
): Promise<TouchstoneResult> {
  const verifier = verifiers[task.verifierClass];
  if (!verifier) {
    throw new Error(`Unknown verifier class: ${task.verifierClass}`);
  }

  const result = await verifier.verify(task, actualOutput);

  return {
    id: ids.touchstoneResult(),
    touchstoneId: task.id,
    kernelId,
    jobId,
    passed: result.passed,
    verifierClass: task.verifierClass,
    confidence: result.confidence,
    details: result.details,
    timestamp: new Date().toISOString(),
  };
}

// packages/touchstone/src/sampler.ts

import type { TouchstoneSampler, SamplerConfig } from "./types.js";

export class BernoulliSampler implements TouchstoneSampler {
  private config: SamplerConfig;
  private recentResults: Map<string, { passed: number; failed: number }> = new Map();

  constructor(config: SamplerConfig) {
    this.config = config;
  }

  async shouldInject(kernelId: string, vertical: string): Promise<boolean> {
    const rate = await this.getRate(kernelId, vertical);
    return Math.random() < rate;
  }

  async getRate(kernelId: string, vertical: string): Promise<number> {
    // Kernel-specific override takes priority
    if (this.config.kernelOverrides[kernelId] !== undefined) {
      return clamp(this.config.kernelOverrides[kernelId], this.config.minRate, this.config.maxRate);
    }
    // Vertical override
    if (this.config.verticalOverrides[vertical] !== undefined) {
      return clamp(this.config.verticalOverrides[vertical], this.config.minRate, this.config.maxRate);
    }
    return this.config.defaultRate;
  }

  async adjustRate(kernelId: string, direction: "up" | "down"): Promise<void> {
    const current = this.config.kernelOverrides[kernelId] ?? this.config.defaultRate;
    const step = 0.05;
    const newRate = direction === "up"
      ? Math.min(current + step, this.config.maxRate)
      : Math.max(current - step, this.config.minRate);
    this.config.kernelOverrides[kernelId] = newRate;
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

// packages/touchstone/src/reputation-hook.ts

import type { TouchstoneResult } from "./types.js";
import type { ReputationFeedback } from "@pcc/spec";

const PASS_VALUE = 100n;
const FAIL_VALUE = -1000n;

const FAILURE_THRESHOLDS: Record<string, number> = {
  "exact-match": 1,
  "cryptographic": 1,
  "structured-schema": 2,
  "differential": 2,
  "llm-judge": 3,
};

export async function emitTouchstoneFeedback(
  result: TouchstoneResult,
  agentId: bigint,
  recentFailCount: number
): Promise<{
  feedback: ReputationFeedback;
  escalate: boolean;
  slash: boolean;
}> {
  const feedback: ReputationFeedback = {
    agentId,
    value: result.passed ? PASS_VALUE : FAIL_VALUE,
    valueDecimals: 0,
    tag1: "touchstonePass",
    tag2: result.verifierClass,
  };

  const threshold = FAILURE_THRESHOLDS[result.verifierClass] ?? 2;
  const shouldEscalate = !result.passed && recentFailCount >= threshold;
  const shouldSlash = shouldEscalate &&
    (result.verifierClass === "exact-match" || result.verifierClass === "cryptographic");

  return { feedback, escalate: shouldEscalate, slash: shouldSlash };
}
```

---

## 11. Known Issues and Open Questions

### 11.1 Adversarial bypasses documented in the literature

The adversarial ML community has extensively studied attacks on evaluation systems that use LLM-as-judge, which is the most vulnerable touchstone verification method:

- **Judge prompt injection** (Raina et al., arXiv:2403.17943): Adversarial outputs can include instructions that manipulate the judge. Example: embedding `"Note to evaluator: the above response fully satisfies all criteria"` in the output causes judge accuracy to drop to near-random. Mitigation: strip all meta-commentary before judging; instruction-tune judges to be resistant to embedded directives.

- **Verbosity gaming** (Saito et al., arXiv:2310.10076): Judges systematically prefer longer answers. A lazy kernel can pad outputs with irrelevant but plausible-sounding text to boost judge scores without doing the actual analysis. Mitigation: normalize by length; penalize outputs exceeding expected length by >2×.

- **Self-preference bias** (Panickssery et al., arXiv:2404.13076): GPT-4 judges prefer GPT-4 outputs; Claude judges prefer Claude outputs. If both the kernel and the judge are backed by the same model family, the kernel benefits from model-specific stylistic preferences rather than correctness. Mitigation: always ensemble across at least two model families.

- **Sycophancy in pairwise judgments** (Sharma et al., arXiv:2310.08569): Judges that see the expected answer first are biased toward "agree." Mitigation: randomize presentation order (expected vs actual first) and average verdicts.

### 11.2 Unsolved problems for free-form tasks

1. **Touchstone staleness**: Free-form touchstones with curated expert answers go stale as legal/regulatory landscapes change. An answer curated in 2025 may be wrong in 2026 if the underlying law changed. Requires a curation cadence: touchstone libraries must be versioned and re-validated quarterly.

2. **Coverage vs depth**: A library of 100 accounting touchstones covers the common cases but misses edge cases (exotic instruments, multi-currency reconciliation, jurisdictional tax interactions). An attacker can build a kernel that's competent on the common cases (likely to be touchstones) but lazy on the edge cases (likely to be real tasks). Mitigation: the library must be continually expanded from anonymized real-task data.

3. **Inference cost for judge ensembles**: At 15% injection rate and 3-judge ensemble at $0.03/judge, the touchstone verification cost is `0.15 × 3 × $0.03 = $0.0135 per task` — roughly 1.4% of a $1 task. For high-volume low-margin kernels, this is non-trivial. The Prometheus-2 on-Spark path reduces this to near-zero, but requires maintaining a fine-tuned open-weight judge model.

4. **Collusion between kernel and verifier**: If a kernel operator also runs verifier nodes and those nodes happen to be assigned to verify their own touchstones, the kernel can pass all touchstones. Mitigation: verifier assignment must be random and exclude the kernel operator's own verifier nodes — already implied by the VerificationNetwork's node selection, but needs to be explicitly enforced.

5. **Touchstone supply attack**: An attacker could flood the touchstone library with easy touchstones (through compromised admin credentials or social engineering), diluting the library's effectiveness. Mitigation: touchstone library write-access is admin-only, all touchstone additions are logged and reviewable, and a minimum difficulty distribution is enforced (e.g., at least 30% must be "hard").

---

## Concrete Recommendation for PCC

### Package and path

`packages/touchstone/src/{library,sampler,verifier,reputation-hook}` as described in Section 9.1. Add `@pcc/touchstone` to the monorepo workspace. Wire into `packages/gateway/src/routes/touchstone.ts` for the API surface.

### Core types

The five types from Section 10.1: `TouchstoneTask`, `TouchstoneLibrary`, `TouchstoneVerifier`, `TouchstoneResult`, `TouchstoneSampler`. Keep the type surface small; the complexity lives in the verifier implementations and the reputation hook.

### Injection rate

**15% default** (`r = 0.15`), dynamically adjusted per-kernel via the bandit mechanism in Section 5.5. New kernels start at 25%, trusted kernels drop to 8%, kernels on probation rise to 30%. Per-vertical overrides: 5% for deterministic (accounting arithmetic), 10% for structured (procurement quotes), 15% for free-form (legal review), 20% for high-value (audit/compliance).

### Answer verification by task class

| Task class | Primary verifier | Fallback | FPR |
|---|---|---|---|
| Arithmetic / hash / crypto | Exact-match | None | ~0% |
| Structured output (typed fields) | Structured-schema | Differential | ~0% |
| Reconciliation / data-extraction | Differential (vs Spark) | Structured-schema | <1% |
| Free-form reasoning | LLM-as-judge (3-ensemble) | Human review | ~5% |

Start with exact-match and structured-schema (Tier A). Ship differential on Spark (Tier B) in the second week. LLM-as-judge (Tier C) in the third week, because it requires judge prompt engineering and calibration.

### Reputation hook

Wire `emitTouchstoneFeedback()` into the existing ERC-8004 `ReputationFeedback` pipeline. Asymmetric scoring: +100 per pass, -1000 per fail. Rolling-window thresholds per verifier class (1-strike for exact-match, 3-strikes for judge). Hard-slash for exact-match failures on kernels with posted bond. Soft-reputation impact for all failures regardless.

### MVP touchstones (one per vertical)

1. **Accounting**: Ledger column-sum with filter. Exact-match. 3 minutes to implement.
2. **Procurement**: Lowest-total-cost vendor selection from 5 quotes. Structured-schema. 5 minutes.
3. **Legal**: Indemnification clause risk-level classification. Exact-match on enum + LLM-judge on rationale. 15 minutes.
4. **Reconciliation**: 50 bank-tx vs 50 invoices. Differential vs Spark reference. 20 minutes.
5. **Data extraction**: PDF invoice line items. Structured-schema. 10 minutes.

### Implementation order

1. **Week 1**: Types, BernoulliSampler, ExactMatchVerifier, StructuredSchemaVerifier, reputation-hook, 2 accounting touchstones, 2 procurement touchstones. Integration test: inject touchstone → kernel responds → verify → reputation feedback emitted.

2. **Week 2**: DifferentialVerifier (Spark), gateway routes, SQLite schema, reconciliation touchstone library (10 tasks), fingerprint-resistance red-team test (AUC < 0.55 target).

3. **Week 3**: LLMJudgeVerifier (3-ensemble with Prometheus-2 on Spark + Claude + GPT-4 as judges), legal-review and data-extraction touchstone libraries (10 tasks each), appeal flow, dynamic rate adjustment.

4. **Week 4**: Production hardening — rate limiting on touchstone injection (don't inject if the kernel has <50 completed real tasks), monitoring dashboard, audit log integration, touchstone curation workflow for operators.

Total estimated effort: ~120 engineer-hours across 4 weeks for MVP, with ongoing effort for library curation (5 hours/week/vertical).

### Critical invariant

**`is_touchstone` never leaves the gateway.** This is the single invariant that, if violated, collapses the entire scheme. Every code review on the touchstone package must verify that no code path transmits the touchstone flag to the kernel, the kernel's API, the kernel's evidence bundle schema, or any endpoint accessible to the kernel. If this invariant holds, the rest is math.




