// BabelPCC compiler
export { BabelPCC } from "./babel-pcc/index.js";
export type { CompileOptions, CompileResult } from "./babel-pcc/index.js";
export { InterfaceGenerator, generateInterface, deriveTypeName } from "./babel-pcc/index.js";
export { ValidatorGenerator, generateValidator } from "./babel-pcc/index.js";
export { PricingGenerator, generatePricing } from "./babel-pcc/index.js";
export { TestDataGenerator, generateTestData } from "./babel-pcc/index.js";

// Public API
export { ContractBuilder } from "./builder.js";
export { TemplateResolver } from "./resolver.js";
export { PricingCalculator } from "./pricing.js";
export type { PricingResult } from "./pricing.js";
export { ContractValidator } from "./validator.js";
export type { ValidationResult } from "./validator.js";

// CSD constraint engine
export { CsdConstraintEvaluator } from "./csd-evaluator.js";
export type { EvaluationResult, EvaluationError, ParamRestriction } from "./csd-evaluator.js";

// CSD invariant evaluator
export { CsdInvariantEvaluator } from "./csd-invariant-evaluator.js";

// CSD-aware resolver
export { CsdResolver } from "./csd-resolver.js";
export type { ResolvedCsd, ResolvedCsdParameter, CsdPricingResult, CsdValidationResult } from "./csd-resolver.js";

// Template registry
export {
  registerTemplate,
  getTemplate,
  getAllTemplates,
  getRegisteredTypes,
} from "./templates/index.js";

// Profile registry
export {
  registerProfile,
  getProfile,
  getProfilesForType,
  getProfilesForKernel,
  getAllProfiles,
} from "./profiles/index.js";

// Built-in templates
export { fdmTemplate } from "./templates/fdm.js";
export { slaTemplate } from "./templates/sla.js";
export { cnc3AxisTemplate } from "./templates/cnc-3axis.js";
export { laserCutTemplate } from "./templates/laser-cut.js";

// Digital workflow templates
export {
  accountingReconcileTemplate,
  accountingReconcileWorkflowSteps,
} from "./templates/digital/index.js";

// Built-in profiles
export { prusaMk4Profile } from "./profiles/prusa-mk4.js";
export { haasVf2Profile } from "./profiles/haas-vf2.js";
