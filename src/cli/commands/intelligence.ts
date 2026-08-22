import { emitJson, openRuntime, wantsJson } from './_shared.js';
import { buildAiLayer } from '../../app/ai.js';
import { EngineHealthState } from '../../engine/types.js';
import {
  answerOwnerDecision,
  intelligenceOrchestrator,
  openOwnerDecisions,
  recordIdea,
} from '../../intelligence/app.js';
import { readOrchestratorRecord } from '../../intelligence/execution/orchestrator.js';
import { assessReadiness } from '../../intelligence/readiness.js';
import { generateWorkItems } from '../../intelligence/handoff.js';
import { outstandingChanges, planReentry } from '../../intelligence/change.js';
import { openProposals } from '../../intelligence/proposals.js';
import { resolveApplicability } from '../../intelligence/applicability.js';
import type { IntelligenceDeps } from '../../intelligence/app.js';
import type { ServaRuntime } from '../../app/runtime.js';
import type { ParsedArgs } from '../main.js';

/**
 * `serva intelligence` — the owner's window onto the company.
 *
 * SPEC: §43, §44.
 *
 * Everything here is READ or OWNER AUTHORITY. Nothing in this file decides anything: it
 * shows what the Store already says, and it carries the two acts that are genuinely the
 * owner's — answering a decision, and asking the company to proceed.
 *
 * The output is deliberately blunt about what is NOT done. A status display that shows
 * progress and hides blockers is worse than none, because it produces confidence in
 * proportion to how little it says. So blockers come first, readiness reports the reasons
 * rather than a percentage, and a stage that halted names what halted it.
 */

function deps(rt: ServaRuntime): IntelligenceDeps {
  const layer = buildAiLayer(rt);
  return {
    store: rt.store,
    clock: rt.clock,
    ids: rt.ids,
    engine: layer.engine,
    projectRoot: rt.root,
  };
}

const DEFAULT_PROFILE = 'PRF-NEW-PRODUCT';

function workItemFrom(args: ParsedArgs, rt: ServaRuntime): string | undefined {
  const positional = args.positionals[1];
  if (positional !== undefined && positional.startsWith('SC-WI-')) return positional;
  if (typeof args.flags['work-item'] === 'string') return args.flags['work-item'];
  /* The most recent run, so the common case needs no id at all. */
  const ids = rt.store.listCanonIds('intel.orchestratorState');
  return ids[ids.length - 1];
}

/** `serva intelligence status` — where the company has got to, and what stops it. */
function status(args: ParsedArgs, rt: ServaRuntime): number {
  const workItemId = workItemFrom(args, rt);
  if (workItemId === undefined) {
    console.log('No intelligence run exists yet.');
    console.log('  serva intelligence start "<what you want>"');
    return 0;
  }
  const record = readOrchestratorRecord(rt.store, workItemId);
  if (record === undefined) {
    console.error('No intelligence run for ' + workItemId);
    return 1;
  }

  const plan = resolveApplicability(record.profileId);
  const decisions = openOwnerDecisions(rt.store);
  const changes = outstandingChanges(rt.store);
  const readiness = assessReadiness({
    store: rt.store,
    clock: rt.clock,
    ids: rt.ids,
    workItemId,
  });

  if (wantsJson(args)) {
    emitJson({
      workItemId,
      profileId: record.profileId,
      state: record.state,
      haltedAtStage: record.haltedAtStage,
      blockedReason: record.blockedReason,
      completedStages: record.completedStages,
      gateResults: record.gateResults,
      openOwnerDecisions: decisions,
      outstandingChanges: changes.map((c) => ({ id: c.id, state: c.state })),
      readiness: { status: readiness.status, blockers: readiness.blockers },
    });
    return 0;
  }

  console.log('SERVA CODE   Company intelligence');
  console.log('');
  console.log('Work item   ' + workItemId + '   profile ' + record.profileId);
  console.log('State       ' + record.state);
  if (record.haltedAtStage !== undefined) {
    console.log('Halted at   ' + record.haltedAtStage);
    if (record.blockedReason !== undefined) console.log('            ' + record.blockedReason);
  }
  console.log('');

  console.log('Stages');
  for (const stage of plan.upstreamToRun) {
    const done = record.completedStages.includes(stage.stageId);
    const ran = record.ranStages.includes(stage.stageId);
    const mark = done ? 'done' : ran ? 'gate' : '    ';
    console.log('  [' + mark + '] ' + stage.stageId + '  ' + stage.name);
  }
  console.log('');

  if (record.gateResults.length > 0) {
    console.log('Gates');
    for (const g of record.gateResults) console.log('  ' + g.verdict.padEnd(24) + g.gateId);
    console.log('');
  }

  if (decisions.length > 0) {
    console.log('WAITING FOR YOU');
    for (const d of decisions) console.log('  ' + d.id + '  ' + d.question);
    console.log('  serva intelligence answer <id> --option "<your choice>" --by "<your name>"');
    console.log('');
  }

  if (changes.length > 0) {
    console.log('Changes not carried through');
    for (const c of changes) console.log('  ' + c.id + '  ' + c.state + '  ' + c.description);
    console.log('');
  }

  console.log('Engineering readiness: ' + readiness.status);
  for (const b of readiness.blockers.slice(0, 20)) console.log('  - ' + b);
  if (readiness.blockers.length > 20) {
    console.log('  ... and ' + String(readiness.blockers.length - 20) + ' more');
  }
  return 0;
}

/** `serva intelligence start "<idea>"` — record the idea and run the company. */
async function start(args: ParsedArgs, rt: ServaRuntime): Promise<number> {
  const text = args.positionals.slice(1).join(' ').trim();
  if (text.length === 0) {
    console.error('Usage: serva intelligence start "<what you want>" [--profile PRF-...]');
    return 2;
  }
  const d = deps(rt);
  const health = await buildAiLayer(rt).engine.health();
  if (health.state !== EngineHealthState.READY) {
    console.error('SERVA CODE cannot run the company: the AI engine is ' + health.state + '.');
    if (health.remedy !== undefined) console.error('  ' + health.remedy);
    return 1;
  }

  const workItemId =
    typeof args.flags['work-item'] === 'string' ? args.flags['work-item'] : rt.ids.next('SC-WI');
  const profileId =
    typeof args.flags['profile'] === 'string' ? args.flags['profile'] : DEFAULT_PROFILE;

  recordIdea(d, text);
  const result = await intelligenceOrchestrator(d, workItemId, profileId).advance();

  console.log('Work item ' + workItemId + '   ' + result.state);
  for (const r of result.ran)
    console.log('  ' + r.outcome.padEnd(26) + r.agentId + '  ' + r.stageId);
  if (result.reason !== undefined) console.log('  ' + result.reason);
  return result.state === 'BLOCKED' ? 1 : 0;
}

/** `serva intelligence resume [<work-item>]` — continue after an owner answer. */
async function resume(args: ParsedArgs, rt: ServaRuntime): Promise<number> {
  const workItemId = workItemFrom(args, rt);
  if (workItemId === undefined) {
    console.error('There is no intelligence run to resume.');
    return 1;
  }
  const record = readOrchestratorRecord(rt.store, workItemId);
  if (record === undefined) {
    console.error('No intelligence run for ' + workItemId);
    return 1;
  }
  const result = await intelligenceOrchestrator(deps(rt), workItemId, record.profileId).advance();
  console.log(workItemId + '   ' + result.state);
  for (const r of result.ran) console.log('  ' + r.outcome.padEnd(26) + r.agentId);
  if (result.reason !== undefined) console.log('  ' + result.reason);
  return result.state === 'BLOCKED' ? 1 : 0;
}

/** `serva intelligence decisions` — the questions only the owner can answer. */
function decisions(args: ParsedArgs, rt: ServaRuntime): number {
  const open = openOwnerDecisions(rt.store);
  if (wantsJson(args)) {
    emitJson({ openOwnerDecisions: open });
    return 0;
  }
  if (open.length === 0) {
    console.log('Nothing is waiting on you.');
    return 0;
  }
  for (const d of open) {
    console.log(d.id);
    console.log('  ' + d.question);
  }
  return 0;
}

/**
 * `serva intelligence answer <id> --option "..." --by "..."`
 *
 * `--by` is required and is not a formality. It is the field that makes the answer
 * attributable to a person, and the runtime refuses an answer attributed to an agent.
 */
function answer(args: ParsedArgs, rt: ServaRuntime): number {
  const decisionId = args.positionals[1];
  const option = args.flags['option'];
  const by = args.flags['by'];
  if (
    decisionId === undefined ||
    typeof option !== 'string' ||
    typeof by !== 'string' ||
    option.trim() === '' ||
    by.trim() === ''
  ) {
    console.error('Usage: serva intelligence answer <SC-ODR-...> --option "<choice>" --by "<you>"');
    return 2;
  }
  answerOwnerDecision(deps(rt), { decisionId, chosenOption: option, answeredBy: by });
  console.log(decisionId + ' answered: ' + option);
  console.log('  serva intelligence resume');
  return 0;
}

/** `serva intelligence readiness` — derived, never declared. */
function readiness(args: ParsedArgs, rt: ServaRuntime): number {
  const workItemId = workItemFrom(args, rt);
  if (workItemId === undefined) {
    console.error('There is no intelligence run to assess.');
    return 1;
  }
  const assessment = assessReadiness({
    store: rt.store,
    clock: rt.clock,
    ids: rt.ids,
    workItemId,
  });
  if (wantsJson(args)) {
    emitJson({
      workItemId,
      status: assessment.status,
      blockers: assessment.blockers,
      package: assessment.package,
    });
    return assessment.status === 'READY' ? 0 : 1;
  }
  console.log('Engineering readiness for ' + workItemId + ': ' + assessment.status);
  if (assessment.blockers.length === 0) {
    console.log('  Nothing blocks implementation.');
    return 0;
  }
  console.log('');
  for (const b of assessment.blockers) console.log('  - ' + b);
  return 1;
}

/** `serva intelligence handoff` — what Phase 4 would be given, and only if READY. */
function handoff(args: ParsedArgs, rt: ServaRuntime): number {
  const workItemId = workItemFrom(args, rt);
  const baseCommit = args.flags['base'];
  if (workItemId === undefined) {
    console.error('There is no intelligence run to hand over.');
    return 1;
  }
  if (typeof baseCommit !== 'string') {
    console.error('Usage: serva intelligence handoff [<work-item>] --base <commit-sha>');
    return 2;
  }
  const assessment = assessReadiness({
    store: rt.store,
    clock: rt.clock,
    ids: rt.ids,
    workItemId,
  });
  const generated = generateWorkItems({ store: rt.store, readiness: assessment, baseCommit });
  if (wantsJson(args)) {
    emitJson(generated);
    return 0;
  }
  console.log(String(generated.items.length) + ' work item(s) generated from accepted canon:');
  for (const item of generated.items) {
    console.log('');
    console.log('  ' + item.workItemId + '  ' + item.title);
    console.log('    requirements: ' + String(item.requirements.length));
    console.log('    acceptance:   ' + String(item.acceptanceCriteria.length));
    console.log('    decisions:    ' + String(item.decisions.length));
  }
  return 0;
}

/** `serva intelligence proposals` — ideas that are not scope, and are not lost either. */
function proposals(args: ParsedArgs, rt: ServaRuntime): number {
  const open = openProposals(rt.store);
  if (wantsJson(args)) {
    emitJson({ openProposals: open.map((p) => ({ id: p.id, state: p.state, title: p.title })) });
    return 0;
  }
  if (open.length === 0) {
    console.log('No open proposals.');
    return 0;
  }
  for (const p of open) {
    console.log(p.id + '  ' + p.state.padEnd(14) + p.title);
    console.log('    raised by ' + p.origin);
  }
  return 0;
}

/**
 * `serva intelligence changes` — what has been asked for since, and where it stands.
 *
 * Read-only. Raising, analysing and approving a change are not one-flag operations: an
 * impact analysis has to assess fourteen dimensions and an approval may need the owner,
 * and a CLI that let either happen in a single command would be a CLI that let them
 * happen without anybody looking. Those go through the API, or through a future guided
 * flow — not through a flag.
 */
function changes(args: ParsedArgs, rt: ServaRuntime): number {
  const outstanding = outstandingChanges(rt.store);
  const workItemId = workItemFrom(args, rt);
  const record =
    workItemId === undefined ? undefined : readOrchestratorRecord(rt.store, workItemId);

  const rows = outstanding.map((c) => {
    const base = { id: c.id, state: c.state, magnitude: c.magnitude, description: c.description };
    if (c.state !== 'APPROVED' || record === undefined) return base;
    /* An approved change knows what it will cost, so show it before anybody commits. */
    try {
      const plan = planReentry(rt.store, {
        changeRequestId: c.id,
        profileId: record.profileId,
      });
      return { ...base, reentryStageId: plan.reentryStageId, stagesToRerun: plan.stagesToRerun };
    } catch {
      return base;
    }
  });

  if (wantsJson(args)) {
    emitJson({ outstandingChanges: rows });
    return 0;
  }
  if (rows.length === 0) {
    console.log('No outstanding changes.');
    return 0;
  }
  for (const r of rows) {
    console.log(r.id + '  ' + r.state.padEnd(10) + r.magnitude + '  ' + r.description);
    if ('stagesToRerun' in r && r.stagesToRerun !== undefined) {
      console.log('    re-enters at ' + String(r.reentryStageId));
      console.log('    re-runs:     ' + r.stagesToRerun.join(', '));
    }
  }
  return 0;
}

const SUBCOMMANDS = [
  '  intelligence status [<work-item>]      Where the company has got to, and what stops it',
  '  intelligence start "<idea>"            Record the idea and run the upstream lifecycle',
  '  intelligence resume [<work-item>]      Continue after answering a decision',
  '  intelligence decisions                 Questions only you can answer',
  '  intelligence answer <id> --option --by Answer one, as yourself',
  '  intelligence readiness [<work-item>]   Derived readiness and every blocker',
  '  intelligence handoff --base <sha>      What engineering would be given',
  '  intelligence proposals                 Ideas raised, not yet scope',
  '  intelligence changes                   Changes asked for, and what re-running costs',
].join('\n');

export async function cmdIntelligence(args: ParsedArgs): Promise<number> {
  const sub = args.positionals[0] ?? 'status';
  const rt = openRuntime(args);
  try {
    switch (sub) {
      case 'status':
        return status(args, rt);
      case 'start':
        return await start(args, rt);
      case 'resume':
        return await resume(args, rt);
      case 'decisions':
        return decisions(args, rt);
      case 'answer':
        return answer(args, rt);
      case 'readiness':
        return readiness(args, rt);
      case 'handoff':
        return handoff(args, rt);
      case 'proposals':
        return proposals(args, rt);
      case 'changes':
      case 'change':
        return changes(args, rt);
      default:
        console.error('Unknown subcommand: intelligence ' + sub);
        console.error(SUBCOMMANDS);
        return 2;
    }
  } finally {
    rt.close();
  }
}

export { SUBCOMMANDS as INTELLIGENCE_USAGE };
