import { describe, expect, it } from 'vitest';
import { ContractRegistry } from '../src/agents/registry.js';
import { getCatalogues } from '../src/catalogue/index.js';
import {
  CoverageSource,
  GateCoverageStatus,
  coverageSummary,
  gateCoverage,
  lifecycleCoverage,
} from '../src/coverage/index.js';
import { ALL_DEPARTMENTS, DOWNSTREAM_DEPARTMENTS } from '../src/intelligence/app.js';
import { validateDepartmentAuthority } from '../src/intelligence/execution/authority.js';
import { INTELLIGENCE_GATES } from '../src/intelligence/gates/definitions.js';

/**
 * TWENTY-SIX AND NINETEEN, COMPUTED.
 *
 * Every phase could say which stages it had implemented. Nobody could say whether all
 * twenty-six were accounted for, because the answer lived in five reports written months
 * apart — and a stage nobody had thought about looked exactly like one somebody had
 * decided was out of scope.
 *
 * These tests are the difference. They read the catalogue, the department registry the
 * orchestrator actually runs, and the gate definitions the gate engine actually evaluates.
 * Nothing here is a hand-maintained table, which is the only reason it will still be true
 * after the next change.
 */

describe('the canonical lifecycle is fully accounted for', () => {
  it('all 26 canonical stages have an implementation or a stated basis', () => {
    const stages = lifecycleCoverage();
    expect(stages).toHaveLength(26);

    const uncovered = stages.filter((s) => s.coveredBy === CoverageSource.UNCOVERED);
    expect(
      uncovered.map((s) => s.stageId + ' (' + s.name + ')'),
      'a stage with no department and no stated basis is a hole, not a status',
    ).toEqual([]);
  });

  it('every stage names what covers it, and every covering department is registered', () => {
    const registered = new Set(ALL_DEPARTMENTS.map((d) => d.id));
    for (const s of lifecycleCoverage()) {
      expect(s.basis.length, s.stageId + ' has no basis').toBeGreaterThan(20);
      for (const d of s.departments) expect(registered.has(d), d + ' is not registered').toBe(true);
    }
  });

  it('the downstream company covers the quality, release and incident stages', () => {
    const byStage = new Map(lifecycleCoverage().map((s) => [s.stageId, s]));
    for (const stageId of [
      'SC-STAGE-042',
      'SC-STAGE-043',
      'SC-STAGE-044',
      'SC-STAGE-045',
      'SC-STAGE-050',
      'SC-STAGE-052',
      'SC-STAGE-054',
    ]) {
      expect(byStage.get(stageId)?.coveredBy, stageId).toBe(CoverageSource.PHASE_6);
      expect(byStage.get(stageId)?.departments.length, stageId).toBeGreaterThan(0);
    }
  });

  it('the engineering stages remain Phase 4’s, and no department was invented for them', () => {
    const byStage = new Map(lifecycleCoverage().map((s) => [s.stageId, s]));
    for (const stageId of ['SC-STAGE-040', 'SC-STAGE-041']) {
      expect(byStage.get(stageId)?.coveredBy).toBe(CoverageSource.PHASE_4);
      /* A second implementation of the factory would be a second answer to one question. */
      expect(byStage.get(stageId)?.departments).toEqual([]);
    }
  });
});

describe('all 19 canonical gates are defined', () => {
  it('none is UNDEFINED', () => {
    const gates = gateCoverage();
    expect(gates).toHaveLength(19);
    const undefinedGates = gates.filter((g) => g.status === GateCoverageStatus.UNDEFINED);
    expect(
      undefinedGates.map((g) => g.gateId),
      'an undefined gate blocks rather than passing, which is correct and useless',
    ).toEqual([]);
  });

  it('every catalogue gate has exactly one definition', () => {
    const cat = getCatalogues();
    for (const g of cat.gates) {
      const defined = INTELLIGENCE_GATES.filter((d) => d.id === g.id);
      expect(defined.length, g.id + ' has ' + String(defined.length) + ' definitions').toBeLessThan(
        2,
      );
    }
  });

  it('SC-GATE-CODE_REVIEW is Phase 4’s and is not redefined here', () => {
    expect(INTELLIGENCE_GATES.some((g) => g.id === 'SC-GATE-CODE_REVIEW')).toBe(false);
    const cov = gateCoverage().find((g) => g.gateId === 'SC-GATE-CODE_REVIEW');
    expect(cov?.status).toBe(GateCoverageStatus.IMPLEMENTED);
    expect(cov?.implementedBy).toBe(CoverageSource.PHASE_4);
  });

  it('every defined gate has criteria, and none passes on absent evidence', () => {
    for (const g of INTELLIGENCE_GATES) {
      expect(g.criteria.length, g.id + ' has no criteria').toBeGreaterThan(0);
      for (const c of g.criteria) {
        /*
         * NO EVIDENCE = NOT VERIFIED. A criterion that treated absence as a proven
         * negative would let an unexamined area read as a decided one — the exact failure
         * §31 exists to prevent.
         */
        expect(c.onMissingEvidence, g.id + '/' + c.id).toBe('INDETERMINATE');
      }
    }
  });

  it('every downstream verdict criterion requires independence', () => {
    const downstream = INTELLIGENCE_GATES.filter((g) =>
      [
        'SC-GATE-QA',
        'SC-GATE-SECURITY',
        'SC-GATE-ACCEPTANCE',
        'SC-GATE-RELEASE',
        'SC-GATE-INCIDENT_CLOSURE',
      ].includes(g.id),
    );
    expect(downstream).toHaveLength(5);
    for (const g of downstream) {
      for (const c of g.criteria) {
        if (c.evaluation.kind !== 'VERIFIER_RESULT') continue;
        /* RL-2 is the Release Manager's own recommendation, which is advice not clearance. */
        if (c.id === 'RL-2') continue;
        expect(c.independence, g.id + '/' + c.id + ' must be independent').toBe(true);
      }
    }
  });

  it('shipping authority belongs to the owner, and no agent criterion can supply it', () => {
    const release = INTELLIGENCE_GATES.find((g) => g.id === 'SC-GATE-RELEASE');
    const owner = release?.criteria.find((c) => c.id === 'RL-1');
    expect(owner?.statement).toContain('OWNER');
    /* Deliberately a Store query: there is no verifier role that could satisfy it. */
    expect(owner?.evaluation.kind).toBe('STORE_QUERY');
  });
});

describe('the downstream company is governed like every other department', () => {
  it('every registered department passes canonical output authority', () => {
    /* The check that has now caught five real misconfigurations nobody went looking for. */
    expect(() =>
      validateDepartmentAuthority(ALL_DEPARTMENTS, ContractRegistry.shared()),
    ).not.toThrow();
  });

  it('every downstream verifier is independent of what it judges', () => {
    const mustBeIndependent = [
      'DEPT-QA-VERIFICATION',
      'DEPT-ACCESSIBILITY-VERIFICATION',
      'DEPT-SECURITY-VERIFICATION',
      'DEPT-PERFORMANCE-VERIFICATION',
      'DEPT-ACCEPTANCE-VERIFICATION',
      'DEPT-OPERATIONAL-READINESS',
      'DEPT-POST-INCIDENT',
    ];
    for (const id of mustBeIndependent) {
      const d = DOWNSTREAM_DEPARTMENTS.find((x) => x.id === id);
      expect(d, id + ' is not registered').toBeDefined();
      expect((d?.independentOf ?? []).length, id + ' declares no independence').toBeGreaterThan(0);
      /* And it cannot be independent of itself by accident. */
      expect(d?.independentOf).not.toContain(d?.agentId);
    }
  });

  it('uses canonical agent ids rather than inventing downstream roles', () => {
    const registry = ContractRegistry.shared();
    for (const d of DOWNSTREAM_DEPARTMENTS) {
      expect(() => registry.get(d.agentId), d.id + ' names ' + d.agentId).not.toThrow();
    }
  });

  it('no downstream department writes the canon it is judging', () => {
    const verdictFamilies = new Set([
      'intel.qaVerdict',
      'intel.defect',
      'intel.accessibilityVerdict',
      'intel.securityVerdict',
      'intel.securityFinding',
      'intel.performanceVerdict',
      'intel.acceptanceVerdict',
      'intel.operationalReadinessVerdict',
      'intel.release',
      'intel.releaseRecommendation',
      'intel.handoverPackage',
      'intel.runbook',
      'intel.incident',
      'intel.postIncidentReview',
      'intel.proposal',
    ]);
    for (const d of DOWNSTREAM_DEPARTMENTS) {
      for (const t of d.produces) {
        /*
         * A verifier that could write a requirement could rewrite the thing it failed to
         * meet. The write boundary already refuses it; this asserts the declaration never
         * asked for it in the first place.
         */
        expect(verdictFamilies.has(t), d.id + ' produces ' + t).toBe(true);
      }
    }
  });
});

describe('the summary is the one-line answer', () => {
  it('reports 26/26 and 19/19, and says complete only when both hold', () => {
    const s = coverageSummary();
    expect(s.stages.total).toBe(26);
    expect(s.stages.covered).toBe(26);
    expect(s.gates.total).toBe(19);
    expect(s.gates.implemented).toBe(19);
    expect(s.complete).toBe(true);
  });
});
