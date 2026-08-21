#!/usr/bin/env node
import { isServaError } from '../core/errors.js';
import { cmdInit } from './commands/init.js';
import { cmdStatus } from './commands/status.js';
import { cmdProject } from './commands/project.js';
import { cmdDoctor } from './commands/doctor.js';
import { cmdGates } from './commands/gates.js';
import { cmdWorkflows } from './commands/workflows.js';
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
  '  help                          This message',
  '',
  'Global options:',
  '  --root <path>                 Operate on the project at <path>',
  '  --json                        Machine-readable output where supported',
].join('\n');

type Handler = (args: ParsedArgs) => number;

const COMMANDS: Readonly<Record<string, Handler>> = {
  init: cmdInit,
  status: cmdStatus,
  project: cmdProject,
  doctor: cmdDoctor,
  gates: cmdGates,
  workflows: cmdWorkflows,
  help: () => {
    console.log(USAGE);
    return 0;
  },
  version: () => {
    console.log(SERVA_VERSION);
    return 0;
  },
};

export function run(argv: readonly string[]): number {
  const args = parseArgs(argv);
  const handler = COMMANDS[args.command];
  if (handler === undefined) {
    console.error('Unknown command: ' + args.command);
    console.error('');
    console.error(USAGE);
    return 2;
  }
  try {
    return handler(args);
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

if (invokedDirectly || process.env['SERVA_CLI_FORCE'] === '1') {
  process.exitCode = run(process.argv.slice(2));
}
