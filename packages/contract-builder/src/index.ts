// Public API
export { ContractBuilder } from "./builder.js";
export { TemplateResolver } from "./resolver.js";
export { PricingCalculator } from "./pricing.js";
export type { PricingResult } from "./pricing.js";
export { ContractValidator } from "./validator.js";
export type { ValidationResult } from "./validator.js";

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

// Built-in profiles
export { prusaMk4Profile } from "./profiles/prusa-mk4.js";
export { haasVf2Profile } from "./profiles/haas-vf2.js";
