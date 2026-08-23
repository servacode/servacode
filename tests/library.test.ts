import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
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
    const result = contributeToLibrary(clock, { ...target, ...GENERAL });
    expect(result.entry).toBeUndefined();
    expect(result.refused).toContain('organizational learning is off');
    /* Not even the directory: a disabled feature that touches files is a surprise. */
    expect(existsSync(libraryRoot(target))).toBe(false);
    expect(readLibrary(target)).toEqual([]);
  });

  it('a disabled read returns nothing even when entries exist', () => {
    const target = library();
    contributeToLibrary(clock, { ...target, ...GENERAL });
    expect(readLibrary(target)).toHaveLength(1);
    expect(readLibrary({ ...target, enabled: false })).toEqual([]);
  });
});

describe('the wall is checked again on the way out', () => {
  it('accepts a genuinely generalised pattern', () => {
    const target = library();
    const result = contributeToLibrary(clock, { ...target, ...GENERAL });
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
    const result = contributeToLibrary(clock, { ...target, ...GENERAL });
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
    const first = contributeToLibrary(clock, { ...target, ...GENERAL });
    const second = contributeToLibrary(clock, { ...target, ...GENERAL });
    expect(second.duplicate).toBe(true);
    expect(second.entry?.id).toBe(first.entry?.id);
    expect(readLibrary(target)).toHaveLength(1);
  });

  it('a different lesson is a different entry', () => {
    const target = library();
    contributeToLibrary(clock, { ...target, ...GENERAL });
    contributeToLibrary(clock, {
      ...target,
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
    const result = contributeToLibrary(clock, { ...target, ...GENERAL });
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
    contributeToLibrary(clock, { ...target, ...GENERAL });
    writeFileSync(join(libraryRoot(target), 'SC-LIB-broken.json'), '{ not json', 'utf8');
    expect(readLibrary(target)).toHaveLength(1);
    expect(readdirSync(libraryRoot(target)).length).toBe(2);
  });

  it('an empty library says so plainly', () => {
    expect(describeLibrary([])).toBe('The library is empty.');
  });
});
