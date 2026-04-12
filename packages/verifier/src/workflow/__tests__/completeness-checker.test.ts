import { describe, it, expect } from 'vitest';
import {
  checkStepCompleteness,
  type CompletenessContract,
  type StepTrace,
} from '../completeness-checker.js';
import type { DigitalWorkflowStep } from '@pcc/spec';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal DigitalWorkflowStep. */
function step(
  stepId: string,
  dependsOn: string[] = [],
  stepType: string = 'transform',
): DigitalWorkflowStep {
  return {
    stepId,
    stepType: stepType as DigitalWorkflowStep['stepType'],
    description: `Step ${stepId}`,
    dependsOn,
  };
}

/** Build a StepTrace with full (non-stub) content. */
function trace(
  stepId: string,
  opts?: Partial<StepTrace>,
): StepTrace {
  return {
    stepId,
    outputHash: `sha256:${stepId}_output`,
    outputSummary: `Output summary for step ${stepId} with sufficient length`,
    durationMs: 1000,
    inputHash: `sha256:${stepId}_input`,
    ...opts,
  };
}

/** Build a stub trace (empty outputHash, short summary). */
function stubTrace(stepId: string): StepTrace {
  return {
    stepId,
    outputHash: '',
    outputSummary: 'short',
    durationMs: 0,
  };
}

/** Find findings by check name. */
function findingsByCheck(
  result: ReturnType<typeof checkStepCompleteness>,
  check: string,
) {
  return result.findings.filter((f) => f.check === check);
}

// ---------------------------------------------------------------------------
// Level 0: Set membership
// ---------------------------------------------------------------------------

describe('checkStepCompleteness — Level 0 (set membership)', () => {
  it('1. all steps covered -> passes, no critical findings', () => {
    const contract: CompletenessContract = {
      workflowSteps: [step('s1'), step('s2'), step('s3')],
    };
    const traces: StepTrace[] = [trace('s1'), trace('s2'), trace('s3')];

    const result = checkStepCompleteness(contract, traces, { level: 0 });

    expect(result.coveredSteps).toEqual(['s1', 's2', 's3']);
    expect(result.missingSteps).toEqual([]);
    expect(result.extraSteps).toEqual([]);
    const criticals = result.findings.filter(
      (f) => !f.passed && f.severity === 'critical',
    );
    expect(criticals).toHaveLength(0);
  });

  it('2. one step missing -> critical finding "step_completeness"', () => {
    const contract: CompletenessContract = {
      workflowSteps: [step('s1'), step('s2'), step('s3')],
    };
    const traces: StepTrace[] = [trace('s1'), trace('s3')];

    const result = checkStepCompleteness(contract, traces, { level: 0 });

    expect(result.missingSteps).toEqual(['s2']);
    const missing = findingsByCheck(result, 'step_completeness');
    expect(missing).toHaveLength(1);
    expect(missing[0].passed).toBe(false);
    expect(missing[0].severity).toBe('critical');
    expect(missing[0].details).toContain('s2');
  });

  it('3. multiple steps missing -> one finding per missing step', () => {
    const contract: CompletenessContract = {
      workflowSteps: [step('s1'), step('s2'), step('s3'), step('s4')],
    };
    const traces: StepTrace[] = [trace('s1')];

    const result = checkStepCompleteness(contract, traces, { level: 0 });

    expect(result.missingSteps).toEqual(['s2', 's3', 's4']);
    const missing = findingsByCheck(result, 'step_completeness');
    expect(missing).toHaveLength(3);
    for (const f of missing) {
      expect(f.severity).toBe('critical');
      expect(f.passed).toBe(false);
    }
  });

  it('4. empty workflowSteps -> passes (nothing to check)', () => {
    const contract: CompletenessContract = { workflowSteps: [] };
    const traces: StepTrace[] = [];

    const result = checkStepCompleteness(contract, traces, { level: 0 });

    expect(result.coveredSteps).toEqual([]);
    expect(result.missingSteps).toEqual([]);
    expect(result.extraSteps).toEqual([]);
    expect(result.findings).toEqual([]);
  });

  it('5. empty traces -> critical finding for each declared step', () => {
    const contract: CompletenessContract = {
      workflowSteps: [step('s1'), step('s2')],
    };
    const traces: StepTrace[] = [];

    const result = checkStepCompleteness(contract, traces, { level: 0 });

    expect(result.missingSteps).toEqual(['s1', 's2']);
    const missing = findingsByCheck(result, 'step_completeness');
    expect(missing).toHaveLength(2);
    expect(missing.every((f) => f.severity === 'critical')).toBe(true);
  });

  it('6. extra traces (unknown stepIds) -> warning finding', () => {
    const contract: CompletenessContract = {
      workflowSteps: [step('s1')],
    };
    const traces: StepTrace[] = [trace('s1'), trace('s_unknown')];

    const result = checkStepCompleteness(contract, traces, { level: 0 });

    expect(result.extraSteps).toEqual(['s_unknown']);
    const extra = findingsByCheck(result, 'step_extra');
    expect(extra).toHaveLength(1);
    expect(extra[0].passed).toBe(false);
    expect(extra[0].severity).toBe('warning');
    expect(extra[0].details).toContain('s_unknown');
  });
});

// ---------------------------------------------------------------------------
// Level 1: Stub detection
// ---------------------------------------------------------------------------

describe('checkStepCompleteness — Level 1 (stub detection)', () => {
  it('7. trace with empty outputHash -> critical "step_stub_detected"', () => {
    const contract: CompletenessContract = {
      workflowSteps: [step('s1')],
    };
    const traces: StepTrace[] = [
      trace('s1', {
        outputHash: '',
        outputSummary: 'A valid summary that is long enough',
      }),
    ];

    const result = checkStepCompleteness(contract, traces, { level: 1 });

    const stubs = findingsByCheck(result, 'step_stub_detected');
    expect(stubs).toHaveLength(1);
    expect(stubs[0].severity).toBe('critical');
    expect(stubs[0].details).toContain('outputHash');
  });

  it('8. trace with outputSummary <= 10 chars -> critical "step_stub_detected"', () => {
    const contract: CompletenessContract = {
      workflowSteps: [step('s1')],
    };
    const traces: StepTrace[] = [
      trace('s1', {
        outputHash: 'sha256:valid',
        outputSummary: '0123456789', // exactly 10 chars, should fail (>10 required)
      }),
    ];

    const result = checkStepCompleteness(contract, traces, { level: 1 });

    const stubs = findingsByCheck(result, 'step_stub_detected');
    expect(stubs).toHaveLength(1);
    expect(stubs[0].severity).toBe('critical');
    expect(stubs[0].details).toContain('outputSummary');
  });

  it('9. trace with valid outputHash and long summary -> passes', () => {
    const contract: CompletenessContract = {
      workflowSteps: [step('s1')],
    };
    const traces: StepTrace[] = [
      trace('s1', {
        outputHash: 'sha256:abc123',
        outputSummary: 'This is a valid summary that is definitely long enough',
      }),
    ];

    const result = checkStepCompleteness(contract, traces, { level: 1 });

    const stubs = findingsByCheck(result, 'step_stub_detected');
    expect(stubs).toHaveLength(0);
  });

  it('10. mixed: some stubs, some valid -> findings only for stubs', () => {
    const contract: CompletenessContract = {
      workflowSteps: [step('s1'), step('s2'), step('s3')],
    };
    const traces: StepTrace[] = [
      trace('s1'), // valid
      stubTrace('s2'), // stub
      trace('s3'), // valid
    ];

    const result = checkStepCompleteness(contract, traces, { level: 1 });

    const stubs = findingsByCheck(result, 'step_stub_detected');
    expect(stubs).toHaveLength(1);
    expect(stubs[0].details).toContain('s2');
  });
});

// ---------------------------------------------------------------------------
// Level 2: Flow integrity
// ---------------------------------------------------------------------------

describe('checkStepCompleteness — Level 2 (flow integrity)', () => {
  it('11. sequential steps with matching input/output hashes -> passes', () => {
    const contract: CompletenessContract = {
      workflowSteps: [
        step('s1', []),
        step('s2', ['s1']),
        step('s3', ['s2']),
      ],
    };
    const traces: StepTrace[] = [
      trace('s1', { outputHash: 'sha256:out1' }),
      trace('s2', { inputHash: 'sha256:out1', outputHash: 'sha256:out2' }),
      trace('s3', { inputHash: 'sha256:out2', outputHash: 'sha256:out3' }),
    ];

    const result = checkStepCompleteness(contract, traces, { level: 2 });

    const flow = findingsByCheck(result, 'step_flow_integrity');
    expect(flow).toHaveLength(0);
  });

  it('12. sequential steps with mismatched hashes -> critical "step_flow_integrity"', () => {
    const contract: CompletenessContract = {
      workflowSteps: [
        step('s1', []),
        step('s2', ['s1']),
      ],
    };
    const traces: StepTrace[] = [
      trace('s1', { outputHash: 'sha256:out1' }),
      trace('s2', { inputHash: 'sha256:WRONG', outputHash: 'sha256:out2' }),
    ];

    const result = checkStepCompleteness(contract, traces, { level: 2 });

    const flow = findingsByCheck(result, 'step_flow_integrity');
    expect(flow).toHaveLength(1);
    expect(flow[0].severity).toBe('critical');
    expect(flow[0].details).toContain('s2');
    expect(flow[0].details).toContain('s1');
  });

  it('13. first step (no dependency) -> no flow check needed', () => {
    const contract: CompletenessContract = {
      workflowSteps: [step('s1', [])],
    };
    const traces: StepTrace[] = [
      trace('s1', { inputHash: undefined, outputHash: 'sha256:out1' }),
    ];

    const result = checkStepCompleteness(contract, traces, { level: 2 });

    const flow = findingsByCheck(result, 'step_flow_integrity');
    expect(flow).toHaveLength(0);
  });

  it('14. step with multiple dependencies -> checks against first dependency', () => {
    const contract: CompletenessContract = {
      workflowSteps: [
        step('s1', []),
        step('s2', []),
        step('s3', ['s1', 's2']),
      ],
    };
    const traces: StepTrace[] = [
      trace('s1', { outputHash: 'sha256:out1' }),
      trace('s2', { outputHash: 'sha256:out2' }),
      trace('s3', { inputHash: 'sha256:out1', outputHash: 'sha256:out3' }),
    ];

    const result = checkStepCompleteness(contract, traces, { level: 2 });

    const flow = findingsByCheck(result, 'step_flow_integrity');
    expect(flow).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('checkStepCompleteness — Edge cases', () => {
  it('15. duplicate stepIds in traces -> warning "step_duplicate"', () => {
    const contract: CompletenessContract = {
      workflowSteps: [step('s1')],
    };
    const traces: StepTrace[] = [trace('s1'), trace('s1')];

    const result = checkStepCompleteness(contract, traces);

    const dups = findingsByCheck(result, 'step_duplicate');
    expect(dups).toHaveLength(1);
    expect(dups[0].severity).toBe('warning');
    expect(dups[0].details).toContain('2 trace entries');
  });

  it('16. expectedSkips excludes missing steps from critical findings', () => {
    const contract: CompletenessContract = {
      workflowSteps: [step('s1'), step('s2'), step('s3')],
      expectedSkips: ['s2'],
    };
    const traces: StepTrace[] = [trace('s1'), trace('s3')];

    const result = checkStepCompleteness(contract, traces);

    // s2 is expected to be skipped, so no critical finding for it
    const missing = findingsByCheck(result, 'step_completeness');
    expect(missing).toHaveLength(0);
    expect(result.missingSteps).toEqual([]);
    expect(result.coveredSteps).toEqual(['s1', 's3']);
  });

  it('17. level defaults to 0 if not specified', () => {
    const contract: CompletenessContract = {
      workflowSteps: [step('s1')],
    };
    // Stub trace — would fail at level 1, but should pass at default level 0
    const traces: StepTrace[] = [stubTrace('s1')];

    const result = checkStepCompleteness(contract, traces);

    // No stub detection at level 0
    const stubs = findingsByCheck(result, 'step_stub_detected');
    expect(stubs).toHaveLength(0);

    // Step is covered
    expect(result.coveredSteps).toEqual(['s1']);
    expect(result.missingSteps).toEqual([]);
  });

  it('18. expected skip + extra trace combo', () => {
    const contract: CompletenessContract = {
      workflowSteps: [step('s1'), step('s2')],
      expectedSkips: ['s2'],
    };
    const traces: StepTrace[] = [trace('s1'), trace('s_extra')];

    const result = checkStepCompleteness(contract, traces);

    expect(result.coveredSteps).toEqual(['s1']);
    expect(result.missingSteps).toEqual([]);
    expect(result.extraSteps).toEqual(['s_extra']);

    const extra = findingsByCheck(result, 'step_extra');
    expect(extra).toHaveLength(1);
    const missing = findingsByCheck(result, 'step_completeness');
    expect(missing).toHaveLength(0);
  });

  it('19. all findings have evidenceEventId as empty string', () => {
    const contract: CompletenessContract = {
      workflowSteps: [step('s1'), step('s2')],
    };
    const traces: StepTrace[] = [trace('s1')];

    const result = checkStepCompleteness(contract, traces, { level: 0 });

    for (const f of result.findings) {
      expect(f.evidenceEventId).toBe('');
    }
  });
});
