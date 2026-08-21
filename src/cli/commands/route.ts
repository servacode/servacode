import { emitJson, openRuntime, wantsJson } from './_shared.js';
import { buildAiLayer } from '../../app/ai.js';
import { EngineHealthState } from '../../engine/types.js';
import { projectAgentRun, findIncompleteRuns } from '../../events/agentRun.js';
import { readContextBundle } from '../../context/store.js';
import { runStream } from '../../events/agentRun.js';
import type { ParsedArgs } from '../main.js';

/**
 * `serva route "<request>"` — the owner's entry point into the company.
 *
 * The owner addresses Serva. Serva classifies, asks for a plan, validates it
 * deterministically, and shows what it queued. Claude is named as the engine and
 * never as the interlocutor.
 */
export async function cmdRoute(args: ParsedArgs): Promise<number> {
  const text = args.positionals.join(' ').trim();
  if (text.length === 0) {
    console.error('Usage: serva route "<what you want>"');
    return 2;
  }

  const rt = openRuntime(args);
  try {
    const layer = buildAiLayer(rt);
    const health = await layer.engine.health();
    if (health.state !== EngineHealthState.READY) {
      // 19 §7 — halt and notify. Serva does not attempt to fix authentication.
      console.error('SERVA CODE cannot dispatch: the AI engine is ' + health.state + '.');
      if (health.detail !== undefined) console.error('  ' + health.detail);
      if (health.remedy !== undefined) console.error('  ' + health.remedy);
      return 1;
    }

    const workItemId =
      typeof args.flags['work-item'] === 'string' ? args.flags['work-item'] : rt.ids.next('SC-WI');

    const result = await layer.orchestrator.route(text, workItemId);

    if (wantsJson(args)) {
      emitJson({
        request: result.request,
        stage: result.stage,
        classification: result.classification,
        plan: result.plan,
        validation: result.validation,
        queue: result.queue,
        haltReason: result.haltReason,
        runs: [result.classificationRun?.runId, result.planRun?.runId].filter(
          (r) => r !== undefined,
        ),
      });
      return result.stage === 'QUEUED' ? 0 : 1;
    }

    console.log('SERVA CODE   AI Engine: Claude   Governance: ACTIVE');
    console.log('');
    console.log('Request ' + result.request.id + '  (work item ' + workItemId + ')');
    console.log('  ' + text);
    console.log('');

    const c = result.classification;
    if (c !== undefined) {
      console.log('Classification  [run ' + (result.classificationRun?.runId ?? '-') + ']');
      console.log('  Class:       ' + c.requestClass + '   Magnitude: ' + c.magnitude);
      console.log('  Confidence:  ' + c.confidence + (c.multiIntent ? '   MULTI-INTENT' : ''));
      console.log('  Departments: ' + (c.recommendedDepartments.join(', ') || '(none)'));
      if (c.riskFlags.length > 0) console.log('  Risk flags:  ' + c.riskFlags.join(', '));
      console.log('  Signals:');
      for (const s of c.signals)
        console.log('    - ' + s.signal + '  [read from ' + s.readFrom + ']');
      if (c.unresolved.length > 0) {
        console.log('  Unresolved:');
        for (const u of c.unresolved) console.log('    - ' + u);
      }
      console.log('');
    }

    if (result.plan !== undefined) {
      console.log('Proposed plan   [run ' + (result.planRun?.runId ?? '-') + ']');
      console.log('  ' + result.plan.rationale);
      for (const s of result.plan.steps) {
        console.log('    ' + s.stepId + '  ' + s.agentId + '  ' + s.purpose);
        if (s.dependsOn.length > 0) console.log('        after: ' + s.dependsOn.join(', '));
      }
      for (const o of result.plan.omissions) {
        console.log('    omitted ' + o.omitted + ': ' + o.reason);
      }
      console.log('');
    }

    if (result.validation !== undefined) {
      console.log(
        'Deterministic plan validation: ' +
          (result.validation.accepted ? 'ACCEPTED' : 'REJECTED') +
          '  (' +
          String(result.validation.findings.length) +
          ' finding(s))',
      );
      for (const f of result.validation.findings) {
        console.log(
          '    ' +
            f.kind +
            (f.stepId === undefined ? '' : ' [' + f.stepId + ']') +
            ': ' +
            f.detail +
            '   (' +
            f.specRef +
            ')',
        );
      }
      console.log('');
    }

    if (result.queue.length > 0) {
      console.log('Dispatch queue (each step is a separate governed AgentRun):');
      for (const q of result.queue) {
        console.log(
          '    ' +
            (q.ready ? '[ready] ' : '[wait]  ') +
            q.stepId +
            '  ' +
            q.agentId +
            '  ' +
            q.purpose,
        );
      }
      console.log('');
      console.log('Phase 3 builds the queue and stops here. Executing producer work requires the');
      console.log('write-capable substrate the Engineering Factory phase introduces.');
    }

    if (result.haltReason !== undefined) {
      console.log('HALTED: ' + result.haltReason);
    }

    return result.stage === 'QUEUED' ? 0 : 1;
  } finally {
    rt.close();
  }
}

/** `serva runs [--incomplete]` — governed AI runs recorded in this project. */
export function cmdRuns(args: ParsedArgs): number {
  const rt = openRuntime(args);
  try {
    const streams = rt.store.listTraceStreams().filter((s) => s.startsWith('agentrun/'));
    const runIds = streams.map((s) => s.slice('agentrun/'.length));
    const incomplete = new Set(findIncompleteRuns(rt.store));

    const rows = runIds.map((id) => {
      const p = projectAgentRun(rt.store, id);
      return {
        runId: id,
        agentId: p.agentId,
        workItemId: p.workItemId,
        outcome: p.outcome,
        terminal: p.terminal,
        incomplete: incomplete.has(id),
        events: p.eventCount,
        toolCalls: p.toolCalls.length,
        contextBundleRef: p.contextBundleRef,
      };
    });

    const shown = args.flags['incomplete'] === true ? rows.filter((r) => r.incomplete) : rows;

    if (wantsJson(args)) {
      emitJson({ count: shown.length, runs: shown });
      return 0;
    }

    console.log('Governed AI runs: ' + String(rows.length));
    if (incomplete.size > 0) {
      console.log(
        '  ' +
          String(incomplete.size) +
          ' run(s) have no terminal event. An interrupted run is DETECTABLE by design',
      );
      console.log('  (05 RI-1); re-dispatch rebuilds from the store, not from engine memory.');
    }
    console.log('');
    for (const r of shown) {
      console.log(
        '  ' +
          r.runId +
          '  ' +
          (r.agentId ?? '?').padEnd(14) +
          (r.outcome ?? (r.incomplete ? 'INCOMPLETE' : '-')).padEnd(20) +
          String(r.events) +
          ' events, ' +
          String(r.toolCalls) +
          ' tool calls',
      );
    }
    return 0;
  } finally {
    rt.close();
  }
}

/** `serva run <id>` — the full event log for one run. */
export function cmdRun(args: ParsedArgs): number {
  const id = args.positionals[0];
  if (id === undefined) {
    console.error('Usage: serva run <SC-RUN-...>');
    return 2;
  }
  const rt = openRuntime(args);
  try {
    const events = rt.store.readTrace(runStream(id));
    if (events.length === 0) {
      console.error('No run ' + id + ' in this project.');
      return 1;
    }
    const p = projectAgentRun(rt.store, id);
    if (wantsJson(args)) {
      emitJson({ projection: p, events });
      return 0;
    }
    console.log(
      'Run ' + id + '   agent ' + (p.agentId ?? '?') + '   outcome ' + (p.outcome ?? 'INCOMPLETE'),
    );
    console.log('  context bundle: ' + (p.contextBundleRef ?? '(none bound)'));
    console.log('  events (authoritative, hash-chained):');
    for (const e of events) {
      console.log('    ' + String(e.seq).padStart(3) + '  ' + e.at + '  ' + e.type);
    }
    return 0;
  } finally {
    rt.close();
  }
}

/**
 * `serva context <run-id>` — exactly what that run was shown (19 CX-5, 08 Q12).
 *
 * Reconstructs the persisted bundle rather than reporting counts. "Six elements, two
 * untrusted" does not answer the question; the elements do.
 */
export function cmdContext(args: ParsedArgs): number {
  const id = args.positionals[0];
  if (id === undefined) {
    console.error('Usage: serva context <SC-RUN-...>');
    return 2;
  }
  const rt = openRuntime(args);
  try {
    const events = rt.store.readTrace(runStream(id));
    if (events.length === 0) {
      console.error('No run ' + id + ' in this project.');
      return 1;
    }
    const bound = events.find((e) => e.type === 'CONTEXT_BOUND');
    const cap = events.find((e) => e.type === 'CAPABILITY_BOUND');
    if (bound === undefined) {
      console.error('Run ' + id + ' has no CONTEXT_BOUND event: it never received a bundle.');
      return 1;
    }
    const meta = bound.payload as Record<string, unknown>;
    const bundleRef = String(meta['contextBundleRef']);

    // A referenced bundle that is missing or altered is an integrity failure, not a
    // blank line. readContextBundle raises; the CLI error handler prints the remedy.
    const bundle = readContextBundle(rt.store, bundleRef);

    if (wantsJson(args)) {
      emitJson({
        runId: id,
        // The whole reconstructible bundle, not a summary of it.
        bundle,
        recordedDigest: meta['digest'],
        digestMatches: meta['digest'] === bundle.digest,
        capability: cap?.payload,
      });
      return 0;
    }

    console.log('Run ' + id + ' was given context bundle ' + bundle.id);
    console.log('  built at:      ' + bundle.builtAt);
    console.log('  store version: ' + String(bundle.storeVersion));
    console.log('  digest:        ' + bundle.digest + ' (verified)');
    console.log(
      '  budget:        ' +
        String(bundle.budget.usedChars) +
        ' of ' +
        String(bundle.budget.maxChars) +
        ' characters',
    );
    console.log('');
    console.log('Elements (' + String(bundle.elements.length) + '), highest relevance first:');
    for (const e of [...bundle.elements].sort((a, b) => b.relevance - a.relevance)) {
      console.log('');
      console.log(
        '  [' +
          e.trust +
          '] ' +
          e.kind +
          '  source=' +
          e.source +
          '  v' +
          e.version +
          '  relevance=' +
          String(e.relevance),
      );
      console.log('    included because: ' + e.reasonIncluded);
      console.log(
        '    digest: ' + e.digest.slice(0, 16) + '  (' + String(e.content.length) + ' chars)',
      );
      if (args.flags['full'] === true) {
        for (const line of e.content.split('\n')) console.log('    | ' + line);
      } else {
        const preview = e.content.slice(0, 200).split('\n').slice(0, 4);
        for (const line of preview) console.log('    | ' + line);
        if (e.content.length > 200) console.log('    | ... (--full for the whole element)');
      }
    }

    console.log('');
    console.log('Deliberately withheld (' + String(bundle.exclusions.length) + '):');
    for (const x of bundle.exclusions) {
      console.log('  [' + x.kind + '] ' + x.subject);
      console.log('    ' + x.reason);
    }

    if (cap !== undefined) {
      const c = cap.payload as Record<string, unknown>;
      const fs = c['filesystem'] as Record<string, unknown> | undefined;
      console.log('');
      console.log('Capability granted to this run:');
      console.log('  tools available: ' + JSON.stringify(c['available'] ?? []));
      console.log('  pre-approved:    ' + JSON.stringify(c['approve'] ?? []));
      console.log('  read scope:      ' + JSON.stringify(fs?.['read'] ?? []));
      console.log('  read refused:    ' + JSON.stringify(fs?.['readDenied'] ?? []));
      console.log('  write scope:     ' + JSON.stringify(fs?.['write'] ?? []));
      console.log('  network:         ' + JSON.stringify(c['network']));
    }
    return 0;
  } finally {
    rt.close();
  }
}
