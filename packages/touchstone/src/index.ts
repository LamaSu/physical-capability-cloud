/**
 * @pcc/touchstone — Statistical enforcement via injected known-answer tasks.
 *
 * @packageDocumentation
 */

// Types
export type {
  VerificationMethod,
  WorkflowStep,
  TouchstoneTask,
  TouchstoneResult,
  TouchstoneLibrary,
  TouchstoneSampler,
  TouchstoneConfig,
} from "./types.js";

// Sampler
export { BernoulliSampler } from "./sampler.js";
export type { SamplerStats } from "./sampler.js";

// Verifiers
export { verifyExactMatch } from "./verifier-exact.js";
export { verifySchemaMatch } from "./verifier-schema.js";
export type { SchemaValidationOutcome, SchemaValidator } from "./verifier-schema.js";
export {
  verifyLLMJudge,
  MockJudgeClient,
  ClaudeJudgeClient,
  buildJudgePrompt,
  parseJudgeVerdict,
} from "./verifier-judge.js";
export type {
  JudgeClient,
  JudgeRequest,
  JudgeVerdict,
  VerifyLLMJudgeOptions,
  MockJudgeScript,
  MockJudgeClientOptions,
  ClaudeJudgeClientOptions,
} from "./verifier-judge.js";

// Reputation hook
export { emitTouchstoneFeedback } from "./reputation-hook.js";

// Libraries
export { accountingLibrary } from "./library/accounting.js";
export { procurementLibrary } from "./library/procurement.js";
