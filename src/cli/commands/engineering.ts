import { emitJson, openRuntime, wantsJson } from './_shared.js';
import {
  buildEngineeringLayer,
  engineeringReconcile,
  engineeringStatus,
} from '../../app/engineering.js';
import { QUALIFICATION_CASES } from '../../substrate/qualification.js';
import { listChangeSets, readChangeSet } from '../../engineering/changeset.js';
import { evidenceForChangeSet, listEvidence } from '../../engineering/execution.js';
import type { ParsedArgs } from '../main.js';

/**
 * `serva engineering …`, `serva worktrees`, `serva changes`, `serva evidence`.
 *
 * SPEC: Phase 4 §26.
 *
 * The output leads with the authority state, because that is the fact a reader needs
 * before any other number on the screen means anything. A green list of workspaces
 * under a BLOCKED substrate would be actively misleading.
 */
export async function cmdEngineering(args: ParsedArgs): Promise<number> {
  const sub = args.positionals[0] ?? 'status';
  const rt = openRuntime(args);
  try {
    const layer = buildEngineeringLayer(rt);

    if (sub === 'status' || sub === 'doctor' || sub === 'qualify') {
      const { view, qualification } = await engineeringStatus(layer);

      if (wantsJson(args)) {
        emitJson(
          sub === 'status'
            ? view
            : { ...view, qualification, explain: await layer.substrate.explain() },
        );
        return view.governance === 'ACTIVE' ? 0 : 1;
      }

      console.log('SERVA CODE');
      console.log('  Engineering Governance: ' + view.governance);
      console.log('  Execution Substrate:    ' + view.executionSubstrate);
      console.log('  Host:                   ' + view.hostPlatform);
      if (view.guestPlatform !== undefined)
        console.log('  Guest:                  ' + view.guestPlatform);
      console.log('  Isolation:              ' + view.isolationMethod);
      console.log('  Workspaces:             ' + String(view.workspaces));
      console.log('  Recipes:                ' + view.recipes.join(', '));
      if (view.blockedBy !== undefined) {
        console.log('');
        console.log('  BLOCKED: ' + view.blockedBy);
      }

      if (view.missingPrerequisites.length > 0) {
        console.log('');
        console.log(
          'PLATFORM_PREREQUISITE_REQUIRED — ' +
            String(view.missingPrerequisites.length) +
            ' item(s):',
        );
        for (const p of view.missingPrerequisites) {
          console.log('  - ' + p.id + '  ' + p.what);
          console.log('      remedy: ' + p.remedy);
        }
        console.log('');
        console.log('  Serva does not install these for you. Changing the machine a sandbox');
        console.log("  runs on is the owner's decision, not a side effect of asking for status.");
      }

      console.log('');
      console.log('Producers enabled: ' + (view.enabledProducers.join(', ') || '(none)'));
      for (const d of view.disabledProducers) {
        console.log('  [off] ' + d.id + ': ' + d.reason);
      }

      if (sub === 'qualify' || sub === 'doctor') {
        console.log('');
        console.log('Qualification (a substrate earns HARD; it is never assumed):');
        for (const t of qualification.tests) {
          const mark = t.outcome === 'PASSED' ? ' ok ' : t.outcome === 'FAILED' ? 'FAIL' : ' -- ';
          console.log('  [' + mark + '] ' + t.id + '  ' + t.title);
          console.log('           expects: ' + t.expectation);
          if (t.outcome !== 'PASSED') console.log('           result:  ' + t.detail);
        }
        console.log('');
        console.log(await layer.substrate.explain());
      }

      return view.governance === 'ACTIVE' ? 0 : 1;
    }

    if (sub === 'reconcile') {
      const report = await engineeringReconcile(rt, layer);
      if (wantsJson(args)) {
        emitJson(report);
        return report.divergences.length === 0 ? 0 : 1;
      }
      console.log('SERVA CODE   Workspace reconciliation');
      console.log('  workspaces checked: ' + String(report.workspacesChecked));
      console.log('  change sets:        ' + String(report.changeSetsChecked));
      console.log('  primary checkout:   ' + (report.primaryCheckoutClean ? 'clean' : 'DIRTY'));
      console.log('');
      if (report.divergences.length === 0) {
        console.log('  No divergence between the store and the repository.');
        return 0;
      }
      for (const d of report.divergences) {
        console.log('  [' + d.kind + '] ' + d.subject);
        console.log('      ' + d.detail);
        console.log('      remedy: ' + d.remedy);
        console.log('      self-repairable: ' + String(d.selfRepairable));
      }
      console.log('');
      console.log("  Serva reports divergence. It does not overwrite the owner's work to");
      console.log('  make its own records look right.');
      return 1;
    }

    console.error('Unknown subcommand: engineering ' + sub);
    console.error('Try: serva engineering status | qualify | doctor | reconcile');
    return 2;
  } finally {
    rt.close();
  }
}

/** `serva worktrees` — the isolated workspaces this project holds. */
export function cmdWorktrees(args: ParsedArgs): number {
  const rt = openRuntime(args);
  try {
    const layer = buildEngineeringLayer(rt);
    const id = args.positionals[0];
    const all = layer.workspaces.list();

    if (typeof id === 'string') {
      const w = layer.workspaces.get(id);
      if (w === undefined) {
        console.error('No workspace ' + id);
        return 1;
      }
      if (wantsJson(args)) {
        emitJson(w);
        return 0;
      }
      console.log('Workspace ' + w.workspaceId);
      console.log('  work item:  ' + w.workItemId + '  attempt ' + String(w.attempt));
      console.log('  producer:   ' + w.producerAgentId);
      console.log('  branch:     ' + w.branch);
      console.log('  path:       ' + w.path);
      console.log('  base:       ' + w.baseCommit);
      console.log('  head:       ' + (w.headCommit ?? '(unchanged)'));
      console.log('  state:      ' + w.state + '   cleanup: ' + w.cleanupState);
      console.log('  substrate:  ' + w.substrateClass);
      console.log('  allowed:    ' + w.expectedScope.allow.join(', '));
      console.log('  forbidden:  ' + (w.expectedScope.forbid.join(', ') || '(none)'));
      return 0;
    }

    if (wantsJson(args)) {
      emitJson({ count: all.length, workspaces: all });
      return 0;
    }
    console.log('Engineering workspaces: ' + String(all.length));
    for (const w of all) {
      console.log(
        '  ' + w.workspaceId.padEnd(24) + w.state.padEnd(10) + w.producerAgentId + '  ' + w.branch,
      );
    }
    return 0;
  } finally {
    rt.close();
  }
}

/** `serva changes` / `serva change <id>` — observed change sets. */
export function cmdChanges(args: ParsedArgs): number {
  const rt = openRuntime(args);
  try {
    const id = args.positionals[0];
    if (typeof id === 'string') {
      const cs = readChangeSet(rt.store, id);
      if (cs === undefined) {
        console.error('No change set ' + id);
        return 1;
      }
      const { valid, stale } = evidenceForChangeSet(rt.store, cs.changeSetId);
      if (wantsJson(args)) {
        emitJson({ changeSet: cs, evidence: valid, staleEvidence: stale });
        return 0;
      }
      console.log('ChangeSet ' + cs.changeSetId);
      console.log('  work item: ' + cs.workItemId + '  attempt ' + String(cs.attempt));
      console.log('  producer:  ' + cs.producerAgentId);
      console.log('  base:      ' + cs.baseCommit);
      console.log('  head:      ' + cs.headCommit);
      console.log('  digest:    ' + cs.digest);
      console.log('  entries:   ' + String(cs.entries.length));
      for (const e of cs.entries) {
        console.log(
          '    ' +
            e.status +
            '  ' +
            e.path +
            (e.isBinary ? '  [binary]' : '') +
            (e.isSymlink ? '  [symlink]' : ''),
        );
      }
      console.log('');
      console.log('  Evidence bound to THIS change set: ' + String(valid.length));
      for (const e of valid) {
        console.log(
          '    [' + e.outcome + '] ' + (e.runtimeComponentId ?? 'JUDGED') + '  ' + e.claim,
        );
      }
      if (stale.length > 0) {
        console.log('');
        console.log(
          '  Stale (measured against a different change set, so it no longer applies): ' +
            String(stale.length),
        );
      }
      return 0;
    }

    const all = listChangeSets(rt.store);
    if (wantsJson(args)) {
      emitJson({ count: all.length, changeSets: all });
      return 0;
    }
    console.log('Change sets: ' + String(all.length));
    for (const cs of all) {
      console.log(
        '  ' +
          cs.changeSetId.padEnd(20) +
          cs.workItemId.padEnd(16) +
          String(cs.entries.length).padStart(3) +
          ' path(s)   ' +
          cs.digest.slice(0, 12),
      );
    }
    return 0;
  } finally {
    rt.close();
  }
}

/** `serva evidence [change-set-id]` — what was actually measured. */
export function cmdEvidence(args: ParsedArgs): number {
  const rt = openRuntime(args);
  try {
    const id = args.positionals[0];
    const all = listEvidence(rt.store);
    const shown =
      typeof id === 'string' ? all.filter((e) => e.changeSetId === id || e.workItemId === id) : all;

    if (wantsJson(args)) {
      emitJson({ count: shown.length, evidence: shown });
      return 0;
    }
    console.log('Runtime-captured evidence: ' + String(shown.length));
    console.log('  (a claim by an agent is never in this list — only what Serva observed)');
    console.log('');
    for (const e of shown) {
      console.log(
        '  [' +
          e.outcome +
          '] ' +
          e.basis.padEnd(9) +
          (e.runtimeComponentId ?? 'JUDGED').padEnd(12) +
          e.changeSetId,
      );
      console.log('        ' + e.claim);
      console.log('        ' + e.detail.split('\n')[0]);
    }
    return 0;
  } finally {
    rt.close();
  }
}

/** `serva qualification` — the adversarial catalogue, printed from the code. */
export function cmdQualificationCatalogue(args: ParsedArgs): number {
  if (wantsJson(args)) {
    emitJson({ cases: QUALIFICATION_CASES });
    return 0;
  }
  console.log('Substrate qualification cases (a boundary is defined by what it refuses):');
  for (const c of QUALIFICATION_CASES) {
    console.log('');
    console.log('  ' + c.id + '  ' + c.title + (c.blocking ? '  [blocking]' : ''));
    console.log('    expects: ' + c.expectation);
    console.log('    why:     ' + c.rationale);
  }
  return 0;
}
