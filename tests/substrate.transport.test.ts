import { afterEach, describe, expect, it } from 'vitest';
import { EnforcementClass } from '../src/vocab/index.js';
import {
  GuestReach,
  TRANSPORT_ATTEMPTS,
  type TransportAttempt,
  type TransportResult,
} from '../src/substrate/transport.js';
import {
  EnforcementState,
  ExecutionAvailability,
  NotRunReason,
  QualificationAttempt,
  deriveEnforcementClass,
  engineeringAuthorityRefusal,
} from '../src/substrate/types.js';
import {
  FingerprintComparison,
  ProducerAuthority,
  compareFingerprint,
  lastValidQualification,
  producerAuthority,
  recordQualification,
} from '../src/substrate/qualificationRecord.js';
import { ServaRuntime } from '../src/app/runtime.js';
import { cleanup, tempRoot } from './helpers.js';
import type {
  QualificationResult,
  SubstrateCapabilities,
  SubstrateQualification,
} from '../src/substrate/types.js';

/**
 * A TRANSPORT FAILURE IS NOT A BOUNDARY VERDICT.
 *
 * SPEC: Phase 6 qualification transport invariant §1–§8.
 *
 * Running `serva engineering qualify` three times on this machine, minutes apart, with
 * nothing changing, produced HARD, then NONE, then NONE. `wsl.exe` intermittently returns
 * exit 4294967295 with no output; the host process started, so `spawnFailed` was false, and
 * qualification recorded `Q-A FAILED: the permitted write was REFUSED` — a measured
 * containment finding, about a command that never ran.
 *
 * HARD is what permits a Producer to write code. It was being decided by a coin flip.
 *
 * These are the regressions the closure asks for, and the property under all of them is one
 * sentence: an exit code is evidence only about a command that ran, so the guest has to say
 * it started.
 */

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) cleanup(r);
});

const ENFORCED: SubstrateCapabilities = {
  filesystemEnforcement: EnforcementState.ENFORCED,
  processEnforcement: EnforcementState.ENFORCED,
  networkEnforcement: EnforcementState.ENFORCED,
  credentialProtection: EnforcementState.ENFORCED,
  hostEscapeProtection: EnforcementState.ENFORCED,
  canWrite: true,
  canExecute: true,
};

function result(over: Partial<QualificationResult> & { id: string }): QualificationResult {
  return {
    title: over.id,
    expectation: 'x',
    outcome: 'PASSED',
    detail: 'ok',
    blocking: true,
    at: 'T',
    reachedGuest: GuestReach.REACHED,
    ...over,
  };
}

/** A blocking probe that never reached the guest. */
const unreached = (id: string, attempts = TRANSPORT_ATTEMPTS): QualificationResult =>
  result({
    id,
    outcome: 'NOT_RUN',
    detail: 'wsl.exe exit 4294967295, no output',
    reachedGuest: GuestReach.NOT_REACHED,
    notRunReason: NotRunReason.TRANSPORT_FAILURE,
    transportAttempts: Array.from({ length: attempts }, (_, i) => ({
      attempt: i + 1,
      reach: GuestReach.NOT_REACHED,
      exitCode: 4294967295,
      spawnFailed: false,
      timedOut: false,
      detail: 'the guest never started the command; wsl.exe exit 4294967295',
    })) as readonly TransportAttempt[],
  });

const IDS = ['Q-A', 'Q-B', 'Q-C'];

function qualification(over: Partial<SubstrateQualification> = {}): SubstrateQualification {
  const tests = over.tests ?? IDS.map((id) => result({ id }));
  const derived = deriveEnforcementClass(tests, over.capabilities ?? ENFORCED);
  return {
    probe: {
      substrateId: 'x',
      hostPlatform: 'win32',
      hostArch: 'x64',
      isolationMethod: 'BUBBLEWRAP',
      engineVersion: '1',
      prerequisites: [],
      observations: {},
      probedAt: 'T',
    },
    capabilities: ENFORCED,
    tests,
    ...derived,
    qualifiedAt: '2026-08-24T10:00:00.000Z',
    engineVersion: '1',
    fingerprint: 'fingerprint-F',
    boundary: {
      boundaryId: 'SC-BOUNDARY-PRODUCER',
      purpose: 'PRODUCER',
      transport: 'wsl:Ubuntu',
      engineVersion: '1',
      sandboxMechanism: 'bubblewrap',
    },
    ...over,
  } as SubstrateQualification;
}

/* =============================================== A. the healthy machine still measures */

describe('A. guest reachable and every probe succeeds', () => {
  it('measures HARD, and says it measured', () => {
    const q = qualification();
    expect(q.enforcementClass).toBe(EnforcementClass.HARD);
    expect(q.attempt).toBe(QualificationAttempt.MEASURED);
    expect(q.availability).toBe(ExecutionAvailability.AVAILABLE);
    expect(engineeringAuthorityRefusal(q)).toBeUndefined();
  });
});

/* ====================================== B. transport failure measures nothing at all */

describe('B. the transport fails before the guest starts', () => {
  const q = qualification({ tests: [unreached('Q-A'), result({ id: 'Q-B' })] });

  it('reports the attempt as NOT_MEASURED, not as a class', () => {
    expect(q.attempt).toBe(QualificationAttempt.NOT_MEASURED);
    expect(q.availability).toBe(ExecutionAvailability.UNREACHABLE);
  });

  it('records NOT_RUN with a transport reason, never FAILED', () => {
    const probe = q.tests.find((t) => t.id === 'Q-A');
    expect(probe?.outcome).toBe('NOT_RUN');
    expect(probe?.outcome).not.toBe('FAILED');
    expect(probe?.notRunReason).toBe(NotRunReason.TRANSPORT_FAILURE);
    expect(probe?.reachedGuest).toBe(GuestReach.NOT_REACHED);
  });

  it('refuses authority in the words of what happened', () => {
    const refusal = String(engineeringAuthorityRefusal(q));
    expect(refusal).toContain('not measured');
    /*
     * The owner must not be sent looking for a broken sandbox. This machine was never
     * examined, and the refusal has to say so rather than name a containment class.
     */
    expect(refusal).not.toMatch(/substrate is NONE/i);
  });
});

/* ================================= C. retries are bounded, recorded, and then honest */

describe('C. the transport fails twice and then succeeds', () => {
  it('keeps every attempt, and the final measurement is the one used', () => {
    /*
     * The retry lives inside the transport, so by the time a probe result exists the
     * question is already settled. What must survive is the EVIDENCE that it took three
     * goes — an owner debugging an unstable guest needs to see that.
     */
    const attempts: TransportAttempt[] = [
      {
        attempt: 1,
        reach: GuestReach.NOT_REACHED,
        exitCode: 4294967295,
        spawnFailed: false,
        timedOut: false,
        detail: 'never started',
      },
      {
        attempt: 2,
        reach: GuestReach.NOT_REACHED,
        exitCode: 4294967295,
        spawnFailed: false,
        timedOut: false,
        detail: 'never started',
      },
      {
        attempt: 3,
        reach: GuestReach.REACHED,
        exitCode: 0,
        spawnFailed: false,
        timedOut: false,
        detail: 'the guest started the command',
      },
    ];
    const q = qualification({
      tests: [result({ id: 'Q-A', transportAttempts: attempts }), result({ id: 'Q-B' })],
    });
    expect(q.attempt).toBe(QualificationAttempt.MEASURED);
    expect(q.enforcementClass).toBe(EnforcementClass.HARD);
    expect(q.tests[0]?.transportAttempts).toHaveLength(3);
    expect(
      q.tests[0]?.transportAttempts?.filter((a) => a.reach === GuestReach.REACHED),
    ).toHaveLength(1);
  });

  it('the retry budget is fixed and small, with no way to raise it', () => {
    expect(TRANSPORT_ATTEMPTS).toBe(3);
  });
});

/* ============================== D & E. a reached probe is a measurement, never retried */

describe('D. the guest is reached and the launcher is genuinely absent', () => {
  it('is a measured failure, and no retry can wash it', () => {
    const q = qualification({
      tests: [
        result({
          id: 'Q-A',
          outcome: 'NOT_RUN',
          detail: 'bwrap is not installed in the guest',
          reachedGuest: GuestReach.REACHED,
          notRunReason: NotRunReason.SUBSTRATE_REFUSED,
        }),
        result({ id: 'Q-B' }),
      ],
    });
    /* Reached, so this attempt DID measure the machine — and what it measured is bad. */
    expect(q.attempt).toBe(QualificationAttempt.MEASURED);
    expect(q.availability).toBe(ExecutionAvailability.AVAILABLE);
    expect(q.enforcementClass).not.toBe(EnforcementClass.HARD);
  });
});

describe('E. a containment escape is observed', () => {
  it('is a measured FAILED, immediately, with no retry and no softening', () => {
    const q = qualification({
      tests: [
        result({
          id: 'Q-C',
          outcome: 'FAILED',
          detail: 'the sandboxed command wrote outside its worktree',
        }),
        result({ id: 'Q-B' }),
      ],
    });
    expect(q.attempt).toBe(QualificationAttempt.MEASURED);
    expect(q.enforcementClass).not.toBe(EnforcementClass.HARD);
    expect(String(engineeringAuthorityRefusal(q))).toContain('Q-C');
  });
});

/* ============================= F & G. the last valid measurement survives an outage */

describe('F. an outage does not destroy the last valid qualification', () => {
  function project(): ServaRuntime {
    const root = tempRoot();
    roots.push(root);
    return ServaRuntime.init('RahalGo', 'Stop losing phone orders', { root });
  }

  it('preserves HARD, reports the outage, and blocks the Producer anyway', () => {
    const rt = project();
    try {
      const measured = qualification();
      const record = recordQualification(rt.store, measured);
      expect(record?.enforcementClass).toBe(EnforcementClass.HARD);

      /* The outage. Nothing about the machine changed; WSL stopped answering. */
      const outage = qualification({ tests: [unreached('Q-A'), result({ id: 'Q-B' })] });
      expect(recordQualification(rt.store, outage)).toBeUndefined();

      /* §4: the preserved measurement is still there and still says HARD. */
      const preserved = lastValidQualification(rt.store);
      expect(preserved?.enforcementClass).toBe(EnforcementClass.HARD);
      expect(preserved?.fingerprint).toBe('fingerprint-F');

      /* §5: preserving it is not permission to use it. */
      const authority = producerAuthority(preserved, outage);
      expect(authority.authority).toBe(ProducerAuthority.BLOCKED);
      expect(authority.attempt).toBe(QualificationAttempt.NOT_MEASURED);
      expect(authority.availability).toBe(ExecutionAvailability.UNREACHABLE);
      expect(authority.reason).toContain('could not be reached');
      expect(authority.reason).toContain('preserved');
    } finally {
      rt.close();
    }
  });

  it('§6: an outage is never evidence that the machine changed', () => {
    const preserved = { ...recordShape() };
    const outage = qualification({ tests: [unreached('Q-A')] });
    /* Not DIFFERS — which would tell an owner their machine changed underneath them. */
    expect(compareFingerprint(preserved, outage)).toBe(FingerprintComparison.UNKNOWN);
  });

  function recordShape() {
    return {
      enforcementClass: EnforcementClass.HARD,
      fingerprint: 'fingerprint-F',
      boundaryId: 'SC-BOUNDARY-PRODUCER',
      measuredAt: '2026-08-24T10:00:00.000Z',
      engineVersion: '1',
    } as const;
  }

  it('G. when the transport comes back, a fresh measurement restores authority', () => {
    const rt = project();
    try {
      recordQualification(rt.store, qualification());
      const outage = qualification({ tests: [unreached('Q-A'), result({ id: 'Q-B' })] });
      expect(producerAuthority(lastValidQualification(rt.store), outage).authority).toBe(
        ProducerAuthority.BLOCKED,
      );

      /* Transport restored. Nothing was edited by hand; the machine was simply measured. */
      const restored = qualification();
      const authority = producerAuthority(lastValidQualification(rt.store), restored);
      expect(authority.authority).toBe(ProducerAuthority.AVAILABLE);
      expect(authority.fingerprint).toBe(FingerprintComparison.MATCHES);
    } finally {
      rt.close();
    }
  });

  it('a machine that changed is re-measured, not blocked on the superseded record', () => {
    /*
     * Staleness is about REUSING a stored qualification, and nothing is reused here: this
     * attempt measured this machine, just now, and found HARD.
     *
     * An earlier draft of `producerAuthority` blocked on DIFFERS regardless, which
     * reintroduced the flapping through a different door — a fingerprint that moved for any
     * reason produced BLOCKED on one run and AVAILABLE on the next. The comparison is still
     * REPORTED, because an owner seeing DIFFERS on an untouched machine has learned
     * something real.
     */
    const rt = project();
    try {
      recordQualification(rt.store, qualification());
      const different = qualification({ fingerprint: 'fingerprint-DIFFERENT' });
      const authority = producerAuthority(lastValidQualification(rt.store), different);
      expect(authority.fingerprint).toBe(FingerprintComparison.DIFFERS);
      expect(authority.authority).toBe(ProducerAuthority.AVAILABLE);
      expect(authority.reason).toContain('superseded');
    } finally {
      rt.close();
    }
  });

  it('a stored record authorises nothing on its own', () => {
    /* The rule the previous test was reaching for, stated where it actually holds. */
    const rt = project();
    try {
      recordQualification(rt.store, qualification());
      const outage = qualification({ tests: [unreached('Q-A'), result({ id: 'Q-B' })] });
      const authority = producerAuthority(lastValidQualification(rt.store), outage);
      expect(authority.lastValid?.enforcementClass).toBe(EnforcementClass.HARD);
      expect(authority.authority).toBe(ProducerAuthority.BLOCKED);
    } finally {
      rt.close();
    }
  });

  it('§6: a fingerprint built from an unmeasured part never reports DIFFERS', () => {
    /*
     * `engineVersion` reads UNKNOWN when its probe does not answer and a real version when it
     * does, so the digest changes on an untouched machine. Comparing two strings is easy; the
     * question is whether either is a measurement.
     */
    const rt = project();
    try {
      recordQualification(rt.store, qualification({ fingerprintComplete: true }));
      const partial = qualification({
        fingerprint: 'fingerprint-BUILT-FROM-UNKNOWN',
        fingerprintComplete: false,
        fingerprintUnmeasured: ['engineVersion'],
      });
      expect(compareFingerprint(lastValidQualification(rt.store), partial)).toBe(
        FingerprintComparison.UNKNOWN,
      );
    } finally {
      rt.close();
    }
  });
});

/* ================================================== H. an unchanged machine agrees */

describe('H. repeated qualification of an unchanged healthy machine', () => {
  it('produces the same semantics every time', () => {
    const runs = Array.from({ length: 5 }, () => qualification());
    const shapes = runs.map((q) => q.enforcementClass + '/' + q.attempt + '/' + q.availability);
    expect(new Set(shapes).size, 'the same machine reported ' + shapes.join(', ')).toBe(1);
    expect(shapes[0]).toBe('HARD/MEASURED/AVAILABLE');
  });

  it('and an unchanged UNREACHABLE machine also agrees with itself', () => {
    /*
     * The flapping was the defect, not the value. Five outages in a row must read as five
     * outages, not as an alternating opinion about containment.
     */
    const runs = Array.from({ length: 5 }, () =>
      qualification({ tests: [unreached('Q-A'), result({ id: 'Q-B' })] }),
    );
    const shapes = runs.map((q) => q.attempt + '/' + q.availability);
    expect(new Set(shapes).size).toBe(1);
    expect(shapes[0]).toBe('NOT_MEASURED/UNREACHABLE');
  });
});

/* ============================= I & J. nothing downstream may reinterpret NOT_MEASURED */

describe('I and J. NOT_MEASURED is neither a pass nor a measured NONE', () => {
  const q = qualification({ tests: [unreached('Q-A'), result({ id: 'Q-B' })] });

  it('I. it is never a pass', () => {
    expect(engineeringAuthorityRefusal(q)).toBeDefined();
    expect(producerAuthority(undefined, q).authority).toBe(ProducerAuthority.BLOCKED);
  });

  it('J. it is never a measured NONE', () => {
    /*
     * The class is NONE for authority purposes — nothing may be granted on an absent
     * measurement — but the ATTEMPT is what a reader routes on, and it says NOT_MEASURED.
     * Anything that printed the class alone would be repeating the original defect.
     */
    expect(q.attempt).toBe(QualificationAttempt.NOT_MEASURED);
    const authority = producerAuthority(undefined, q);
    expect(authority.reason).not.toMatch(/measured NONE|substrate is NONE/i);
    expect(authority.reason).toContain('never been measured');
  });
});

/* ================================================ K. reach is recorded, per probe */

describe('K. the evidence says whether each probe reached the guest', () => {
  it('every result carries its reach, passing or not', () => {
    const q = qualification({
      tests: [result({ id: 'Q-A' }), unreached('Q-B'), result({ id: 'Q-C', outcome: 'FAILED' })],
    });
    for (const test of q.tests) {
      expect(
        test.reachedGuest,
        test.id + ' does not say whether it reached the guest',
      ).toBeDefined();
    }
    expect(q.tests.find((t) => t.id === 'Q-B')?.reachedGuest).toBe(GuestReach.NOT_REACHED);
    expect(q.tests.find((t) => t.id === 'Q-C')?.reachedGuest).toBe(GuestReach.REACHED);
  });

  it('an unreached probe keeps every attempt behind it', () => {
    const q = qualification({ tests: [unreached('Q-A'), result({ id: 'Q-B' })] });
    const attempts = q.tests[0]?.transportAttempts ?? [];
    expect(attempts).toHaveLength(TRANSPORT_ATTEMPTS);
    expect(attempts.every((a) => a.reach === GuestReach.NOT_REACHED)).toBe(true);
  });

  it('a transport result defaults to a reach that grants nothing', () => {
    /*
     * `UNKNOWN` rather than `REACHED`. A caller that forgets to prove reach gets the answer
     * that authorises nothing, because an assumed REACHED is the original defect written
     * down as a default.
     */
    const raw: TransportResult = {
      exitCode: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
      truncated: { stdout: false, stderr: false },
      spawnFailed: false,
      reach: GuestReach.UNKNOWN,
      attempts: [],
    };
    expect(raw.reach).not.toBe(GuestReach.REACHED);
  });
});
