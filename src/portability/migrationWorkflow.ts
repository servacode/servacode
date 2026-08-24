import { existsSync } from 'node:fs';
import { EnforcementClass } from '../vocab/index.js';
import { QualificationAttempt } from '../substrate/types.js';
import { bootstrapPlan } from './bootstrap.js';
import { verifyBackup } from './backup.js';
import { planMigration } from './migration.js';
import { isServaProject } from '../app/services.js';
import type { DoctorProbes } from './doctor.js';
import type { SubstrateQualification } from '../substrate/types.js';
import type { BackupManifest } from './backup.js';

/**
 * MOVING TO ANOTHER COMPUTER, AS A WORKFLOW RATHER THAN A LEAFLET.
 *
 * SPEC: Phase 6 closure §10; §26, §31.
 *
 * `serva migrate` printed seven numbered lines and exited zero. An independent audit called
 * it what it was: instructions, not a workflow. It could not tell an owner where they had got
 * to, could not check that a step had actually happened, and said the same thing on the
 * source machine as on the target — which are the two states the whole exercise is about.
 *
 * THE PHASE IS DERIVED, NOT STORED. There is no cursor an owner advances by asserting they
 * did something, because the one thing a migration must never do is believe a step happened
 * that did not. Every phase below is computed from what is observably true: whether a project
 * is here, whether a bundle verifies, whether the machine has been measured. An owner who
 * skips a step does not get a workflow that has quietly moved on; they get told what is
 * missing.
 *
 * IT SURVIVES THE DISCONTINUITY. The middle of a migration happens on a different computer,
 * so the state cannot live in one machine's Store. It lives in the BUNDLE and in the two
 * machines themselves, which is why every input to `migrationState` is either a path or a
 * probe of the current machine — and why the workflow can be resumed on a target that has
 * never seen the source.
 *
 * WHAT DOES NOT MOVE. Machine qualification stays behind. HARD describes a computer, and the
 * new one is a different computer until it has been measured — so the final phase is the
 * target earning its own qualification, and nothing in this file will carry the old one
 * across to save time.
 */

export const MigrationPhase = {
  /** Nothing has been captured yet. The owner is on the source machine. */
  CAPTURE: 'CAPTURE',
  /** A bundle exists and has not been proved. */
  VERIFY: 'VERIFY',
  /** A verified bundle exists, and the owner has to carry it somewhere. */
  CARRY: 'CARRY',
  /** The target machine has the bundle and no project restored from it. */
  RESTORE: 'RESTORE',
  /** Restored, and the machine is missing prerequisites. */
  PREPARE_MACHINE: 'PREPARE_MACHINE',
  /** Prerequisites present, and this computer has not earned its own qualification. */
  QUALIFY: 'QUALIFY',
  /** The project is here, the machine is measured, and work can continue. */
  COMPLETE: 'COMPLETE',
  /** Something is wrong that the owner must resolve before continuing. */
  BLOCKED: 'BLOCKED',
} as const;
export type MigrationPhase = (typeof MigrationPhase)[keyof typeof MigrationPhase];

export const Actor = {
  /** Serva does it, when asked. */
  SERVA: 'SERVA',
  /** Only a person can: carry a drive, install software, sign in. */
  OWNER: 'OWNER',
} as const;
export type Actor = (typeof Actor)[keyof typeof Actor];

export interface MigrationStepView {
  readonly phase: MigrationPhase;
  readonly title: string;
  readonly actor: Actor;
  /** The exact command, where there is one. */
  readonly command?: string;
  /** How Serva will KNOW this happened. Never "tell me when you are done". */
  readonly provenBy: string;
  readonly done: boolean;
}

export interface MigrationStateInput {
  /** The folder Serva is looking at right now. */
  readonly root?: string;
  /** Where the bundle is, when the owner has said. */
  readonly bundlePath?: string;
  readonly probes: DoctorProbes;
  /**
   * The current machine's substrate measurement, when one is available.
   *
   * Optional because obtaining it is expensive and the early phases do not need it — and
   * because a migration that could not report its state until the substrate answered would
   * be unusable on exactly the half-built machine it exists to help.
   */
  readonly qualification?: SubstrateQualification;
  /**
   * Whether the ENGINE reports an authenticated session, when anybody has asked it.
   *
   * Passed straight through to `bootstrapPlan`. Absent means nobody asked, which is not the
   * same as "not signed in" and must never be flattened into it.
   */
  readonly engineAuthenticated?: boolean;
}

export interface MigrationState {
  readonly phase: MigrationPhase;
  /** Everything, in order, each marked done or not. An owner can see the whole route. */
  readonly steps: readonly MigrationStepView[];
  /** The one thing to do next, or undefined when complete. */
  readonly next?: MigrationStepView;
  readonly summary: string;
  /** What the bundle says about itself, when one was found and verified. */
  readonly manifest?: BackupManifest;
  readonly problems: readonly string[];
}

/**
 * Where this migration has got to.
 *
 * Reads. Nothing here writes, moves, installs or qualifies — the workflow's job is to know
 * the truth and say what is next, and every action it names is performed by a command the
 * owner can also run themselves.
 */
export function migrationState(input: MigrationStateInput): MigrationState {
  const problems: string[] = [];
  const root = input.root;

  /* ------------------------------------------------------- what is actually on disk */

  const projectHere = root !== undefined && isServaProject(root);

  const bundleGiven = input.bundlePath !== undefined && input.bundlePath.trim() !== '';
  const bundleExists = bundleGiven && existsSync(input.bundlePath as string);
  const verification = bundleExists ? verifyBackup(input.bundlePath as string) : undefined;
  const bundleVerified = verification?.ok === true;
  const manifest = verification?.manifest;

  if (bundleGiven && !bundleExists) {
    problems.push('There is nothing at ' + String(input.bundlePath) + '.');
  }
  if (bundleExists && !bundleVerified) {
    problems.push(
      'The bundle at ' +
        String(input.bundlePath) +
        ' did not verify: ' +
        (verification?.problems[0] ?? 'unknown'),
    );
  }

  /*
   * A bundle from a FORMAT this build cannot read is a stop, not a step. Saying so here —
   * before the owner carries a drive to another building — is the whole value of checking.
   */
  if (manifest !== undefined) {
    const plan = planMigration(manifest.formatVersion);
    if (plan.outcome === 'UNSUPPORTED' || plan.outcome === 'FROM_THE_FUTURE') {
      problems.push(plan.explanation);
    }
  }

  /* ------------------------------------------------------------------- this machine */

  /*
   * READINESS IS BOOTSTRAP'S QUESTION, ASKED ONCE.
   *
   * An earlier draft asked the doctor directly and required every engineering-blocking check
   * to read READY. That state is unreachable by construction: the sign-in check deliberately
   * never returns READY from a credentials file, because a file is not a session. The step
   * could therefore never complete, and a migration whose fourth step can never finish is
   * worse than no migration.
   *
   * So this asks `bootstrapPlan`, which already knows the difference between "a person must
   * act" and "Serva could not see" — and knows that the authoritative answer about sign-in
   * comes from the engine rather than from a file. One definition of a prepared machine, in
   * one place, used by both commands.
   */
  const bootstrap = bootstrapPlan({
    probes: input.probes,
    ...(projectHere && root !== undefined ? { projectRoots: [root] } : {}),
    ...(input.engineAuthenticated === undefined
      ? {}
      : { engineAuthenticated: input.engineAuthenticated }),
  });
  const machineReady = bootstrap.ownerActions.length === 0;

  /*
   * Qualification is the TARGET machine earning HARD for itself. An absent measurement is
   * not a failure here — it is simply the step that has not happened yet — but a measurement
   * that did not reach the guest is never counted as one.
   */
  const qualified =
    input.qualification !== undefined &&
    input.qualification.attempt === QualificationAttempt.MEASURED &&
    input.qualification.enforcementClass === EnforcementClass.HARD;

  /* ------------------------------------------------------------------------- the route */

  const steps: MigrationStepView[] = [
    {
      phase: MigrationPhase.CAPTURE,
      title: 'Capture everything on the machine you are leaving',
      actor: Actor.SERVA,
      command: 'serva backup --to <path on external storage> --confirm',
      provenBy: 'a bundle exists at the path you name',
      done: bundleExists,
    },
    {
      phase: MigrationPhase.VERIFY,
      title: 'Prove the bundle before you rely on it',
      actor: Actor.SERVA,
      command: 'serva verify-backup <that path>',
      provenBy: 'every file in the bundle matches the digest recorded for it',
      done: bundleVerified,
    },
    {
      phase: MigrationPhase.CARRY,
      title: 'Carry the bundle to the new computer',
      actor: Actor.OWNER,
      /*
       * SERVA CANNOT SEE WHICH COMPUTER YOU ARE STANDING AT.
       *
       * An earlier draft inferred it — a verified bundle plus no project meant "arrived" —
       * and it was wrong in both directions. On the source machine it read as not-yet-carried
       * forever; on the target it flipped BACK to not-carried the moment the project was
       * restored, so the workflow went backwards after a step succeeded.
       *
       * The truthful model is that this step is the owner's and its completion is not
       * observable. What IS observable is everything after it, and those steps are what
       * distinguish the two machines: a project restored here, a machine prepared here, a
       * measurement taken here. So this is marked done once the bundle is provably readable
       * from wherever Serva is running, and the rendering says plainly that the remaining
       * steps describe the computer in front of you.
       */
      provenBy:
        'the bundle verifies from the machine Serva is running on. Serva cannot tell which ' +
        'computer that is — the steps below are about the one in front of you',
      done: bundleVerified,
    },
    {
      phase: MigrationPhase.RESTORE,
      title: 'Restore the project here',
      actor: Actor.SERVA,
      command: 'serva restore <bundle> --to <projects dir> --confirm',
      provenBy: 'a Serva project exists at the destination and opens',
      done: projectHere,
    },
    {
      phase: MigrationPhase.PREPARE_MACHINE,
      title: 'Give this computer what Serva needs',
      actor: Actor.OWNER,
      command: 'serva machine bootstrap',
      provenBy: 'nothing on this computer is left for a person to install or sign into',
      done: machineReady,
    },
    {
      phase: MigrationPhase.QUALIFY,
      title: 'This computer earns its own qualification',
      actor: Actor.SERVA,
      command: 'serva engineering qualify',
      provenBy: 'a completed measurement of THIS machine reports HARD',
      done: qualified,
    },
  ];

  const firstOutstanding = steps.find((s) => !s.done);
  const phase =
    problems.length > 0
      ? MigrationPhase.BLOCKED
      : (firstOutstanding?.phase ?? MigrationPhase.COMPLETE);

  const summary =
    problems.length > 0
      ? 'Migration cannot continue: ' + problems[0]
      : firstOutstanding === undefined
        ? 'The project is here and this computer has been measured. Nothing is outstanding.'
        : 'Next: ' +
          firstOutstanding.title +
          ' (' +
          (firstOutstanding.actor === Actor.OWNER ? 'you' : 'Serva') +
          ')';

  return {
    phase,
    steps,
    ...(firstOutstanding === undefined ? {} : { next: firstOutstanding }),
    summary,
    ...(manifest === undefined ? {} : { manifest }),
    problems,
  };
}

/** The owner-facing rendering. */
export function renderMigration(state: MigrationState): string {
  const lines: string[] = ['Moving Serva to another computer', ''];

  for (const step of state.steps) {
    const mark = step.done ? ' ok ' : step === state.next ? ' >> ' : '    ';
    lines.push('  [' + mark + '] ' + step.title + (step.actor === Actor.OWNER ? '  (you)' : ''));
    if (!step.done) {
      if (step.command !== undefined) lines.push('           ' + step.command);
      lines.push('           Serva knows this happened when: ' + step.provenBy);
    }
  }

  lines.push('');
  lines.push('Everything below the carry step describes the computer you are using now.');
  lines.push('');
  lines.push(state.summary);

  if (state.problems.length > 0) {
    lines.push('');
    for (const problem of state.problems) lines.push('  ! ' + problem);
  }

  if (state.manifest !== undefined) {
    lines.push('');
    lines.push(
      'The bundle holds ' +
        String(state.manifest.projects.length) +
        ' project(s), captured ' +
        state.manifest.createdAt +
        ' by Serva ' +
        state.manifest.servaVersion +
        '.',
    );
    if (state.manifest.machineBoundExcluded.length > 0) {
      lines.push(
        'Deliberately left behind: ' +
          state.manifest.machineBoundExcluded.join(', ') +
          '. These describe the old computer.',
      );
    }
  }

  lines.push('');
  lines.push('Project truth, git history, decisions and evidence move.');
  lines.push('Machine qualification does not: HARD describes a computer, and this is a');
  lines.push('different computer until it has measured itself.');

  return lines.join('\n');
}
