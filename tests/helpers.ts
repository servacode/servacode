import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FixedClock } from '../src/core/clock.js';
import { SequentialIdSource } from '../src/core/ids.js';
import { ServaRuntime } from '../src/app/runtime.js';
import { Store, type StoreDeps } from '../src/store/store.js';
import {
  CriterionBasis,
  CriterionResult,
  Severity,
  type IndeterminateReason,
} from '../src/vocab/index.js';
import type {
  ArtifactVerifierResult,
  Criterion,
  CriterionEvaluation,
  Qualification,
} from '../src/gates/types.js';

/** Deterministic dependency set: no wall clock, no randomness. */
export function testDeps(actor = 'TEST_RUNTIME'): StoreDeps {
  return { clock: new FixedClock(), ids: new SequentialIdSource(), actor };
}

/**
 * Every temporary root this process created, so none of them outlives it.
 *
 * Suites that own a root clean it up in `afterEach`, and most do. The ones that do not —
 * and there are a lot of them, spread over five phases — leaked a directory per test, which
 * over a few hundred runs filled a disk and turned the whole suite red for a reason that
 * had nothing to do with the code under test.
 *
 * So cleanup is a property of `tempRoot` rather than of the discipline of every caller.
 */
const created: string[] = [];

export function tempRoot(prefix = 'serva-test-'): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  created.push(root);
  return root;
}

export function cleanup(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

/*
 * The backstop, per worker process.
 *
 * `exit` handlers must be synchronous, which `rmSync` is. Failures are swallowed: a
 * directory Windows still holds a handle on is a nuisance, and a test run that failed
 * during teardown would report the nuisance instead of the result.
 */
process.on('exit', () => {
  for (const root of created.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* Best effort. */
    }
  }
});

export function freshStore(): { store: Store; root: string; deps: StoreDeps } {
  const root = tempRoot();
  const deps = testDeps();
  const store = Store.initialize(root, deps);
  return { store, root, deps };
}

export function freshRuntime(
  name = 'Test Project',
  idea = 'A raw idea, verbatim.',
): {
  rt: ServaRuntime;
  root: string;
} {
  const root = tempRoot();
  const rt = ServaRuntime.init(name, idea, {
    root,
    clock: new FixedClock(),
    ids: new SequentialIdSource(),
    actor: 'TEST_RUNTIME',
  });
  return { rt, root };
}

let ceCounter = 0;

/** Build a CriterionEvaluation for composition tests. */
export function ce(opts: {
  value: CriterionResult;
  severity: Severity;
  basis?: CriterionBasis;
  reason?: IndeterminateReason;
  waiverRef?: string;
  criterionRef?: string;
  qualifications?: readonly Qualification[];
}): CriterionEvaluation {
  ceCounter += 1;
  const basis = opts.basis ?? CriterionBasis.MEASURED;
  return {
    id: 'SC-CE-' + String(ceCounter).padStart(6, '0'),
    criterionRef: opts.criterionRef ?? 'C' + String(ceCounter),
    value: opts.value,
    basis,
    ...(opts.reason === undefined ? {} : { reason: opts.reason }),
    severity: opts.severity,
    evidenceRefs: [],
    ...(opts.waiverRef === undefined ? {} : { waiverRef: opts.waiverRef }),
    ...(basis === CriterionBasis.JUDGED
      ? {
          judgedBy: {
            role: 'TEST_VERIFIER',
            criteriaApplied: ['c1'],
            confidence: 'MEDIUM' as const,
          },
        }
      : {}),
    qualifications: opts.qualifications ?? [],
    artifactVersionsEvaluated: [],
    evaluatedAt: '2026-01-01T00:00:00.000Z',
  };
}

export function criterion(opts: Partial<Criterion> & { id: string }): Criterion {
  return {
    statement: 'test criterion',
    evaluation: { kind: 'STORE_QUERY', query: 'noop' },
    independence: false,
    severity: Severity.BLOCKING,
    testsExistence: false,
    onMissingEvidence: 'INDETERMINATE',
    policyRefs: [],
    applicability: 'ALWAYS',
    ...opts,
  };
}

let avrCounter = 0;

export function avr(opts: {
  value: ArtifactVerifierResult['value'];
  cause?: IndeterminateReason;
  measured?: string[];
  judged?: string[];
  derived?: string[];
  qualifications?: readonly Qualification[];
}): ArtifactVerifierResult {
  avrCounter += 1;
  return {
    id: 'SC-AVR-' + String(avrCounter).padStart(6, '0'),
    role: 'CODE_REVIEW',
    subject: [],
    value: opts.value,
    ...(opts.cause === undefined ? {} : { cause: opts.cause }),
    dimensionsChecked: ['correctness'],
    dimensionsNotChecked: [],
    findings: [],
    basisSummary: {
      measured: opts.measured ?? [],
      judged: opts.judged ?? [],
      derived: opts.derived ?? [],
    },
    evidenceRefs: ['SC-EV-000001'],
    actor: { runRef: 'SC-RUN-000001', agentId: 'SC-AGENT-200', role: 'CODE_REVIEW' },
    criteriaApplied: ['requirement-satisfaction'],
    confidence: 'MEDIUM',
    qualifications: opts.qualifications ?? [],
    artifactVersionsEvaluated: [],
    dependsOn: [],
    evaluatedAt: '2026-01-01T00:00:00.000Z',
  };
}
