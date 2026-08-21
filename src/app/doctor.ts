import { existsSync } from 'node:fs';
import { GovernanceState } from '../vocab/index.js';
import { enforcementCoverage } from '../policy/registry.js';
import { findIncompleteRuns } from '../events/agentRun.js';
import { SERVA_VERSION, SPEC_BASELINE, type ServaRuntime } from './runtime.js';
import { SCHEMA_VERSION } from '../store/store.js';
import { getCatalogues } from '../catalogue/index.js';
import { ContractRegistry } from '../agents/registry.js';
import { PHASE3_ENABLED_AGENTS } from './ai.js';

/**
 * `serva doctor` — local prerequisites and store health.
 * SPEC: 21 §6 (integrity checking), 20 §2 (governance state), 33 PC-5 (enforcement class).
 */

export type CheckStatus = 'OK' | 'WARN' | 'FAIL';

export interface Check {
  readonly id: string;
  readonly title: string;
  readonly status: CheckStatus;
  readonly detail: string;
  readonly remedy?: string;
}

export interface DoctorReport {
  readonly checks: readonly Check[];
  readonly governance: GovernanceState;
  readonly ok: boolean;
}

function nodeMajor(): number {
  const m = /^v(\d+)\./.exec(process.version);
  return m?.[1] === undefined ? 0 : Number.parseInt(m[1], 10);
}

export function runDoctor(rt: ServaRuntime | undefined, cwd: string): DoctorReport {
  const checks: Check[] = [];

  const major = nodeMajor();
  checks.push({
    id: 'ENV_NODE',
    title: 'Node.js runtime',
    status: major >= 20 ? 'OK' : 'FAIL',
    detail: process.version + ' (major ' + String(major) + ')',
    ...(major >= 20 ? {} : { remedy: 'Serva Core requires Node.js 20 or newer.' }),
  });

  checks.push({
    id: 'ENV_VERSION',
    title: 'Serva version / spec baseline',
    status: 'OK',
    detail: 'serva ' + SERVA_VERSION + ', specification baseline ' + SPEC_BASELINE,
  });

  /**
   * 33 PC-5 — capability enforcement class must be DETECTED and DECLARED, never
   * assumed. Phase 2 implements detection and honest reporting; the enforcement
   * mechanisms themselves belong to the engine-integration phase.
   */
  const onWindows = process.platform === 'win32';
  const inWsl = process.env['WSL_DISTRO_NAME'] !== undefined;
  const substrateOk = !onWindows || inWsl;
  checks.push({
    id: 'ENV_SUBSTRATE',
    title: 'Isolation substrate (33 PC-4/PC-5)',
    status: substrateOk ? 'OK' : 'WARN',
    detail: substrateOk
      ? 'platform=' + process.platform + (inWsl ? ' (WSL2)' : '') + ' — HARD enforcement available'
      : 'platform=win32 without WSL2 — capability enforcement would be SOFT (harness-level only)',
    ...(substrateOk
      ? {}
      : {
          remedy:
            'Agent runs requiring HARD enforcement must execute under WSL2 or a proven equivalent. Native-Windows sandboxing must not be assumed (33 PC-4).',
        }),
  });

  const cat = getCatalogues();
  checks.push({
    id: 'CAT_LOADED',
    title: 'Canonical catalogues',
    status: 'OK',
    detail:
      cat.counts['departments'] +
      ' departments, ' +
      cat.counts['agents'] +
      ' agents, ' +
      cat.counts['stages'] +
      ' stages, ' +
      cat.counts['gates'] +
      ' gates, ' +
      cat.counts['workflows'] +
      ' workflows, ' +
      cat.counts['policies'] +
      ' policies (generated from 30)',
  });

  // The AgentContract registry is a build artifact generated from 32, and a stale one
  // is a real failure mode: the spec moves and the runtime does not. Checked here so
  // `serva doctor` catches it rather than a dispatch failing later.
  try {
    const registry = ContractRegistry.shared();
    const problems = registry.validateAgainstCatalogue();
    const enabled = registry.all().filter((c) => PHASE3_ENABLED_AGENTS.has(c.id)).length;
    checks.push({
      id: 'AGENT_CONTRACTS',
      title: 'Agent contract registry (32, 30 §4)',
      status: problems.length === 0 ? 'OK' : 'FAIL',
      detail:
        problems.length === 0
          ? String(registry.all().length) +
            ' contracts resolved, ' +
            String(enabled) +
            ' enabled for execution in this phase'
          : problems
              .slice(0, 5)
              .map((p) => p.agentId + ': ' + p.problem)
              .join('; '),
      ...(problems.length === 0
        ? {}
        : { remedy: 'Run `npm run catalogues && npm run contracts` to regenerate.' }),
    });
  } catch (e) {
    checks.push({
      id: 'AGENT_CONTRACTS',
      title: 'Agent contract registry (32, 30 §4)',
      status: 'FAIL',
      detail: e instanceof Error ? e.message : String(e),
      remedy: 'Run `npm run contracts` to regenerate the registry from the specification.',
    });
  }

  const cov = enforcementCoverage();
  checks.push({
    id: 'POL_COVERAGE',
    title: 'Policy enforcement coverage (Phase 2 core)',
    status: 'OK',
    detail:
      String(cov.enforced) +
      ' of ' +
      String(cov.total) +
      ' policies mechanically enforced by the core; the remainder belong to later phases (29 CF-2)',
  });

  if (rt === undefined) {
    checks.push({
      id: 'PROJ_PRESENT',
      title: 'Serva project',
      status: 'WARN',
      detail: 'No project found from ' + cwd,
      remedy: 'Run `serva init <name>` to create one.',
    });
    return {
      checks,
      governance: GovernanceState.INACTIVE,
      ok: !checks.some((c) => c.status === 'FAIL'),
    };
  }

  checks.push({
    id: 'PROJ_PRESENT',
    title: 'Serva project',
    status: 'OK',
    detail: rt.requireProject().name + ' at ' + rt.root,
  });

  checks.push({
    id: 'STORE_SCHEMA',
    title: 'Store schema version',
    status: existsSync(rt.store.paths.schemaVersion) ? 'OK' : 'FAIL',
    detail: 'expected ' + String(SCHEMA_VERSION),
    ...(existsSync(rt.store.paths.schemaVersion)
      ? {}
      : { remedy: 'The store is missing SCHEMA_VERSION. Restore from backup (21 §7).' }),
  });

  // 08 KI-1 — hash chain verification across every trace stream.
  const streams = rt.store.listTraceStreams();
  const broken: string[] = [];
  for (const s of streams) {
    const v = rt.store.trace(s).verify();
    if (!v.ok) broken.push(s + ' (' + v.detail + ')');
  }
  checks.push({
    id: 'TRACE_INTEGRITY',
    title: 'Trace immutability (08 KI-1)',
    status: broken.length === 0 ? 'OK' : 'FAIL',
    detail:
      broken.length === 0
        ? String(streams.length) + ' stream(s) verified, hash chains intact'
        : 'broken: ' + broken.join(', '),
    ...(broken.length === 0
      ? {}
      : {
          remedy:
            'A trace stream was modified outside the append-only API. Quarantine and restore from a verified backup (22 §5.1).',
        }),
  });

  // 08 KI-1 -- T-CANON envelope integrity. Detects an out-of-band edit or an
  // accidentally corrupted record. Tamper-EVIDENCE, not tamper-proofing: an
  // attacker with write access could recompute the digest as easily as we can.
  const canon = rt.store.verifyCanon();
  checks.push({
    id: 'CANON_INTEGRITY',
    title: 'Canon integrity (08 KI-1)',
    status: canon.problems.length === 0 ? 'OK' : 'FAIL',
    detail:
      canon.problems.length === 0
        ? String(canon.checked) + ' record(s) verified, digests and identity intact'
        : canon.problems.map((p) => p.ref + ': ' + p.problem).join('; '),
    ...(canon.problems.length === 0
      ? {}
      : {
          remedy:
            'A canon record does not match its recorded digest or its own path. Quarantine and restore from a verified backup (22 5.1).',
        }),
  });

  const journalPending = existsSync(rt.store.paths.journal);
  const recovered = rt.startupReport.recovered;
  checks.push({
    id: 'STORE_JOURNAL',
    title: 'Transaction journal',
    status: 'OK',
    detail:
      'journal present=' +
      String(journalPending) +
      ', recovered at startup: reapplied=' +
      String(recovered.reapplied) +
      ' discarded=' +
      String(recovered.discarded),
  });

  // 22 §4.2 — runs with no terminal event are detectable, not silent.
  const incomplete = findIncompleteRuns(rt.store);
  checks.push({
    id: 'RUNS_INCOMPLETE',
    title: 'Interrupted agent runs (05 RI-1)',
    status: incomplete.length === 0 ? 'OK' : 'WARN',
    detail:
      incomplete.length === 0
        ? 'none'
        : String(incomplete.length) + ' run(s) with no terminal event: ' + incomplete.join(', '),
    ...(incomplete.length === 0
      ? {}
      : {
          remedy:
            'Each must be terminated with RUN_ABORTED and its artifacts quarantined (22 RC-1).',
        }),
  });

  const governance = rt.startupReport.governance;
  const ok = !checks.some((c) => c.status === 'FAIL');
  return { checks, governance, ok };
}
