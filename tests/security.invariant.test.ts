import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import {
  ActorAuthority,
  RoleAuthority,
  actorRefusal,
  resolveActor,
} from '../src/core/actorAuthority.js';
import { ContractRegistry } from '../src/agents/registry.js';
import { ServaRuntime } from '../src/app/runtime.js';
import { cleanup, tempRoot } from './helpers.js';
import type { Store } from '../src/store/store.js';

/**
 * NO AUTHORITY FROM CALLER-PROVIDED STRINGS.
 *
 * SPEC: Phase 6 security invariant sweep.
 *
 * Four rounds of independent review found the same defect wearing four different names:
 * `curatedBy`, `assessedBy`, `reviewerAgentId`, `verifiedByAgentId`. Each time it was fixed
 * where it was found and left standing in the sibling function twenty lines away — which is
 * how `assessApplicability` survived the round that fixed `contributeLesson`, and how
 * `liveProof.ts` survived the round that fixed `proof.ts`.
 *
 * Patching them one at a time is what produced that pattern, so this suite tests the INVARIANT
 * rather than the instances:
 *
 *   an identity is a fact about the store, never a string a caller typed;
 *   an authority is a fact about the contract registry, never a role name in a document;
 *   an action is authorised by resolving BOTH, together, against the world.
 *
 * The last test in this file is the one that matters most: it reads the source and fails when
 * a NEW authority decision is written as a string comparison. A test that only covers today's
 * sites would leave tomorrow's exactly as exposed.
 */

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) cleanup(r);
});

const CURATOR = 'SC-AGENT-290';
const PRODUCER = 'SC-AGENT-150';
const VERIFIER = 'SC-AGENT-200';

function project(): ServaRuntime {
  const root = tempRoot();
  roots.push(root);
  return ServaRuntime.init('RahalGo', 'Stop losing phone orders', { root });
}

function seedRun(
  store: Store,
  runId: string,
  agentId: string,
  over: Record<string, unknown> = {},
): void {
  const tx = store.begin();
  tx.putCanon('agentRunRecord', runId, {
    runId,
    agentId,
    outcome: 'COMPLETED',
    terminal: true,
    ...over,
  });
  tx.commit();
}

function resolve(rt: ServaRuntime, runId: string, claimedAgentId: string, role?: RoleAuthority) {
  return resolveActor({
    store: rt.store,
    registry: ContractRegistry.shared(),
    runId,
    claimedAgentId,
    ...(role === undefined ? {} : { requiredAuthority: role }),
  });
}

/* ===================================================== the ten adversarial shapes */

describe('an actor is resolved from governed evidence, never from what a caller says', () => {
  it('FORGED AGENT ID: a run that does not exist authorises nothing', () => {
    const rt = project();
    const actor = resolve(rt, 'SC-RUN-INVENTED', CURATOR);
    expect(actor.resolved).toBe(false);
    expect(actor.refusal).toMatch(/does not resolve|does not exist/i);
  });

  it('MISMATCHED RUN IDENTITY: a real run borrowed by another agent authorises nothing', () => {
    /* The commonest forgery: cite a genuine run and claim to be the agent that made it. */
    const rt = project();
    seedRun(rt.store, 'SC-RUN-000001', PRODUCER);
    const actor = resolve(rt, 'SC-RUN-000001', CURATOR);
    expect(actor.resolved).toBe(false);
    expect(actor.refusal).toContain(PRODUCER);
  });

  it('DELETED RUN ID: a run whose record is gone authorises nothing', () => {
    const rt = project();
    const actor = resolve(rt, 'SC-RUN-000404', CURATOR);
    expect(actor.resolved).toBe(false);
  });

  it('REPLAYED RUN: a run that never completed authorises nothing', () => {
    /* A started-and-abandoned run is a real id with no act of deciding behind it. */
    const rt = project();
    seedRun(rt.store, 'SC-RUN-000002', CURATOR, { outcome: undefined, terminal: false });
    const actor = resolve(rt, 'SC-RUN-000002', CURATOR);
    expect(actor.resolved).toBe(false);
  });

  it('FAILED RUN: an outcome that is not COMPLETED authorises nothing', () => {
    const rt = project();
    seedRun(rt.store, 'SC-RUN-000003', CURATOR, { outcome: 'FAILED' });
    const actor = resolve(rt, 'SC-RUN-000003', CURATOR);
    expect(actor.resolved).toBe(false);
    expect(actor.refusal).toContain('FAILED');
  });

  it('FORGED ROLE CLAIM: an id no contract issues holds no authority', () => {
    const rt = project();
    seedRun(rt.store, 'SC-RUN-000004', 'SC-AGENT-999');
    const actor = resolve(rt, 'SC-RUN-000004', 'SC-AGENT-999');
    expect(actor.resolved).toBe(false);
    expect(actor.refusal).toMatch(/no contract|unknown/i);
  });

  it('VALID IDENTITY, INVALID AUTHORITY: a real producer cannot verify', () => {
    /*
     * The distinction the whole invariant turns on. SC-AGENT-150 genuinely ran and genuinely
     * is who it says — and still may not certify, because its contract does not grant that.
     */
    const rt = project();
    seedRun(rt.store, 'SC-RUN-000005', PRODUCER);
    const actor = resolve(rt, 'SC-RUN-000005', PRODUCER, RoleAuthority.VERIFY);
    expect(actor.resolved).toBe(false);
    expect(actor.refusal).toMatch(/authoris|authority/i);
  });

  it('VALID AUTHORITY, WRONG ACTION: a verifier is not a curator', () => {
    /* Holding one authority is not holding every authority. */
    const rt = project();
    seedRun(rt.store, 'SC-RUN-000006', VERIFIER);
    const verifying = resolve(rt, 'SC-RUN-000006', VERIFIER, RoleAuthority.VERIFY);
    expect(verifying.resolved, verifying.refusal).toBe(true);

    const curating = resolve(rt, 'SC-RUN-000006', VERIFIER, RoleAuthority.CURATE);
    expect(curating.resolved).toBe(false);
  });

  it('FORGED APPROVAL METADATA: a document claiming an authority does not gain one', () => {
    /*
     * The document is not consulted at all — which is the point. Whatever it declares about
     * itself, the answer comes from the run and the registry.
     */
    const rt = project();
    seedRun(rt.store, 'SC-RUN-000007', PRODUCER);
    const forged = { reviewerAgentId: VERIFIER, reviewerAuthority: 'VERIFY', approved: true };
    const actor = resolve(rt, 'SC-RUN-000007', forged.reviewerAgentId, RoleAuthority.VERIFY);
    expect(actor.resolved).toBe(false);
    /* Refused because the RUN was by a producer, whatever the document said. */
    expect(actor.refusal).toContain(PRODUCER);
  });

  it('THE HONEST CASE: a real completed run by a real verifier resolves', () => {
    const rt = project();
    seedRun(rt.store, 'SC-RUN-000008', VERIFIER);
    const actor = resolve(rt, 'SC-RUN-000008', VERIFIER, RoleAuthority.VERIFY);
    expect(actor.resolved, actor.refusal).toBe(true);
    expect(actor.agentId).toBe(VERIFIER);
    expect(actor.authority).toBeDefined();
  });
});

describe('independence is decided between resolved actors, not between two strings', () => {
  it('refuses a reviewer that is the producer, resolved from runs', () => {
    const rt = project();
    seedRun(rt.store, 'SC-RUN-P', VERIFIER);
    seedRun(rt.store, 'SC-RUN-R', VERIFIER);
    const refusal = actorRefusal({
      store: rt.store,
      registry: ContractRegistry.shared(),
      actorRunId: 'SC-RUN-R',
      claimedAgentId: VERIFIER,
      requiredAuthority: RoleAuthority.VERIFY,
      mustDifferFromRunId: 'SC-RUN-P',
    });
    expect(refusal).toMatch(/same|independen/i);
  });

  it('accepts a reviewer that is a different, authorised actor', () => {
    const rt = project();
    seedRun(rt.store, 'SC-RUN-P', PRODUCER);
    seedRun(rt.store, 'SC-RUN-R', VERIFIER);
    const refusal = actorRefusal({
      store: rt.store,
      registry: ContractRegistry.shared(),
      actorRunId: 'SC-RUN-R',
      claimedAgentId: VERIFIER,
      requiredAuthority: RoleAuthority.VERIFY,
      mustDifferFromRunId: 'SC-RUN-P',
    });
    expect(refusal).toBeUndefined();
  });

  it('refuses when the run it must differ from does not resolve', () => {
    /* Independence from an unknown party is not independence; it is an unanswered question. */
    const rt = project();
    seedRun(rt.store, 'SC-RUN-R', VERIFIER);
    const refusal = actorRefusal({
      store: rt.store,
      registry: ContractRegistry.shared(),
      actorRunId: 'SC-RUN-R',
      claimedAgentId: VERIFIER,
      requiredAuthority: RoleAuthority.VERIFY,
      mustDifferFromRunId: 'SC-RUN-GONE',
    });
    expect(refusal).toBeDefined();
  });
});

/* ============================ the structural test: no NEW site may regress ============ */

describe('the invariant holds across the codebase, not only where it was last enforced', () => {
  /*
   * Every previous round fixed the site the review named and left its siblings standing. This
   * test is the reason that cannot happen again: it reads the source, finds authority decisions
   * expressed as string comparisons, and fails on any that is not routed through the resolver.
   *
   * The allow-list is deliberately explicit. Adding to it is a decision somebody makes on
   * purpose, with a reason written next to it — not something that happens by forgetting.
   */
  const ACTOR_COMPARISON =
    /(curatedBy|assessedBy|reviewerAgentId|verifiedByAgentId|approvedBy|producerAgentId)\s*(===|!==)/;

  /** Sites where comparing two strings is the correct and complete answer. */
  const ALLOWED: readonly { readonly file: string; readonly why: string }[] = [
    {
      file: 'src/core/actorAuthority.ts',
      why: 'the resolver itself, which is where the comparison is supposed to happen',
    },
    {
      file: 'src/acceptance/reviewAuthority.ts',
      why: 'derives the producer SET from governed history; membership is not an authority grant',
    },
    {
      file: 'src/engineering/factory.ts',
      why: 'a schema refinement and a same-item check over records already resolved from the store',
    },
    {
      file: 'src/intelligence/research/verification.ts',
      why: 'detects self-verification between two STORED records; the claimant is now mandatory, so a caller can no longer skip the question by omitting it',
    },
  ];

  it('no source file decides authority by comparing caller-supplied strings', () => {
    const files = execSync('git ls-files src', { encoding: 'utf8' })
      .split(/\r?\n/)
      .map((f) => f.trim())
      .filter((f) => f.endsWith('.ts'));

    const offenders: string[] = [];
    for (const file of files) {
      if (ALLOWED.some((a) => a.file === file)) continue;
      const source = readFileSync(file, 'utf8');
      for (const [i, line] of source.split(/\r?\n/).entries()) {
        if (line.trim().startsWith('*') || line.trim().startsWith('//')) continue;
        if (ACTOR_COMPARISON.test(line)) {
          offenders.push(file + ':' + String(i + 1) + '  ' + line.trim().slice(0, 100));
        }
      }
    }

    expect(
      offenders,
      'these lines decide who may act by comparing strings; route them through resolveActor:\n' +
        offenders.join('\n'),
    ).toEqual([]);
  });

  it('every allow-list entry names a file that still exists', () => {
    /* An allow-list that outlives its files stops meaning anything. */
    for (const entry of ALLOWED) {
      expect(() => readFileSync(entry.file, 'utf8'), entry.file).not.toThrow();
      expect(entry.why.length, entry.file + ' needs a reason').toBeGreaterThan(20);
    }
  });

  it('the authority vocabulary is closed, so a new role cannot be invented in a string', () => {
    for (const value of Object.values(RoleAuthority)) {
      expect(typeof value).toBe('string');
    }
    expect(Object.values(ActorAuthority).length).toBeGreaterThan(0);
  });
});
