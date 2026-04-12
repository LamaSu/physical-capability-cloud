// packages/gateway/src/services/template-suggestion-service.ts
//
// Suggests templates during operator onboarding based on machine model,
// capability type, industry, and device protocol.
//
// Called by GET /api/templates/suggest

import { getRepos } from "../db.js";

export interface TemplateSuggestion {
  type: "capability" | "machine" | "verification" | "compliance";
  templateId: string;
  name: string;
  matchReason: string;
  confidence: number; // 0-1
}

export class TemplateSuggestionService {
  suggest(opts: {
    machineModel?: string;
    capabilityType?: string;
    industry?: string;
    deviceProtocol?: string;
  }): TemplateSuggestion[] {
    const suggestions: TemplateSuggestion[] = [];
    const repos = getRepos();

    // 1. Find capability templates matching capabilityType
    if (opts.capabilityType) {
      const templates = repos.templateStore.findCapabilityTemplatesByType(opts.capabilityType);

      // Sort by (rating * usageCount) descending, take top 3
      const ranked = templates
        .filter((t) => t.status === "active")
        .sort((a, b) => {
          const scoreA = (a.rating ?? 0) * (a.usageCount + 1);
          const scoreB = (b.rating ?? 0) * (b.usageCount + 1);
          return scoreB - scoreA;
        })
        .slice(0, 3);

      for (const t of ranked) {
        // Confidence: exact type match = 0.9 base, boosted by rating/usage
        const ratingBoost = t.rating ? (t.rating / 5) * 0.1 : 0;
        suggestions.push({
          type: "capability",
          templateId: t.id,
          name: t.name,
          matchReason: `Matches capability type "${opts.capabilityType}"`,
          confidence: Math.min(0.95, 0.85 + ratingBoost),
        });
      }

      // Also try all templates (incl drafts) if no active ones found
      if (ranked.length === 0) {
        const fallbacks = templates.slice(0, 2);
        for (const t of fallbacks) {
          suggestions.push({
            type: "capability",
            templateId: t.id,
            name: t.name,
            matchReason: `Matches capability type "${opts.capabilityType}" (draft)`,
            confidence: 0.6,
          });
        }
      }
    }

    // 2. Find machine profiles matching machine model (name-based fuzzy search)
    if (opts.machineModel) {
      const modelLower = opts.machineModel.toLowerCase();

      // First try type-filtered if capabilityType provided, otherwise all
      const allProfiles = opts.capabilityType
        ? repos.templateStore.findMachineProfilesByType(opts.capabilityType)
        : repos.templateStore.findAllMachineProfiles();

      // Fuzzy match: score by how many words in machineModel appear in profile name
      const modelWords = modelLower.split(/\s+/).filter(Boolean);
      const scored = allProfiles
        .map((p) => {
          const profileNameLower = p.machineName.toLowerCase();
          const matchedWords = modelWords.filter((w) => profileNameLower.includes(w));
          const wordScore = modelWords.length > 0 ? matchedWords.length / modelWords.length : 0;
          // Also check if model name appears as substring
          const substringMatch = profileNameLower.includes(modelLower) ? 0.2 : 0;
          return { profile: p, score: wordScore + substringMatch };
        })
        .filter(({ score }) => score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 2);

      for (const { profile, score } of scored) {
        suggestions.push({
          type: "machine",
          templateId: profile.id,
          name: profile.machineName,
          matchReason: `Matches machine model "${opts.machineModel}"`,
          confidence: Math.min(0.9, 0.5 + score * 0.4),
        });
      }
    }

    // 3. Find verification templates matching capabilityType
    if (opts.capabilityType) {
      const verTemplates = repos.templateStore
        .findVerificationTemplatesByType(opts.capabilityType)
        .filter((t) => t.status === "active")
        .slice(0, 2);

      for (const t of verTemplates) {
        suggestions.push({
          type: "verification",
          templateId: t.id,
          name: t.name,
          matchReason: `Verification requirements for "${opts.capabilityType}"`,
          confidence: 0.8,
        });
      }
    }

    // 4. Find compliance templates matching industry
    if (opts.industry) {
      const industryLower = opts.industry.toLowerCase();
      // Get all compliance templates and filter by industry tag
      const allCompliance = repos.analytics.findAllComplianceTemplates();
      const matching = allCompliance
        .filter((t) => {
          const industries: string[] = (t.industries as string[]) ?? [];
          return industries.some((ind) => ind.toLowerCase().includes(industryLower) || industryLower.includes(ind.toLowerCase()));
        })
        .filter((t) => t.status === "active")
        .slice(0, 2);

      for (const t of matching) {
        suggestions.push({
          type: "compliance",
          templateId: t.id,
          name: t.name,
          matchReason: `Compliance requirements for "${opts.industry}" industry`,
          confidence: 0.75,
        });
      }
    }

    return suggestions.sort((a, b) => b.confidence - a.confidence);
  }
}
