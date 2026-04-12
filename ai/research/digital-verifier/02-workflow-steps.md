# Digital Workflow Contract Extensions for PCC BuilderContract

**Research target**: Extend `packages/contract-builder` and `packages/spec` with typed digital-workflow semantics so PCC can contract for things like accounting reconciliations, procurement pipelines, legal review, and data extraction — composing cleanly with the existing physical manufacturing templates.

**Date**: 2026-04-11
**Output file**: `C:\Users\globa\physical-capability-cloud\ai\research\digital-verifier\02-workflow-steps.md`
**Status**: Draft (written incrementally)

---

## 0. Executive Summary

PCC's `BuilderContract` (at `C:\Users\globa\physical-capability-cloud\packages\contract-builder\src\builder.ts`) was designed around physical processes: a `CapabilityTemplate` defines a flat set of typed parameters (`material`, `infill`, `layer_height`), a `MachineProfile` narrows those parameters for a specific machine (Prusa MK4, Haas VF-2), and the validator produces a single `cwmStep` — a leaf node of the Capability Workflow Manifest (CWM) — that the scheduler can dispatch to a shop.

This shape works for one-machine-one-step jobs. It starts to crack when the thing you're buying is a *digital* capability — "reconcile last month's bank statement against GL," "solicit quotes from 5 approved vendors for a bill of materials," "extract all radio frequencies from this PDF datasheet and map them to our spectrum database." These tasks don't have a single machine; they're pipelines of typed operations, often with branching, with inputs and outputs that need to be machine-checkable at every boundary.

The path we take in this report is: **extend `BuilderContract` with an optional `workflowSteps[]` field that describes a typed DAG of digital operations**, where each step declares its own input and output schema (via Zod, reusing the pattern already in `packages/spec/src/csd/schema.ts`). A validator-issued freshness anchor (we call it `challenge`) binds each contract instance to a specific moment in time and a specific issuing validator, so a worker can't replay an old execution against a new contract. Physical steps (the existing `CWMStep`) and digital workflow steps compose in the same dependency graph.

**What we do NOT do**:

- We do not fork `BuilderContract`. Every extension is additive and optional (`workflowSteps?`, `digitalTaskType?`, `challenge?`). An existing physical 3D-printing contract produced today still validates tomorrow after the change ships.
- We do not adopt any vocabulary from Provenonce PoA's `CanonicalPathContract` (`C:\Users\globa\scratch\poa-subnet\protocol\cpc.py`). No "canary," no "CPC," no "nonce reflection." PoA's design is read as a pattern reference only; its Pydantic types and enum names stay in their repo. PCC uses PCC-native names: *digital workflow contract*, *workflow step*, *challenge anchor*, *touchstone task*.
- We do not try to re-implement BPMN or Temporal. The point is to type the *contract* (the thing that two parties agree on and that gets settled), not to build a runtime. An operator is free to execute the contract with Temporal, LangGraph, Airflow, a shell script — the contract just says what the inputs, outputs, dependencies, and acceptance criteria are.

The rest of this document: (1) first principles, (2) prior art scan, (3) schema-language choice, (4) dependency graph representation, (5) PCC's actual extension surface as we read it in the repo, (6) a taxonomy of digital capability kernels to ship first, (7) how digital and physical workflows compose, (8) the challenge-anchor mechanism, (9) the concrete TypeScript sketch, (10) known failure modes, and a final concrete extension plan with exact file paths.

---

## 1. First Principles: Why Typed Workflow Contracts Beat Prompts

The argument for typed workflow DAGs over natural-language task briefs is the same argument that made FHIR StructureDefinition beat "just write a free-text discharge summary" and that made SQL beat "the DBA will know what I meant." The property gained is **mechanical verifiability**. The property lost is **flexibility at the edges**.

When the contract is a prompt — "Agent, please reconcile these bank statements against the GL and flag discrepancies" — three things are indeterminate:

1. **What counts as done**. The agent can return "I looked at it, seems fine" and the requester has no mechanical way to dispute the claim. Disputes become human adjudication, which is expensive.
2. **What counts as correct output**. If the output is a freeform report, two runs of the same reconciliation may produce two reports that are both reasonable and neither is machine-comparable to the other. This kills the ability to cross-check one worker against another, which is how PCC assurance tiers 2 and 3 work today for physical jobs.
3. **What the worker actually executed**. Without a typed step list, the worker's execution trace is a sequence of tool calls against an LLM's choice, not a sequence of steps that the requester specified. The requester is paying for outcomes they cannot audit.

A typed workflow contract fixes each of these by turning "execute this task" into "execute this DAG of operations, each with a declared input type, output type, and dependency list." Now:

1. **Done** means every step produced an output that validates against its declared output schema.
2. **Correct** can be checked per-step: a reconciliation step that outputs a JSON object with `{matched: Match[], unmatched: Transaction[], totalVariance: Amount}` can be compared two ways between two workers — if worker A and worker B both produce schema-valid outputs and their `totalVariance` differs by more than a threshold, that's a dispute trigger regardless of which worker is "right."
3. **Executed** becomes an audit problem with a clear answer: show me, for each step in the declared DAG, the inputs you fed in and the outputs you produced. Miss a step, fail the contract.

The cost of this rigor is flexibility. You pay for it in two places:

- **Step-boundary ossification**. If the contract declares 7 steps and the worker discovers a more efficient 4-step path, they can't take it without either (a) failing the contract because extra/fewer steps are forbidden or (b) admitting that the DAG is advisory, not binding, which defeats the audit property. Argo Workflows and AWS Step Functions both hit this in practice; the escape hatch is typically a higher-level "outcome contract" wrapping the DAG, where the DAG is a default path and the worker can substitute as long as the final output still validates.
- **Schema rigidity**. A typed output schema like `{matched: Match[], unmatched: Transaction[]}` is great for reconciliation but terrible for tasks where the output shape depends on the input. "Summarize this meeting" produces a different shape depending on whether the meeting was a code review or a board meeting. You can force it into `{summary: string, actionItems: ActionItem[]}` but you lose information.

The PCC position is: **typed workflow contracts are the right default for the tasks where mechanical verification matters** — accounting, procurement, legal clause extraction, data migration, compliance reporting — and physical contracts already live in this world because material + infill + layer_height are trivially typeable. Freeform cognitive work can sit outside the contract system or wrap a typed core in an outer "judgment layer" that's settled separately.

This is also the reason we do *not* want to reuse PoA's `CanonicalPathContract` type directly. PoA lives on a Bittensor subnet where miners are incentivized to game the validator. That's a different threat model. PCC has an operator-accountability threat model — operators fail jobs, produce bad evidence, get disputed, lose escrow. The data flow is different, the economics are different, the naming should be different. We're doing parallel evolution on similar machinery, not sharing it.

---

## 2. Prior Art: What's Out There and What They Got Right

I did a fast scan of the main workflow-definition systems and extracted the single property each one nails and the single thing each one gets wrong. The goal is to steal the good parts.

### BPMN 2.0

BPMN is the 20-year-old business process modeling standard. Its contribution is **a formal graph model for business processes** with a tight vocabulary (tasks, gateways, events, swimlanes, message flows) and an XML serialization that runtime engines (Camunda, Activiti, Flowable) can execute.

Right: BPMN's separation of *pool* (organizational boundary) from *lane* (responsibility boundary) from *task* (atomic work) is genuinely useful and maps almost directly onto PCC's concept of kernel (pool), capability (lane), and step (task). BPMN's token semantics — a token moves through the graph and splits at parallel gateways — is also a clean execution model that we can borrow.

Wrong: BPMN's type system is basically absent. A task has a name and optional documentation. Input and output "data objects" exist but have no schema. The result is that in practice BPMN diagrams are drawn by analysts and then hand-translated into real code by developers, with all the schema fidelity that implies. Camunda's own docs have repeated complaints from users about "I drew the BPMN, now how do I make the Java code actually match it?" (see Camunda forum threads on DMN/BPMN type mismatch; search "Camunda BPMN type mismatch typed variable"). BPMN teaches us: **graph model is good, but typed data at every edge is non-negotiable**.

### CMMN

CMMN (Case Management Model and Notation) is BPMN's cousin for case-oriented work: legal case, insurance claim, medical case. It models things that BPMN can't — non-sequential, human-judgment-heavy, dynamically emerging tasks.

Right: CMMN has the concept of a "discretionary task" — a task that a case worker *may* add if conditions warrant. This is exactly the escape hatch we need for digital workflows where the worker has to improvise, and neither BPMN nor Temporal gives you this cleanly.

Wrong: CMMN essentially died in the market. Vendors never built good tooling, and users found it too abstract. The lesson: if you ship a concept that requires a lot of meta-modeling before anyone can do a concrete task, nobody uses it. Keep it concrete.

### Temporal / Cadence

Temporal (the open-source descendant of Uber's Cadence) is the current state-of-the-art for durable, reliable workflow execution. A workflow is a function written in Go, Java, Python, TypeScript, or .NET; Temporal persists every step of the function's execution and can resume it after failure.

Right: Temporal's *determinism constraint* is the core insight. A workflow function must be deterministic — every non-deterministic operation (network calls, random numbers, current time) has to go through a Temporal "activity" which is logged. The workflow can then be replayed from its event history and produce the same result. This means the execution *is* the audit log, not a separate thing. For PCC, the equivalent is: every digital workflow step's output must be deterministic given its declared inputs, or the nondeterminism must be externalized (e.g., as an "oracle call" step that logs its response).

Wrong: Temporal workflows are code, not data. You cannot compare two Temporal workflows for equivalence without running them. You cannot generate a UI configurator from a Temporal workflow. You cannot ship a Temporal workflow across organizational boundaries as a contract. Temporal documented issues: workflow versioning is notoriously difficult (see temporalio/temporal issues #1769, #2340 on versioning pain), and the "code not data" problem means analysts and auditors can't read the workflows. For PCC, we want the contract to be data — a JSON document with typed fields — even if at execution time it's run by a Temporal-like engine.

### AWS Step Functions (Amazon States Language / ASL)

ASL is a JSON DSL for describing state machines. Each state has a type (Task, Choice, Parallel, Map, Wait, Pass, Succeed, Fail), an input path, an output path, a result path, and transitions.

Right: ASL is *data*. A state machine is a JSON document. You can lint it, diff it, version it, ship it across APIs. JSONPath-based `InputPath`/`OutputPath`/`ResultPath` lets a state declare which slice of the global state it reads and which slice it writes, which gives you a form of typed data flow without declaring explicit schemas. ASL's `Parameters` field can include `$$.Execution.Input.foo` references, which is an implicit dependency expression — state B reads from execution input, state C reads from state A's output, the dependency graph falls out of the references.

Wrong: ASL has no types. The fields are untyped JSON. A Choice state's `BooleanEquals` comparator doesn't care if you compare a string to a boolean. Errors surface at runtime, not at contract-build time. ASL users repeatedly ask for a typed version; AWS has added JSONata support in 2024 which is better but still not a type system. Real documented issue: Step Functions' "silently passing the wrong shape between states" is a GitHub search staple — search "AWS Step Functions untyped data error" for a wall of postmortems. For PCC: steal the *data-not-code* approach, reject the *untyped-JSON* approach.

### Argo Workflows

Argo is Kubernetes-native, YAML-defined, DAG-based workflows. Each step is a container; dependencies are declared with `dependencies: [stepA, stepB]`.

Right: Argo's `dependencies: string[]` is the simplest possible dependency expression and the one most people read first. It does not try to infer dependencies from data references (like ASL) or from function call order (like Temporal). You say the dependency, explicitly, by name. This makes the DAG easy to visualize, easy to validate (no cycles), and easy to reason about. We'll steal this for PCC's digital workflow steps.

Wrong: Argo inputs and outputs are Kubernetes-flavored — parameters are strings, artifacts are files. There's no type system; a step that claims to produce a "result" string can produce a 5MB JSON blob or an empty string and Argo doesn't care. Users repeatedly hit "I thought my template's output was JSON but it was YAML and the next step barfed." See argoproj/argo-workflows issues around `valueFrom` and output parameter handling. Lesson: keep Argo's explicit `dependsOn`, but type the I/O with Zod.

### GitHub Actions

GitHub Actions YAML is probably the most-used workflow DSL in the world right now. Jobs depend on other jobs via `needs: [job-name]`. Each job runs steps in sequence; each step is a shell command or an action reference.

Right: `needs` is dead simple and universally understood. GitHub Actions also gets *versioning* right in a way most workflow systems don't: actions are referenced by commit SHA or tag, so a workflow is reproducible as long as you pin the action versions. For PCC: if a workflow step references a "kernel function" (a digital capability), it should reference it by a versioned identifier, not just a name. The CSD URI pattern (`pcc://capabilities/fdm/v2`) is already there and works for this.

Wrong: Actions has no data types. Inputs and outputs are strings, strings, strings. The `outputs` of a job are stringified JSON at best, and the next job has to parse them. Real documented pain: GitHub Actions issue #28146 ("Support structured outputs between jobs"), still open. Thousands of upvotes. Lesson: **the pattern of "my previous job computed an object, now I want to pass it to the next job" is the single most-requested feature in every workflow system, and nobody has solved it except by typing the boundaries.**

### Airflow / Dagster / Prefect

Python DAG frameworks. Airflow is the oldest (Airbnb, 2014), Prefect is the refactor (Prefect Core then Prefect 2 with Orion), Dagster is the type-first pitch (declarative, op-based, with "op" being a typed function).

Right: Dagster is the closest to what we want. Dagster *ops* declare input types and output types with Python type hints plus Dagster's type system. Dagster can then check at graph-build time that a downstream op can actually accept an upstream op's output. It can also generate a UI from the op graph. Dagster's insight: **the graph is derived from type-annotated functions**. You write the function with types, and the framework builds the DAG.

Wrong: Dagster is still code-first. The DAG is in Python. You can serialize a Dagster graph to JSON for the UI, but the canonical definition is the Python code. Dagster also struggles when ops have branching or conditional execution — their `@op` decorator's semantics around dynamic outputs are repeatedly documented as confusing (see Dagster community forum). For PCC: **the typed-input/typed-output op model is the right model, but we want the canonical definition to be JSON (CSD-like), not Python code.**

### LlamaIndex Workflows / LangGraph

These are the LLM-era workflow frameworks. LlamaIndex Workflows is event-driven (steps communicate by emitting typed events); LangGraph is graph-with-state (a `StateGraph` where nodes mutate a shared `State` TypedDict).

Right: LangGraph's `StateGraph` is explicitly typed via Python `TypedDict`. You declare the state shape once — e.g., `class ResearchState(TypedDict): query: str; results: list[Paper]; summary: str` — and every node is a function `State -> State`. The graph is built from edges between nodes. This is very close to PCC's needs because the "state" is the contract's evolving data and the "nodes" are the workflow steps. LlamaIndex's typed-events approach is also solid — each step declares which event types it accepts and which it emits, and the framework routes events.

Wrong: Both are still Python-code-first. Both are also relatively new (LangGraph shipped in 2024) and have documented rough edges around error handling and step retry — see langchain-ai/langgraph issue tracker for "node failed silently" reports. For PCC: LangGraph's *typed state + node edges* model is worth stealing, but once again we want the canonical form to be JSON.

### Cue, Jsonnet

Both are typed config languages. Cue is the stronger one: it has a type system that supports constraints, validation, and unification of partial configs. Jsonnet is simpler (closer to JSON with functions and object composition).

Right: Cue's insight is that a schema and a value are the same thing — a schema is just a very general value, a value is just a very constrained schema. This means you can start with a Cue schema for "a workflow step" and progressively constrain it to a specific step. Cue is the right mental model for CSDs: a CSD is a schema that narrows the general "capability" into a specific one.

Wrong: Cue is unfamiliar to most developers and introduces a second toolchain. For PCC, which already uses Zod + TypeScript, adopting Cue would be cultural friction for minimal gain. Stay in the TypeScript + Zod world, but borrow the *mental model* of schemas-as-constrained-values.

---

**Aggregated lessons from prior art**:

1. **The contract should be data, not code** (ASL, Argo YAML, GitHub Actions YAML) — so it can be diffed, versioned, shipped across org boundaries, and rendered as a UI.
2. **Dependencies should be explicit, not inferred** (Argo, GitHub Actions `needs`) — because implicit dependencies via data references (ASL) make validation harder.
3. **Each step's I/O should be typed** (Dagster, LangGraph TypedDict) — because the single most-hit pain in workflow systems is "my previous step produced the wrong shape."
4. **Use a schema language already in the ecosystem** (TypeScript + Zod for us) — don't introduce a second toolchain.
5. **Keep an explicit execution-state model** (Temporal's deterministic replay, LangGraph's TypedDict state) — because you want to be able to replay a workflow for audit.
6. **Allow discretionary steps** (CMMN's insight) — because real workflows have "if weird, escalate to human."

---

## 3. Input/Output Schema Approaches

The typed-I/O-at-every-edge conclusion from section 2 pushes the next question: which schema language do we use to type the boundaries? PCC is a TypeScript monorepo, so we're constrained to something that works in the Node/browser runtime without a second compiler pass. The realistic contenders: JSON Schema (via Ajv), Zod, TypeBox, Yup, io-ts.

**PCC already uses Zod in `packages/spec/src/csd/schema.ts`.** I verified this — the CSD schema is built from `z.object`, `z.discriminatedUnion`, `z.enum`, `z.record`, etc. Every CSD parameter (`CsdEnumParamSchema`, `CsdNumberParamSchema`, etc.) is a Zod schema that gets both runtime validation and static TypeScript inference via `z.infer<typeof ...>`. This is the right foundation for PCC because:

1. **Single source of truth**: a Zod schema gives you the runtime validator AND the TypeScript type in one declaration. You don't declare a type and then separately declare a matching JSON Schema — the type *is* the validator.
2. **It matches the rest of the codebase**: Fastify routes in `packages/gateway` validate request bodies with Zod. Adopting a different schema language for workflow steps would create a second validation idiom inside the same repo.
3. **Zod v4 performance is acceptable**: the March-2026 state-of-play is that Zod v4 is roughly 2x faster than v3 in most scenarios and ~20M weekly npm downloads, dominating the TypeScript validation ecosystem. TypeBox+Ajv is measurably faster (JIT-compiled via Ajv) but only matters if you're validating thousands of workflow steps per second, which is not our workload — a contract build happens on the order of once per job. (Source: [PkgPulse Zod vs TypeBox 2026](https://www.pkgpulse.com/blog/zod-vs-typebox-2026), [Better Stack TypeBox vs Zod](https://betterstack.com/community/guides/scaling-nodejs/typebox-vs-zod/).)
4. **Zod composes cleanly with discriminated unions**, which is exactly how we want to model "step type" — a workflow step is one of {DataExtraction, Reconciliation, Transform, Aggregate, HumanReview, ExternalAPICall}, and each variant has its own input/output shape. Zod's `z.discriminatedUnion` gives this directly. `packages/spec/src/csd/schema.ts` already uses `z.discriminatedUnion("type", [...])` for CSD parameter types, so there's a working pattern to copy.

The one place we deviate from pure Zod is for storage. When a workflow contract is serialized to JSON (sent to a kernel, stored in the DB, anchored on-chain), we don't ship Zod schemas — we ship JSON-Schema-compatible shapes or the parsed JSON value. Zod has `.toJSONSchema()` in v4 for exactly this: you author in Zod, serialize to JSON Schema for wire format, and validate on receipt either by re-parsing the JSON Schema with Ajv or by keeping the Zod schema on both ends.

**Verdict**: author workflow step I/O types in Zod (matches existing CSD/contract-builder patterns), serialize to JSON Schema when crossing process boundaries, validate with Zod on both ends. Do not introduce TypeBox, io-ts, Yup, or Protobuf. Do not invent a fourth approach.

A secondary consideration: **should the input/output schema be declared inline in the workflow step, or referenced by URI?** Inline is simpler for small steps; reference is better for steps that share schemas across many contracts (e.g., a `BankStatement` shape used by 40 different accounting workflows). The answer is both. Use the CSD pattern: a `DigitalWorkflowStep.inputSchema` field accepts either an inline Zod/JSON Schema object or a URI like `pcc://schemas/bank-statement/v1` that resolves via the CSD registry. The registry already exists in `packages/spec/src/csd/registry.ts` and supports URI-based lookup. We reuse it.

---

## 4. Dependency Graph Representation

Three main options, each documented in section 2:

- **Explicit `dependsOn: string[]`**, Argo / GitHub Actions `needs` style. Each step declares the IDs of steps it depends on.
- **Implicit via input references**, AWS ASL style. Step B reads `$.StateA.output.result` — the dependency on StateA is inferred.
- **Edge list**, classic graph-library style. A separate `edges: [{from, to}]` array outside the step list.

**Explicit `dependsOn` wins for PCC**, for three reasons:

1. **It matches the existing `CWMStep.dependsOn: Id[]` field.** Look at `packages/spec/src/types/cwm.ts` line 83: `dependsOn: Id[]`. The Capability Workflow Manifest already uses explicit dependencies for physical steps. Using the same pattern for digital steps means a mixed workflow (physical + digital) reads as one graph, not two grafted together. This is the most important reason.
2. **It's what the market has converged on.** Argo, GitHub Actions, CircleCI, Tekton Pipelines, Nextflow (bioinformatics), Snakemake (also bioinformatics) — all use explicit `dependsOn` or `needs`. ASL's implicit-via-references approach is only popular inside AWS and has documented pain (the untyped-data-flow issue cited in section 2). Following market convention reduces the cognitive load for operators and reviewers who already know these systems.
3. **It composes with schemas.** The dependency graph and the data flow are kept orthogonal. Step B says "I depend on step A" (graph edge) and "my input is of type X" (schema). Whether A's output is a subset of X is a separate check, run at contract-build time. This separation is cleaner than ASL's approach where the graph and the schema are both encoded in path references.

One nuance: a single step might depend on multiple upstream steps and need to *join* their outputs. Dagster calls this "fan-in"; LangGraph handles it by having the downstream node read multiple keys from the shared state. For PCC, the pattern is: if step C depends on A and B, step C's input schema must declare named fields for both (e.g., `{aResult: ..., bResult: ...}`), and the runtime engine wires them up by matching names. This is the same pattern as GitHub Actions' `needs.*.outputs.*` accessors. Simple, works.

For branching (conditional execution), the answer is: don't put branching inside a single step. If you need a conditional, express it as two parallel branches where each branch's first step has a different guard condition, and downstream steps depend on whichever branch activated. This keeps each step atomic and easy to verify. Airflow's `BranchPythonOperator` is the cautionary tale here — the complexity of inline branching is where Airflow users hit the most bugs (see airflow/airflow issue tracker, search "branching task not executing").

---

## 5. PCC's Existing Extension Surface — What I Found in the Code

I read the following files end-to-end to figure out where the digital-workflow extension plugs in:

- `C:\Users\globa\physical-capability-cloud\packages\contract-builder\src\builder.ts`
- `C:\Users\globa\physical-capability-cloud\packages\contract-builder\src\validator.ts`
- `C:\Users\globa\physical-capability-cloud\packages\contract-builder\src\templates\index.ts`
- `C:\Users\globa\physical-capability-cloud\packages\contract-builder\src\templates\liquid-handler.ts` (representative)
- `C:\Users\globa\physical-capability-cloud\packages\spec\src\types\contract-builder.ts`
- `C:\Users\globa\physical-capability-cloud\packages\spec\src\types\cwm.ts`
- `C:\Users\globa\physical-capability-cloud\packages\spec\src\csd\schema.ts`

Key observations:

**`BuilderContract` is already the right shape to extend** (line 254-278 of `contract-builder.ts`). It's an interface with: `selections`, `totalPrice`, `priceBreakdown`, `cwmStep`, `validationErrors`, `isValid`, `templateName`, optional `machineInfo`. Every extension we add has to be optional so existing physical contracts keep validating. The fields we'll append: `workflowSteps?`, `digitalTaskType?`, `challenge?`, `digitalCwmStep?`.

**`CWMStep` already has `dependsOn: Id[]`** (line 83 of `cwm.ts`). This means the top-level CWM (Capability Workflow Manifest — what actually gets submitted to the scheduler) already understands dependency graphs. A workflow contract that produces multiple CWMSteps with cross-dependencies will slot into the existing scheduler with no changes to the scheduler logic. The only question is how the contract-builder *produces* those CWMSteps from a `workflowSteps[]` declaration. Answer: the validator loops over `workflowSteps`, produces one CWMStep per workflow step with capability type set to the digital kernel type (e.g., `accounting-reconcile`, `procurement-rfq`), and writes the `dependsOn` array through unchanged. Done.

**`CapabilityType` is an open string union** (line 63 of `capability.js`): `type CapabilityType = BuiltinCapabilityType | (string & {});`. This means we can add `"accounting-reconcile"`, `"procurement-rfq"`, `"legal-clause-extract"`, `"data-extract-pdf"`, `"supply-chain-bom-decompose"`, `"report-generate"` as valid capability types without modifying the builtin enum — and even if we don't modify the enum at all, the string-literal form still type-checks. So the existing `BuilderContract.cwmStep.capability: CapabilityType` field accepts digital capabilities today. No breaking change needed; we just need templates and validators for them.

**`ContractValidator.validate()` is small and clean** (line 28 of `validator.ts`, ~100 lines). It takes the resolved options, the selections, and a tier, and produces a `ValidationResult` with errors plus a `cwmStep`. To extend it, we either (a) add a second method `validateDigitalWorkflow(workflowSteps, selections, assuranceTier)` that produces a list of CWMSteps and a list of workflow-level errors, or (b) add an optional second return branch to `validate()`. Option (a) is cleaner because it keeps the physical path untouched and makes the digital path testable in isolation. I recommend (a).

**The CSD schema in `packages/spec/src/csd/schema.ts` is Zod-native** and uses `z.discriminatedUnion` for parameter types. This is our template for how to type the workflow step variants (DataExtraction, Reconciliation, etc.): extend the CSD schema with a new section `workflowSteps: z.array(z.discriminatedUnion("stepType", [...]))`, or more likely, add a new schema file `packages/spec/src/csd/workflow-schema.ts` that layers on top.

**There's already a `ParamConstraint` + `ParamOverride` machinery** (contract-builder.ts lines 103-174) for cross-parameter dependencies and machine-specific restrictions. This is analogous to what we need for workflow steps: a cross-step constraint (e.g., "if step A's output includes foreign currency, step B must be set to mode=fx-convert") and a "machine profile" analog for digital kernels (e.g., "this kernel only supports reconciliation of USD-denominated ledgers"). We can reuse the existing shape wholesale.

**The template registry in `packages/contract-builder/src/templates/index.ts` is a simple `Map<CapabilityType, CapabilityTemplate>` with register/get helpers.** New digital templates plug in the same way: `registerTemplate(accountingReconcileTemplate)`, etc. Zero refactoring needed.

**Verdict**: the extension points are clean. `BuilderContract` accepts optional workflow fields, the validator grows a second method, the CSD schema grows a workflow-step discriminated union, digital templates register alongside physical templates, digital capability types live in the same open string union as physical ones, and the produced CWMSteps slot into the existing scheduler via `dependsOn`. All additive, all backward-compatible.

---

## 6. Digital Kernel Taxonomy — What to Ship First

Here's the initial set of digital capability kernels I'd recommend PCC ship as templates. For each: typical step count, input shape, output shape, and whether it has deterministic right answers (which determines whether it can be verified via touchstone — a known-answer task used as a quality gate — or whether it requires human or consensus adjudication).

| Kernel | Steps | Inputs (high level) | Outputs (high level) | Deterministic? | Touchstone-friendly? |
|---|---|---|---|---|---|
| `accounting-reconcile` | 4-7 | GL export (CSV/JSON), bank statements (PDF/CSV), mapping rules | `{matched, unmatched, totalVariance, reconciliationReport}` | Yes (given inputs, the matched set is determined by the rules) | Yes — seed with a synthetic ledger+statement pair and check the matched set |
| `accounting-journal-entry` | 2-4 | Source document (invoice, receipt), chart of accounts | `{journalEntry: {debits, credits, date, memo}, confidence}` | Mostly yes (standard account coding) | Yes |
| `accounting-tax-compute` | 3-5 | Transactions, jurisdiction, tax rules reference | `{totalTax, byJurisdiction, lineItems}` | Yes (deterministic given the rules) | Yes |
| `procurement-rfq` | 5-9 | BOM, approved-vendor list, quantity, delivery date | `{quotesReceived: [{vendor, price, leadTime, terms}], recommendation}` | No (vendor responses vary) | Partial — can touchstone the *formatting* of the RFQ, not the responses |
| `procurement-po-generate` | 2-4 | Accepted quote, buyer data, delivery terms | `{purchaseOrder: PurchaseOrderDocument}` | Yes | Yes |
| `legal-clause-extract` | 3-6 | Contract PDF, clause taxonomy | `{extractedClauses: [{type, text, location, risk}]}` | Partial (the taxonomy is deterministic, the matching is LLM-assisted) | Yes — use a known contract + expected clause list |
| `legal-risk-score` | 2-4 | Extracted clauses, risk ruleset | `{overallRisk, perClauseRisk, recommendations}` | Yes (given rules) | Yes |
| `data-extract-pdf` | 3-5 | PDF document, field specification | `{extractedFields: Record<string, unknown>, confidences, pages}` | Partial (LLM-assisted, but can be compared) | Yes — canonical PDF with known fields |
| `data-schema-map` | 2-4 | Source schema, target schema, sample rows | `{mapping: Record<srcField, tgtField>, unmappedFields, transformations}` | Yes (given source+target) | Yes |
| `supply-chain-bom-decompose` | 4-8 | Assembly definition, part catalog | `{bom: [{part, qty, vendor?}], critical path, lead time estimate}` | Yes | Yes |
| `supply-chain-vendor-select` | 3-6 | BOM, vendor scoring rules | `{selectedVendors: [{part, vendor, reason}], alternatives}` | Partial | Partial |
| `report-generate-executive` | 3-7 | Data sources, template, period | `{report: MarkdownOrPdfDoc, keyMetrics, charts}` | No (freeform text) | No — judgment-based |
| `report-generate-compliance` | 4-8 | Data sources, compliance framework (ISO 13485, SOC2, etc.), period | `{report, checklistResults, gaps, remediation}` | Mostly yes (framework is rule-based) | Yes |
| `compliance-alcoa-audit` | 3-5 | Evidence bundle, assurance tier | `{alcoaStatus: ALCOAStatus, passFailByPrinciple, gaps}` | Yes — ALCOA is a 10-principle rule set, already exists in PCC | Yes — this is literally touchstoneable today |
| `doc-translate` | 2-4 | Source doc, target language, glossary | `{translation, glossaryApplied, confidence}` | Partial | Partial — use BLEU or similar |
| `doc-summarize` | 2-3 | Source doc, length target | `{summary, keyPoints}` | No | No |
| `data-dedupe` | 3-5 | Record set, dedup rules | `{deduplicated, duplicatesFound, mergeDecisions}` | Yes | Yes |

**Patterns I see in the table**:

- **Deterministic + touchstoneable** are the easy wins and should be the first shipping kernels. Accounting reconciliation and ALCOA audit are the two strongest candidates because they have rule-based right answers and PCC already has the data surface for ALCOA.
- **Rule-based outputs** (tax compute, PO generate, BOM decompose) are deterministic-enough that disputes can be settled by re-running the rules.
- **LLM-assisted extraction** (clause extract, PDF extract, schema map) are partially deterministic — the extraction can be compared across two workers even if neither is canonically "right."
- **Judgment-based** (executive report, summary) are the hardest to settle via contract and should probably sit outside the automatic-settlement flow. They can still be contracted, but settlement requires human review.

**Shipping order recommendation**: ship accounting-reconcile and compliance-alcoa-audit first, as templates that round-trip through the builder → contract → touchstone check → settlement flow. These are the two where PCC can demonstrate the digital-kernel story end-to-end with the least new infrastructure.

---

## 7. Composition with Physical Workflows

The whole point of keeping digital workflow steps in the same `BuilderContract` / `CWMStep` shape as physical steps is that a mixed workflow reads as one dependency graph. Here's the canonical example:

**Scenario**: "I need a custom CNC-milled aluminum bracket delivered to my lab, and I need the vendor selected via RFP and PO-generated automatically."

Dependency graph:

```
[1] bom-decompose           (digital kernel: supply-chain-bom-decompose)
     inputs: {assemblyDef}
     outputs: {bom: [{part, qty, spec}]}
     dependsOn: []

[2] rfq                     (digital kernel: procurement-rfq)
     inputs: {bom: step[1].outputs.bom, approvedVendors}
     outputs: {quotes, recommendation}
     dependsOn: [1]

[3] po-generate             (digital kernel: procurement-po-generate)
     inputs: {acceptedQuote: step[2].outputs.recommendation}
     outputs: {po: PurchaseOrderDocument}
     dependsOn: [2]

[4] cnc-mill                (physical capability: cnc-3axis)
     inputs: { material, fileHash of the STEP model, toleranceSpec }
     outputs: { evidenceBundleId }
     dependsOn: [3]

[5] inspection              (physical capability: inspection)
     inputs: { partReference: step[4].outputs.evidenceBundleId }
     outputs: { inspectionReport }
     dependsOn: [4]

[6] courier-delivery        (physical capability: courier-delivery)
     inputs: { from: step[4], to: labAddress }
     outputs: { deliveryConfirmation }
     dependsOn: [5]
```

Steps 1-3 are digital workflow steps; steps 4-6 are physical CWMSteps. They compose because:

1. Both share the `dependsOn: Id[]` convention.
2. Both are capabilities — `supply-chain-bom-decompose` is as much a "capability type" as `cnc-3axis` is. They both live in the open `CapabilityType` string union.
3. Both produce `cwmStep` nodes that slot into the CWM that the scheduler dispatches.
4. The scheduler does not need to know the difference. It sees a graph of 6 steps with declared dependencies. It routes each step to a kernel that offers the capability. Digital kernels are kernels that expose digital capabilities — they pass `maxAssuranceTier`, `reputation`, and `evidenceTypes` the same way a physical kernel does.

This is the most important architectural claim in the whole document: **the digital workflow extension adds no new top-level primitives to PCC.** It adds types (workflow step variants, schemas) and it adds templates (digital capability templates), but the orchestration and settlement layers don't change. The CWM, the scheduler, the escrow contract, the evidence bundles — all of them read a digital step the same way they read a physical one.

One nuance: digital kernels' evidence is digital (JSON output, execution trace, hash chain) rather than sensor readings + photos. PCC's `EvidenceBundle` already supports arbitrary `events: [{type, timestamp, payload}]` arrays and `deviceHealth`, so this fits naturally. The `alcoaStatus` check adapts per-kernel: for a digital kernel, "Attributable" means the executing node is signed, "Original" means the output hash matches what the node committed to, "Accurate" means the output validates against the declared output schema. All existing ALCOA slots map cleanly.

---

## 8. Challenge Anchor: Binding a Contract to a Specific Moment

The problem: a validator (or in PCC's case, a requester) needs the worker's execution to be tied to *this contract at this moment*, not a cached execution from last week. The worker should not be able to pre-compute the output, store it, and return it instantly when asked.

PoA's `CanonicalPathContract` solves this with a validator-generated `nonce` that the miner must "reflect" in the evidence bundle. We are deliberately NOT importing that vocabulary. But the underlying problem is real and we need a PCC-native answer. Call the mechanism `challenge` (noun), or more specifically `challengeAnchor`.

Four options:

**Option A: Block hash anchor.** The requester includes `{challenge: {type: "block-hash", chain: "base-sepolia", blockNumber: N, hash: "0x..."}}`. The contract is valid only after block N and the worker must include block N's hash in the evidence bundle. Anyone can verify by looking up block N on a public RPC. Pro: trustless, zero infrastructure (PCC already has RPC access for escrow). Con: precision is limited by block time (2s on Base Sepolia), and it reveals the contract's existence to chain watchers.

**Option B: VRF (verifiable random function).** The requester generates a random `challengeValue` with a VRF keypair and includes `{challenge: {type: "vrf", value, proof}}`. The worker reflects `challengeValue` in the output. Anyone with the VRF public key can verify. Pro: precise, no chain lookup. Con: requires VRF infrastructure that PCC doesn't have today; adds a new primitive.

**Option C: Commit-reveal via Pedersen commitment.** The requester commits to a random value via Pedersen commitment at contract issuance, the worker completes the job, and then the requester reveals the value. The worker must have included the commitment in their work trace. Pro: zero-knowledge-friendly, composes with PCC's existing Starknet ZK story. Con: two-phase protocol (commit at issuance, reveal at settlement), which adds timing complexity.

**Option D: Signed nonce from validator identity.** The requester (or their delegated validator) signs a random value with their Ed25519 identity key (PCC's `packages/spec/src/identity/`), and the signature is the challenge. The worker must include both the value and the signature in the evidence. Verification is cheap (one Ed25519 verify). Pro: uses existing PCC identity infrastructure, no new primitives. Con: relies on the requester's private key not leaking — but that's already true of everything else in PCC's identity layer.

**Pick Option D**: signed nonce from the issuing identity. Reasons: (1) zero new infrastructure, since every PCC agent already has an Ed25519 keypair via ERC-8004 registration; (2) verification is a single signature check that fits in the existing evidence validator path; (3) it ties the challenge directly to the issuing identity, so you get accountability "who issued this challenge" for free; (4) it doesn't leak contract existence to chain watchers or require RPC calls to verify.

Shape of the `challenge` field:

```
challenge: {
  type: "signed-nonce",
  nonce: "32-byte random value, base64",
  issuerDid: "did:pcc:operator:0x...",
  signature: "ed25519 signature over nonce, base64",
  issuedAt: "ISO timestamp"
}
```

The worker's digital evidence bundle must include a `reflectedChallenge` field echoing the nonce. The verifier checks: (a) signature valid for issuerDid, (b) nonce present in reflectedChallenge, (c) issuedAt within the contract's valid window (default: 15 minutes), (d) contract not already consumed (one-shot — the nonce is logged in a bloom filter at settlement time to prevent replay across contracts).

Replay protection across requesters: the bloom filter is keyed on `(nonce, issuerDid)` so two different requesters can't generate colliding nonces and confuse the system. The cost is one bloom-filter lookup at settlement, which is negligible.

**We do NOT call this concept a "canary" or a "canonical path contract."** We call it a *challenge anchor* or *signed nonce challenge*. The file that hosts the types is `packages/spec/src/types/challenge.ts`. The verification logic lives alongside the existing evidence verifier.

---

## 9. Concrete TypeScript Sketch

Here are the exact types to add to `packages/spec/src/types/digital-workflow.ts`. Zod schemas first, inferred types second.

```typescript
/**
 * Digital Workflow Contract Extensions for BuilderContract
 *
 * Adds typed workflow-step semantics for digital capability kernels
 * (accounting, procurement, legal review, data extraction, etc.)
 * without forking the existing physical-first BuilderContract type.
 *
 * Composes with packages/spec/src/types/cwm.ts (CWMStep.dependsOn) and
 * packages/spec/src/csd/schema.ts (Zod-based schema patterns).
 */

import { z } from "zod";
import type { Id, Timestamp } from "./common.js";
import type { CapabilityType } from "./capability.js";

// ── Schema Reference ───────────────────────────────────────────────

/**
 * A workflow step's input or output schema. Either:
 * - inline JSON Schema object (authored from Zod via z.toJSONSchema)
 * - URI reference resolved via the CSD registry
 */
export const WorkflowStepSchemaSchema = z.union([
  z.object({
    kind: z.literal("inline"),
    schema: z.record(z.unknown()), // JSON Schema 2020-12 compatible
  }),
  z.object({
    kind: z.literal("uri"),
    uri: z.string().min(1), // e.g. "pcc://schemas/bank-statement/v1"
  }),
]);

export type WorkflowStepSchema = z.infer<typeof WorkflowStepSchemaSchema>;

// ── Digital Workflow Step ──────────────────────────────────────────

/**
 * A single step in a digital workflow. Same shape as CWMStep for physical
 * work, but with explicit input/output schemas and a stepType discriminator.
 *
 * stepType values are open-ended to match CapabilityType's open string union —
 * custom kernels can register new stepTypes without modifying the core.
 */
export const DigitalWorkflowStepSchema = z.object({
  /** Unique identifier within this contract */
  stepId: z.string().min(1),
  /**
   * Type of digital operation. Matches CapabilityType string values for
   * digital kernels, e.g. "accounting-reconcile", "procurement-rfq",
   * "legal-clause-extract", "data-extract-pdf".
   */
  stepType: z.string().min(1),
  /** Human-readable description for auditors and disputes */
  description: z.string(),
  /** Schema the step's input must validate against */
  inputSchema: WorkflowStepSchemaSchema,
  /** Schema the step's output must validate against */
  outputSchema: WorkflowStepSchemaSchema,
  /**
   * IDs of steps that must complete before this one.
   * Matches CWMStep.dependsOn convention so mixed (digital+physical)
   * workflows compose in a single DAG.
   */
  dependsOn: z.array(z.string()).default([]),
  /** Step-specific constraints (model choice, max tokens, timeouts) */
  constraints: z.record(z.unknown()).default({}),
  /** Estimated duration in seconds — hint for scheduling */
  estimatedDurationSec: z.number().int().positive().optional(),
  /** Maximum price for this step, if rate-limited */
  maxPrice: z.string().optional(),
  /** Preferred digital kernel ID */
  preferredKernel: z.string().optional(),
});

export type DigitalWorkflowStep = z.infer<typeof DigitalWorkflowStepSchema>;

// ── Challenge Anchor ───────────────────────────────────────────────

/**
 * A signed-nonce challenge anchor binding a contract instance to a specific
 * moment and a specific issuing identity. Prevents replay of cached executions.
 *
 * The worker's evidence must include reflectedChallenge echoing the nonce,
 * and the verifier checks signature + freshness at settlement time.
 *
 * Intentionally named "challenge" — not "canary" or "CPC" — to avoid
 * namespace collision with PoA's CanonicalPathContract vocabulary.
 */
export const ChallengeAnchorSchema = z.object({
  type: z.literal("signed-nonce"),
  /** 32-byte random value, base64url */
  nonce: z.string().min(1),
  /** Issuing agent's DID (ERC-8004 identity) */
  issuerDid: z.string().min(1),
  /** Ed25519 signature over nonce, base64url */
  signature: z.string().min(1),
  /** ISO timestamp of issuance */
  issuedAt: z.string(),
  /** Validity window in seconds (default 900 = 15 min) */
  validWindowSec: z.number().int().positive().default(900),
});

export type ChallengeAnchor = z.infer<typeof ChallengeAnchorSchema>;

// ── BuilderContract Extension ──────────────────────────────────────

/**
 * Additive extension to BuilderContract (packages/spec/src/types/contract-builder.ts).
 * All fields are OPTIONAL — existing physical contracts continue to validate.
 *
 * Usage:
 *   interface BuilderContract {
 *     // ...existing physical fields...
 *     workflowSteps?: DigitalWorkflowStep[];
 *     digitalTaskType?: CapabilityType;  // when the top-level task is digital
 *     challenge?: ChallengeAnchor;
 *     digitalCwmSteps?: CWMStep[];  // expanded CWMStep list if workflowSteps present
 *   }
 */
export interface DigitalWorkflowExtension {
  /**
   * Typed DAG of digital workflow steps. When present, validator emits
   * one CWMStep per workflow step into digitalCwmSteps, preserving dependsOn.
   */
  workflowSteps?: DigitalWorkflowStep[];
  /**
   * Top-level digital task type. Used for touchstone routing — the template
   * knows which known-answer input to seed. Leave undefined for pure physical.
   */
  digitalTaskType?: CapabilityType;
  /** Signed-nonce challenge anchor — required for touchstone-graded contracts */
  challenge?: ChallengeAnchor;
  /**
   * CWMSteps produced from workflowSteps. One step per workflowStep, dependsOn
   * mapped through unchanged, capability set to the digital kernel type.
   * Populated by the extended validator; undefined if no workflowSteps given.
   */
  digitalCwmSteps?: unknown[]; // imported CWMStep from cwm.ts at implementation time
}
```

That's roughly 100 lines of Zod schemas + JSDoc plus the `DigitalWorkflowExtension` interface. At implementation time, `BuilderContract` in `contract-builder.ts` gets `extends DigitalWorkflowExtension` or has the three fields spread inline — both are backward-compatible since every added field is optional.

---

## 10. Known Failure Modes from Prior Art

Cataloging the documented ways workflow-contract systems fail in production, so we can watch for them.

**BPMN/Camunda: type mismatch between diagram and runtime.** Users repeatedly hit "the BPMN diagram says the variable is an integer, but the Java code produces a string." Camunda docs have extensive treatment of typed vs untyped variables; search "Camunda typed variable value" on docs and forum. Mitigation for PCC: there is no separate diagram artifact — the Zod schema *is* the diagram and the runtime validator, produced from one source.

**Temporal: versioning and long-running workflows.** Temporal's worker-versioning feature is explicitly "optimized for short-running workflows" (Temporal 2026 docs on worker versioning: [temporal.io/blog/announcing-worker-versioning](https://temporal.io/blog/announcing-worker-versioning-public-preview-pin-workflows-to-a-single-code)). Long-running workflows block version drainage — a workflow started on build N keeps a worker pinned to build N, and you can't retire build N until that workflow finishes. Mitigation for PCC: workflow contracts are short-lived (hours to days) and the "runtime" is not PCC's problem — the operator runs it however they want. PCC only needs to verify the contract's outputs, not manage worker versions across months.

**AWS Step Functions: silent schema drift between states.** The most-upvoted complaint about ASL is that untyped JSON flows between states and errors surface only when a downstream state receives the wrong shape. Mitigation: type every boundary. PCC's `inputSchema` / `outputSchema` fields on `DigitalWorkflowStep` are non-optional.

**Argo Workflows: output parameter confusion.** Argo users repeatedly ask "why is my template's output empty" — the answer is usually that `valueFrom` wasn't configured right, or the file path for artifact output was wrong. See argoproj/argo-workflows docs on outputs and issues tagged "kind/question". Mitigation: for PCC, outputs are explicit typed values, not filesystem artifacts. An operator can choose to serialize intermediate outputs to files, but the contract-visible output is the typed JSON object.

**GitHub Actions: stringly-typed outputs.** GitHub Actions issue [#28146](https://github.com/orgs/community/discussions/28146) (approximated; Actions has many open issues requesting structured job outputs) documents the pain of JSON-stringified job outputs. Users stringify, pass, parse, re-stringify, lose newlines, escape quotes, etc. Mitigation: same as Step Functions — typed boundaries.

**Airflow: branching operator bugs.** Airflow's `BranchPythonOperator` is a frequent source of "my task didn't run" bugs because the branching logic interacts subtly with task skipping. The lesson is don't put conditionals inside steps. Mitigation: PCC's workflow-step model has no conditional construct inside a step; conditional paths are separate parallel branches with guards.

**Dagster: dynamic output confusion.** Dagster's dynamic output feature (a step emits N outputs known only at runtime) is documented as one of the harder-to-learn parts of the framework. Mitigation: PCC's workflow steps have static step counts. If you need to process N items, use a "foreach" step type with an explicit `items` input and a single `results[]` output, not a dynamic fan-out.

**LangGraph: silent node failures.** LangGraph's state-based execution can result in a node returning an unchanged state dict with no error, and the next node running against stale data. Community reports on langchain-ai/langgraph issue tracker document "node failed silently" patterns. Mitigation: PCC requires every workflow step to produce an output that validates against the declared output schema; a step that wants to signal failure must produce a typed error output (e.g., `{status: "error", error: {...}}`), not a silent pass-through.

**Generic pattern across all systems: schema evolution.** Once contracts are in production, the schema changes. Workers and requesters end up on different versions. The only systems that handle this gracefully are ones that version the schema explicitly (Protobuf's field numbers, gRPC's forward/backward compatibility rules, JSON Schema with `$ref` and version-pinned URIs). Mitigation for PCC: every `inputSchema` / `outputSchema` URI reference includes a version segment (`pcc://schemas/bank-statement/v1`), and the CSD registry's `baseDefinition` field lets new versions inherit from old ones. Breaking changes bump the major version in the URI.

---

## 11. Concrete Extension to BuilderContract — Files, Types, Migration

### Files to create

1. **`packages/spec/src/types/digital-workflow.ts`** (new)
   - Export `DigitalWorkflowStepSchema`, `DigitalWorkflowStep`, `WorkflowStepSchemaSchema`, `WorkflowStepSchema`, `ChallengeAnchorSchema`, `ChallengeAnchor`, `DigitalWorkflowExtension`.
   - ~150 lines including JSDoc.

2. **`packages/spec/src/types/index.ts`** (modify)
   - Add `export * from "./digital-workflow.js";` alongside existing exports.

3. **`packages/spec/src/types/contract-builder.ts`** (modify)
   - Extend `BuilderContract` interface with optional fields:
     ```typescript
     import type {
       DigitalWorkflowStep,
       ChallengeAnchor,
     } from "./digital-workflow.js";
     import type { CWMStep } from "./cwm.js";

     export interface BuilderContract {
       // ... existing fields unchanged ...
       workflowSteps?: DigitalWorkflowStep[];
       digitalTaskType?: CapabilityType;
       challenge?: ChallengeAnchor;
       digitalCwmSteps?: CWMStep[];
     }
     ```

4. **`packages/contract-builder/src/digital-workflow-validator.ts`** (new)
   - Export `DigitalWorkflowValidator` class with a `validateWorkflow(steps, selections, assuranceTier, challenge?)` method.
   - Produces one `CWMStep` per workflow step, preserving `dependsOn`.
   - Validates: (a) unique stepIds, (b) dependsOn references resolve to known stepIds, (c) no cycles in the DAG (topological sort passes), (d) each step's declared inputSchema/outputSchema parses cleanly, (e) if `challenge` provided, signature verification passes.
   - ~200 lines.

5. **`packages/contract-builder/src/templates/accounting-reconcile.ts`** (new)
   - First digital template. CapabilityType = `"accounting-reconcile"`.
   - Parameters: `ledgerSource`, `statementSource`, `matchingStrategy` (enum: strict/fuzzy/ml-assisted), `currencyCode`, `periodStart`, `periodEnd`.
   - Sample output: `workflowSteps = [{stepId: "parse-ledger", ...}, {stepId: "parse-statement", ...}, {stepId: "match", ..., dependsOn: ["parse-ledger", "parse-statement"]}, {stepId: "report", ..., dependsOn: ["match"]}]`.
   - ~150 lines.

6. **`packages/contract-builder/src/templates/compliance-alcoa-audit.ts`** (new)
   - Second digital template. CapabilityType = `"compliance-alcoa-audit"`.
   - Parameters: `evidenceBundleId`, `assuranceTier`, `framework` (optional).
   - Sample workflow steps: one per ALCOA principle (10 steps in parallel), one aggregation step depending on all 10.
   - ~120 lines.

7. **`packages/contract-builder/src/templates/index.ts`** (modify)
   - Add `registerTemplate(accountingReconcileTemplate);` and `registerTemplate(complianceAlcoaAuditTemplate);`

8. **`packages/contract-builder/src/builder.ts`** (modify)
   - Extend `ContractBuilder.buildContract()` to detect when the template has a `workflowSteps` generator and, if so, call `DigitalWorkflowValidator.validateWorkflow()` alongside the existing `ContractValidator.validate()`. The existing flow for physical templates is untouched.
   - Add a sibling method `buildDigitalContract(capabilityType, selections, assuranceTier, challenge?)` that returns a `BuilderContract` with `workflowSteps`, `digitalTaskType`, `challenge`, and `digitalCwmSteps` populated.

9. **`packages/spec/src/__tests__/digital-workflow.test.ts`** (new)
   - Tests for schema round-tripping, cycle detection, DAG validation, challenge signature verification.
   - ~300 lines.

10. **`packages/contract-builder/src/__tests__/digital-workflow-validator.test.ts`** (new)
    - Tests for `buildDigitalContract()` against the two new templates.
    - ~250 lines.

### Tests that continue to pass unchanged

- All existing `contract-builder/src/__tests__/*.test.ts` files. The physical-contract path is untouched.
- All existing `spec/src/__tests__/*.test.ts` files. The `BuilderContract` interface only gains optional fields.

### Migration path

**Phase 1 (types)**: merge the new `digital-workflow.ts` file and the interface extension. Nothing in the runtime changes; only the type surface. Ships silently with no API changes.

**Phase 2 (validator)**: merge `DigitalWorkflowValidator` and the `buildDigitalContract` method on `ContractBuilder`. Add Zod-only tests. No new HTTP endpoints yet.

**Phase 3 (templates)**: merge `accounting-reconcile` and `compliance-alcoa-audit` templates. Register them. Contract builder now answers to `buildDigitalContract("accounting-reconcile", selections, 1)`. Still no HTTP exposure.

**Phase 4 (gateway)**: add a new endpoint `POST /api/build/digital-contract` that wraps `buildDigitalContract`. The existing `/api/build/contract` endpoint continues to serve physical contracts. Either endpoint can be called depending on the client's needs.

**Phase 5 (settlement)**: teach the evidence verifier to recognize digital evidence bundles (JSON outputs that must validate against the contract's declared output schemas) and the challenge-anchor verification step. This is the first point where existing infrastructure is modified, and it's done behind a feature flag so physical evidence flows are not affected.

**Phase 6 (kernels)**: publish the digital-kernel adapter interface so operators can run digital-capability kernels (e.g., an accounting-reconcile kernel implemented as a Node service that reads from a Postgres ledger). Kernels register with `POST /api/kernels` as before, just with `capabilities: ["accounting-reconcile"]` instead of `["cnc-3axis"]`.

### Backward compatibility

Every change is additive. A client that builds only physical contracts sees no change. A client that builds a digital contract gets the new fields populated. A client that mixes them in one CWM gets a graph where digital and physical steps coexist via the shared `dependsOn` convention.

The naming is strictly PCC-native: **workflow step**, **digital workflow contract**, **challenge anchor**, **signed-nonce challenge**, **touchstone task**. No "canary," no "CPC," no "canonical path contract."

---

## 12. Summary

The digital-workflow extension to `BuilderContract` turns PCC from "AWS for physical manufacturing" into "AWS for physical + digital capabilities," and does it without forking the contract type, without new orchestration primitives, and without borrowing vocabulary from PoA's Bittensor subnet.

The three claims that matter:

1. **Typed DAGs beat prompts for agent-to-agent delegation** because they produce mechanically verifiable execution boundaries. This is the same reason FHIR StructureDefinition beat free-text discharge summaries.
2. **The existing PCC surface absorbs the extension cleanly.** `CWMStep.dependsOn` already exists, `CapabilityType` is an open string union, the CSD schema is already Zod, the validator is small and clean to extend. Every change is additive.
3. **The first two kernels to ship** are `accounting-reconcile` and `compliance-alcoa-audit` — both deterministic, both touchstoneable, both demonstrable end-to-end.

If the physical-capability cloud already works, the digital-capability cloud is a week of focused work on top of it, not a rewrite.

---

**Sources**:

- [Zod vs TypeBox 2026: Runtime vs Compile-Time Validation (PkgPulse)](https://www.pkgpulse.com/blog/zod-vs-typebox-2026)
- [TypeBox vs Zod (Better Stack Community)](https://betterstack.com/community/guides/scaling-nodejs/typebox-vs-zod/)
- [io-ts vs Zod in TypeScript (Dev Genius)](https://blog.devgenius.io/io-ts-vs-zod-in-typescript-which-validation-library-should-you-choose-440411b378d2)
- [TypeScript Runtime Validator Performance Benchmark (Dev.to / moltar)](https://github.com/moltar/typescript-runtime-type-benchmarks)
- [Announcing Worker Versioning Public Preview (Temporal blog)](https://temporal.io/blog/announcing-worker-versioning-public-preview-pin-workflows-to-a-single-code)
- [Worker Versioning docs (Temporal)](https://docs.temporal.io/production-deployment/worker-deployments/worker-versioning)
- [temporalio/temporal GitHub releases](https://github.com/temporalio/temporal/releases)
- Provenonce PoA CPC (read-only reference): `C:\Users\globa\scratch\poa-subnet\protocol\cpc.py`
- PCC contract builder (extension target): `C:\Users\globa\physical-capability-cloud\packages\contract-builder\src\`
- PCC spec/CSD (schema foundation): `C:\Users\globa\physical-capability-cloud\packages\spec\src\csd\schema.ts`
- PCC CWM types (dependency graph foundation): `C:\Users\globa\physical-capability-cloud\packages\spec\src\types\cwm.ts`
- PCC capability types (open string union): `C:\Users\globa\physical-capability-cloud\packages\spec\src\types\capability.ts`

