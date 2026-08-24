import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * NOTHING FROM THE TOOLS THAT WROTE THE CODE SURVIVES IN THE CODE.
 *
 * SPEC: Phase 6 closure §1, §16.
 *
 * Large parts of this codebase were edited with patch scripts, and that left something behind
 * more than once. A literal backspace character replaced a word boundary in a regular
 * expression and silently disabled the check it was in. Five refusal messages shipped with a
 * fragment of a Python here-doc where a section reference should have been, so an owner who
 * hit one of them was handed part of the patch script as their pointer into the
 * specification. A raw NUL byte sat inside a string literal in a test.
 *
 * All three were invisible in review, because all three look like code until you read the
 * exact bytes. This test reads the exact bytes.
 *
 * It is deliberately not a lint rule about style. Every pattern here is a thing that got into
 * this repository, or is the same shape as one that did.
 *
 * The forbidden fragments are BUILT rather than written, because a scan that contains its own
 * needle finds itself and then gets weakened to make itself pass.
 */

const ROOTS = ['src', 'tests', 'scripts', 'extension/src', 'extension/media'];
const EXTENSIONS = ['.ts', '.mjs', '.js', '.json', '.css'];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const path = join(dir, entry);
    if (entry === 'node_modules' || entry === 'generated' || entry === 'fixtures') continue;
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (EXTENSIONS.some((e) => entry.endsWith(e))) out.push(path);
  }
  return out;
}

const FILES = ROOTS.flatMap(sourceFiles);

/** Three double quotes, three single quotes, and the conflict markers — never written out. */
const TRIPLE_DOUBLE = String.fromCharCode(34, 34, 34);
const TRIPLE_SINGLE = String.fromCharCode(39, 39, 39);
const FRAGMENTS = [
  TRIPLE_DOUBLE + ' +',
  '+ ' + TRIPLE_DOUBLE,
  TRIPLE_SINGLE + ' +',
  '+ ' + TRIPLE_SINGLE,
  '<'.repeat(7) + ' ',
  '>'.repeat(7) + ' ',
];

describe('the source contains nothing left over from the tools that produced it', () => {
  it('finds files to check at all, so a broken walk cannot pass vacuously', () => {
    /* A scan that silently found nothing is the most comfortable kind of green. */
    expect(FILES.length).toBeGreaterThan(80);
  });

  it('carries no patch-script template fragment or merge conflict marker', () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      const text = readFileSync(file, 'utf8');
      for (const fragment of FRAGMENTS) {
        if (text.includes(fragment)) offenders.push(file + ' :: ' + fragment.trim());
      }
    }
    expect(offenders).toEqual([]);
  });

  it('carries no control character outside tab, newline and carriage return', () => {
    /*
     * The backspace that replaced a word boundary was here for weeks, and the NUL byte in
     * `ai.engine.test.ts` for longer. A control character in source is never intentional and
     * never visible, which is exactly the combination that survives review.
     */
    const offenders: string[] = [];
    for (const file of FILES) {
      const text = readFileSync(file, 'utf8');
      for (let i = 0; i < text.length; i += 1) {
        const code = text.charCodeAt(i);
        if ((code < 0x20 && code !== 9 && code !== 10 && code !== 13) || code === 0x7f) {
          offenders.push(file + ' :: U+' + code.toString(16).padStart(4, '0') + ' at ' + String(i));
          break;
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('carries no unresolved placeholder in a message an owner could read', () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      if (!file.endsWith('.ts')) continue;
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!/(?:specRef|remedy|message|summary|refusal)\s*:/.test(line)) continue;
        if (/\bTODO\b|\bFIXME\b|\bXXX\b|\{\{|<PLACEHOLDER>/.test(line)) {
          offenders.push(file + ' :: ' + line.trim().slice(0, 90));
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every spec reference is a reference rather than a fragment', () => {
    /*
     * Deliberately not a format rule. Spec references legitimately vary — `07 §2.1`,
     * `21 PI-1..PI-5`, `31 §4.3 cause field, MV-4` — and a test insisting on one shape would
     * be corrected by loosening it, which teaches nothing.
     *
     * What it forbids is a value that cannot be a reference at all: empty, carrying the
     * punctuation of a template rather than of a citation, or citing no number. That is the
     * defect that shipped.
     */
    const offenders: string[] = [];
    for (const file of FILES) {
      if (!file.endsWith('.ts')) continue;
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/specRef:\s*'([^']*)'/g)) {
        const value = (match[1] ?? '').trim();
        if (value === '' || /[+{}<>$]|\bundefined\b|\bnull\b/.test(value)) {
          offenders.push(file + ' :: ' + value);
        } else if (!/\d/.test(value)) {
          offenders.push(file + ' :: ' + value + ' (cites nothing)');
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
