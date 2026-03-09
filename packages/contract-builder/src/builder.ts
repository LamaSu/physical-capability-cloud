/**
 * ContractBuilder — main API class composing resolver + pricing + validator.
 *
 * Usage:
 *   const builder = new ContractBuilder();
 *   const options = builder.getBuildOptions("fdm", {}, profileId);
 *   const price = builder.calculatePrice("fdm", selections, profileId);
 *   const contract = builder.buildContract("fdm", selections, 1, profileId);
 */

import type {
  CapabilityType,
  ResolvedBuildOptions,
  BuilderContract,
  MachineProfile,
} from "@pcc/spec";
import { getTemplate } from "./templates/index.js";
import { getProfile, registerProfile as regProfile, getProfilesForKernel } from "./profiles/index.js";
import { TemplateResolver } from "./resolver.js";
import { PricingCalculator, type PricingResult } from "./pricing.js";
import { ContractValidator } from "./validator.js";

export class ContractBuilder {
  private resolver = new TemplateResolver();
  private pricing = new PricingCalculator();
  private validator = new ContractValidator();

  /**
   * Get the full resolved build options for a capability type.
   * Optionally applies a machine profile and current selections to resolve constraints.
   */
  getBuildOptions(
    capabilityType: CapabilityType,
    selections: Record<string, unknown> = {},
    profileId?: string,
  ): ResolvedBuildOptions {
    const template = getTemplate(capabilityType);
    if (!template) {
      throw new Error(`No template registered for capability type: ${capabilityType}`);
    }

    const profile = profileId ? getProfile(profileId) : undefined;
    return this.resolver.resolve(template, selections, profile);
  }

  /**
   * Calculate the price for current selections.
   */
  calculatePrice(
    capabilityType: CapabilityType,
    selections: Record<string, unknown>,
    profileId?: string,
  ): PricingResult {
    const options = this.getBuildOptions(capabilityType, selections, profileId);
    return this.pricing.calculate(options, selections);
  }

  /**
   * Build a complete, validated contract from selections.
   */
  buildContract(
    capabilityType: CapabilityType,
    selections: Record<string, unknown>,
    assuranceTier: number = 1,
    profileId?: string,
  ): BuilderContract {
    const options = this.getBuildOptions(capabilityType, selections, profileId);
    const pricingResult = this.pricing.calculate(options, selections);
    const validationResult = this.validator.validate(options, selections, assuranceTier);

    return {
      selections: selections as Record<string, string | number | boolean | string[]>,
      totalPrice: pricingResult.totalPrice.toFixed(2),
      priceBreakdown: pricingResult.breakdown,
      cwmStep: validationResult.cwmStep,
      validationErrors: validationResult.errors,
      isValid: validationResult.isValid,
      templateName: options.templateName,
      machineInfo: options.machineInfo,
    };
  }

  /**
   * Register a machine profile.
   */
  registerProfile(profile: MachineProfile): void {
    regProfile(profile);
  }

  /**
   * Get profiles available for a specific kernel.
   */
  getKernelProfiles(kernelId: string): MachineProfile[] {
    return getProfilesForKernel(kernelId);
  }
}
