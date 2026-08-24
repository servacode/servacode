import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { SERVA_VERSION } from '../src/portability/version.js';

/**
 * THE DOCUMENTATION DESCRIBES THIS PRODUCT, NOT A SIMILAR ONE.
 *
 * SPEC: Phase 6 final acceptance sequence §5.
 *
 * The closure is explicit that P6-DOCS must not pass merely because eleven markdown files
 * exist, and the way documentation actually fails is worse than being absent: it names a
 * command that was renamed, quotes a version that moved, or links to a page somebody deleted.
 * All three look fine to a person skimming, and all three waste an owner's afternoon.
 *
 * So every CLI command, every extension command id, every internal link and the version these
 * documents quote is checked against the product on every run.
 */

const DOCS = 'docs/owner';

const REQUIRED: readonly { readonly file: string; readonly title: string }[] = [
  { file: 'getting-started.md', title: 'Getting Started' },
  { file: 'new-project.md', title: 'New Project' },
  { file: 'working-with-serva.md', title: 'Working With Serva' },
  { file: 'owner-decisions.md', title: 'Owner Decisions' },
  { file: 'engineering.md', title: 'Engineering' },
  { file: 'backups.md', title: 'Backups' },
  { file: 'moving-to-a-new-computer.md', title: 'Moving To A New Computer' },
  { file: 'recovery.md', title: 'Recovery' },
  { file: 'security-model.md', title: 'Security Model' },
  { file: 'troubleshooting.md', title: 'Troubleshooting' },
];

const files = existsSync(DOCS) ? readdirSync(DOCS).filter((f) => f.endsWith('.md')) : [];
const read = (file: string): string => readFileSync(join(DOCS, file), 'utf8');
const all = files.map((f) => ({ file: f, text: read(f) }));

/**
 * Every command name the CLI actually dispatches.
 *
 * The key may be QUOTED — `'verify-backup': cmdVerifyBackup` — because it contains a hyphen.
 * A first version of this pattern required a bare identifier and therefore reported three real
 * commands as invented, which would have been "fixed" by editing correct documentation. A
 * check that reads the wrong shape does not announce itself; it hands you a plausible list.
 */
const cliCommands: ReadonlySet<string> = new Set(
  [...readFileSync('src/cli/main.ts', 'utf8').matchAll(/^\s{2}'?([a-z][a-z-]*)'?: cmd[A-Z]/gm)].map(
    (m) => m[1] as string,
  ),
);

/** Every command id the extension contributes. */
const extensionCommands: ReadonlySet<string> = new Set(
  (
    JSON.parse(readFileSync('extension/package.json', 'utf8')) as {
      contributes: { commands: { command: string }[] };
    }
  ).contributes.commands.map((c) => c.command),
);

describe('every required owner document exists and says what it is', () => {
  it('all ten are present', () => {
    for (const { file } of REQUIRED) {
      expect(existsSync(join(DOCS, file)), file + ' is missing').toBe(true);
    }
  });

  it('each opens with a heading rather than starting mid-thought', () => {
    for (const { file } of REQUIRED) {
      expect(read(file).trimStart().startsWith('#'), file + ' has no heading').toBe(true);
    }
  });

  it('none is a stub', () => {
    /* A file with a heading and two lines is an absence with a filename. */
    for (const { file } of REQUIRED) {
      const words = read(file)
        .split(/\s+/)
        .filter((w) => w !== '').length;
      expect(words, file + ' has only ' + String(words) + ' words').toBeGreaterThan(120);
    }
  });
});

describe('every command the documentation names is a command that exists', () => {
  it('names no `serva` command the CLI does not dispatch', () => {
    const offenders: string[] = [];
    for (const { file, text } of all) {
      for (const match of text.matchAll(/(?:^|[\s`(])serva\s+([a-z][a-z-]*)/g)) {
        const command = match[1] as string;
        /* `serva <name>` in a usage line is a placeholder, not a command. */
        if (command === 'code') continue;
        if (!cliCommands.has(command)) offenders.push(file + ': serva ' + command);
      }
    }
    expect([...new Set(offenders)]).toEqual([]);
  });

  it('names no extension command the manifest does not contribute', () => {
    const offenders: string[] = [];
    for (const { file, text } of all) {
      for (const match of text.matchAll(/`(serva\.[A-Za-z]+)`/g)) {
        const id = match[1] as string;
        if (!extensionCommands.has(id)) offenders.push(file + ': ' + id);
      }
    }
    expect([...new Set(offenders)]).toEqual([]);
  });

  it('quotes extension commands by their real titles', () => {
    /*
     * An owner types the TITLE into the command palette, not the id. A title that drifted is
     * a command the owner cannot find, which is indistinguishable from one that is missing.
     */
    const titles = new Set(
      (
        JSON.parse(readFileSync('extension/package.json', 'utf8')) as {
          contributes: { commands: { title: string }[] };
        }
      ).contributes.commands.map((c) => c.title),
    );
    const offenders: string[] = [];
    for (const { file, text } of all) {
      for (const match of text.matchAll(/`(Serva: [A-Za-z ]+)`/g)) {
        const title = match[1] as string;
        if (!titles.has(title)) offenders.push(file + ': ' + title);
      }
    }
    expect([...new Set(offenders)]).toEqual([]);
  });
});

describe('the documentation is internally and factually consistent', () => {
  it('every internal link points at a file that exists', () => {
    const offenders: string[] = [];
    for (const { file, text } of all) {
      for (const match of text.matchAll(/\]\(([^)#]+\.md)(?:#[^)]*)?\)/g)) {
        const target = match[1] as string;
        if (target.startsWith('http')) continue;
        if (!existsSync(join(DOCS, target))) offenders.push(file + ' -> ' + target);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('quotes no version other than the one this build is', () => {
    const offenders: string[] = [];
    for (const { file, text } of all) {
      for (const match of text.matchAll(/\bserva\s+(\d+\.\d+\.\d+)/gi)) {
        if (match[1] !== SERVA_VERSION) offenders.push(file + ': ' + String(match[1]));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('describes no earlier phase as though it were the product', () => {
    for (const { file, text } of all) {
      expect(text, file).not.toMatch(/\bPhase [1-5] Core Engine\b/);
    }
  });

  it('says the things an owner must not be allowed to misunderstand', () => {
    /*
     * Three sentences whose absence would make the documentation actively misleading. Each is
     * checked in the document that owns it rather than anywhere in the corpus, because a
     * promise made in the wrong place is one nobody reads.
     */
    expect(read('security-model.md')).toMatch(/never|not/i);
    expect(read('moving-to-a-new-computer.md')).toMatch(/qualification|measure/i);
    expect(read('backups.md')).toMatch(/verif/i);
  });
});
