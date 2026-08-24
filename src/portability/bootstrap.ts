import { CheckState, machineDoctor } from './doctor.js';
import { SERVA_VERSION } from './version.js';
import type { DoctorInput, DoctorReport, CheckResult } from './doctor.js';

/**
 * BRINGING A MACHINE UP, WITHOUT SERVA INSTALLING ANYTHING ON IT.
 *
 * SPEC: Phase 6 closure §9, §18; §29, §30.
 *
 * `serva doctor` says what is wrong. An independent audit found nothing that turns that into
 * a sequence somebody can follow, so an owner on a fresh machine got a list of complaints and
 * no order to address them in.
 *
 * The obvious implementation is the forbidden one. Serva does not install WSL, does not
 * install an engine, does not enable a sandbox mechanism and does not weaken containment to
 * make a check pass. Those are the owner's machine, the owner's account and the owner's
 * security posture, and a program that silently changed any of them would be doing the thing
 * this product exists to refuse.
 *
 * So bootstrap CLASSIFIES. Every step lands in exactly one disposition, and the disposition
 * decides who acts:
 *
 *   AUTO_SAFE                     Serva may do it, because it touches only Serva's own state
 *                                 inside a project directory. Nothing here installs software,
 *                                 changes a setting outside Serva, or spends anything.
 *
 *   OWNER_APPROVAL_REQUIRED       Serva could do it, and will not without being asked. It
 *                                 costs something, changes something durable, or would be a
 *                                 surprise.
 *
 *   MANUAL_HUMAN_ACTION_REQUIRED  Only a person can do it: install a package, sign into an
 *                                 account, change a Windows feature. Serva supplies the exact
 *                                 command and stops.
 *
 *   BLOCKED                       It cannot be done on this machine as it stands, and the
 *                                 owner needs to know why rather than be given a command that
 *                                 will fail.
 *
 * The overall state is the worst step present, and COMPLETE means every step is satisfied.
 * Derived rather than set: a bootstrap that could be marked complete would be marked complete.
 */

export const StepDisposition = {
  AUTO_SAFE: 'AUTO_SAFE',
  OWNER_APPROVAL_REQUIRED: 'OWNER_APPROVAL_REQUIRED',
  MANUAL_HUMAN_ACTION_REQUIRED: 'MANUAL_HUMAN_ACTION_REQUIRED',
  BLOCKED: 'BLOCKED',
  /** Already true. Nothing to do. */
  SATISFIED: 'SATISFIED',
} as const;
export type StepDisposition = (typeof StepDisposition)[keyof typeof StepDisposition];

export const BootstrapState = {
  /** Every step is satisfied. */
  COMPLETE: 'COMPLETE',
  /** Something is left that Serva may do on its own. */
  AUTO_SAFE: 'AUTO_SAFE',
  OWNER_APPROVAL_REQUIRED: 'OWNER_APPROVAL_REQUIRED',
  MANUAL_HUMAN_ACTION_REQUIRED: 'MANUAL_HUMAN_ACTION_REQUIRED',
  BLOCKED: 'BLOCKED',
} as const;
export type BootstrapState = (typeof BootstrapState)[keyof typeof BootstrapState];

export interface BootstrapStep {
  readonly id: string;
  readonly title: string;
  readonly disposition: StepDisposition;
  /** Why this step is in the state it is, in terms of what was measured. */
  readonly because: string;
  /**
   * The exact command the OWNER runs, for a manual step.
   *
   * Written for the guest shell it belongs in, and never run by Serva. A step that carries a
   * command Serva would execute itself is a step in the wrong disposition.
   */
  readonly ownerCommand?: string;
  /** Where the owner runs it: the Windows host, or inside the WSL guest. */
  readonly runIn?: 'WINDOWS' | 'WSL_GUEST';
  /** True when engineering cannot run until this step is satisfied. */
  readonly blocksEngineering: boolean;
  /**
   * Serva could not measure this, so the step is what the owner may need rather than what
   * they definitely need.
   *
   * Carried separately from the disposition because the two answer different questions: WHO
   * acts, and HOW SURE Serva is. Folding them together is how "I could not check" becomes
   * "it is missing" in an owner's inbox.
   */
  readonly unmeasured?: boolean;
}

export interface BootstrapInput extends DoctorInput {
  /**
   * Whether the ENGINE ITSELF reports an authenticated session.
   *
   * The doctor deliberately never returns READY for sign-in: a credentials file is evidence
   * that somebody signed in once, on some machine, and reporting READY from it once produced
   * a green diagnostic line sitting directly above a refusal from the factory.
   *
   * That rule is right, and it leaves this one with a problem — a bootstrap that could never
   * reach COMPLETE would train an owner to ignore its last line. So the authoritative answer
   * is accepted here, from the only thing that has one: the engine's own health report, which
   * `serva engineering doctor` obtains by asking it.
   *
   * Absent means nobody asked. That is NOT the same as `false`, and it must never be
   * flattened into one: unasked stays unmeasured and the owner is told to check, while a real
   * `false` is a real "you are not signed in".
   */
  readonly engineAuthenticated?: boolean;
}

export interface BootstrapPlan {
  readonly servaVersion: string;
  readonly state: BootstrapState;
  readonly steps: readonly BootstrapStep[];
  /** Everything the owner must do by hand, in order. Empty when there is nothing. */
  readonly ownerActions: readonly BootstrapStep[];
  readonly summary: string;
  /** The doctor report this plan was derived from, so a reader can check the reasoning. */
  readonly report: DoctorReport;
}

/**
 * Which checks can only ever be resolved by a person, and the command that resolves them.
 *
 * A table rather than a rule over the check's own text. The audit's recurring lesson is that
 * anything routing on how something described itself will eventually miss a case, and the
 * cost here is Serva either doing something on somebody's machine that it must not, or
 * telling an owner to run a command for a component that is already there.
 */
const MANUAL: Readonly<
  Record<string, { readonly command: string; readonly runIn: 'WINDOWS' | 'WSL_GUEST' }>
> = Object.freeze({
  WSL2: { command: 'wsl --install', runIn: 'WINDOWS' },
  DISTRO: { command: 'wsl --install -d Ubuntu', runIn: 'WINDOWS' },
  GIT: { command: 'sudo apt-get update && sudo apt-get install -y git', runIn: 'WSL_GUEST' },
  /*
   * The engine is named by its check id because that is what the doctor measured. Naming a
   * vendor here is the same irreducible fact as in `doctor.ts`: the owner has to install and
   * sign into a specific program, and a message that would not say which is not a remedy.
   * Nothing in this file reaches into an adapter.
   */
  CLAUDE: {
    command: 'Install the engine CLI inside the guest, following its vendor’s instructions',
    runIn: 'WSL_GUEST',
  },
  CLAUDE_AUTH: {
    command: 'Sign in to the engine CLI inside the guest, with your existing subscription',
    runIn: 'WSL_GUEST',
  },
  SANDBOX: {
    command: 'sudo apt-get update && sudo apt-get install -y bubblewrap',
    runIn: 'WSL_GUEST',
  },
  SANDBOX_PRODUCER: {
    command: 'Install the engine’s own sandbox runtime inside the guest',
    runIn: 'WSL_GUEST',
  },
  /*
   * The only entry whose command asks for nothing to be installed. Interop being enabled
   * WEAKENS containment, so the remedy is to leave it off — and Serva must never turn it
   * back on because a test would be easier with it.
   */
  INTEROP: {
    command: 'Leave Windows interop disabled in /etc/wsl.conf',
    runIn: 'WSL_GUEST',
  },
});

const AUTO_SAFE_STEPS: readonly string[] = Object.freeze(['BACKUP']);

function dispositionFor(check: CheckResult): StepDisposition {
  if (check.state === CheckState.READY) return StepDisposition.SATISFIED;

  /*
   * UNKNOWN is never satisfied, and never something Serva acts on.
   *
   * What it becomes depends on whether a person has anything to do about it. With a known
   * owner action — signing in, installing a runtime — the honest answer is that action,
   * because "Serva could not confirm you are signed in" and "you may need to sign in" are the
   * same instruction from the owner's side. Without one, it is BLOCKED: a probe that did not
   * run tells nobody what to do, and inventing a command for a component that might already
   * be there is the failure the doctor was corrected for once already.
   *
   * The uncertainty is not lost. `unmeasured` travels with the step and the renderer says so
   * before the command, so an owner is never told something is missing when what actually
   * happened is that Serva could not see it.
   */
  if (check.state === CheckState.UNKNOWN) {
    return MANUAL[check.id] === undefined
      ? StepDisposition.BLOCKED
      : StepDisposition.MANUAL_HUMAN_ACTION_REQUIRED;
  }

  if (AUTO_SAFE_STEPS.includes(check.id)) return StepDisposition.AUTO_SAFE;
  if (MANUAL[check.id] !== undefined) return StepDisposition.MANUAL_HUMAN_ACTION_REQUIRED;

  /*
   * Anything unrecognised needs a person to look at it. Defaulting the other way would mean
   * a check added later becomes something Serva silently acts on.
   */
  return StepDisposition.OWNER_APPROVAL_REQUIRED;
}

const ORDER: readonly StepDisposition[] = Object.freeze([
  StepDisposition.BLOCKED,
  StepDisposition.MANUAL_HUMAN_ACTION_REQUIRED,
  StepDisposition.OWNER_APPROVAL_REQUIRED,
  StepDisposition.AUTO_SAFE,
]);

/**
 * Work out what this machine still needs.
 *
 * Reads. Nothing here installs, enables, configures or authenticates, and there is no option
 * that makes it do so — the plan is the deliverable.
 */
export function bootstrapPlan(input: BootstrapInput): BootstrapPlan {
  const report = machineDoctor(input);

  const steps: BootstrapStep[] = report.checks.map((check) => {
    /*
     * The one place an answer from outside the doctor overrides it, and only ever in the
     * direction of a fact the doctor said it could not establish. A `false` here does not
     * make anything satisfied, and an absent value changes nothing at all.
     */
    if (check.id === 'CLAUDE_AUTH' && input.engineAuthenticated === true) {
      return {
        id: check.id,
        title: check.label,
        disposition: StepDisposition.SATISFIED,
        because: 'the engine itself reports an authenticated session',
        blocksEngineering: check.blocksEngineering,
      };
    }
    const disposition = dispositionFor(check);
    const manual = MANUAL[check.id];
    return {
      id: check.id,
      title: check.label,
      disposition,
      because: check.detail,
      ...(disposition === StepDisposition.MANUAL_HUMAN_ACTION_REQUIRED && manual !== undefined
        ? { ownerCommand: manual.command, runIn: manual.runIn }
        : {}),
      blocksEngineering: check.blocksEngineering,
      ...(check.state === CheckState.UNKNOWN ? { unmeasured: true } : {}),
    };
  });

  /* The worst thing present, in a fixed order. A machine is as ready as its weakest step. */
  const worst = ORDER.find((d) => steps.some((s) => s.disposition === d));
  const state: BootstrapState =
    worst === undefined
      ? BootstrapState.COMPLETE
      : worst === StepDisposition.BLOCKED
        ? BootstrapState.BLOCKED
        : worst === StepDisposition.MANUAL_HUMAN_ACTION_REQUIRED
          ? BootstrapState.MANUAL_HUMAN_ACTION_REQUIRED
          : worst === StepDisposition.OWNER_APPROVAL_REQUIRED
            ? BootstrapState.OWNER_APPROVAL_REQUIRED
            : BootstrapState.AUTO_SAFE;

  const ownerActions = steps.filter(
    (s) =>
      s.disposition === StepDisposition.MANUAL_HUMAN_ACTION_REQUIRED ||
      s.disposition === StepDisposition.BLOCKED,
  );

  const outstanding = steps.filter((s) => s.disposition !== StepDisposition.SATISFIED);

  return {
    servaVersion: SERVA_VERSION,
    state,
    steps,
    ownerActions,
    summary:
      state === BootstrapState.COMPLETE
        ? 'This machine has everything Serva needs.'
        : String(outstanding.length) +
          ' step(s) outstanding; ' +
          String(ownerActions.length) +
          ' need you rather than Serva.',
    report,
  };
}

/**
 * The owner-facing text.
 *
 * Headed `SERVA CODE — OWNER ACTION REQUIRED` when a person has to act, because that is the
 * phrase the closure asks for and because an owner scanning a terminal should be able to tell
 * in one line whether they are being informed or asked.
 *
 * BOOTSTRAP COMPLETE IS NOT QUALIFICATION. A machine can have every prerequisite and still be
 * SOFT, and engineering that writes requires a HARD boundary measured by Phase 4 — not by
 * this. Saying so here is the difference between a plan and a promise.
 */
export function renderBootstrap(plan: BootstrapPlan): string {
  const lines: string[] = [];

  if (plan.state === BootstrapState.COMPLETE) {
    lines.push('SERVA CODE ' + plan.servaVersion + ' — machine bootstrap COMPLETE');
  } else if (
    plan.state === BootstrapState.MANUAL_HUMAN_ACTION_REQUIRED ||
    plan.state === BootstrapState.BLOCKED
  ) {
    lines.push('SERVA CODE — OWNER ACTION REQUIRED');
  } else {
    lines.push('SERVA CODE ' + plan.servaVersion + ' — machine bootstrap ' + plan.state);
  }
  lines.push('');
  lines.push(plan.summary);
  lines.push('');

  for (const step of plan.steps) {
    const mark =
      step.disposition === StepDisposition.SATISFIED
        ? ' ok '
        : step.disposition === StepDisposition.BLOCKED
          ? 'STOP'
          : step.disposition === StepDisposition.MANUAL_HUMAN_ACTION_REQUIRED
            ? ' you'
            : step.disposition === StepDisposition.OWNER_APPROVAL_REQUIRED
              ? ' ask'
              : ' srv';
    lines.push('  [' + mark + '] ' + step.title);
    if (step.disposition !== StepDisposition.SATISFIED) {
      lines.push('         ' + step.because);
      if (step.unmeasured === true) {
        lines.push('         Serva could not confirm this, so check before acting on it.');
      }
      if (step.ownerCommand !== undefined) {
        lines.push(
          '         run in ' +
            (step.runIn === 'WSL_GUEST' ? 'the WSL guest' : 'Windows') +
            ':  ' +
            step.ownerCommand,
        );
      }
    }
  }

  lines.push('');
  if (plan.ownerActions.length > 0) {
    lines.push('Serva does not install these for you. They are your machine, your account and');
    lines.push('your security posture, and a program that changed any of them quietly would be');
    lines.push('doing the thing this one exists to refuse.');
    lines.push('');
  }
  /*
   * Always printed, including on COMPLETE. The one sentence somebody is most likely to skip
   * is the one that stops them reading a green line as permission to write code.
   */
  lines.push('Bootstrap is not qualification. A machine with every prerequisite can still be');
  lines.push('SOFT; write-capable engineering needs a HARD boundary, measured separately.');

  return lines.join('\n');
}
