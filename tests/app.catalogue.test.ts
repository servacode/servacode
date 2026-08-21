import { afterEach, describe, expect, it } from 'vitest';
import { getCatalogues } from '../src/catalogue/index.js';
import { enforcementCoverage, getPolicy, listPolicies } from '../src/policy/registry.js';
import { runDoctor } from '../src/app/doctor.js';
import { ServaRuntime, SERVA_VERSION, SPEC_BASELINE } from '../src/app/runtime.js';
import { parseArgs, run } from '../src/cli/main.js';
import { FixedClock } from '../src/core/clock.js';
import { SequentialIdSource, assertIdPrefix, parseIdPrefix } from '../src/core/ids.js';
import { canonicalJson, chainDigest, digestOf, GENESIS_DIGEST } from '../src/core/hash.js';
import { GovernanceState } from '../src/vocab/index.js';
import { cleanup, freshRuntime, tempRoot } from './helpers.js';

/**
 * Application foundation, canonical catalogue loading, policy registry and CLI.
 */

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) cleanup(r);
});

describe('canonical catalogue loading (30 CAT-1)', () => {
  const cat = getCatalogues();

  it('loads every catalogue generated from the R4 specification', () => {
    expect(cat.departmentIds.length).toBeGreaterThan(0);
    expect(cat.agentIds.length).toBeGreaterThan(0);
    expect(cat.stageIds.length).toBeGreaterThan(0);
    expect(cat.gateIds.length).toBeGreaterThan(0);
    expect(cat.workflowIds.length).toBeGreaterThan(0);
    expect(cat.policyIds.length).toBeGreaterThan(0);
    expect(cat.runtimeComponentIds.length).toBeGreaterThan(0);
  });

  it('cardinalities match the R4 baseline exactly', () => {
    expect(cat.counts['departments']).toBe(30);
    expect(cat.counts['agents']).toBe(55);
    expect(cat.counts['runtimeComponents']).toBe(19);
    expect(cat.counts['stages']).toBe(26);
    expect(cat.counts['gates']).toBe(19);
    expect(cat.counts['workflows']).toBe(15);
    expect(cat.counts['policies']).toBe(35);
  });

  it('records the source document and its digest, so drift is detectable', () => {
    expect(cat.$generated.from).toContain('30_CANONICAL_CATALOGUES.md');
    expect(cat.$generated.specDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('R-TIER: agent tier is derived from department, never stored on the agent', () => {
    const agent = cat.agent('SC-AGENT-150');
    expect(agent).toBeDefined();
    expect(Object.keys(agent!)).not.toContain('tier');
    expect(cat.tierOfAgent('SC-AGENT-150')).toBe(cat.department(agent!.departmentId)?.tier);
    expect(cat.tierOfAgent('SC-AGENT-150')).toBe(4);
  });

  it('every agent references a department that exists', () => {
    for (const a of cat.agents) expect(cat.department(a.departmentId), a.id).toBeDefined();
  });

  it('retired identifiers are absent from the live catalogue (30 §10)', () => {
    for (const retired of ['SC-AGENT-012', 'SC-AGENT-212', 'SC-AGENT-241', 'SC-AGENT-021']) {
      expect(cat.agentIds).not.toContain(retired);
    }
    for (const retired of ['SC-STAGE-001', 'SC-STAGE-012', 'SC-STAGE-014', 'SC-STAGE-051']) {
      expect(cat.stageIds).not.toContain(retired);
    }
  });

  it('the gate catalogue contains the R4 gate set', () => {
    expect(cat.gateIds).toContain('SC-GATE-ACCEPTANCE');
    expect(cat.gateIds).toContain('SC-GATE-CODE_REVIEW');
    expect(cat.gate('SC-GATE-ACCEPTANCE')?.blocking).toBe(true);
  });
});

describe('policy registry', () => {
  it('lists every policy from the catalogue', () => {
    expect(listPolicies()).toHaveLength(35);
    expect(getPolicy('SC-POL-005').name).toMatch(/Evidence Before PASS/);
    expect(getPolicy('SC-POL-035').name).toMatch(/Provider Capability/);
  });

  it('reports which policies the Phase 2 core enforces, and which it does not (29 CF-2)', () => {
    const cov = enforcementCoverage();
    expect(cov.total).toBe(35);
    expect(cov.enforced).toBeGreaterThan(0);
    expect(cov.enforced).toBeLessThan(cov.total); // honest: the core does not enforce all of them yet
    expect(cov.unenforced.length).toBe(cov.total - cov.enforced);
  });

  it('refuses an unknown policy identifier', () => {
    expect(() => getPolicy('SC-POL-999')).toThrowError(/Unknown policy/);
  });
});

describe('core primitives', () => {
  it('canonical JSON sorts keys so digests are reproducible', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(digestOf({ a: 1, b: 2 })).toBe(digestOf({ b: 2, a: 1 }));
  });

  it('drops undefined rather than emitting it', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('chain digests depend on the predecessor', () => {
    const d1 = chainDigest(GENESIS_DIGEST, { n: 1 });
    const d2 = chainDigest(d1, { n: 2 });
    const d2Alt = chainDigest(GENESIS_DIGEST, { n: 2 });
    expect(d2).not.toBe(d2Alt);
  });

  it('identifier prefixes are parsed and asserted', () => {
    expect(parseIdPrefix('SC-REQ-000001')).toBe('SC-REQ');
    expect(() => assertIdPrefix('SC-REQ-000001', 'SC-DEC')).toThrowError(/expected SC-DEC/);
    expect(() => parseIdPrefix('nonsense')).toThrowError(/Malformed identifier/);
  });

  it('the deterministic id source is reproducible', () => {
    const a = new SequentialIdSource();
    const b = new SequentialIdSource();
    expect(a.next('SC-REQ')).toBe(b.next('SC-REQ'));
    expect(a.next('SC-REQ')).toBe('SC-REQ-000002');
  });

  it('FixedClock advances deterministically and can jump', () => {
    const c = new FixedClock('2026-01-01T00:00:00.000Z', 1000);
    expect(c.now()).toBe('2026-01-01T00:00:00.000Z');
    expect(c.now()).toBe('2026-01-01T00:00:01.000Z');
    c.advance(60_000);
    expect(c.now()).toBe('2026-01-01T00:01:02.000Z');
  });
});

describe('runtime and doctor', () => {
  it('init creates a project and reports ACTIVE governance', () => {
    const { rt, root } = freshRuntime('Doctor Project', 'the idea');
    roots.push(root);
    expect(rt.requireProject().name).toBe('Doctor Project');
    expect(rt.startupReport.governance).toBe(GovernanceState.ACTIVE);
    expect(rt.startupReport.degradedReasons).toEqual([]);
  });

  it('refuses to initialize twice', () => {
    const { root } = freshRuntime('Once');
    roots.push(root);
    expect(() =>
      ServaRuntime.init('Twice', 'x', {
        root,
        clock: new FixedClock(),
        ids: new SequentialIdSource(),
      }),
    ).toThrowError(/already exists/);
  });

  it('doctor passes on a healthy store and reports the substrate honestly', () => {
    const { rt, root } = freshRuntime('Healthy');
    roots.push(root);
    const report = runDoctor(rt, root);
    expect(report.ok).toBe(true);
    expect(report.checks.find((c) => c.id === 'TRACE_INTEGRITY')?.status).toBe('OK');

    // 33 PC-5 — the substrate check must never silently claim HARD.
    const substrate = report.checks.find((c) => c.id === 'ENV_SUBSTRATE');
    expect(substrate).toBeDefined();
    if (process.platform === 'win32' && process.env['WSL_DISTRO_NAME'] === undefined) {
      expect(substrate?.status).toBe('WARN');
      expect(substrate?.detail).toMatch(/SOFT/);
    }
  });

  it('doctor warns rather than failing when no project exists', () => {
    const bare = tempRoot();
    roots.push(bare);
    const report = runDoctor(undefined, bare);
    expect(report.governance).toBe(GovernanceState.INACTIVE);
    expect(report.checks.find((c) => c.id === 'PROJ_PRESENT')?.status).toBe('WARN');
  });

  it('exposes the implementation version and the specification baseline separately', () => {
    expect(SERVA_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(SPEC_BASELINE).toBe('R4');
  });
});

describe('CLI foundation', () => {
  it('parses flags, values and positionals', () => {
    const a = parseArgs(['init', 'MyProject', '--idea', 'some idea', '--json']);
    expect(a.command).toBe('init');
    expect(a.positionals).toEqual(['MyProject']);
    expect(a.flags['idea']).toBe('some idea');
    expect(a.flags['json']).toBe(true);
  });

  it('supports --key=value form', () => {
    const a = parseArgs(['status', '--root=/tmp/x']);
    expect(a.flags['root']).toBe('/tmp/x');
  });

  it('defaults to help with no arguments', () => {
    expect(parseArgs([]).command).toBe('help');
    expect(run(['help'])).toBe(0);
  });

  it('returns a non-zero code for an unknown command', () => {
    expect(run(['nonsense-command'])).toBe(2);
  });

  it('status and project run against a real store', () => {
    const { root } = freshRuntime('CLI Project', 'cli idea');
    roots.push(root);
    expect(run(['status', '--root', root, '--json'])).toBe(0);
    expect(run(['project', '--root', root, '--json'])).toBe(0);
    expect(run(['gates', '--root', root])).toBe(0);
    expect(run(['workflows', '--root', root])).toBe(0);
    expect(run(['doctor', '--root', root, '--json'])).toBe(0);
  });

  it('reports a missing project as an actionable error, not a crash', () => {
    const bare = tempRoot();
    roots.push(bare);
    expect(run(['status', '--root', bare])).toBe(1);
  });
});
