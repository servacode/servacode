import { emitJson, openRuntime, wantsJson } from './_shared.js';
import { buildAiLayer, summarizeAgents, toStatusView } from '../../app/ai.js';
import { API_BILLING_ENV_VARS, THIRD_PARTY_ENV_VARS } from '../../engine/claude/billing.js';
import { EngineHealthState } from '../../engine/types.js';
import type { ParsedArgs } from '../main.js';

/**
 * `serva ai <status|probe|doctor>` — the owner's view of the engine.
 *
 * Presentation rule (§23 of the Phase 3 brief): the owner is talking to SERVA, which
 * uses Claude as an engine. The output says so. It does not imitate the Claude Code
 * interface, because a person who cannot tell which system they are addressing cannot
 * know which system's rules apply.
 *
 * Nothing printed here is a secret. Environment variables are reported by NAME and by
 * whether they are set; their values are never read, never printed, never stored.
 */
export async function cmdAi(args: ParsedArgs): Promise<number> {
  const sub = args.positionals[0] ?? 'status';
  const rt = openRuntime(args);
  try {
    const layer = buildAiLayer(rt);
    const status = await layer.engine.health();
    const view = toStatusView(status);

    if (sub === 'probe' || sub === 'status' || sub === 'doctor') {
      if (wantsJson(args)) {
        emitJson(
          sub === 'doctor'
            ? { ...view, capabilities: status.capabilities, environment: envReport() }
            : view,
        );
        return status.state === EngineHealthState.READY ? 0 : 1;
      }

      console.log('SERVA CODE');
      console.log('  AI Engine:      ' + view.aiEngine + '  (' + view.transport + ')');
      console.log('  Provider:       ' + view.provider);
      console.log('  Version:        ' + view.version);
      console.log('  Authentication: ' + view.authentication);
      console.log('  Billing mode:   ' + view.billingMode);
      console.log('  Capability:     ' + view.capabilityLevel);
      console.log('  Governance:     ACTIVE');
      console.log('  Dispatch:       ' + view.governedDispatch);
      if (view.detail !== undefined) console.log('  Detail:         ' + view.detail);
      if (view.remedy !== undefined) console.log('  Remedy:         ' + view.remedy);
      console.log('  Checked at:     ' + view.checkedAt);

      if (sub === 'doctor') {
        console.log('');
        console.log('Engine capabilities (detected, not assumed):');
        for (const [k, v] of Object.entries(status.capabilities)) {
          if (Array.isArray(v) && v.length === 0) continue;
          console.log('  ' + k.padEnd(32) + String(Array.isArray(v) ? v.join(', ') : v));
        }
        console.log('');
        console.log('Billing-route environment (names only; values are never read):');
        for (const e of envReport()) {
          console.log('  ' + (e.set ? '[SET]  ' : '[unset]') + ' ' + e.name + '  - ' + e.effect);
        }
        console.log('');
        console.log('Enabled agents: ' + [...layer.enabledAgents].sort().join(', '));
      }
      return status.state === EngineHealthState.READY ? 0 : 1;
    }

    console.error('Unknown subcommand: ai ' + sub);
    console.error('Try: serva ai status | serva ai probe | serva ai doctor');
    return 2;
  } finally {
    rt.close();
  }
}

function envReport(): { name: string; set: boolean; effect: string }[] {
  const out: { name: string; set: boolean; effect: string }[] = [];
  for (const name of API_BILLING_ENV_VARS) {
    const v = process.env[name];
    out.push({
      name,
      set: typeof v === 'string' && v.trim().length > 0,
      effect: 'would route usage to a separately billed API account',
    });
  }
  for (const name of THIRD_PARTY_ENV_VARS) {
    const v = process.env[name];
    out.push({
      name,
      set: typeof v === 'string' && v.trim().length > 0,
      effect: 'would route usage through a third-party cloud',
    });
  }
  return out;
}

/** `serva agents [--id <SC-AGENT-...>] [--enabled]` — the contract registry. */
export function cmdAgents(args: ParsedArgs): number {
  const rt = openRuntime(args);
  try {
    const layer = buildAiLayer(rt);
    const id = args.flags['id'];

    if (typeof id === 'string') {
      const c = layer.registry.get(id);
      if (wantsJson(args)) {
        emitJson(c);
        return 0;
      }
      console.log(c.id + '  ' + c.name + '  v' + c.version);
      console.log('  Department: ' + c.department + ' (tier ' + String(c.tier) + ')');
      console.log('  Archetype:  ' + c.archetype + '   Authority: ' + c.authorityLevel);
      console.log('  Ceiling:    ' + c.magnitudeCeiling + '   Budget: ' + c.contextBudget);
      console.log('  Mission:    ' + c.mission);
      console.log('  Output:     ' + c.outputs + '  [schema ' + c.outputSchemaRef + ']');
      console.log('  Tools:      ' + c.tools);
      console.log('  FS scope:   ' + c.filesystemScope);
      console.log('  Net scope:  ' + c.networkScope);
      console.log('  AET:        ' + c.aet.criteria.join(', ') + ' - ' + c.aet.justification);
      console.log('');
      console.log('  Field resolution (32 §8.1) — every one of the 29 schema fields:');
      for (const [field, kind] of Object.entries(c.resolution)) {
        console.log('    ' + field.padEnd(24) + kind);
      }
      return 0;
    }

    const summaries = summarizeAgents(layer);
    if (wantsJson(args)) {
      emitJson({ count: summaries.length, agents: summaries });
      return 0;
    }

    const onlyEnabled = args.flags['enabled'] === true;
    const shown = onlyEnabled ? summaries.filter((s) => s.enabled) : summaries;
    console.log(
      'Agent contracts: ' +
        String(summaries.length) +
        ' loaded, ' +
        String(summaries.filter((s) => s.enabled).length) +
        ' enabled for execution in this phase',
    );
    console.log('');
    for (const s of shown) {
      console.log(
        (s.enabled ? '  [on ] ' : '  [off] ') +
          s.id +
          '  ' +
          s.name.padEnd(30) +
          s.department +
          '  ' +
          s.archetype.padEnd(9) +
          s.capabilityLevel,
      );
      if (!s.enabled && s.reasonNotEnabled !== undefined && !onlyEnabled) {
        console.log('          ' + s.reasonNotEnabled);
      }
    }
    return 0;
  } finally {
    rt.close();
  }
}
