import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MapValidityContext, deriveValidity, isUsable } from '../src/validity/derive.js';
import { ValidityState } from '../src/vocab/index.js';
import { ServaRuntime, discoverProjectRoot } from '../src/app/runtime.js';
import { FixedClock } from '../src/core/clock.js';
import { SequentialIdSource } from '../src/core/ids.js';
import { cleanup, freshRuntime, tempRoot } from './helpers.js';
import type { ValidityBearing } from '../src/validity/derive.js';

/**
 * TEST CATEGORY J — validity.
 * TEST CATEGORY L — cross-project isolation.
 */

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) cleanup(r);
});

const NOW = Date.parse('2026-06-01T00:00:00.000Z');

function record(over: Partial<ValidityBearing> & { id: string }): ValidityBearing {
  return {
    kind: 'GATE_RESULT',
    artifactVersionsCovered: [],
    dependsOn: [],
    ...over,
  };
}

describe('J — derived validity (31 §3.2)', () => {
  it('a record covering current artifact versions is VALID', () => {
    const ctx = new MapValidityContext(NOW);
    ctx.setArtifactVersion('SC-ART-000001', 3);
    const r = record({
      id: 'SC-GR-000001',
      artifactVersionsCovered: [{ artifactId: 'SC-ART-000001', version: 3 }],
    });
    expect(deriveValidity(r, ctx)).toBe(ValidityState.VALID);
    expect(isUsable(deriveValidity(r, ctx))).toBe(true);
  });

  it('an artifact version change makes the verification derive STALE without modifying it', () => {
    const ctx = new MapValidityContext(NOW);
    ctx.setArtifactVersion('SC-ART-000001', 3);
    const r = record({
      id: 'SC-GR-000001',
      artifactVersionsCovered: [{ artifactId: 'SC-ART-000001', version: 3 }],
    });
    const snapshot = JSON.stringify(r);

    expect(deriveValidity(r, ctx)).toBe(ValidityState.VALID);

    ctx.setArtifactVersion('SC-ART-000001', 4); // the artifact changed

    expect(deriveValidity(r, ctx)).toBe(ValidityState.STALE);
    // The historical verification record itself is byte-identical.
    expect(JSON.stringify(r)).toBe(snapshot);
  });

  it('a deleted artifact also derives STALE', () => {
    const ctx = new MapValidityContext(NOW);
    ctx.setArtifactVersion('SC-ART-000001', 1);
    const r = record({
      id: 'SC-GR-000001',
      artifactVersionsCovered: [{ artifactId: 'SC-ART-000001', version: 1 }],
    });
    ctx.removeArtifact('SC-ART-000001');
    expect(deriveValidity(r, ctx)).toBe(ValidityState.STALE);
  });

  it('time-bound validity derives EXPIRED once the clock passes valid_until', () => {
    const ctx = new MapValidityContext(NOW);
    const r = record({
      id: 'SC-EV-000001',
      kind: 'EVIDENCE',
      validUntil: '2026-07-01T00:00:00.000Z',
    });
    expect(deriveValidity(r, ctx)).toBe(ValidityState.VALID);
    ctx.setNow(Date.parse('2026-08-01T00:00:00.000Z'));
    expect(deriveValidity(r, ctx)).toBe(ValidityState.EXPIRED);
  });

  it('a revocation record derives REVOKED; a dispute derives DISPUTED', () => {
    const ctx = new MapValidityContext(NOW);
    const a = record({ id: 'SC-EV-000001', kind: 'EVIDENCE' });
    const b = record({ id: 'SC-EV-000002', kind: 'EVIDENCE' });
    ctx.revoke(a.id);
    ctx.dispute(b.id);
    expect(deriveValidity(a, ctx)).toBe(ValidityState.REVOKED);
    expect(deriveValidity(b, ctx)).toBe(ValidityState.DISPUTED);
  });

  it('INADMISSIBLE applies to Evidence only (31 §3.1, KI-2c)', () => {
    const ctx = new MapValidityContext(NOW);
    const ev = record({ id: 'SC-EV-000001', kind: 'EVIDENCE', provenanceComplete: false });
    expect(deriveValidity(ev, ctx)).toBe(ValidityState.INADMISSIBLE);

    const gr = record({ id: 'SC-GR-000001', kind: 'GATE_RESULT', provenanceComplete: false });
    expect(deriveValidity(gr, ctx)).not.toBe(ValidityState.INADMISSIBLE);
    expect(deriveValidity(gr, ctx)).toBe(ValidityState.VALID);
  });

  it('VD-3: validity propagates through dependsOn without touching the dependency', () => {
    const ctx = new MapValidityContext(NOW);
    ctx.setArtifactVersion('SC-ART-000001', 1);

    const evidence = record({
      id: 'SC-EV-000001',
      kind: 'EVIDENCE',
      artifactVersionsCovered: [{ artifactId: 'SC-ART-000001', version: 1 }],
    });
    const gate = record({ id: 'SC-GR-000001', dependsOn: [evidence.id] });
    ctx.put(evidence);
    ctx.put(gate);

    expect(deriveValidity(gate, ctx)).toBe(ValidityState.VALID);

    ctx.setArtifactVersion('SC-ART-000001', 2);

    expect(deriveValidity(evidence, ctx)).toBe(ValidityState.STALE);
    expect(deriveValidity(gate, ctx)).toBe(ValidityState.STALE); // propagated
  });

  it('a missing dependency derives STALE rather than silently passing', () => {
    const ctx = new MapValidityContext(NOW);
    const gate = record({ id: 'SC-GR-000001', dependsOn: ['SC-EV-MISSING'] });
    expect(deriveValidity(gate, ctx)).toBe(ValidityState.STALE);
  });

  it('a dependency cycle terminates instead of recursing forever', () => {
    const ctx = new MapValidityContext(NOW);
    const a = record({ id: 'SC-GR-000001', dependsOn: ['SC-GR-000002'] });
    const b = record({ id: 'SC-GR-000002', dependsOn: ['SC-GR-000001'] });
    ctx.put(a);
    ctx.put(b);
    expect(() => deriveValidity(a, ctx)).not.toThrow();
    expect(deriveValidity(a, ctx)).toBe(ValidityState.VALID);
  });

  it('revocation outranks staleness and expiry', () => {
    const ctx = new MapValidityContext(NOW);
    ctx.setArtifactVersion('SC-ART-000001', 2);
    const r = record({
      id: 'SC-EV-000001',
      kind: 'EVIDENCE',
      artifactVersionsCovered: [{ artifactId: 'SC-ART-000001', version: 1 }],
      validUntil: '2020-01-01T00:00:00.000Z',
    });
    ctx.revoke(r.id);
    expect(deriveValidity(r, ctx)).toBe(ValidityState.REVOKED);
  });

  it('no ValidityBearing record carries a stored validity field (VD-1)', () => {
    const r = record({ id: 'SC-GR-000001' });
    expect(Object.keys(r)).not.toContain('validity');
    expect(Object.keys(r)).not.toContain('freshness');
    expect(Object.keys(r)).not.toContain('state');
  });
});

describe('L — cross-project isolation (21 PI-1..PI-5)', () => {
  it('two projects keep entirely separate authoritative state', () => {
    const a = freshRuntime('Project A', 'idea A');
    const b = freshRuntime('Project B', 'idea B');
    roots.push(a.root, b.root);

    const pa = a.rt.requireProject();
    const pb = b.rt.requireProject();
    expect(pa.name).toBe('Project A');
    expect(pb.name).toBe('Project B');
    expect(pa.idea.text).toBe('idea A');
    expect(pb.idea.text).toBe('idea B');

    const txa = a.rt.store.begin();
    txa.putCanon('requirement', 'SC-REQ-000001', { statement: 'only in A' });
    txa.commit();

    // B cannot see A's records.
    expect(b.rt.store.getCanon('requirement', 'SC-REQ-000001')).toBeUndefined();
    expect(b.rt.store.listCanonIds('requirement')).toEqual([]);
    expect(a.rt.store.listCanonIds('requirement')).toEqual(['SC-REQ-000001']);
  });

  it('project roots and stores are disjoint paths', () => {
    const a = freshRuntime('A');
    const b = freshRuntime('B');
    roots.push(a.root, b.root);
    expect(a.rt.root).not.toBe(b.rt.root);
    expect(a.rt.store.paths.serva.startsWith(b.rt.root)).toBe(false);
    expect(b.rt.store.paths.serva.startsWith(a.rt.root)).toBe(false);
  });

  it('trace streams do not bleed between projects', () => {
    const a = freshRuntime('A');
    const b = freshRuntime('B');
    roots.push(a.root, b.root);

    const tx = a.rt.store.begin();
    tx.appendTrace('demo', { type: 'ONLY_A', payload: {} });
    tx.commit();

    expect(a.rt.store.readTrace('demo').map((r) => r.type)).toEqual(['ONLY_A']);
    expect(b.rt.store.readTrace('demo')).toEqual([]);
  });

  it('root discovery finds the nearest project and stops there', () => {
    const outer = tempRoot();
    roots.push(outer);
    ServaRuntime.init('Outer', 'outer idea', {
      root: outer,
      clock: new FixedClock(),
      ids: new SequentialIdSource(),
    });
    const inner = join(outer, 'sub', 'deeper');
    require('node:fs').mkdirSync(inner, { recursive: true });
    expect(discoverProjectRoot(inner)).toBe(outer);
  });

  it('discovery returns undefined outside any project', () => {
    const bare = tempRoot();
    roots.push(bare);
    expect(discoverProjectRoot(bare)).toBeUndefined();
    expect(() => ServaRuntime.open({ cwd: bare })).toThrowError(/No Serva project found/);
  });

  it('the Idea is stored verbatim and immutably (03 §2)', () => {
    const idea = 'Build a thing that does X, exactly as I said it.';
    const a = freshRuntime('Verbatim', idea);
    roots.push(a.root);
    const p = a.rt.requireProject();
    expect(p.idea.text).toBe(idea);

    const onDisk = readFileSync(join(a.rt.store.paths.canon, 'project', p.id, 'v1.json'), 'utf8');
    expect(JSON.parse(onDisk).body.idea.text).toBe(idea);
  });
});
