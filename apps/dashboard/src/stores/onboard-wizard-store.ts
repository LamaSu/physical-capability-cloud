import { create } from "zustand";
import type {
  CapabilityType,
  OnboardingDocument,
  AISuggestedCapability,
  MachineCapabilityDef,
  PhysicalSpaceRequirements,
  PricingConfig,
  OperatorCertification,
} from "@pcc/spec";

interface WizardIdentity {
  name: string;
  category: CapabilityType | "";
  manufacturer: string;
  model: string;
  serialNumber: string;
  description: string;
  photos: string[];
}

interface AIMessage {
  id: string;
  content: string;
  suggestions?: string[];
  timestamp: string;
}

interface OnboardWizardState {
  step: number;

  // Step 1: Identity
  identity: WizardIdentity;

  // Step 2: Documents
  documents: OnboardingDocument[];
  isAnalyzing: boolean;

  // Step 3: Capabilities
  aiSuggestions: AISuggestedCapability[];
  capabilities: MachineCapabilityDef[];

  // Step 4: Space
  spaceRequirements: PhysicalSpaceRequirements | null;

  // Step 5: Pricing
  pricing: PricingConfig | null;

  // Step 6: Operator
  operatorName: string;
  certifications: OperatorCertification[];
  trainingAcknowledgments: Record<string, boolean>;

  // AI Chat
  aiMessages: AIMessage[];

  // Actions
  setStep: (step: number) => void;
  nextStep: () => void;
  prevStep: () => void;
  updateIdentity: (fields: Partial<WizardIdentity>) => void;
  addDocument: (doc: OnboardingDocument) => void;
  setAnalyzing: (v: boolean) => void;
  setAISuggestions: (s: AISuggestedCapability[]) => void;
  acceptSuggestion: (id: string) => void;
  rejectSuggestion: (id: string) => void;
  addCapability: (cap: MachineCapabilityDef) => void;
  removeCapability: (id: string) => void;
  setSpaceRequirements: (r: PhysicalSpaceRequirements) => void;
  setPricing: (p: PricingConfig) => void;
  setOperatorName: (n: string) => void;
  addCertification: (c: OperatorCertification) => void;
  setTrainingAck: (key: string, value: boolean) => void;
  addAIMessage: (msg: AIMessage) => void;
  reset: () => void;
  isStepValid: (step: number) => boolean;
}

const TOTAL_STEPS = 7;

export const useOnboardWizardStore = create<OnboardWizardState>((set, get) => ({
  step: 0,

  identity: { name: "", category: "", manufacturer: "", model: "", serialNumber: "", description: "", photos: [] },
  documents: [],
  isAnalyzing: false,
  aiSuggestions: [],
  capabilities: [],
  spaceRequirements: null,
  pricing: null,
  operatorName: "",
  certifications: [],
  trainingAcknowledgments: {},
  aiMessages: [],

  setStep: (step) => set({ step: Math.max(0, Math.min(TOTAL_STEPS - 1, step)) }),
  nextStep: () => set((s) => ({ step: Math.min(TOTAL_STEPS - 1, s.step + 1) })),
  prevStep: () => set((s) => ({ step: Math.max(0, s.step - 1) })),

  updateIdentity: (fields) => set((s) => ({ identity: { ...s.identity, ...fields } })),

  addDocument: (doc) => set((s) => ({ documents: [...s.documents, doc] })),
  setAnalyzing: (v) => set({ isAnalyzing: v }),

  setAISuggestions: (suggestions) => set({ aiSuggestions: suggestions }),
  acceptSuggestion: (id) => {
    const { aiSuggestions, capabilities } = get();
    const suggestion = aiSuggestions.find((s) => s.id === id);
    if (!suggestion) return;
    const cap: MachineCapabilityDef = {
      id: `cap-${Date.now()}`,
      type: suggestion.type,
      name: suggestion.name,
      description: suggestion.description,
      materials: suggestion.materials,
      tolerances: suggestion.tolerances,
      envelope: suggestion.envelope,
      params: suggestion.suggestedParams,
      source: "ai-suggested",
    };
    set({
      capabilities: [...capabilities, cap],
      aiSuggestions: aiSuggestions.filter((s) => s.id !== id),
    });
  },
  rejectSuggestion: (id) => set((s) => ({ aiSuggestions: s.aiSuggestions.filter((x) => x.id !== id) })),
  addCapability: (cap) => set((s) => ({ capabilities: [...s.capabilities, cap] })),
  removeCapability: (id) => set((s) => ({ capabilities: s.capabilities.filter((c) => c.id !== id) })),

  setSpaceRequirements: (r) => set({ spaceRequirements: r }),
  setPricing: (p) => set({ pricing: p }),

  setOperatorName: (n) => set({ operatorName: n }),
  addCertification: (c) => set((s) => ({ certifications: [...s.certifications, c] })),
  setTrainingAck: (key, value) =>
    set((s) => ({ trainingAcknowledgments: { ...s.trainingAcknowledgments, [key]: value } })),

  addAIMessage: (msg) => set((s) => ({ aiMessages: [...s.aiMessages, msg] })),

  reset: () =>
    set({
      step: 0,
      identity: { name: "", category: "", manufacturer: "", model: "", serialNumber: "", description: "", photos: [] },
      documents: [],
      isAnalyzing: false,
      aiSuggestions: [],
      capabilities: [],
      spaceRequirements: null,
      pricing: null,
      operatorName: "",
      certifications: [],
      trainingAcknowledgments: {},
      aiMessages: [],
    }),

  isStepValid: (step) => {
    const s = get();
    switch (step) {
      case 0: return s.identity.name.length > 0 && s.identity.category !== "" && s.identity.manufacturer.length > 0;
      case 1: return true; // docs optional
      case 2: return s.capabilities.length > 0;
      case 3: return s.spaceRequirements !== null;
      case 4: return s.pricing !== null;
      case 5: return s.operatorName.length > 0;
      case 6: return true; // review
      default: return false;
    }
  },
}));
