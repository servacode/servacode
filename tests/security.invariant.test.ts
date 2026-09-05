import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import {
  ActorAuthority,
  RoleAuthority,
  actorRefusal,
  resolveActor,
} from '../src/core/actorAuthority.js';
import {
  supportedVerdict,
  verdictIsAffirmative,
} from '../src/intelligence/departments/verdictSupport.js';
import {
  guestPrerequisite,
  localPrerequisite,
  unreachedPrerequisite,
} from '../src/substrate/types.js';
import { GuestReach } from '../src/substrate/transport.js';
import { isAuthoritativeOwnerAnswer } from '../src/intelligence/artifacts/governance.js';
import { isSettlementFor } from '../src/intelligence/artifacts/framing.js';
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

/* ============ THE SAME CLASS, IN VERDICTS: a self-reported PASS is not a measurement ======= */

describe('a verification verdict is downgraded when nothing was actually exercised', () => {
  /*
   * SPEC: Phase 6 security invariant sweep; HIGH findings
   * ORGANIZATIONAL-LEARNING-DEPARTMENTS-B/F1 and F2.
   *
   * This is the authority defect in a second costume. There the question was "who says you may
   * act"; here it is "who says the work was checked" — and the answer was the same: the agent
   * itself, believed.
   *
   * Two departments computed the honest answer (`unjudged.length > 0 && verdict === PASS =>
   * NOT_VERIFIED`, with a comment reading "Serva computes this"). Three others —
   * qaVerification, accessibilityVerification, securityVerification — wrote `verdict:
   * output.verdict` straight through. An agent could report PASS for the SECURITY stage with
   * `threatsExercised: []` and every threat in `notVerified`, and Serva persisted a clean PASS.
   *
   * And where the downgrade did exist it tested `=== PASS` only, so PASS_WITH_QUALIFICATION
   * bypassed it entirely — while the Release department reads exactly that field to decide
   * RECOMMEND or HOLD.
   */
  it('downgrades a PASS that exercised nothing', () => {
    expect(supportedVerdict('PASS', { exercised: 0, notVerified: 3 })).toBe('NOT_VERIFIED');
  });

  it('downgrades PASS_WITH_QUALIFICATION too, which the original check let through', () => {
    expect(supportedVerdict('PASS_WITH_QUALIFICATION', { exercised: 0, notVerified: 3 })).toBe(
      'NOT_VERIFIED',
    );
  });

  it('leaves an honest PASS alone', () => {
    expect(supportedVerdict('PASS', { exercised: 5, notVerified: 0 })).toBe('PASS');
  });

  it('leaves a PASS with some coverage and some gaps alone', () => {
    /* Partial coverage is what PASS_WITH_QUALIFICATION and `notVerified` are FOR. */
    expect(supportedVerdict('PASS_WITH_QUALIFICATION', { exercised: 5, notVerified: 2 })).toBe(
      'PASS_WITH_QUALIFICATION',
    );
  });

  it('never upgrades a FAIL', () => {
    /* The helper only ever makes a verdict weaker. */
    expect(supportedVerdict('FAIL', { exercised: 5, notVerified: 0 })).toBe('FAIL');
    expect(supportedVerdict('NOT_VERIFIED', { exercised: 5, notVerified: 0 })).toBe('NOT_VERIFIED');
  });
});

/* ====== CLASS 1: a declared safeguard must have an enforcement consumer ====== */

describe('every declared safeguard is consumed by something that enforces it', () => {
  /*
   * SPEC: Phase 6 targeted hardening, class 1.
   *
   * `MIN_CLASSIFICATION_CONFIDENCE` shipped for months carrying the sentence "below this, a
   * classification is not acted on without owner input", read by nothing. Two separate review
   * rounds named it, and the round that fixed the identical shape for `ownerDecisionRequired`
   * walked past it in the same function.
   *
   * A declared safeguard nothing consumes is worse than none: the constant documents a
   * protection, and a reader has no reason to check that anything reads it. So the check is
   * structural — an exported constant whose comment CLAIMS enforcement must be referenced by
   * production code outside its own declaration.
   *
   * Deliberately narrow. This is not an unused-export sweep: it fires only on constants whose
   * own documentation asserts that something is refused, required, or not acted on.
   */
  const CLAIMS_ENFORCEMENT =
    /\b(must not|may not|is not acted on|is refused|refuses|never|required|forbidden|only .* may)\b/i;

  interface Declared {
    readonly file: string;
    readonly name: string;
    readonly claim: string;
  }

  function declaredSafeguards(): readonly Declared[] {
    const files = execSync('git ls-files src', { encoding: 'utf8' })
      .split(/\r?\n/)
      .map((f) => f.trim())
      .filter((f) => f.endsWith('.ts'));

    const found: Declared[] = [];
    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split(/\r?\n/);
      for (const [i, line] of lines.entries()) {
        const declaration = /^export const ([A-Z][A-Z0-9_]{3,})\s*[:=]/.exec(line);
        if (declaration === null) continue;
        const name = declaration[1] as string;

        /* The doc comment immediately above, however it is written. */
        const comment: string[] = [];
        for (let j = i - 1; j >= 0 && j > i - 12; j -= 1) {
          const above = (lines[j] ?? '').trim();
          if (above === '' || above.startsWith('*/')) continue;
          if (above.startsWith('*') || above.startsWith('/**') || above.startsWith('/*')) {
            comment.unshift(above.replace(/^[/*]+/, '').trim());
            if (above.startsWith('/**') || above.startsWith('/*')) break;
            continue;
          }
          break;
        }
        const claim = comment.join(' ');
        if (claim === '') continue;
        /*
         * A constant may honestly be enforced by ABSENCE (nothing constructs it) or be purely
         * INFORMATIONAL. Both are fine — but each has to say so, in those words, so the
         * exemption is a sentence somebody wrote on purpose rather than a silence.
         */
        if (/enforced by absence|informational/i.test(claim)) continue;
        if (CLAIMS_ENFORCEMENT.test(claim)) found.push({ file, name, claim });
      }
    }
    return found;
  }

  it('finds the safeguards it is supposed to be checking', () => {
    /* A structural test that matched nothing would pass forever while proving nothing. */
    expect(declaredSafeguards().length).toBeGreaterThan(3);
  });

  it('every safeguard claiming enforcement is read by production code', () => {
    const files = execSync('git ls-files src', { encoding: 'utf8' })
      .split(/\r?\n/)
      .map((f) => f.trim())
      .filter((f) => f.endsWith('.ts'));
    const sources = new Map(files.map((f) => [f, readFileSync(f, 'utf8')]));

    const unenforced: string[] = [];
    for (const safeguard of declaredSafeguards()) {
      let consumers = 0;
      for (const [file, source] of sources) {
        for (const line of source.split(/\r?\n/)) {
          if (!line.includes(safeguard.name)) continue;
          /* Its own declaration, and its own doc comment, do not count as consumption. */
          if (/^export const/.test(line.trim())) continue;
          if (line.trim().startsWith('*') || line.trim().startsWith('//')) continue;
          consumers += 1;
          void file;
        }
      }
      if (consumers === 0) {
        unenforced.push(
          safeguard.file + '  ' + safeguard.name + '\n    claims: ' + safeguard.claim.slice(0, 120),
        );
      }
    }

    expect(
      unenforced,
      'these constants document a protection that nothing enforces. Either wire them into the ' +
        'code that should refuse, or rewrite the comment to stop claiming they do:\n' +
        unenforced.join('\n'),
    ).toEqual([]);
  });
});

/* ====== CLASS 2: one verdict resolver, whatever enum a department speaks ====== */

describe('a decision-bearing verdict is resolved, never read raw from a document', () => {
  /*
   * SPEC: Phase 6 targeted hardening, class 2; finding
   * ORGANIZATIONAL-LEARNING-DEPARTMENTS-A/F2.
   *
   * `supportedVerdict` closed this for the PASS/FAIL family and the review immediately found
   * the same hole one enum over: four reviewer departments persist `met: output.verdict ===
   * 'ACCEPTABLE'` with a `findings` array that is `.default([])` and has no `minItems`. A
   * reviewer returning `{verdict: 'ACCEPTABLE', findings: []}` records a met judgement having
   * examined nothing.
   *
   * My own comment claimed the fix applied "by every department, so the next one written
   * cannot quietly omit it". It did not, because it only understood one vocabulary. One
   * resolver now takes both.
   */
  it('FORGED VERDICT: a value outside the family is not a pass', () => {
    expect(verdictIsAffirmative('TOTALLY_FINE', { examined: 5 })).toBe(false);
    expect(verdictIsAffirmative('', { examined: 5 })).toBe(false);
  });

  it('UNSUPPORTED VERDICT: ACCEPTABLE having examined nothing is not a pass', () => {
    expect(verdictIsAffirmative('ACCEPTABLE', { examined: 0 })).toBe(false);
  });

  it('MISMATCHED ENUM FAMILY: PASS is not an answer to an ACCEPTABLE question', () => {
    /*
     * Both families are understood, and each is only affirmative in its own terms — so a
     * department cannot launder a verdict by answering in the other vocabulary.
     */
    expect(verdictIsAffirmative('PASS', { examined: 5, family: 'REVIEW' })).toBe(false);
    expect(verdictIsAffirmative('ACCEPTABLE', { examined: 5, family: 'VERIFICATION' })).toBe(false);
  });

  it('a supported verdict in its own family is affirmative', () => {
    expect(verdictIsAffirmative('ACCEPTABLE', { examined: 3, family: 'REVIEW' })).toBe(true);
    expect(verdictIsAffirmative('PASS', { examined: 3, family: 'VERIFICATION' })).toBe(true);
  });

  it('a negative verdict is never upgraded, however much was examined', () => {
    expect(verdictIsAffirmative('NOT_ACCEPTABLE', { examined: 99 })).toBe(false);
    expect(verdictIsAffirmative('FAIL', { examined: 99 })).toBe(false);
  });

  it('PASS_WITH_QUALIFICATION is affirmative only when something was examined', () => {
    expect(verdictIsAffirmative('PASS_WITH_QUALIFICATION', { examined: 3 })).toBe(true);
    expect(verdictIsAffirmative('PASS_WITH_QUALIFICATION', { examined: 0 })).toBe(false);
  });

  it('every reviewer department routes its judgement through the resolver', () => {
    /*
     * The structural half. A department added later cannot quietly compare a raw verdict
     * string again, which is exactly how this class survived the first fix.
     */
    const files = execSync('git ls-files src/intelligence/departments', { encoding: 'utf8' })
      .split(/\r?\n/)
      .map((f) => f.trim())
      .filter((f) => f.endsWith('.ts'));

    const raw: string[] = [];
    for (const file of files) {
      for (const [i, line] of readFileSync(file, 'utf8').split(/\r?\n/).entries()) {
        if (/met:\s*output\.verdict\s*===/.test(line)) {
          raw.push(file + ':' + String(i + 1) + '  ' + line.trim());
        }
      }
    }
    expect(
      raw,
      'these compare a raw verdict from a document; route them through verdictIsAffirmative:\n' +
        raw.join('\n'),
    ).toEqual([]);
  });
});

/* ====== A: one canonical way to record a guest-derived prerequisite ====== */

describe('a guest prerequisite cannot be built without its reach', () => {
  /*
   * SPEC: findings QUALIFICATION-TRANSPORT-SEMANTICS/QTS-A and QTS-PREREQ-NOREACH.
   *
   * The first fix added `reach` as an OPTIONAL field and supplied it at one of the four
   * guest-derived producers. The consumer filtered `p.reach !== undefined && p.reach !==
   * REACHED`, so the three that omitted it could never be counted as unreached — and the same
   * defect came back, caused by the shape of its own fix.
   *
   * An optional field is a field somebody forgets. `guestPrerequisite` demands reach at the
   * type level and `unreachedPrerequisite` is the single predicate consumers use, so the
   * question "did anyone forget?" is answered by the compiler rather than by a reviewer.
   */
  it('an unreached guest never satisfies a prerequisite, whatever the caller passes', () => {
    /* Even asked for `satisfied: true`, an unreached probe establishes nothing. */
    const p = guestPrerequisite({
      id: 'GUEST_NODE',
      what: 'node',
      why: 'recipes run in the guest',
      remedy: 'install node',
      satisfied: true,
      reach: GuestReach.NOT_REACHED,
    });
    expect(p.satisfied).toBe(false);
    expect(unreachedPrerequisite(p)).toBe(true);
  });

  it('a reached guest reporting absence is a real negative measurement', () => {
    const p = guestPrerequisite({
      id: 'GUEST_NODE',
      what: 'node',
      why: 'recipes run in the guest',
      remedy: 'install node',
      satisfied: false,
      reach: GuestReach.REACHED,
    });
    expect(p.satisfied).toBe(false);
    expect(unreachedPrerequisite(p), 'a measured absence is not a transport failure').toBe(false);
  });

  it('UNKNOWN reach is unreached, not satisfied', () => {
    const p = guestPrerequisite({
      id: 'GUEST_NODE',
      what: 'node',
      why: 'x',
      remedy: 'y',
      satisfied: true,
      reach: GuestReach.UNKNOWN,
    });
    expect(unreachedPrerequisite(p)).toBe(true);
    expect(p.satisfied).toBe(false);
  });

  it('a local prerequisite is never unreached, because no guest was asked', () => {
    const p = localPrerequisite({
      id: 'ENGINE_VERSION',
      what: 'a parseable engine version',
      why: 'x',
      remedy: 'y',
      satisfied: false,
    });
    expect(unreachedPrerequisite(p)).toBe(false);
  });

  it('no production code builds a prerequisite by object literal', () => {
    /*
     * The structural half. A `prerequisites.push({...})` literal is how three producers came
     * to omit reach; the constructors are the only supported path, so a new producer that
     * bypasses them fails here rather than in a security review six weeks later.
     */
    const files = execSync('git ls-files src', { encoding: 'utf8' })
      .split(/\r?\n/)
      .map((f) => f.trim())
      .filter((f) => f.endsWith('.ts'));

    const literals: string[] = [];
    for (const file of files) {
      if (file === 'src/substrate/types.ts') continue; /* where the constructors live */
      const lines = readFileSync(file, 'utf8').split(/\r?\n/);
      for (const [i, line] of lines.entries()) {
        if (!/prerequisites(\.push\(|: \[)\s*\{|prerequisites\.push\(\{/.test(line)) continue;
        literals.push(file + ':' + String(i + 1) + '  ' + line.trim());
      }
    }
    expect(
      literals,
      'build these with guestPrerequisite() or localPrerequisite() so reach cannot be ' +
        'omitted:\n' +
        literals.join('\n'),
    ).toEqual([]);
  });

  it('the qualification consumer uses the canonical predicate', () => {
    /* One predicate, so "is this unreached?" cannot be re-answered differently elsewhere. */
    const source = readFileSync('src/substrate/sandboxed.ts', 'utf8');
    expect(source).toContain('unreachedPrerequisite');
    expect(source).not.toMatch(/p\.reach !== undefined/);
  });
});

/* ====== C: one predicate decides whether the owner answered ====== */

describe('an owner answer is proved, not asserted by state', () => {
  /*
   * SPEC: HIGH finding ORGANIZATIONAL-LEARNING-EXECUTION-AND-RESEARCH/F1-OWNER-ANSWER-TRUST.
   *
   * `ownerDecisionRefusal` always knew what a real owner answer looks like, and only one of
   * its three consumers asked it. The other two filtered on `state === 'ANSWERED'` alone —
   * and `OWNER_DECISION_REQUEST` is universal, so a department could persist an ANSWERED
   * decision attributed to itself, suppress the question the owner should have been asked,
   * and feed "the owner answered X. Proceed on it." into its own trusted context.
   *
   * Enforced in one place and reinvented in two is the shape this whole stabilisation pass is
   * about, so the fix is one predicate and a structural ban on the alternative.
   */
  function decision(over: Record<string, unknown> = {}) {
    return {
      id: 'SC-ODR-000001',
      question: 'Does a reservation take a deposit?',
      state: 'ANSWERED',
      answeredBy: 'the owner',
      chosenOption: 'no deposit',
      options: [],
      askedBy: 'SC-AGENT-040',
      meta: { attribution: { at: '2026-08-30T00:00:00.000Z', agentId: 'SC-AGENT-040' } },
      ...over,
    } as never;
  }

  it('a genuine owner answer is authoritative', () => {
    expect(isAuthoritativeOwnerAnswer(decision())).toBe(true);
  });

  it('an answer attributed to an AGENT is refused', () => {
    /* The attack: a department answers its own question and proceeds on it. */
    expect(isAuthoritativeOwnerAnswer(decision({ answeredBy: 'SC-AGENT-040' }))).toBe(false);
  });

  it('an answer attributed to a RUN is refused', () => {
    expect(isAuthoritativeOwnerAnswer(decision({ answeredBy: 'SC-RUN-01M0V88G2K' }))).toBe(false);
  });

  it('ANSWERED with nobody recorded as answering is refused', () => {
    expect(isAuthoritativeOwnerAnswer(decision({ answeredBy: undefined }))).toBe(false);
    expect(isAuthoritativeOwnerAnswer(decision({ answeredBy: '   ' }))).toBe(false);
  });

  it('an OPEN decision is not an answer', () => {
    expect(isAuthoritativeOwnerAnswer(decision({ state: 'OPEN' }))).toBe(false);
  });

  it('a WITHDRAWN decision is not an answer', () => {
    expect(isAuthoritativeOwnerAnswer(decision({ state: 'WITHDRAWN' }))).toBe(false);
  });

  it('ANSWERED with no actual answer in it is refused', () => {
    expect(
      isAuthoritativeOwnerAnswer(decision({ chosenOption: undefined, answerValue: undefined })),
    ).toBe(false);
  });

  it('no consumer decides owner authority from state alone', () => {
    /*
     * The structural half. `state === 'ANSWERED'` is a fact about a field; owner authority is
     * a fact about who answered. Only the predicate and the refusal it wraps may look at the
     * field directly.
     */
    const files = execSync('git ls-files src', { encoding: 'utf8' })
      .split(/\r?\n/)
      .map((f) => f.trim())
      .filter((f) => f.endsWith('.ts'));

    const ALLOWED = ['src/intelligence/artifacts/governance.ts'];
    const offenders: string[] = [];
    for (const file of files) {
      if (ALLOWED.includes(file)) continue;
      const lines = readFileSync(file, 'utf8').split(/\r?\n/);
      for (const [i, line] of lines.entries()) {
        if (line.trim().startsWith('*') || line.trim().startsWith('//')) continue;
        if (!/state\s*(===|!==)\s*'ANSWERED'/.test(line)) continue;
        /*
         * Only OWNER decisions. An OpenQuestion is a department's own obligation and a
         * department may legitimately answer one; conflating the two would ban a correct
         * pattern and teach the next reader that this check is noise.
         */
        const context = lines.slice(Math.max(0, i - 18), i + 2).join('\n');
        if (!/OWNER_DECISION_REQUEST|OwnerDecisionRequest/.test(context)) continue;
        offenders.push(file + ':' + String(i + 1) + '  ' + line.trim());
      }
    }
    expect(
      offenders,
      'these decide owner authority from a field; use isAuthoritativeOwnerAnswer:\n' +
        offenders.join('\n'),
    ).toEqual([]);
  });
});

describe("a settled obligation reaching a trusted context must be that department's own", () => {
  /*
   * SPEC: HIGH finding ORGANIZATIONAL-LEARNING-EXECUTION-AND-RESEARCH/OLER-CTX-1, 1.0.1.
   *
   * The sibling of the owner-answer block above, found by a SECOND independent review of code
   * the first had already accepted. `settledObligations` turns an ANSWERED OpenQuestion into a
   * DIRECTIVE in a department's trusted context — "this has been discharged, proceed on it, do
   * not raise it again" — and pulls in every canon its `resolvedByRefs` names.
   *
   * It filtered on `raisedBy`, `state` and `answer`. All three are body fields written by
   * whoever wrote the artifact, and OPEN_QUESTION is UNIVERSAL: any department may write one.
   * So a department could address a fabricated settlement to another department and put words
   * in its head, along with any canon it chose to name.
   *
   * Exactly the shape the owner-answer path was hardened against — in the sibling that never
   * got the guard. One predicate, and a structural ban on the alternative.
   */
  function settlement(over: Record<string, unknown> = {}) {
    return {
      id: 'SC-OQ-000001',
      question: 'How long is a reservation held?',
      state: 'ANSWERED',
      answer: 'thirty minutes',
      askedOf: 'RESEARCH',
      raisedBy: 'DEPT-PRODUCT',
      blocks: [],
      sourceFields: [],
      resolvedByRefs: [{ id: 'SC-RFND-000001' }],
      meta: {
        provenance: { marking: 'SYSTEM', component: 'intelligence-runner' },
        attribution: { at: '2026-08-30T00:00:00.000Z', agentId: 'SC-AGENT-030' },
        workItemId: 'SC-WI-000990',
      },
      ...over,
    } as never;
  }

  const WHO = {
    departmentId: 'DEPT-PRODUCT',
    agentId: 'SC-AGENT-030',
    workItemId: 'SC-WI-000990',
  };

  const metaOf = (agentId: string, workItemId: string) => ({
    provenance: { marking: 'SYSTEM', component: 'intelligence-runner' },
    attribution: { at: '2026-08-30T00:00:00.000Z', agentId },
    workItemId,
  });

  it("a department's own discharged obligation is one it may act on", () => {
    expect(isSettlementFor(settlement(), WHO)).toBe(true);
  });

  it('a settlement written by another agent is refused', () => {
    /*
     * THE ATTACK. `raisedBy` names the target department; the attribution says who actually
     * wrote it. A forger cannot write under somebody else's attribution, and `put` never
     * re-stamps meta — so the raiser's identity survives the fulfilment and can be checked.
     */
    expect(isSettlementFor(settlement({ meta: metaOf('SC-AGENT-999', 'SC-WI-000990') }), WHO)).toBe(
      false,
    );
  });

  it("a settlement addressed to another department is not this department's", () => {
    expect(isSettlementFor(settlement({ raisedBy: 'DEPT-SOMEBODY-ELSE' }), WHO)).toBe(false);
  });

  it('a settlement from another work item says nothing about this one', () => {
    expect(isSettlementFor(settlement({ meta: metaOf('SC-AGENT-030', 'SC-WI-OTHER') }), WHO)).toBe(
      false,
    );
  });

  it('a settlement naming no canon that discharged it is a sentence, not evidence', () => {
    /* The legitimate writer always names the canon, precisely so a reader can check it. */
    expect(isSettlementFor(settlement({ resolvedByRefs: [] }), WHO)).toBe(false);
  });

  it('an OPEN or WITHDRAWN question has settled nothing', () => {
    expect(isSettlementFor(settlement({ state: 'OPEN' }), WHO)).toBe(false);
    expect(isSettlementFor(settlement({ state: 'WITHDRAWN' }), WHO)).toBe(false);
  });

  it('ANSWERED with no answer in it is refused', () => {
    expect(isSettlementFor(settlement({ answer: undefined }), WHO)).toBe(false);
    expect(isSettlementFor(settlement({ answer: '   ' }), WHO)).toBe(false);
  });

  it('both consumers use the predicate rather than reinventing it', () => {
    /*
     * The structural half. The defect was not a missing idea — the idea existed one file away.
     * It was a second consumer written without it, so this asserts that neither consumer
     * decides settlement from body fields of its own accord.
     */
    const runner = readFileSync('src/intelligence/execution/runner.ts', 'utf8');
    expect(runner).toContain('isSettlementFor(q, {');
    const questions = readFileSync('src/intelligence/execution/questions.ts', 'utf8');
    expect(questions).toContain('isSettlementFor(q, {');
  });
});
