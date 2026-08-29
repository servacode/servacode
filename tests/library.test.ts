import { afterEach, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FixedClock } from '../src/core/clock.js';
import {
  LibraryEntryKind,
  contributeToLibrary,
  deleteLibraryEntry,
  describeLibrary,
  libraryProvenance,
  libraryRoot,
  readLibrary,
} from '../src/learning/library.js';
import { cleanup, tempRoot } from './helpers.js';

/**
 * THE WALL HELD, AND THERE WAS NOWHERE TO PUT WHAT GOT THROUGH IT.
 *
 * Phase 5 refused anything carrying a path, a URL, an email, a project id or a fragment of
 * code — and then wrote the result into the same project it came from, where no other
 * project could ever see it. These tests are about the door that was missing, and about
 * the fact that opening it changed nothing about the wall.
 */

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) cleanup(r);
});

function library(): { root: string; enabled: true } {
  const root = tempRoot();
  roots.push(root);
  return { root: join(root, 'library'), enabled: true };
}

const clock = { clock: new FixedClock() };

const GENERAL = {
  kind: LibraryEntryKind.PATTERN,
  title: 'Separate the actor that produces work from the actor that verifies it',
  body: {
    context: 'Any workflow where the same role would otherwise mark its own output',
    problem: 'A reviewer who wrote the work reads its own intent into it and agrees',
    solution: 'Require a different actor, and record which one judged',
  },
};

describe('the library is off until the owner turns it on', () => {
  it('contributes nothing while disabled, and reads nothing either', () => {
    const target = { ...library(), enabled: false as const };
    const result = contributeToLibrary(clock, { ...target, ...GENERAL, knownNames: [] });
    expect(result.entry).toBeUndefined();
    expect(result.refused).toContain('organizational learning is off');
    /* Not even the directory: a disabled feature that touches files is a surprise. */
    expect(existsSync(libraryRoot(target))).toBe(false);
    expect(readLibrary(target)).toEqual([]);
  });

  it('a disabled read returns nothing even when entries exist', () => {
    const target = library();
    contributeToLibrary(clock, { ...target, ...GENERAL, knownNames: [] });
    expect(readLibrary(target)).toHaveLength(1);
    expect(readLibrary({ ...target, enabled: false })).toEqual([]);
  });
});

describe('the wall is checked again on the way out', () => {
  it('accepts a genuinely generalised pattern', () => {
    const target = library();
    const result = contributeToLibrary(clock, { ...target, ...GENERAL, knownNames: [] });
    expect(result.entry).toBeDefined();
    expect(result.entry?.kind).toBe(LibraryEntryKind.PATTERN);
    expect(readLibrary(target)).toHaveLength(1);
  });

  it('refuses a path, a URL, an email, an id or code — in ANY reader-visible field', () => {
    const target = library();
    for (const leak of [
      'the fix was in d:/clients/acme/src/checkout.ts',
      'see https://acme.example.com/internal/spec',
      'ask sara@acme.example.com',
      'this came from SC-REQ-000042',
      'call `applyDiscount(order, 0.1)` first',
    ]) {
      expect(
        () =>
          contributeToLibrary(clock, {
            ...target,
            ...GENERAL,
            knownNames: [],
            body: { ...GENERAL.body, solution: leak },
          }),
        leak,
      ).toThrow(/Refusing to publish/);
    }
    expect(readLibrary(target)).toEqual([]);
  });

  it('refuses a leak in the title as readily as in the body', () => {
    const target = library();
    expect(() =>
      contributeToLibrary(clock, {
        ...target,
        ...GENERAL,
        knownNames: [],
        title: 'What we learned on the Acme project at c:/work/acme',
      }),
    ).toThrow(/Refusing to publish/);
  });

  it('says to generalise rather than to redact', () => {
    const target = library();
    try {
      contributeToLibrary(clock, {
        ...target,
        ...GENERAL,
        knownNames: [],
        body: { ...GENERAL.body, context: 'in /srv/acme/api' },
      });
      expect.unreachable('the leak should have been refused');
    } catch (e) {
      /*
       * Redaction produces something that looks clean and is not: the sentence still
       * describes one client's situation, minus the words that made it obvious.
       */
      expect((e as { remedy?: string }).remedy).toContain('generalisation, not a redaction');
    }
  });
});

describe('provenance without identity', () => {
  it('records what kind and when, and can never say which project', () => {
    const target = library();
    const result = contributeToLibrary(clock, { ...target, ...GENERAL, knownNames: [] });
    const provenance = libraryProvenance(result.entry as never);

    expect(provenance.kind).toBe(LibraryEntryKind.PATTERN);
    expect(provenance.contributedAt.length).toBeGreaterThan(0);
    /* And the honest half: what Serva deliberately does not know. */
    expect(provenance.notRecorded.join(' ')).toContain('which project contributed it');
    expect(provenance.notRecorded.join(' ')).toContain('which client');

    /* Nothing anywhere in the stored entry names a source. */
    const serialised = JSON.stringify(result.entry);
    expect(serialised).not.toContain(target.root);
    expect(serialised).not.toMatch(/project|client|directory/i);
  });

  it('the digest is over content, so the same lesson twice is one entry', () => {
    const target = library();
    const first = contributeToLibrary(clock, { ...target, ...GENERAL, knownNames: [] });
    const second = contributeToLibrary(clock, { ...target, ...GENERAL, knownNames: [] });
    expect(second.duplicate).toBe(true);
    expect(second.entry?.id).toBe(first.entry?.id);
    expect(readLibrary(target)).toHaveLength(1);
  });

  it('a different lesson is a different entry', () => {
    const target = library();
    contributeToLibrary(clock, { ...target, ...GENERAL, knownNames: [] });
    contributeToLibrary(clock, {
      ...target,
      knownNames: [],
      kind: LibraryEntryKind.LESSON,
      title: 'Absent evidence is not a passing check',
      body: { context: 'Any gate', problem: 'Missing evidence read as success', solution: 'Block' },
    });
    expect(readLibrary(target)).toHaveLength(2);
    expect(describeLibrary(readLibrary(target))).toContain('2 generalised item(s)');
  });
});

describe('the owner is in control of what is kept', () => {
  it('deletes one entry permanently', () => {
    const target = library();
    const result = contributeToLibrary(clock, { ...target, ...GENERAL, knownNames: [] });
    expect(deleteLibraryEntry(String(result.entry?.id), target)).toBe(true);
    expect(readLibrary(target)).toEqual([]);
    /* And deleting again is false rather than an error. */
    expect(deleteLibraryEntry(String(result.entry?.id), target)).toBe(false);
  });

  it('an id that is not a library id cannot walk out of the directory', () => {
    const target = library();
    for (const hostile of ['../../etc/passwd', 'SC-LIB-../../x', '..', 'SC-LIB-zzz']) {
      expect(() => deleteLibraryEntry(hostile, target), hostile).toThrow(/Not a library entry id/);
    }
  });

  it('a malformed file is skipped rather than breaking the library', () => {
    const target = library();
    contributeToLibrary(clock, { ...target, ...GENERAL, knownNames: [] });
    writeFileSync(join(libraryRoot(target), 'SC-LIB-broken.json'), '{ not json', 'utf8');
    expect(readLibrary(target)).toHaveLength(1);
    expect(readdirSync(libraryRoot(target)).length).toBe(2);
  });

  it('an empty library says so plainly', () => {
    expect(describeLibrary([])).toBe('The library is empty.');
  });
});

/* ====== HIGH 1: the last wall must know which names are a client's ====== */

describe('a client name cannot leave through the library', () => {
  /*
   * SPEC: 11, 27, 28; HIGH finding ORGANIZATIONAL-LEARNING-CORE/ORG-LEARN-CORE-1.
   *
   * `leakageRefusal` gained a `knownNames` argument so it could catch client names, and this
   * caller kept invoking the one-argument form. Its own comment calls it "the last code that
   * runs before a sentence leaves the project" and "the only place that can be sure" — and it
   * was the place that could not be, because nobody told it which names to look for.
   *
   * `knownNames` is required rather than optional now. An optional parameter is omitted by
   * exactly the caller that most needs it, which is what happened here.
   */
  it('refuses a body naming a project Serva holds', () => {
    const target = { ...library(), enabled: true as const };
    expect(() =>
      contributeToLibrary(clock, {
        ...target,
        kind: 'PATTERN' as const,
        title: 'Offline-first order capture',
        body: {
          context: 'RahalGo staff could not wait for the network during a rush',
          problem: 'connectivity drops during service',
          solution: 'queue locally and reconcile',
        },
        knownNames: ['RahalGo'],
      }),
    ).toThrow(/client or project name/);
  });

  it('lets the same lesson through once the name is gone', () => {
    const target = { ...library(), enabled: true as const };
    const result = contributeToLibrary(clock, {
      ...target,
      kind: 'PATTERN' as const,
      title: 'Offline-first order capture',
      body: {
        context: 'counter staff could not wait for the network during a rush',
        problem: 'connectivity drops during service',
        solution: 'queue locally and reconcile',
      },
      knownNames: ['RahalGo'],
    });
    expect(result.refused).toBeUndefined();
    expect(result.entry).toBeDefined();
  });
});

describe('every publishing boundary supplies the name context', () => {
  /*
   * The structural half. This is the second time a `leakageRefusal` caller was missed — first
   * `library.ts` and `departments/learning.ts` when the argument was added, and the review
   * found both. An inventory is cheaper than a third round.
   */
  it('no production caller invokes leakageRefusal with one argument', () => {
    const files = execSync('git ls-files src', { encoding: 'utf8' })
      .split(/\r?\n/)
      .map((f) => f.trim())
      .filter((f) => f.endsWith('.ts'));

    const bare: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const [i, line] of source.split(/\r?\n/).entries()) {
        if (line.trim().startsWith('*') || line.trim().startsWith('//')) continue;
        /* `leakageRefusal(x)` with no second argument, and not the declaration itself. */
        if (/leakageRefusal\([^,)]*\)/.test(line) && !/export function/.test(line)) {
          bare.push(file + ':' + String(i + 1) + '  ' + line.trim());
        }
      }
    }
    expect(
      bare,
      'these publish or generalise knowledge without telling the wall which names are a ' +
        "client's:\n" +
        bare.join('\n'),
    ).toEqual([]);
  });
});
