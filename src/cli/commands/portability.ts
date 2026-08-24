import { ACTIONS, invokeAction } from '../../app/actions.js';
import { projectSnapshot } from '../../app/services.js';
import { machineDoctor, renderDoctor } from '../../portability/doctor.js';
import { nodeDoctorProbes } from '../../portability/probes.js';
import { bootstrapPlan, renderBootstrap } from '../../portability/bootstrap.js';
import { migrationState, renderMigration } from '../../portability/migrationWorkflow.js';
import {
  installation,
  performSwitch,
  planSwitch,
  removeVersion,
  renderInstallation,
} from '../../portability/install.js';
import { buildEngineeringLayer } from '../../app/engineering.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyBackup } from '../../portability/backup.js';
import { inspectRestore } from '../../portability/restore.js';
import {
  describeLibrary,
  deleteLibraryEntry,
  libraryProvenance,
  readLibrary,
} from '../../learning/library.js';
import { acceptanceStatus } from '../../acceptance/status.js';
import { emitJson, openRuntime, tryOpenRuntime, wantsJson } from './_shared.js';
import type { ParsedArgs } from '../main.js';

/**
 * PORTABILITY AND MACHINE COMMANDS — THE SAME COMPANY, FROM A TERMINAL.
 *
 * SPEC: §49, §22, §24, §27, §30.
 *
 * Every command here calls the SAME application service the extension calls. That is the
 * whole point of `serva backup` existing alongside a button: two implementations of "make
 * a verified backup" would eventually differ, and the difference would surface on the day
 * somebody needed the backup.
 *
 * The consequential ones require `--confirm`. A flag is not a modal, and it is not meant
 * to be — what it is, is a deliberate act. `serva restore` with no flag prints exactly what
 * would happen and writes nothing, which is the behaviour somebody wants at 2am when they
 * are not sure which backup they are holding.
 */

function confirmed(args: ParsedArgs): boolean {
  return args.flags['confirm'] === true || args.flags['confirm'] === 'true';
}

function flag(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags[name];
  return typeof value === 'string' ? value : undefined;
}

/** `serva machine doctor` — inspect this computer. Nothing is repaired. */
export function cmdMachine(args: ParsedArgs): number {
  const sub = args.positionals[0] ?? 'doctor';
  if (sub !== 'doctor' && sub !== 'bootstrap') {
    console.error('Usage: serva machine doctor | bootstrap  [--json]');
    return 2;
  }
  const rt = tryOpenRuntime(args);

  if (sub === 'bootstrap') {
    const plan = bootstrapPlan({
      probes: nodeDoctorProbes(),
      ...(rt === undefined ? {} : { projectRoots: [rt.root] }),
    });
    if (wantsJson(args)) {
      emitJson(plan);
    } else {
      console.log(renderBootstrap(plan));
    }
    /*
     * Exit 0 only when the machine needs nothing. Anything waiting on the owner exits
     * non-zero, so a script cannot mistake "you still have to install WSL" for success — and
     * BLOCKED gets its own code, because "do this" and "this cannot be done here" are
     * different answers and a caller may want to tell them apart.
     */
    return plan.state === 'COMPLETE' ? 0 : plan.state === 'BLOCKED' ? 2 : 1;
  }

  const report = machineDoctor({
    probes: nodeDoctorProbes(),
    ...(rt === undefined ? {} : { projectRoots: [rt.root] }),
  });
  if (wantsJson(args)) {
    emitJson(report);
    return report.engineeringReady ? 0 : 1;
  }
  console.log(renderDoctor(report));
  /*
   * Exit 1 when engineering could not run. A diagnostic that always exits 0 is one nobody
   * can put in a script, and the whole point of this command is that its answer is
   * actionable.
   */
  return report.engineeringReady ? 0 : 1;
}

/** `serva backup --to <path> [--confirm]` */
export async function cmdBackup(args: ParsedArgs): Promise<number> {
  const rt = openRuntime(args);
  const destination = flag(args, 'to') ?? args.positionals[0];
  if (destination === undefined) {
    console.error('Usage: serva backup --to <path> [--confirm]');
    console.error('Without --confirm nothing is written.');
    return 2;
  }
  if (!confirmed(args)) {
    console.log('serva backup would write a verified backup of');
    console.log('  ' + rt.root);
    console.log('to');
    console.log('  ' + destination);
    console.log('');
    console.log(String(ACTIONS.get('backup.create')?.confirmPrompt));
    console.log('Re-run with --confirm to do it.');
    return 0;
  }
  const result = await invokeAction(
    { rt },
    {
      id: 'backup.create',
      /*
       * The identity comes from the Store, and this caller is not asked for it. It used to
       * derive an id from the FOLDER NAME, which meant renaming a directory renamed the
       * project as far as every backup made afterwards was concerned.
       */
      input: { destination },
      confirmed: true,
    },
  );
  if (wantsJson(args)) emitJson(result);
  else console.log(result.ok ? result.summary : String(result.refusal));
  return result.ok ? 0 : 1;
}

/** `serva verify-backup <path>` — prove a bundle before relying on it. */
export function cmdVerifyBackup(args: ParsedArgs): number {
  const bundle = args.positionals[0] ?? flag(args, 'path');
  if (bundle === undefined) {
    console.error('Usage: serva verify-backup <path> [--json]');
    return 2;
  }
  const result = verifyBackup(bundle);
  if (wantsJson(args)) {
    emitJson(result);
  } else {
    console.log(result.summary);
    for (const problem of result.problems) console.log('  - ' + problem);
  }
  return result.ok ? 0 : 1;
}

/** `serva restore <bundle> --to <dir> [--confirm] [--overwrite]` */
export async function cmdRestore(args: ParsedArgs): Promise<number> {
  const bundlePath = args.positionals[0] ?? flag(args, 'from');
  const destinationRoot = flag(args, 'to');
  if (bundlePath === undefined || destinationRoot === undefined) {
    console.error('Usage: serva restore <bundle> --to <dir> [--confirm] [--overwrite]');
    return 2;
  }

  /*
   * INSPECT FIRST, ALWAYS. This half never writes, and it runs whether or not the caller
   * passed --confirm: somebody about to overwrite a project should see the plan even when
   * they were sure.
   */
  const inspection = inspectRestore({ bundlePath, destinationRoot });
  console.log(inspection.summary);
  for (const project of inspection.projects) {
    console.log(
      '  ' +
        project.projectId +
        ' → ' +
        project.destination +
        ' (' +
        String(project.files) +
        ' files, ' +
        project.conflict +
        ')',
    );
  }
  if (inspection.notRestored.length > 0) {
    console.log('');
    console.log('What will NOT be restored:');
    for (const line of inspection.notRestored) console.log('  - ' + line);
  }
  for (const problem of inspection.problems) console.log('  ! ' + problem);

  if (!confirmed(args)) {
    console.log('');
    console.log('Nothing was written. Re-run with --confirm to restore.');
    return inspection.ok ? 0 : 1;
  }

  const rt = tryOpenRuntime(args);
  const result = await invokeAction(
    /*
     * A restore may run with no project open — that is the whole point on a fresh
     * machine — so the runtime is optional and the action reads only the paths it was
     * given.
     */
    { rt: rt as never },
    {
      id: 'restore.perform',
      input: {
        bundlePath,
        destinationRoot,
        ...(args.flags['overwrite'] === true ? { overwrite: true } : {}),
      },
      confirmed: true,
    },
  );
  console.log(result.ok ? result.summary : String(result.refusal));
  if (result.ok) {
    const data = result.data as { readonly notes?: readonly string[] } | undefined;
    for (const note of data?.notes ?? []) console.log('  - ' + note);
  }
  return result.ok ? 0 : 1;
}

/**
 * `serva migrate` — the guided move to another computer.
 *
 * SPEC: Phase 6 closure §10.
 *
 * This used to print seven numbered lines and exit zero: instructions, not a workflow. It
 * said the same thing on the machine being left as on the machine being moved to, which are
 * the two states the whole exercise is about.
 *
 * Now it reports WHERE THE MIGRATION HAS GOT TO, derived from what is observably true — a
 * bundle that verifies, a project that opens, a machine that has measured itself. There is no
 * cursor to advance, so an owner who skips a step is told what is missing rather than handed
 * a workflow that has quietly moved on.
 */
export async function cmdMigrate(args: ParsedArgs): Promise<number> {
  const rt = tryOpenRuntime(args);
  const bundle = flag(args, 'bundle') ?? args.positionals[0];

  /*
   * The substrate measurement is obtained only when there is a project to measure for, and
   * failures are absorbed: a half-built target machine is exactly where this command is most
   * useful, and one that refused to report until the substrate answered would be useless
   * there.
   */
  let qualification;
  if (rt !== undefined) {
    try {
      const layer = await buildEngineeringLayer(rt);
      const fixture = mkdtempSync(join(tmpdir(), 'serva-migrate-'));
      try {
        qualification = await layer.substrate.qualify(fixture);
      } finally {
        rmSync(fixture, { recursive: true, force: true });
      }
    } catch {
      qualification = undefined;
    }
  }

  const state = migrationState({
    ...(rt === undefined ? {} : { root: rt.root }),
    ...(typeof bundle === 'string' ? { bundlePath: bundle } : {}),
    probes: nodeDoctorProbes(),
    ...(qualification === undefined ? {} : { qualification }),
  });

  if (wantsJson(args)) {
    emitJson(state);
  } else {
    console.log(renderMigration(state));
  }

  /*
   * Zero only when there is nothing outstanding. A migration command that always exited zero
   * could not be used in a script, and the owner most likely to script this is the one moving
   * several machines.
   */
  return state.phase === 'COMPLETE' ? 0 : state.phase === 'BLOCKED' ? 2 : 1;
}

/**
 * `serva install [status | use <version> | remove <version>]`
 *
 * SPEC: Phase 6 closure §11.
 *
 * Serva does not download anything, and there is no code path here that could. What this
 * manages is which INSTALLED version runs — a pointer move, which is why going back costs
 * exactly what going forward did.
 */
export function cmdInstall(args: ParsedArgs): number {
  const sub = args.positionals[0] ?? 'status';
  const root = flag(args, 'install-root') ?? defaultInstallRoot();
  const state = installation(root);

  if (sub === 'status') {
    if (wantsJson(args)) emitJson(state);
    else console.log(renderInstallation(state));
    return state.problems.length === 0 ? 0 : 1;
  }

  if (sub === 'use' || sub === 'remove') {
    const version = args.positionals[1];
    if (version === undefined) {
      console.error('Usage: serva install ' + sub + ' <version>');
      return 2;
    }

    /*
     * The projects this machine knows about, so a rollback that would strand one is refused
     * BEFORE the pointer moves. An installer that discovered this afterwards would already
     * have broken the thing it was meant to protect.
     */
    const rt = tryOpenRuntime(args);
    const projectRoots = rt === undefined ? [] : [rt.root];

    if (sub === 'remove') {
      if (!confirmed(args)) {
        console.log('serva install remove ' + version + ' would delete that version from disk.');
        console.log('It is the one operation here that cannot be undone by moving a pointer.');
        console.log('Re-run with --confirm to do it.');
        return 0;
      }
      const plan = removeVersion(state, version);
      if (wantsJson(args)) emitJson(plan);
      else console.log(plan.reason);
      return plan.outcome === 'REFUSED' ? 1 : 0;
    }

    const preview = planSwitch(state, version, projectRoots);
    if (preview.outcome !== 'READY' || !confirmed(args)) {
      if (wantsJson(args)) {
        emitJson(preview);
      } else {
        console.log(preview.reason);
        for (const step of preview.steps) console.log('  - ' + step);
        if (preview.outcome === 'READY') console.log('Re-run with --confirm to do it.');
      }
      return preview.outcome === 'REFUSED' ? 1 : 0;
    }

    const plan = performSwitch(state, version, projectRoots);
    if (wantsJson(args)) emitJson(plan);
    else console.log(plan.reason);
    return plan.outcome === 'REFUSED' ? 1 : 0;
  }

  console.error('Usage: serva install status | use <version> | remove <version>');
  return 2;
}

/**
 * Where Serva keeps its own versions when nobody says otherwise.
 *
 * Under the owner's own data directory rather than a shared system location: this is a
 * single-owner product, and an installation somewhere requiring administrator rights would
 * make every update an escalation.
 */
function defaultInstallRoot(): string {
  const home = process.env['USERPROFILE'] ?? process.env['HOME'] ?? process.cwd();
  return join(home, '.serva-code');
}

/** `serva library [list|show <id>|forget <id>] --enable` */
export function cmdLibrary(args: ParsedArgs): number {
  const sub = args.positionals[0] ?? 'list';
  const enabled = args.flags['enable'] === true || args.flags['enable'] === 'true';
  const options = { enabled };

  if (sub === 'list') {
    const entries = readLibrary(options);
    if (!enabled) {
      console.log('Organizational learning is off.');
      console.log(
        'Nothing crosses between projects until you turn it on: serva library list --enable',
      );
      return 0;
    }
    if (wantsJson(args)) {
      emitJson(entries);
      return 0;
    }
    console.log(describeLibrary(entries));
    for (const e of entries) console.log('  ' + e.id + '  ' + e.kind.padEnd(16) + e.title);
    return 0;
  }

  if (sub === 'show') {
    const id = args.positionals[1];
    const entry = readLibrary(options).find((e) => e.id === id);
    if (entry === undefined) {
      console.error('No library entry ' + String(id) + (enabled ? '' : ' (learning is off)'));
      return 1;
    }
    const provenance = libraryProvenance(entry);
    console.log(entry.title);
    for (const [k, v] of Object.entries(entry.body)) console.log('  ' + k + ': ' + v);
    console.log('');
    console.log('Contributed ' + provenance.contributedAt + ' by Serva ' + provenance.servaVersion);
    console.log('Serva deliberately does not record:');
    for (const line of provenance.notRecorded) console.log('  - ' + line);
    return 0;
  }

  if (sub === 'forget') {
    const id = args.positionals[1];
    if (id === undefined) {
      console.error('Usage: serva library forget <id>');
      return 2;
    }
    const removed = deleteLibraryEntry(id, options);
    console.log(removed ? 'Removed ' + id : 'No entry ' + id);
    return removed ? 0 : 1;
  }

  console.error('Usage: serva library [list|show <id>|forget <id>] [--enable]');
  return 2;
}

/** `serva actions` — every validated action, and what each one costs. */
export function cmdActions(args: ParsedArgs): number {
  const entries = [...ACTIONS.values()].map((d) => ({
    id: d.id,
    title: d.title,
    consequence: d.consequence,
    ...(d.confirmPrompt === undefined ? {} : { confirmPrompt: d.confirmPrompt }),
  }));
  if (wantsJson(args)) {
    emitJson(entries);
    return 0;
  }
  console.log('Serva actions — the same table the VS Code panel dispatches against.');
  console.log('');
  for (const e of entries) {
    console.log('  ' + e.id.padEnd(22) + e.consequence.padEnd(16) + e.title);
  }
  return 0;
}

/** `serva release` — the derived readiness, condition by condition. */
export async function cmdRelease(args: ParsedArgs): Promise<number> {
  const rt = openRuntime(args);
  const result = await invokeAction({ rt }, { id: 'release.readiness' });
  const readiness = result.data as
    | {
        readonly status: string;
        readonly conditions: readonly {
          id: string;
          label: string;
          state: string;
          detail: string;
        }[];
      }
    | undefined;
  if (wantsJson(args)) {
    emitJson(readiness);
    return readiness?.status === 'READY' ? 0 : 1;
  }
  console.log('Release readiness: ' + String(readiness?.status));
  console.log('');
  for (const c of readiness?.conditions ?? []) {
    console.log('  ' + c.label.padEnd(48, '.') + ' ' + c.state);
    if (c.state !== 'MET') console.log('      ' + c.detail);
  }
  console.log('');
  console.log(result.summary);
  return readiness?.status === 'READY' ? 0 : 1;
}

/** `serva overview` — what the status bar shows, in a terminal. */
export function cmdOverview(args: ParsedArgs): number {
  const rt = openRuntime(args);
  const snapshot = projectSnapshot(rt);
  if (wantsJson(args)) {
    emitJson(snapshot);
    return 0;
  }
  console.log('SERVA CODE ' + snapshot.servaVersion);
  console.log('');
  console.log('Project: ' + snapshot.projectName);
  console.log('Status:  ' + snapshot.health);
  console.log('');
  console.log(snapshot.headline);
  console.log('Next:    ' + snapshot.nextAction);
  if (snapshot.ownerActions.length > 0) {
    console.log('');
    console.log('Waiting for you:');
    for (const a of snapshot.ownerActions) console.log('  - ' + a.question);
  }
  if (snapshot.blockers.length > 0) {
    console.log('');
    console.log('Blocking:');
    for (const b of snapshot.blockers) console.log('  - ' + b);
  }
  console.log('');
  console.log('Machine: ' + snapshot.machine.state + ' — ' + snapshot.machine.reason);
  console.log('Release: ' + snapshot.release.status);
  return 0;
}

/**
 * `serva acceptance` — the status Serva issues about itself.
 *
 * Exits non-zero unless every line is proven. A readiness command that always succeeded
 * would be a readiness command nobody could put in a pipeline, and the whole point is that
 * READY is a conjunction rather than a headline.
 */
export function cmdAcceptance(args: ParsedArgs): number {
  const status = acceptanceStatus();
  if (wantsJson(args)) {
    emitJson(status);
    return status.readyForOwnerUse ? 0 : 1;
  }
  console.log(status.rendered);
  return status.readyForOwnerUse ? 0 : 1;
}
