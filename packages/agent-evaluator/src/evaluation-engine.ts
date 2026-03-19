/**
 * Evaluation Engine — rules-based assessment of evidence against requirements.
 *
 * Checks evidence data against milestone requirements and produces
 * structured findings with severity classification.
 */

export interface EvidenceData {
  events: Array<{
    type: string;
    data: Record<string, unknown>;
    timestamp: string;
  }>;
  measurements?: Record<string, number>;
  sensorReadings?: Array<{
    channel: string;
    value: number;
    unit: string;
    timestamp: string;
  }>;
}

export interface Requirement {
  name: string;
  expectedValue?: string;
  tolerance?: string;
  unit?: string;
}

export interface Finding {
  category: "dimensional" | "material" | "process" | "documentation" | "safety";
  severity: "critical" | "major" | "minor" | "observation";
  description: string;
  evidenceRef?: string;
  expectedValue?: string;
  actualValue?: string;
}

export interface EvaluationOutput {
  verdict: "pass" | "fail" | "conditional";
  score: number;
  confidence: number;
  findings: Finding[];
  recommendations: string[];
}

/**
 * Evaluate evidence data against requirements.
 *
 * Scoring:
 * - Start at 100
 * - Critical finding: -30
 * - Major finding: -15
 * - Minor finding: -5
 * - Observation: -0
 *
 * Verdict:
 * - score >= 80 and no critical: pass
 * - score >= 60 and no critical: conditional
 * - else: fail
 */
export function evaluate(
  evidence: EvidenceData,
  requirements: Requirement[],
  capabilityType: string,
): EvaluationOutput {
  const findings: Finding[] = [];
  const recommendations: string[] = [];

  // Check 1: Evidence completeness — are all required events present?
  const eventTypes = new Set(evidence.events.map(e => e.type));
  const expectedEvents = getExpectedEvents(capabilityType);
  for (const expected of expectedEvents) {
    if (!eventTypes.has(expected)) {
      findings.push({
        category: "documentation",
        severity: "major",
        description: `Missing required evidence event: ${expected}`,
        expectedValue: expected,
        actualValue: "not found",
      });
      recommendations.push(`Ensure ${expected} event is captured during the process`);
    }
  }

  // Check 2: Measurement requirements
  for (const req of requirements) {
    if (!req.expectedValue) continue;

    const measurement = evidence.measurements?.[req.name];
    if (measurement === undefined) {
      findings.push({
        category: "dimensional",
        severity: "major",
        description: `Required measurement '${req.name}' not found in evidence`,
        expectedValue: `${req.expectedValue}${req.unit ? ` ${req.unit}` : ""}`,
        actualValue: "missing",
      });
      continue;
    }

    // Check against expected value with tolerance
    const expected = parseFloat(req.expectedValue);
    const tolerance = req.tolerance ? parseFloat(req.tolerance) : expected * 0.05; // 5% default
    const diff = Math.abs(measurement - expected);

    if (diff > tolerance * 2) {
      findings.push({
        category: "dimensional",
        severity: "critical",
        description: `${req.name} out of specification by ${((diff / tolerance) * 100).toFixed(1)}%`,
        expectedValue: `${expected} ± ${tolerance}${req.unit ? ` ${req.unit}` : ""}`,
        actualValue: `${measurement}${req.unit ? ` ${req.unit}` : ""}`,
      });
    } else if (diff > tolerance) {
      findings.push({
        category: "dimensional",
        severity: "minor",
        description: `${req.name} near tolerance limit`,
        expectedValue: `${expected} ± ${tolerance}${req.unit ? ` ${req.unit}` : ""}`,
        actualValue: `${measurement}${req.unit ? ` ${req.unit}` : ""}`,
      });
    }
  }

  // Check 3: Sensor data continuity (no gaps > 60s during job)
  if (evidence.sensorReadings && evidence.sensorReadings.length > 1) {
    const sorted = [...evidence.sensorReadings].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );
    for (let i = 1; i < sorted.length; i++) {
      const gap =
        (new Date(sorted[i]!.timestamp).getTime() - new Date(sorted[i - 1]!.timestamp).getTime()) / 1000;
      if (gap > 60) {
        findings.push({
          category: "process",
          severity: "minor",
          description: `Sensor data gap of ${gap.toFixed(0)}s detected between readings`,
          evidenceRef: `sensor[${i - 1}]-sensor[${i}]`,
        });
      }
    }
  }

  // Check 4: Minimum event count
  if (evidence.events.length < 3) {
    findings.push({
      category: "documentation",
      severity: "major",
      description: `Insufficient evidence events (${evidence.events.length} < 3 minimum)`,
    });
    recommendations.push("Capture more process events for complete evidence trail");
  }

  // Calculate score
  let score = 100;
  let hasCritical = false;
  for (const f of findings) {
    switch (f.severity) {
      case "critical":
        score -= 30;
        hasCritical = true;
        break;
      case "major":
        score -= 15;
        break;
      case "minor":
        score -= 5;
        break;
      // observation: no deduction
    }
  }
  score = Math.max(0, score);

  // Determine confidence based on evidence completeness
  const completeness = expectedEvents.length > 0
    ? [...expectedEvents].filter(e => eventTypes.has(e)).length / expectedEvents.length
    : evidence.events.length > 0 ? 0.8 : 0.3;

  const confidence = Math.min(1, completeness * (evidence.measurements ? 1 : 0.7));

  // Verdict
  let verdict: "pass" | "fail" | "conditional";
  if (hasCritical || score < 60) {
    verdict = "fail";
  } else if (score < 80) {
    verdict = "conditional";
  } else {
    verdict = "pass";
  }

  return { verdict, score, confidence, findings, recommendations };
}

/** Get expected evidence events for a capability type */
function getExpectedEvents(capabilityType: string): string[] {
  const eventMap: Record<string, string[]> = {
    hplc: ["sample_loaded", "run_started", "peak_detected", "purity_calculated", "run_completed"],
    "mass-spec": ["sample_ionized", "scan_started", "mass_detected", "analysis_complete"],
    "cnc-3axis": ["tool_loaded", "program_started", "machining_complete", "measurement_taken"],
    "cnc-5axis": ["tool_loaded", "program_started", "machining_complete", "measurement_taken"],
    "fdm-printer": ["print_started", "layer_complete", "print_finished", "quality_check"],
    "flow-reactor": ["reagents_loaded", "flow_started", "temperature_stable", "reaction_complete", "product_collected"],
    centrifuge: ["sample_loaded", "run_started", "separation_complete", "sample_collected"],
  };
  return eventMap[capabilityType] ?? ["process_started", "process_completed"];
}
