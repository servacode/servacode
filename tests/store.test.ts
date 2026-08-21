import { afterEach, describe, expect, it } from 'vitest';
import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../src/store/store.js';
import { traceFile } from '../src/store/paths.js';
import { cleanup, freshStore, testDeps } from './helpers.js';

/**
 * TEST CATEGORY E — immutable trace.
 * TEST CATEGORY F — supersession.
 * TEST CATEGORY K — storage.
 */

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) cleanup(r);
});

function makeStore(): Store {
  const { store, root } = freshStore();
  roots.push(root);
  return store;
}

describe('E — immutable trace (08 KI-1, SC-POL-022)', () => {
  it('exposes no update or delete operation on the trace log', () => {
    const store = makeStore();
    const log = store.trace('audit');
    const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(log));
    expect(surface).toContain('append');
    expect(surface).toContain('readAll');
    expect(surface).toContain('verify');
    expect(surface).not.toContain('update');
    expect(surface).not.toContain('delete');
    expect(surface).not.toContain('remove');
    expect(surface).not.toContain('rewrite');
  });

  it('hash-chains records so the chain verifies', () => {
    const store = makeStore();
    const tx = store.begin();
    tx.appendTrace('demo', { type: 'A', payload: { n: 1 } });
    tx.appendTrace('demo', { type: 'B', payload: { n: 2 } });
    tx.appendTrace('demo', { type: 'C', payload: { n: 3 } });
    tx.commit();

    const records = store.readTrace('demo');
    expect(records).toHaveLength(3);
    expect(records.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(store.trace('demo').verify()).toEqual({ ok: true });
  });

  it('detects a record rewritten outside the API', () => {
    const store = makeStore();
    const tx = store.begin();
    tx.appendTrace('demo', { type: 'A', payload: { amount: 100 } });
    tx.appendTrace('demo', { type: 'B', payload: { amount: 200 } });
    tx.commit();

    // Tamper directly on disk: change a historical payload.
    const path = traceFile(store.paths, 'demo');
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    const first = JSON.parse(lines[0]!) as { payload: { amount: number } };
    first.payload.amount = 999;
    lines[0] = JSON.stringify(first);
    writeFileSync(path, lines.join('\n') + '\n', 'utf8');

    const v = store.trace('demo').verify();
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.brokenAt).toBe(0);
      expect(v.detail).toMatch(/modified/);
    }
  });

  it('detects a record deleted from the middle of a stream', () => {
    const store = makeStore();
    const tx = store.begin();
    for (const n of [1, 2, 3]) tx.appendTrace('demo', { type: 'X', payload: { n } });
    tx.commit();

    const path = traceFile(store.paths, 'demo');
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    writeFileSync(path, [lines[0], lines[2]].join('\n') + '\n', 'utf8');

    expect(store.trace('demo').verify().ok).toBe(false);
  });

  it('detects an appended forgery that does not continue the chain', () => {
    const store = makeStore();
    const tx = store.begin();
    tx.appendTrace('demo', { type: 'A', payload: {} });
    tx.commit();

    appendFileSync(
      traceFile(store.paths, 'demo'),
      JSON.stringify({
        seq: 2,
        at: '2026-01-01T00:00:00.000Z',
        actor: 'ATTACKER',
        type: 'FORGED',
        payload: { verdict: 'PASS' },
        prevDigest: '0'.repeat(64),
        digest: 'f'.repeat(64),
      }) + '\n',
      'utf8',
    );

    expect(store.trace('demo').verify().ok).toBe(false);
  });
});

describe('F — supersession is forward-only (08 §6.2)', () => {
  it('records supersedes on the NEW record and never touches the old one', () => {
    const store = makeStore();

    const tx1 = store.begin();
    tx1.putCanon('decision', 'SC-DEC-000001', { title: 'Use approach A' });
    tx1.commit();

    const originalPath = join(store.paths.canon, 'decision', 'SC-DEC-000001', 'v1.json');
    const before = readFileSync(originalPath, 'utf8');

    const tx2 = store.begin();
    tx2.putCanon(
      'decision',
      'SC-DEC-000002',
      { title: 'Use approach B' },
      {
        supersedes: 'SC-DEC-000001',
      },
    );
    tx2.commit();

    const after = readFileSync(originalPath, 'utf8');
    expect(after).toBe(before); // byte-identical: the old record was not touched

    const old = store.getCanon<{ title: string }>('decision', 'SC-DEC-000001');
    expect(old).toBeDefined();
    expect(Object.keys(old!)).not.toContain('superseded_by');
    expect(Object.keys(old!)).not.toContain('supersededBy');

    const neu = store.getCanon<{ title: string }>('decision', 'SC-DEC-000002');
    expect(neu?.supersedes).toBe('SC-DEC-000001');
  });

  it('derives the reverse index from forward links', () => {
    const store = makeStore();
    const tx = store.begin();
    tx.putCanon('decision', 'SC-DEC-000001', { title: 'v1' });
    tx.putCanon('decision', 'SC-DEC-000002', { title: 'v2' }, { supersedes: 'SC-DEC-000001' });
    tx.commit();

    expect(store.supersededBy('decision', 'SC-DEC-000001')).toEqual(['SC-DEC-000002@v1']);
    expect(store.supersededBy('decision', 'SC-DEC-000002')).toEqual([]);
  });

  it('versions canon immutably: v1 survives when v2 is written', () => {
    const store = makeStore();
    const tx1 = store.begin();
    tx1.putCanon('project', 'SC-PROJ-000001', { name: 'first' });
    tx1.commit();
    const tx2 = store.begin();
    tx2.putCanon('project', 'SC-PROJ-000001', { name: 'second' });
    tx2.commit();

    expect(store.listCanonVersions('project', 'SC-PROJ-000001')).toEqual([1, 2]);
    expect(store.getCanon<{ name: string }>('project', 'SC-PROJ-000001', 1)?.body.name).toBe(
      'first',
    );
    expect(store.getCanon<{ name: string }>('project', 'SC-PROJ-000001')?.body.name).toBe('second');
  });
});

describe('K — storage transactions and recovery', () => {
  it('rollback discards every staged write', () => {
    const store = makeStore();
    const tx = store.begin();
    tx.putCanon('requirement', 'SC-REQ-000001', { statement: 'x' });
    tx.appendTrace('demo', { type: 'A', payload: {} });
    expect(tx.pendingCount).toBe(2);
    tx.rollback();

    expect(store.getCanon('requirement', 'SC-REQ-000001')).toBeUndefined();
    expect(store.readTrace('demo')).toHaveLength(0);
  });

  it('refuses to reuse a committed transaction', () => {
    const store = makeStore();
    const tx = store.begin();
    tx.putCanon('requirement', 'SC-REQ-000001', { statement: 'x' });
    tx.commit();
    expect(() => tx.putCanon('requirement', 'SC-REQ-000002', { statement: 'y' })).toThrowError(
      /is closed/,
    );
    expect(() => tx.rollback()).toThrowError(/already committed/);
  });

  it('commits multi-record writes atomically', () => {
    const store = makeStore();
    const tx = store.begin();
    tx.putCanon('requirement', 'SC-REQ-000001', { statement: 'a' });
    tx.putCanon('requirement', 'SC-REQ-000002', { statement: 'b' });
    tx.appendTrace('audit', { type: 'CANON_WRITTEN', payload: { count: 2 } });
    tx.commit();

    expect(store.getCanon('requirement', 'SC-REQ-000001')).toBeDefined();
    expect(store.getCanon('requirement', 'SC-REQ-000002')).toBeDefined();
    expect(store.readTrace('audit')).toHaveLength(1);
  });

  it('reopens cleanly after shutdown and preserves all state', () => {
    const { store, root, deps } = freshStore();
    roots.push(root);
    const tx = store.begin();
    tx.putCanon('project', 'SC-PROJ-000001', { name: 'persisted' });
    tx.appendTrace('audit', { type: 'PROJECT_INITIALIZED', payload: {} });
    tx.commit();

    const reopened = Store.open(root, deps);
    expect(reopened.getCanon<{ name: string }>('project', 'SC-PROJ-000001')?.body.name).toBe(
      'persisted',
    );
    expect(reopened.readTrace('audit')).toHaveLength(1);
    expect(reopened.trace('audit').verify().ok).toBe(true);
  });

  it('recovery re-applies a committed journal left behind by a crash', () => {
    const { store, root, deps } = freshStore();
    roots.push(root);

    // Simulate: process died after the commit point but before applying writes.
    const target = join(store.paths.canon, 'requirement', 'SC-REQ-000099', 'v1.json');
    const journal = join(store.paths.journal, 'SC-TX-000999.commit');
    mkdirSync(store.paths.journal, { recursive: true });
    writeFileSync(
      journal,
      JSON.stringify({
        txId: 'SC-TX-000999',
        createdAt: '2026-01-01T00:00:00.000Z',
        writes: [
          {
            kind: 'FILE',
            path: target,
            contents: JSON.stringify({ id: 'SC-REQ-000099', body: { statement: 'recovered' } }),
          },
        ],
      }),
      'utf8',
    );
    expect(existsSync(target)).toBe(false);

    const reopened = Store.open(root, deps);
    expect(existsSync(target)).toBe(true);
    expect(existsSync(journal)).toBe(false);
    expect(reopened.recover()).toEqual({ reapplied: 0, discarded: 0 });
  });

  it('recovery discards a staged journal that never reached the commit point', () => {
    const { store, root, deps } = freshStore();
    roots.push(root);

    const target = join(store.paths.canon, 'requirement', 'SC-REQ-000098', 'v1.json');
    const staged = join(store.paths.journal, 'SC-TX-000998.json');
    mkdirSync(store.paths.journal, { recursive: true });
    writeFileSync(
      staged,
      JSON.stringify({
        txId: 'SC-TX-000998',
        createdAt: '2026-01-01T00:00:00.000Z',
        writes: [{ kind: 'FILE', path: target, contents: '{}' }],
      }),
      'utf8',
    );

    Store.open(root, deps);
    expect(existsSync(target)).toBe(false); // never applied
    expect(existsSync(staged)).toBe(false); // discarded
  });

  it('refuses to open a store with an unexpected schema version', () => {
    const { store, root, deps } = freshStore();
    roots.push(root);
    writeFileSync(store.paths.schemaVersion, '99\n', 'utf8');
    expect(() => Store.open(root, deps)).toThrowError(/schema version/);
  });

  it('refuses to open a directory that is not a Serva store', () => {
    const { root } = freshStore();
    roots.push(root);
    const empty = join(root, 'not-a-project');
    mkdirSync(empty, { recursive: true });
    expect(() => Store.open(empty, testDeps())).toThrowError(/No Serva store/);
  });

  it('refuses to initialize twice in the same directory', () => {
    const { root } = freshStore();
    roots.push(root);
    expect(() => Store.initialize(root, testDeps())).toThrowError(/already exists/);
  });

  it('the store is inspectable as plain text without Serva running (ST-2)', () => {
    const store = makeStore();
    const tx = store.begin();
    tx.putCanon('project', 'SC-PROJ-000001', { name: 'readable' });
    tx.appendTrace('audit', { type: 'X', payload: { k: 'v' } });
    tx.commit();

    const canon = readFileSync(
      join(store.paths.canon, 'project', 'SC-PROJ-000001', 'v1.json'),
      'utf8',
    );
    expect(JSON.parse(canon)).toMatchObject({ body: { name: 'readable' } });

    const trace = readFileSync(traceFile(store.paths, 'audit'), 'utf8');
    expect(JSON.parse(trace.trim().split('\n')[0]!)).toMatchObject({ type: 'X' });
  });

  it('T-DERIVED is freely rewritable and never authoritative', () => {
    const store = makeStore();
    store.putDerived('index', { a: 1 });
    store.putDerived('index', { a: 2 });
    expect(store.getDerived<{ a: number }>('index')?.a).toBe(2);
  });
});
