import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { fail } from '../core/errors.js';
import { canonicalJson, digestOf } from '../core/hash.js';
import { IsoSchema } from '../domain/schemas.js';
import { leakageRefusal } from '../intelligence/artifacts/learning.js';
import { SERVA_VERSION } from '../portability/version.js';
import type { Clock } from '../core/clock.js';

/**
 * THE ORGANIZATIONAL LIBRARY — LOCAL, GENERALISED, AND OFF BY DEFAULT.
 *
 * SPEC: §19, §38, §39, 27, 28.
 *
 * Phase 5 built the wall and had nowhere to put what got through it. `contributeLesson`
 * refused anything carrying a path, a URL, an email, a project id or a fragment of code —
 * and then wrote the result into the same project it came from, where no other project
 * could ever see it. The wall worked and the door did not exist.
 *
 * This is the door. It is deliberately small:
 *
 *   ONE MACHINE. The library is a directory on this computer. There is no server, no
 *   account and no synchronisation. Serva is local-first and this is the feature where
 *   that promise is most tempting to break.
 *
 *   OFF UNTIL THE OWNER SAYS OTHERWISE. `enabled` defaults to false. A feature that moves
 *   material between clients' projects is not something to opt somebody out of.
 *
 *   THE WALL IS CHECKED AGAIN HERE. `contribute*` already refused leakage on the way in;
 *   this refuses it again on the way out. Not redundancy for its own sake — this is the
 *   last code that runs before a sentence leaves the project that produced it, and it is
 *   the only place that can be sure.
 *
 *   PROVENANCE WITHOUT IDENTITY. An entry records what KIND of thing it is, when, and an
 *   opaque digest that makes duplicates detectable. It never records which project, which
 *   client, or which directory — because "the pattern from the bank project" is exactly
 *   the disclosure the wall exists to prevent, arriving as metadata.
 *
 * And on the way back in, nothing changes: an entry becomes a CANDIDATE, a candidate is
 * not an instruction, and `applyPattern` still refuses without an independent
 * ApplicabilityAssessment. Prior success is not authority.
 */

export const LibraryEntryKind = {
  LESSON: 'LESSON',
  PATTERN: 'PATTERN',
  FAILED_APPROACH: 'FAILED_APPROACH',
} as const;
export type LibraryEntryKind = (typeof LibraryEntryKind)[keyof typeof LibraryEntryKind];

export const LibraryEntrySchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum([
      LibraryEntryKind.LESSON,
      LibraryEntryKind.PATTERN,
      LibraryEntryKind.FAILED_APPROACH,
    ]),
    title: z.string().min(1),
    /** The generalised body. Every field here has passed the leakage wall twice. */
    body: z.record(z.string(), z.string()),
    contributedAt: IsoSchema,
    servaVersion: z.string().min(1),
    /**
     * An opaque digest over the generalised content.
     *
     * Its only job is to make the same lesson contributed twice detectable. It is derived
     * from the CONTENT rather than from the source, so it says nothing about which project
     * produced it — a digest of a project id would be an identifier wearing a disguise.
     */
    contentDigest: z.string().min(1),
  })
  .strict();
export type LibraryEntry = z.output<typeof LibraryEntrySchema>;

export interface LibraryOptions {
  /** Where the library lives. Defaults to a directory beside the owner's home. */
  readonly root?: string;
  /** Nothing is contributed or read while this is false. */
  readonly enabled?: boolean;
}

export function libraryRoot(o: LibraryOptions = {}): string {
  return resolve(o.root ?? join(homedir(), '.serva', 'library'));
}

/** Fields whose text a future reader would see. All of them are checked. */
function readerVisible(body: Record<string, string>): readonly string[] {
  return Object.values(body);
}

export interface ContributeInput {
  readonly kind: LibraryEntryKind;
  readonly title: string;
  readonly body: Record<string, string>;
  /**
   * The project and client names the calling project holds.
   *
   * SPEC: HIGH finding ORGANIZATIONAL-LEARNING-CORE/ORG-LEARN-CORE-1.
   *
   * REQUIRED rather than optional, and deliberately so. This function is the last code that
   * runs before a sentence leaves the project that produced it, and `leakageRefusal` cannot
   * recognise a client name without being told which names exist. An optional parameter here
   * would be omitted by exactly the caller that most needs it — which is what happened.
   *
   * This module holds no store, so the names come from the caller. Passing an empty array to
   * satisfy the signature defeats the check as surely as omitting it did.
   */
  readonly knownNames: readonly string[];
}

export interface ContributeResult {
  readonly entry?: LibraryEntry;
  readonly refused?: string;
  readonly duplicate?: boolean;
}

/**
 * Publish one generalised item to the machine-local library.
 *
 * Refusals are RESULTS rather than exceptions in one case only — a duplicate, which is
 * ordinary and not an error. A leakage refusal throws, because it is the wall doing its
 * job and a caller that could carry on past it would eventually carry on past it.
 */
export function contributeToLibrary(
  deps: { readonly clock: Clock },
  o: LibraryOptions & ContributeInput,
): ContributeResult {
  if (o.enabled !== true) {
    return {
      refused:
        'organizational learning is off. Nothing is contributed between projects until the owner turns it on.',
    };
  }

  /*
   * THE WALL, AGAIN. This is the last code that runs before a sentence leaves the project
   * that produced it. `contribute*` checked on the way in; the caller may have composed a
   * body since, and this is the only place that can be sure.
   */
  const reasons = [
    ...new Set([o.title, ...readerVisible(o.body)].flatMap((f) => leakageRefusal(f, o.knownNames))),
  ];
  if (reasons.length > 0) {
    return fail({
      code: 'E_ISOLATION',
      message: 'Refusing to publish this to the shared library: ' + reasons.join('; '),
      remedy:
        'Cross-project knowledge is a generalisation, not a redaction. Rewrite it so it describes the KIND of situation rather than this one — if that cannot be done without the specifics, it is a project detail rather than a lesson.',
      details: { reasons },
      specRef: '§39',
    });
  }

  const contentDigest = digestOf(canonicalJson({ kind: o.kind, title: o.title, body: o.body }));
  const root = libraryRoot(o);
  mkdirSync(root, { recursive: true });

  const existing = readLibrary({ ...o, enabled: true });
  const already = existing.find((e) => e.contentDigest === contentDigest);
  if (already !== undefined) return { entry: already, duplicate: true };

  const entry = LibraryEntrySchema.parse({
    id: 'SC-LIB-' + contentDigest.slice(0, 16),
    kind: o.kind,
    title: o.title,
    body: o.body,
    contributedAt: deps.clock.now(),
    servaVersion: SERVA_VERSION,
    contentDigest,
  });
  writeFileSync(join(root, entry.id + '.json'), JSON.stringify(entry, null, 2), 'utf8');
  return { entry };
}

/**
 * Everything in the library.
 *
 * Returns nothing at all when the feature is off, rather than reading and filtering. A
 * disabled feature that still touches the files is a disabled feature somebody will find
 * surprising.
 */
export function readLibrary(o: LibraryOptions = {}): readonly LibraryEntry[] {
  if (o.enabled !== true) return [];
  const root = libraryRoot(o);
  if (!existsSync(root)) return [];
  const out: LibraryEntry[] = [];
  for (const name of readdirSync(root).sort()) {
    if (!name.endsWith('.json')) continue;
    try {
      const parsed = LibraryEntrySchema.safeParse(
        JSON.parse(readFileSync(join(root, name), 'utf8')) as unknown,
      );
      if (parsed.success) out.push(parsed.data);
    } catch {
      /* A malformed entry is skipped rather than fatal: one bad file is not a broken library. */
    }
  }
  return out;
}

/**
 * Delete one entry, permanently.
 *
 * An owner control rather than a maintenance routine. Somebody who realises a lesson was
 * too specific needs to be able to remove it in one action, and "contact support" is not
 * an answer a local-first product can give.
 */
export function deleteLibraryEntry(id: string, o: LibraryOptions = {}): boolean {
  const root = libraryRoot(o);
  /* The id shape is fixed, so a caller cannot walk out of the library directory. */
  if (!/^SC-LIB-[0-9a-f]{16}$/.test(id)) {
    return fail({
      code: 'E_VALIDATION',
      message: 'Not a library entry id: ' + id,
      remedy: 'Entry ids are derived from content digests and have a fixed shape.',
      details: { id },
      specRef: '§19',
    });
  }
  const path = join(root, id + '.json');
  if (!existsSync(path)) return false;
  rmSync(path);
  return true;
}

export interface LibraryProvenance {
  readonly id: string;
  readonly kind: LibraryEntryKind;
  readonly contributedAt: string;
  readonly servaVersion: string;
  readonly contentDigest: string;
  /** What Serva deliberately does NOT know about this entry. */
  readonly notRecorded: readonly string[];
}

/**
 * Where an entry came from, as far as anybody can say.
 *
 * The list of what is NOT recorded is the interesting half. An owner inspecting a pattern
 * should be able to see that Serva genuinely cannot tell them which project produced it —
 * a provenance view that quietly had the answer would mean the wall never held.
 */
export function libraryProvenance(entry: LibraryEntry): LibraryProvenance {
  return {
    id: entry.id,
    kind: entry.kind,
    contributedAt: entry.contributedAt,
    servaVersion: entry.servaVersion,
    contentDigest: entry.contentDigest,
    notRecorded: [
      'which project contributed it',
      'which client it was for',
      'the directory it was produced in',
      'any requirement, source file or research it rested on',
    ],
  };
}

/** A one-line summary for the owner-facing list. */
export function describeLibrary(entries: readonly LibraryEntry[]): string {
  if (entries.length === 0) return 'The library is empty.';
  const counts = new Map<string, number>();
  for (const e of entries) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
  return (
    String(entries.length) +
    ' generalised item(s): ' +
    [...counts.entries()]
      .sort()
      .map(([kind, n]) => String(n) + ' ' + kind.toLowerCase().replace(/_/g, ' '))
      .join(', ')
  );
}
