/**
 * Policy Engine — pure function that evaluates a job against an OperatorPolicy.
 *
 * No I/O, no side effects. Takes a policy + context, returns an evaluation.
 * All three enforcement points (KernelAgent, OpentronOperator, KernelService)
 * call this same function.
 *
 * Rule evaluation order (short-circuit on first block):
 *   1. Emergency stop
 *   2. Blocked agents
 *   3. Operating hours
 *   4. Maintenance windows
 *   5. Rate limits (hour, day, cost)
 *   6. Material allowlist
 *   7. Capability type allowlist
 *   8. Duration limit
 *   9. Escrow requirement
 *  10. Approval mode decision
 *
 * Pricing rule evaluation (always runs, stacks adjustments):
 *   - Volume discount
 *   - Batch discount
 *   - Rush surcharge
 *   - Off-peak discount
 *   - Material markup
 *   - Loyalty discount
 */

import type {
  OperatorPolicy,
  PolicyEvaluation,
  PolicyViolation,
  PricingRule,
} from "@pcc/spec";

// ── Context ───────────────────────────────────────────────────────

export interface PolicyContext {
  /** Agent submitting the job */
  agentId: string;
  /** Agent's reputation score (0-1000) */
  agentReputation?: number;
  /** Capability type requested */
  capabilityType?: string;
  /** Material requested */
  material?: string;
  /** Estimated job duration in ms */
  estimatedDurationMs?: number;
  /** Estimated job cost (USDC string) */
  estimatedCost?: string;
  /** Current time (for schedule checks) */
  currentTime: Date;
  /** Rate counters from DB */
  rateCounts: {
    jobsThisHour: number;
    jobsToday: number;
    costToday: number;
  };
  /** Number of items in this order (for volume pricing) */
  quantity?: number;
  /** Number of previously completed jobs from this agent */
  agentCompletedJobs?: number;
  /** Whether the user has funded escrow */
  escrowFunded?: boolean;
  /** Requested lead time in ms (time until job must start) */
  leadTimeMs?: number;
}

// ── Evaluation ────────────────────────────────────────────────────

export function evaluatePolicy(
  policy: OperatorPolicy,
  ctx: PolicyContext,
): PolicyEvaluation {
  const violations: PolicyViolation[] = [];

  // ── 1. Emergency Stop ───────────────────────────────────────
  if (policy.emergencyStop) {
    return {
      allowed: false,
      requiresApproval: false,
      violations: [{
        rule: "emergency_stop",
        message: "Operator has activated emergency stop. All jobs are currently suspended.",
        severity: "block",
      }],
    };
  }

  // ── 2. Blocked Agents ───────────────────────────────────────
  if (policy.blockedAgents.includes(ctx.agentId)) {
    return {
      allowed: false,
      requiresApproval: false,
      violations: [{
        rule: "blocked_agent",
        message: "Agent is on the operator's block list.",
        severity: "block",
      }],
    };
  }

  // ── 3. Reputation Check ─────────────────────────────────────
  if (
    policy.minReputationScore > 0 &&
    ctx.agentReputation !== undefined &&
    ctx.agentReputation < policy.minReputationScore
  ) {
    violations.push({
      rule: "min_reputation",
      message: `Agent reputation ${ctx.agentReputation} is below minimum ${policy.minReputationScore}.`,
      severity: "block",
    });
  }

  // ── 4. Operating Hours ──────────────────────────────────────
  const scheduleViolation = checkSchedule(policy, ctx.currentTime);
  if (scheduleViolation) {
    violations.push(scheduleViolation);
  }

  // ── 5. Maintenance Windows ──────────────────────────────────
  const maintenanceViolation = checkMaintenance(policy, ctx.currentTime);
  if (maintenanceViolation) {
    violations.push(maintenanceViolation);
  }

  // ── 6. Rate Limits ──────────────────────────────────────────
  if (policy.maxJobsPerHour > 0 && ctx.rateCounts.jobsThisHour >= policy.maxJobsPerHour) {
    violations.push({
      rule: "rate_limit_hour",
      message: `Rate limit exceeded: ${ctx.rateCounts.jobsThisHour}/${policy.maxJobsPerHour} jobs this hour.`,
      severity: "block",
    });
  }

  if (policy.maxJobsPerDay > 0 && ctx.rateCounts.jobsToday >= policy.maxJobsPerDay) {
    violations.push({
      rule: "rate_limit_day",
      message: `Rate limit exceeded: ${ctx.rateCounts.jobsToday}/${policy.maxJobsPerDay} jobs today.`,
      severity: "block",
    });
  }

  const maxCostPerDay = parseFloat(policy.maxCostPerDay);
  const estimatedCost = parseFloat(ctx.estimatedCost ?? "0");
  if (maxCostPerDay > 0 && ctx.rateCounts.costToday + estimatedCost > maxCostPerDay) {
    violations.push({
      rule: "rate_limit_cost",
      message: `Daily cost limit exceeded: $${ctx.rateCounts.costToday.toFixed(2)} + $${estimatedCost.toFixed(2)} > $${maxCostPerDay.toFixed(2)} max.`,
      severity: "block",
    });
  }

  // ── 7. Material Allowlist ───────────────────────────────────
  if (
    policy.allowedMaterials.length > 0 &&
    ctx.material &&
    !policy.allowedMaterials.some(
      (m) => m.toLowerCase() === ctx.material!.toLowerCase(),
    )
  ) {
    violations.push({
      rule: "material_not_allowed",
      message: `Material "${ctx.material}" is not in the operator's allowed list: ${policy.allowedMaterials.join(", ")}.`,
      severity: "block",
    });
  }

  // ── 8. Capability Type Allowlist ────────────────────────────
  if (
    policy.allowedCapabilityTypes.length > 0 &&
    ctx.capabilityType &&
    !policy.allowedCapabilityTypes.includes(ctx.capabilityType)
  ) {
    violations.push({
      rule: "capability_type_not_allowed",
      message: `Capability type "${ctx.capabilityType}" is not allowed by this operator.`,
      severity: "block",
    });
  }

  // ── 9. Duration Limit ──────────────────────────────────────
  if (
    policy.maxDurationMs > 0 &&
    ctx.estimatedDurationMs &&
    ctx.estimatedDurationMs > policy.maxDurationMs
  ) {
    violations.push({
      rule: "duration_exceeded",
      message: `Estimated duration ${Math.round(ctx.estimatedDurationMs / 60_000)}min exceeds max ${Math.round(policy.maxDurationMs / 60_000)}min.`,
      severity: "block",
    });
  }

  // ── 10. Escrow Requirement ─────────────────────────────────
  if (policy.requireEscrow && !ctx.escrowFunded) {
    violations.push({
      rule: "escrow_required",
      message: "This operator requires funded escrow before job execution.",
      severity: "block",
    });
  }

  // ── Check for blocking violations ──────────────────────────
  const blockingViolations = violations.filter((v) => v.severity === "block");
  if (blockingViolations.length > 0) {
    return {
      allowed: false,
      requiresApproval: false,
      violations,
    };
  }

  // ── 11. Evaluate Pricing Rules ─────────────────────────────
  const appliedPricingRules = evaluatePricingRules(policy.pricingRules, ctx);

  // ── 12. Approval Mode Decision ─────────────────────────────
  switch (policy.approvalMode) {
    case "auto": {
      // Auto-approve if no whitelist, or agent is on whitelist
      if (
        policy.trustedAgents.length === 0 ||
        policy.trustedAgents.includes(ctx.agentId)
      ) {
        return {
          allowed: true,
          requiresApproval: false,
          violations,
          appliedPricingRules,
        };
      }
      // Agent not on whitelist in auto mode — still allow but warn
      return {
        allowed: true,
        requiresApproval: false,
        violations: [
          ...violations,
          {
            rule: "not_on_whitelist",
            message: "Agent is not on the trusted list (auto-approved anyway in auto mode).",
            severity: "warn",
          },
        ],
        appliedPricingRules,
      };
    }

    case "manual":
      return {
        allowed: false,
        requiresApproval: true,
        violations,
        appliedPricingRules,
      };

    case "policy": {
      // Policy mode: auto-approve trusted agents, require manual for others
      if (policy.trustedAgents.includes(ctx.agentId)) {
        return {
          allowed: true,
          requiresApproval: false,
          violations,
          appliedPricingRules,
        };
      }
      return {
        allowed: false,
        requiresApproval: true,
        violations: [
          ...violations,
          {
            rule: "not_trusted",
            message: "Agent is not on the trusted list. Manual approval required.",
            severity: "warn",
          },
        ],
        appliedPricingRules,
      };
    }

    default:
      return { allowed: false, requiresApproval: true, violations, appliedPricingRules };
  }
}

// ── Schedule Check ────────────────────────────────────────────────

function checkSchedule(
  policy: OperatorPolicy,
  now: Date,
): PolicyViolation | null {
  const dayOfWeek = now.getDay(); // 0 = Sunday
  const windows = policy.operatingHours[dayOfWeek];

  // null = closed today
  if (windows === null) {
    return {
      rule: "outside_operating_hours",
      message: `Operator is closed on ${["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][dayOfWeek]}.`,
      severity: "block",
    };
  }

  // undefined or empty = open all day
  if (!windows || windows.length === 0) return null;

  // Check if current time falls within any window
  const hours = now.getHours();
  const minutes = now.getMinutes();
  const currentMinutes = hours * 60 + minutes;

  for (const window of windows) {
    const [startH, startM] = window.start.split(":").map(Number);
    const [endH, endM] = window.end.split(":").map(Number);
    const startMinutes = startH * 60 + startM;
    const endMinutes = endH * 60 + endM;

    if (currentMinutes >= startMinutes && currentMinutes < endMinutes) {
      return null; // Within operating hours
    }
  }

  return {
    rule: "outside_operating_hours",
    message: `Current time is outside operating hours. Available windows: ${windows.map((w) => `${w.start}-${w.end}`).join(", ")}.`,
    severity: "block",
  };
}

// ── Maintenance Check ─────────────────────────────────────────────

function checkMaintenance(
  policy: OperatorPolicy,
  now: Date,
): PolicyViolation | null {
  const nowMs = now.getTime();

  for (const mw of policy.maintenanceWindows) {
    const start = new Date(mw.start).getTime();
    const end = new Date(mw.end).getTime();

    if (nowMs >= start && nowMs < end) {
      return {
        rule: "maintenance_window",
        message: `Operator is in maintenance: "${mw.reason}" (until ${mw.end}).`,
        severity: "block",
      };
    }
  }

  return null;
}

// ── Pricing Rules Evaluation ──────────────────────────────────────

function evaluatePricingRules(
  rules: PricingRule[],
  ctx: PolicyContext,
): PricingRule[] {
  const applied: PricingRule[] = [];

  for (const rule of rules) {
    if (!rule.enabled) continue;

    switch (rule.type) {
      case "volume_discount":
        if (
          rule.condition.minQuantity &&
          ctx.quantity &&
          ctx.quantity >= rule.condition.minQuantity
        ) {
          applied.push(rule);
        }
        break;

      case "rush_surcharge":
        if (
          rule.condition.maxLeadTimeMs &&
          ctx.leadTimeMs !== undefined &&
          ctx.leadTimeMs <= rule.condition.maxLeadTimeMs
        ) {
          applied.push(rule);
        }
        break;

      case "loyalty_discount":
        if (
          rule.condition.minCompletedJobs &&
          ctx.agentCompletedJobs !== undefined &&
          ctx.agentCompletedJobs >= rule.condition.minCompletedJobs
        ) {
          applied.push(rule);
        }
        break;

      case "material_markup":
        if (
          rule.condition.material &&
          ctx.material &&
          rule.condition.material.toLowerCase() === ctx.material.toLowerCase()
        ) {
          applied.push(rule);
        }
        break;

      case "offpeak_discount":
        if (rule.condition.timeWindow) {
          const hours = ctx.currentTime.getHours();
          const mins = ctx.currentTime.getMinutes();
          const currentMins = hours * 60 + mins;
          const [startH, startM] = rule.condition.timeWindow.start.split(":").map(Number);
          const [endH, endM] = rule.condition.timeWindow.end.split(":").map(Number);
          const startMins = startH * 60 + startM;
          const endMins = endH * 60 + endM;
          if (currentMins >= startMins && currentMins < endMins) {
            applied.push(rule);
          }
        }
        break;

      case "batch_discount":
        // Batch discount applies when multiple jobs are combined
        // Implementation depends on batch context — applied by caller
        break;

      default:
        // Extensible: unknown rule types are silently skipped
        break;
    }
  }

  return applied;
}

// ── Pricing Adjustment Calculator ─────────────────────────────────

/**
 * Apply pricing rules to a base price. Returns adjusted total.
 */
export function applyPricingRules(
  basePrice: number,
  rules: PricingRule[],
): { adjustedPrice: number; adjustments: Array<{ ruleId: string; label: string; amount: number }> } {
  let total = basePrice;
  const adjustments: Array<{ ruleId: string; label: string; amount: number }> = [];

  for (const rule of rules) {
    const value = parseFloat(rule.impact.value);
    let amount: number;

    if (rule.impact.mode === "percent") {
      amount = basePrice * (value / 100);
    } else {
      amount = value;
    }

    total += amount;
    adjustments.push({
      ruleId: rule.id,
      label: rule.label,
      amount,
    });
  }

  return { adjustedPrice: Math.max(0, total), adjustments };
}

// ── Sanitization Utilities ────────────────────────────────────────

/** Strip control characters and limit length for free-text fields */
export function sanitizeText(text: string, maxLength = 1000): string {
  // Remove control characters (except newlines and tabs)
  const cleaned = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
  return cleaned.slice(0, maxLength);
}

/** Check G-code for dangerous commands */
export function scanGcode(gcode: string, maxTemp: number): PolicyViolation[] {
  const violations: PolicyViolation[] = [];

  // Dangerous commands that could damage equipment
  const dangerousPatterns = [
    { pattern: /M112/gi, message: "Emergency stop command (M112) found in G-code" },
    { pattern: /M999/gi, message: "Restart command (M999) found in G-code" },
    { pattern: /M502/gi, message: "Factory reset command (M502) found in G-code" },
  ];

  for (const { pattern, message } of dangerousPatterns) {
    if (pattern.test(gcode)) {
      violations.push({ rule: "gcode_dangerous_command", message, severity: "block" });
    }
  }

  // Temperature checks
  if (maxTemp > 0) {
    const hotendTemps = [...gcode.matchAll(/M104\s+S(\d+)/gi)];
    const bedTemps = [...gcode.matchAll(/M140\s+S(\d+)/gi)];

    for (const match of [...hotendTemps, ...bedTemps]) {
      const temp = parseInt(match[1], 10);
      if (temp > maxTemp) {
        violations.push({
          rule: "gcode_temperature_exceeded",
          message: `Temperature ${temp}°C exceeds operator limit of ${maxTemp}°C.`,
          severity: "block",
        });
      }
    }
  }

  return violations;
}
