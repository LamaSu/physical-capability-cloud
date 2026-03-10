import { create } from "zustand";
import type {
  CapabilityTemplate,
  MachineProfile,
  ParamDef,
  EnumParamDef,
  NumberParamDef,
  BooleanParamDef,
  ParamConstraint,
  PricingImpact,
  EnumOption,
} from "@pcc/spec";
import { registerTemplate, registerProfile } from "@pcc/contract-builder";

// ── Draft types for the wizard ───────────────────────────────────────

export interface ParamOptionDraft {
  value: string;
  label: string;
  pricingPercent?: string;
}

export interface ParamDraft {
  id: string;
  type: "enum" | "number" | "boolean";
  key: string;
  label: string;
  group: string;
  required: boolean;
  description: string;
  /** For enum */
  options: ParamOptionDraft[];
  /** For number */
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  /** Default value */
  defaultValue?: string | number | boolean;
  /** Boolean pricing impact percent */
  booleanPricingPercent?: string;
}

export interface ConstraintDraft {
  id: string;
  whenParam: string;
  whenEquals: string;
  thenParam: string;
  action: "restrictTo" | "exclude";
  values: string[];
}

// ── Store state ──────────────────────────────────────────────────────

interface DeviceBuilderState {
  step: number;

  // Step 1: Device
  deviceName: string;
  capabilityType: string;
  manufacturer: string;
  model: string;
  description: string;

  // Step 2: Parameters
  params: ParamDraft[];

  // Step 3: Pricing
  basePrice: string;
  currency: string;
  perUnitLabel: string;

  // Step 4: Constraints
  constraints: ConstraintDraft[];

  // Step 5: Generated output
  generatedTemplate: CapabilityTemplate | null;
  generatedProfile: MachineProfile | null;
  registered: boolean;

  // Actions
  setStep: (step: number) => void;
  nextStep: () => void;
  prevStep: () => void;
  updateDevice: (fields: Partial<{ deviceName: string; capabilityType: string; manufacturer: string; model: string; description: string }>) => void;
  addParam: () => void;
  updateParam: (id: string, fields: Partial<ParamDraft>) => void;
  removeParam: (id: string) => void;
  addParamOption: (paramId: string) => void;
  updateParamOption: (paramId: string, index: number, fields: Partial<ParamOptionDraft>) => void;
  removeParamOption: (paramId: string, index: number) => void;
  setPricing: (fields: Partial<{ basePrice: string; currency: string; perUnitLabel: string }>) => void;
  addConstraint: () => void;
  updateConstraint: (id: string, fields: Partial<ConstraintDraft>) => void;
  removeConstraint: (id: string) => void;
  generate: () => void;
  register: () => void;
  reset: () => void;
  isStepValid: (step: number) => boolean;
}

const TOTAL_STEPS = 5;

let draftCounter = 0;
function nextId(prefix: string): string {
  return `${prefix}_${Date.now()}_${++draftCounter}`;
}

function buildParamDef(draft: ParamDraft, order: number): ParamDef {
  const base = {
    key: draft.key,
    label: draft.label,
    description: draft.description || undefined,
    required: draft.required,
    order,
    group: draft.group || "General",
  };

  if (draft.type === "enum") {
    const options: EnumOption[] = draft.options.map((o) => {
      const opt: EnumOption = { value: o.value, label: o.label };
      if (o.pricingPercent && parseFloat(o.pricingPercent) !== 0) {
        opt.pricingImpact = {
          mode: "percent",
          value: o.pricingPercent,
          label: `+${o.pricingPercent}%`,
        };
      }
      return opt;
    });
    const def: EnumParamDef = {
      ...base,
      type: "enum",
      options,
    };
    if (draft.defaultValue !== undefined && draft.defaultValue !== "") {
      def.defaultValue = String(draft.defaultValue);
    }
    return def;
  }

  if (draft.type === "number") {
    const def: NumberParamDef = {
      ...base,
      type: "number",
      min: draft.min ?? 0,
      max: draft.max ?? 100,
      step: draft.step ?? 1,
      unit: draft.unit || undefined,
    };
    if (draft.defaultValue !== undefined && draft.defaultValue !== "") {
      def.defaultValue = Number(draft.defaultValue);
    }
    return def;
  }

  // boolean
  const def: BooleanParamDef = {
    ...base,
    type: "boolean",
  };
  if (draft.defaultValue !== undefined && draft.defaultValue !== "") {
    def.defaultValue = Boolean(draft.defaultValue);
  }
  if (draft.booleanPricingPercent && parseFloat(draft.booleanPricingPercent) !== 0) {
    def.pricingImpact = {
      mode: "percent",
      value: draft.booleanPricingPercent,
      label: `+${draft.booleanPricingPercent}% when enabled`,
    } satisfies PricingImpact;
  }
  return def;
}

function buildConstraint(draft: ConstraintDraft): ParamConstraint {
  const action: ParamConstraint["then"][number] = { param: draft.thenParam };
  if (draft.action === "restrictTo") {
    action.restrictTo = draft.values;
  } else {
    action.exclude = draft.values;
  }
  return {
    when: { param: draft.whenParam, equals: draft.whenEquals },
    then: [action],
  };
}

export const useDeviceBuilderStore = create<DeviceBuilderState>((set, get) => ({
  step: 0,

  // Step 1
  deviceName: "",
  capabilityType: "",
  manufacturer: "",
  model: "",
  description: "",

  // Step 2
  params: [],

  // Step 3
  basePrice: "15.00",
  currency: "USDC",
  perUnitLabel: "per part",

  // Step 4
  constraints: [],

  // Step 5
  generatedTemplate: null,
  generatedProfile: null,
  registered: false,

  // ── Navigation ──

  setStep: (step) => set({ step: Math.max(0, Math.min(TOTAL_STEPS - 1, step)) }),
  nextStep: () => set((s) => ({ step: Math.min(TOTAL_STEPS - 1, s.step + 1) })),
  prevStep: () => set((s) => ({ step: Math.max(0, s.step - 1) })),

  // ── Step 1: Device ──

  updateDevice: (fields) => set((s) => ({
    deviceName: fields.deviceName ?? s.deviceName,
    capabilityType: fields.capabilityType ?? s.capabilityType,
    manufacturer: fields.manufacturer ?? s.manufacturer,
    model: fields.model ?? s.model,
    description: fields.description ?? s.description,
  })),

  // ── Step 2: Parameters ──

  addParam: () => set((s) => ({
    params: [
      ...s.params,
      {
        id: nextId("param"),
        type: "enum",
        key: "",
        label: "",
        group: "General",
        required: true,
        description: "",
        options: [{ value: "", label: "" }],
        defaultValue: undefined,
      },
    ],
  })),

  updateParam: (id, fields) => set((s) => ({
    params: s.params.map((p) => (p.id === id ? { ...p, ...fields } : p)),
  })),

  removeParam: (id) => set((s) => ({
    params: s.params.filter((p) => p.id !== id),
  })),

  addParamOption: (paramId) => set((s) => ({
    params: s.params.map((p) =>
      p.id === paramId
        ? { ...p, options: [...p.options, { value: "", label: "" }] }
        : p,
    ),
  })),

  updateParamOption: (paramId, index, fields) => set((s) => ({
    params: s.params.map((p) =>
      p.id === paramId
        ? {
            ...p,
            options: p.options.map((o, i) =>
              i === index ? { ...o, ...fields } : o,
            ),
          }
        : p,
    ),
  })),

  removeParamOption: (paramId, index) => set((s) => ({
    params: s.params.map((p) =>
      p.id === paramId
        ? { ...p, options: p.options.filter((_, i) => i !== index) }
        : p,
    ),
  })),

  // ── Step 3: Pricing ──

  setPricing: (fields) => set((s) => ({
    basePrice: fields.basePrice ?? s.basePrice,
    currency: fields.currency ?? s.currency,
    perUnitLabel: fields.perUnitLabel ?? s.perUnitLabel,
  })),

  // ── Step 4: Constraints ──

  addConstraint: () => set((s) => ({
    constraints: [
      ...s.constraints,
      {
        id: nextId("constraint"),
        whenParam: "",
        whenEquals: "",
        thenParam: "",
        action: "restrictTo",
        values: [],
      },
    ],
  })),

  updateConstraint: (id, fields) => set((s) => ({
    constraints: s.constraints.map((c) =>
      c.id === id ? { ...c, ...fields } : c,
    ),
  })),

  removeConstraint: (id) => set((s) => ({
    constraints: s.constraints.filter((c) => c.id !== id),
  })),

  // ── Step 5: Generate & Register ──

  generate: () => {
    const s = get();
    const capType = s.capabilityType.toLowerCase().trim();
    const templateName = `${s.deviceName} ${capType.toUpperCase()}`;

    const params: ParamDef[] = s.params.map((draft, i) => buildParamDef(draft, i + 1));

    const constraints: ParamConstraint[] = s.constraints
      .filter((c) => c.whenParam && c.thenParam && c.values.length > 0)
      .map(buildConstraint);

    const template: CapabilityTemplate = {
      capabilityType: capType,
      version: "1.0",
      name: templateName,
      description: s.description || undefined,
      params,
      constraints: constraints.length > 0 ? constraints : undefined,
      basePricingHints: {
        basePrice: s.basePrice,
        currency: s.currency,
        perUnitLabel: s.perUnitLabel,
      },
    };

    const profileId = `profile_${capType}_${s.manufacturer.toLowerCase().replace(/\s+/g, "_")}_${s.model.toLowerCase().replace(/\s+/g, "_")}`;

    const profile: MachineProfile = {
      id: profileId,
      capabilityType: capType,
      machineName: `${s.manufacturer} ${s.model}`.trim() || s.deviceName,
      kernelId: "",
      paramOverrides: [],
      pricingOverrides: {
        basePrice: s.basePrice,
        currency: s.currency,
      },
    };

    set({ generatedTemplate: template, generatedProfile: profile });
  },

  register: () => {
    const { generatedTemplate, generatedProfile } = get();
    if (generatedTemplate) {
      registerTemplate(generatedTemplate);
    }
    if (generatedProfile) {
      registerProfile(generatedProfile);
    }
    set({ registered: true });
  },

  reset: () => set({
    step: 0,
    deviceName: "",
    capabilityType: "",
    manufacturer: "",
    model: "",
    description: "",
    params: [],
    basePrice: "15.00",
    currency: "USDC",
    perUnitLabel: "per part",
    constraints: [],
    generatedTemplate: null,
    generatedProfile: null,
    registered: false,
  }),

  isStepValid: (step) => {
    const s = get();
    switch (step) {
      case 0:
        return s.deviceName.length > 0 && s.capabilityType.length > 0 && s.manufacturer.length > 0;
      case 1:
        return (
          s.params.length > 0 &&
          s.params.every((p) => p.key.length > 0 && p.label.length > 0 && (p.type !== "enum" || p.options.some((o) => o.value.length > 0)))
        );
      case 2:
        return parseFloat(s.basePrice) > 0;
      case 3:
        return true; // constraints are optional
      case 4:
        return true; // review step
      default:
        return false;
    }
  },
}));
