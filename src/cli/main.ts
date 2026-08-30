#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { isServaError } from '../core/errors.js';
import { defaultInstallRoot } from '../portability/install.js';
import { HANDOFF_ENV, resolveActive } from '../portability/activeVersion.js';
import { cmdInit } from './commands/init.js';
import { cmdStatus } from './commands/status.js';
import { cmdProject } from './commands/project.js';
import { cmdDoctor } from './commands/doctor.js';
import { cmdGates } from './commands/gates.js';
import { cmdWorkflows } from './commands/workflows.js';
import { cmdAi, cmdAgents } from './commands/ai.js';
import { cmdRoute, cmdRuns, cmdRun, cmdContext } from './commands/route.js';
import {
  cmdEngineering,
  cmdWorktrees,
  cmdChanges,
  cmdEvidence,
  cmdQualificationCatalogue,
} from './commands/engineering.js';
import { cmdImplement } from './commands/implement.js';
import { cmdIntelligence, INTELLIGENCE_USAGE } from './commands/intelligence.js';
import {
  cmdAcceptance,
  cmdActions,
  cmdBackup,
  cmdLibrary,
  cmdMachine,
  cmdInstall,
  cmdMigrate,
  cmdOverview,
  cmdRelease,
  cmdRestore,
  cmdVerifyBackup,
} from './commands/portability.js';
import { SERVA_VERSION, SPEC_BASELINE } from '../app/runtime.js';

/**
 * Serva CLI — the engineering/control surface for the Core.
 *
 * This is NOT the conversational Serva interface (20). It exists so the Core can
 * be exercised and inspected without a UI.
 *
 * Argument parsing is hand-rolled: the surface is small and stable, and ADR-001
 * §3.3 rejects a dependency for splitting argv (DEP-3, SC-POL-017).
 */

export interface ParsedArgs {
  readonly command: string;
  readonly positionals: readonly string[];
  readonly flags: Readonly<Record<string, string | boolean>>;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('-')) {
          flags[a.slice(2)] = next;
          i += 1;
        } else {
          flags[a.slice(2)] = true;
        }
      }
    } else {
      positionals.push(a);
    }
  }
  const command = positionals.shift() ?? 'help';
  return { command, positionals, flags };
}

const USAGE = [
  'serva ' + SERVA_VERSION + '  (specification baseline ' + SPEC_BASELINE + ')',
  '',
  'Usage: serva <command> [options]',
  '',
  'Commands:',
  '  init <name> --idea "<text>"   Create a Serva project in the current directory',
  '  status                        Project state, governance state, next-action foundation',
  '  project [--json]              Project identity, metadata and configuration',
  '  doctor [--json]               Local prerequisites and store health',
  '  gates [--id <SC-GATE-...>]    Quality gate catalogue and recorded results',
  '  workflows [--runs]            Workflow catalogue and run states',
  '',
  'AI company runtime:',
  '  ai status                     AI engine, authentication and billing route',
  '  ai probe                      Re-probe the local engine capability',
  '  ai doctor                     Full engine capability and billing-route report',
  '  agents [--id <id>] [--enabled] Agent contract registry (all 55)',
  '  route "<request>"             Classify, plan, validate and queue a request',
  '  runs [--incomplete]           Governed AI runs recorded in this project',
  '  run <SC-RUN-...>              One run event log',
  '  context <SC-RUN-...>          Exactly what that run was shown',
  '',
  'Company intelligence:',
  INTELLIGENCE_USAGE,
  '',
  'Engineering factory:',
  '  implement <work-item-id>      Build a work item: producer, checks, review, commit',
  '  engineering status            Substrate class, governance state, enabled producers',
  '  engineering qualify           Run the adversarial substrate qualification',
  '  engineering doctor            Full substrate report with prerequisites',
  '  engineering reconcile         Store vs. repository divergence',
  '  worktrees [<id>]              Isolated engineering workspaces',
  '  changes [<change-set-id>]     Observed change sets and their evidence',
  '  evidence [<id>]               Runtime-captured evidence only',
  '  qualification                 The adversarial qualification catalogue',
  '',
  'Product, portability and recovery:',
  '  overview                      What the status bar shows, in a terminal',
  '  release                       Derived release readiness, condition by condition',
  '  actions                       Every validated action the UI can dispatch',
  '  machine doctor                Inspect this computer. Nothing is repaired.',
  '  machine bootstrap             What this computer still needs, and who must do it.',
  '  backup --to <path> --confirm  Write a verified backup of this project',
  '  verify-backup <path>          Prove a bundle before relying on it',
  '  restore <bundle> --to <dir>   Inspect a restore; --confirm to perform it',
  '  migrate                       The guided move to another computer',
  '  install [adopt|status|use|remove]  Which installed Serva runs, and going back',
  '  library [list|show|forget]    Machine-local generalised knowledge (--enable)',
  '  acceptance                    Serva Code 1.0 status, computed from measured truth',
  '  help                          This message',
  '',
  'Global options:',
  '  --root <path>                 Operate on the project at <path>',
  '  --json                        Machine-readable output where supported',
].join('\n');

type Handler = (args: ParsedArgs) => number | Promise<number>;

const COMMANDS: Readonly<Record<string, Handler>> = {
  init: cmdInit,
  status: cmdStatus,
  project: cmdProject,
  doctor: cmdDoctor,
  gates: cmdGates,
  workflows: cmdWorkflows,
  ai: cmdAi,
  agents: cmdAgents,
  route: cmdRoute,
  runs: cmdRuns,
  run: cmdRun,
  context: cmdContext,
  engineering: cmdEngineering,
  implement: cmdImplement,
  intelligence: cmdIntelligence,
  worktrees: cmdWorktrees,
  worktree: cmdWorktrees,
  changes: cmdChanges,
  change: cmdChanges,
  evidence: cmdEvidence,
  qualification: cmdQualificationCatalogue,
  overview: cmdOverview,
  release: cmdRelease,
  actions: cmdActions,
  machine: cmdMachine,
  backup: cmdBackup,
  'verify-backup': cmdVerifyBackup,
  restore: cmdRestore,
  install: cmdInstall,
  migrate: cmdMigrate,
  library: cmdLibrary,
  acceptance: cmdAcceptance,
  help: () => {
    console.log(USAGE);
    return 0;
  },
  version: () => {
    console.log(SERVA_VERSION);
    return 0;
  },
};

export async function run(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  const handler = COMMANDS[args.command];
  if (handler === undefined) {
    console.error('Unknown command: ' + args.command);
    console.error('');
    console.error(USAGE);
    return 2;
  }
  try {
    // AI commands are asynchronous; the deterministic Core commands are not. Awaiting
    // a number is harmless, and it keeps one error boundary for both kinds.
    return await handler(args);
  } catch (e) {
    if (isServaError(e)) {
      console.error(e.format());
      return 1;
    }
    console.error('Unexpected failure: ' + (e instanceof Error ? e.message : String(e)));
    if (e instanceof Error && e.stack !== undefined) console.error(e.stack);
    return 70;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));

/**
 * THE POINTER DECIDES WHICH BUILD RUNS, BEFORE ANYTHING ELSE HAPPENS.
 *
 * SPEC: the 1.0.1 packaging audit, §17.2.
 *
 * `install use` moved `current` and nothing read it, so a rollback reported success and left
 * the owner on the build they had just rolled away from. This is the read.
 *
 * It lives INSIDE the `invokedDirectly` guard on purpose. `parseArgs` and `run` are imported by
 * the test suite, and a module that handed off at import time would spawn a second Serva every
 * time a test asked what an argument list parses to.
 */
function handOffToCurrentVersion(): boolean {
  const decision = resolveActive({
    root: defaultInstallRoot(),
    runningVersion: SERVA_VERSION,
    alreadyHandedOff: process.env[HANDOFF_ENV] !== undefined,
    argv: process.argv.slice(2),
  });

  if (decision.problem !== undefined) console.error(decision.problem);
  if (decision.handOffTo === undefined) return false;

  /*
   * A child process rather than an import. The build being handed to may be older than this
   * one and is entitled to its own module graph — importing it into a process this build has
   * already started would mix two versions of Serva in one heap.
   *
   * `stdio: 'inherit'` so the delegate owns the terminal exactly as if it had been invoked,
   * and its exit code is adopted unchanged.
   */
  const result = spawnSync(process.execPath, [decision.handOffTo, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, [HANDOFF_ENV]: SERVA_VERSION },
  });

  if (result.error !== undefined) {
    console.error('serva: could not start the active version: ' + result.error.message);
    return false;
  }
  /* A signalled child has no numeric status; 70 is what this CLI already uses for "the
     failure was ours, not the caller's". */
  process.exitCode = result.status ?? 70;
  return true;
}

if (invokedDirectly || process.env['SERVA_CLI_FORCE'] === '1') {
  if (!handOffToCurrentVersion()) {
    void run(process.argv.slice(2)).then((code) => {
      process.exitCode = code;
    });
  }
}
