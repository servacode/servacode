import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { IsoSchema } from '../domain/schemas.js';
import type { RepositoryIdentity } from './proof.js';

/**
 * WHAT THE VERIFICATION COMMANDS ACTUALLY DID, BOUND TO A TREE.
 *
 * SPEC: Phase 6 final acceptance sequence §4.
 *
 * "I ran the tests and they passed" is a sentence. A pasted transcript is a longer sentence.
 * Neither is authority, and the acceptance model has already been taken apart once for
 * treating text as evidence.
 *
 * A verification record says: THIS command, at THIS commit and THIS tree, exited with THIS
 * code, ran THIS many tests, and produced reports with THESE digests, at THIS time. Every
 * field is checkable, and `resolveVerificationRecord` checks them — against the repository as
 * it is now, not against what the record says about itself.
 *
 * The failure this prevents is specific and easy: run the suite, edit some source, and mint
 * the proof afterwards. The tree digest is what makes that impossible.
 */

export const VerificationCommandSchema = z
  .object({
    /** Exactly what was run, as a person would type it. */
    command: z.string().min(1),
    exitCode: z.number().int(),
    startedAt: IsoSchema,
    endedAt: IsoSchema,
    durationMs: z.number().int().min(0),
    /** Test counts, where the command produces them. */
    testsPassed: z.number().int().min(0).optional(),
    testsFailed: z.number().int().min(0).optional(),
    testFiles: z.number().int().min(0).optional(),
    /** The machine-readable report this command wrote, if any. */
    reportPath: z.string().min(1).optional(),
    reportDigest: z.string().length(64).optional(),
  })
  .strict();
export type VerificationCommand = z.output<typeof VerificationCommandSchema>;

export const VerificationRecordSchema = z
  .object({
    producedBy: z.string().min(1),
    implementationCommit: z.string().regex(/^[0-9a-f]{40}$/),
    treeDigest: z.string().regex(/^[0-9a-f]{40}$/),
    producedAt: IsoSchema,
    commands: z.array(VerificationCommandSchema).min(1),
  })
  .strict();
export type VerificationRecord = z.output<typeof VerificationRecordSchema>;

export const RECORD_PATH = 'evidence/acceptance-run/offline-verification.json';

export interface VerificationResolution {
  readonly resolved: boolean;
  readonly record?: VerificationRecord;
  readonly refusals: readonly string[];
}

export interface ResolveVerificationInput {
  readonly root: string;
  readonly repository?: RepositoryIdentity;
  /** Which commands must be present and green. Absence of one is a refusal. */
  readonly required: readonly string[];
}

/**
 * Resolve a verification record against the repository as it is now.
 *
 * Returns every refusal rather than the first, because a stale record usually fails more than
 * one way and an author needs to see whether they have an old run or a wrong one.
 */
export function resolveVerificationRecord(input: ResolveVerificationInput): VerificationResolution {
  const refusals: string[] = [];
  const path = join(input.root, ...RECORD_PATH.split('/'));

  if (!existsSync(path)) {
    return { resolved: false, refusals: ['no verification record at ' + RECORD_PATH] };
  }

  let parsed: VerificationRecord;
  try {
    const result = VerificationRecordSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
    if (!result.success) {
      return {
        resolved: false,
        refusals: [
          'the verification record is malformed: ' +
            result.error.issues
              .slice(0, 3)
              .map((i) => i.path.join('.') + ' ' + i.message)
              .join('; '),
        ],
      };
    }
    parsed = result.data;
  } catch (e) {
    return {
      resolved: false,
      refusals: ['the verification record could not be read: ' + String(e)],
    };
  }

  /*
   * THE TREE, NOT THE COMMIT ALONE.
   *
   * A commit is a label and the tree is the content. Checking only the commit would let a
   * record survive every change that does not create a new commit — which is every change
   * made while working, including the one that broke something.
   */
  if (input.repository === undefined) {
    refusals.push('repository identity could not be read, so nothing binds this record to a tree');
  } else {
    if (parsed.implementationCommit !== input.repository.commit) {
      refusals.push(
        'the record describes commit ' +
          parsed.implementationCommit.slice(0, 12) +
          ' and this package is ' +
          input.repository.commit.slice(0, 12),
      );
    }
    if (parsed.treeDigest !== input.repository.tree) {
      refusals.push(
        'the record describes tree ' +
          parsed.treeDigest.slice(0, 12) +
          ' and this package is ' +
          input.repository.tree.slice(0, 12) +
          '; something changed after the commands ran',
      );
    }
  }

  for (const required of input.required) {
    const command = parsed.commands.find((c) => c.command === required);
    if (command === undefined) {
      refusals.push('`' + required + '` was not run');
      continue;
    }
    if (command.exitCode !== 0) {
      refusals.push('`' + required + '` exited ' + String(command.exitCode));
    }
    if ((command.testsFailed ?? 0) > 0) {
      refusals.push('`' + required + '` had ' + String(command.testsFailed) + ' failing test(s)');
    }
    /*
     * A command that reports zero tests passed either ran nothing or lost its report. Both
     * are the same thing for this purpose: no evidence that anything was checked.
     */
    if (command.testsPassed !== undefined && command.testsPassed === 0) {
      refusals.push('`' + required + '` reported no passing tests, so nothing was verified');
    }
    /* The report it cites, re-digested. A report edited afterwards is not the one that ran. */
    if (command.reportPath !== undefined && command.reportDigest !== undefined) {
      const reportFile = join(input.root, ...command.reportPath.split('/'));
      if (!existsSync(reportFile)) {
        refusals.push('the report `' + command.reportPath + '` is not in this package');
      } else {
        const digest = createHash('sha256').update(readFileSync(reportFile)).digest('hex');
        if (digest !== command.reportDigest) {
          refusals.push(
            'the report `' + command.reportPath + '` does not match its recorded digest',
          );
        }
      }
    }
  }

  return refusals.length === 0
    ? { resolved: true, record: parsed, refusals: [] }
    : { resolved: false, record: parsed, refusals };
}
