import { describe, expect, it } from 'vitest';
import {
  FIXTURE_NAMES,
  enumerationEvidence,
  filesystemTruth,
  hostEscapeRan,
  osProbesFor,
} from '../src/engineering/osQualification.js';

/**
 * A HOST ESCAPE THAT PRODUCED NO HOST OUTPUT DID NOT HAPPEN.
 *
 * SPEC: Phase 6 qualification transport invariant آ§6; LIVE-SERVA H1 diagnosis.
 *
 * `hostEscapeRunsUnsandboxed` decides whether the H1 probe is real containment evidence or an
 * environmental non-event, by running the escape command in the guest with no sandbox. Its
 * original test was `/EXIT=0\b/.test(out)` â€” and `EXIT=$?` reports the status of the SHELL,
 * not of the Windows binary.
 *
 * That gap is small and the direction it fails in is not: a command that never executed, in a
 * shell that exited 0, reads as "the host escape works". H1 is then attributed to the SANDBOX,
 * becomes a live probe whose containment nothing can decide, and the whole qualification stops
 * at SANDBOX_NOT_MEASURED. It fails closed, which is the correct direction â€” but a measurement
 * that reaches the right refusal for the wrong reason has not measured anything.
 *
 * So the escape must show its work: a zero status AND output that only the host could have
 * produced. Neither alone is enough.
 */

const VER_OUTPUT = 'Microsoft Windows [Version 10.0.26200.1234]';

describe('the host-escape baseline requires evidence the host actually ran something', () => {
  it('accepts a real escape: host output AND a zero status', () => {
    expect(hostEscapeRan(VER_OUTPUT + '\nEXIT=0\n')).toBe(true);
  });

  it('refuses a zero status with no host output at all', () => {
    /*
     * The measured case on this machine. With interop disabled the binary never executes;
     * depending on how the command is written the shell can still exit 0, and the old test
     * read that as a successful escape.
     */
    expect(hostEscapeRan('EXIT=0\n')).toBe(false);
  });

  it('refuses a not-found shell error that still exited zero', () => {
    expect(hostEscapeRan('sh: 1: cmd.exe: not found\nEXIT=0\n')).toBe(false);
  });

  it('refuses host output alongside a NON-zero status', () => {
    /* Partial output from a failed invocation is not a completed escape. */
    expect(hostEscapeRan(VER_OUTPUT + '\nEXIT=1\n')).toBe(false);
  });

  it('refuses the exact failing output this machine produces', () => {
    expect(hostEscapeRan('EXIT=1\n')).toBe(false);
  });

  it('refuses empty output', () => {
    expect(hostEscapeRan('')).toBe(false);
    expect(hostEscapeRan('   \n')).toBe(false);
  });

  it('does not mistake the word EXIT inside host output for the status line', () => {
    /* `EXIT=0` must be the probe's own trailer, not a substring of whatever the host printed. */
    expect(hostEscapeRan('some tool printed EXIT=0 in its banner\n')).toBe(false);
  });
});

describe('a containment probe is judged on the marker it actually reads', () => {
  /*
   * SPEC: finding ENGINEERING-HARD-BOUNDARY/F1 (HIGH), 1.0.1 security review.
   *
   * `filesystemTruth` fell through to `!output.includes(token(id))`, which assumes every probe
   * reads a marker named after itself. R6 reads `.serva/PROBE_MARKER.txt` â€” R2's file, whose
   * content is token('R2') â€” so the check looked for SERVA-PROBE-TOKEN-R6, a string that exists
   * nowhere in the fixture. It could never appear, so R6 was unconditionally "contained".
   *
   * A subprocess that genuinely read the Serva store and printed it would still have been
   * recorded as contained, and `measurementRefusal` gates HARD on these probes â€” so the probe
   * written to catch exactly that escape would have authorised a Producer while proving
   * nothing. A check that reads the wrong thing does not fail; it agrees.
   *
   * Asserted over EVERY marker-reading probe rather than over R6, because the defect was in
   * the rule and R6 was only where it surfaced.
   */
  const PROBES = osProbesFor({
    worktreeGuest: '/w',
    projectGuest: '/p',
    servaGuest: '/p/.serva',
    siblingGuest: '/s',
    workspacesGuest: '/ws',
    outsideGuest: '/out',
    guestHome: '/home/u',
    homeMarker: 'HOME_MARKER.txt',
  });

  /* What qualifyOsSandbox actually writes into each marker file. */
  const LEAK_OF = (body: string): string | undefined => {
    if (body.includes('PROBE_MARKER_R1.txt')) return 'SERVA-PROBE-TOKEN-R1';
    if (body.includes('PROBE_MARKER.txt')) return 'SERVA-PROBE-TOKEN-R2';
    return undefined;
  };

  const CTX = {
    worktree: '/w',
    projectRoot: '/p',
    outside: '/out',
    homeMarker: 'HOME_MARKER.txt',
  };

  it('every marker-reading probe reports an escape when its marker comes back', () => {
    const reading = PROBES.filter((probe) => LEAK_OF(probe.body) !== undefined);
    expect(reading.length, 'the fixture should contain marker-reading probes').toBeGreaterThan(0);

    for (const probe of reading) {
      const leaked = String(LEAK_OF(probe.body));
      const [truth] = filesystemTruth(probe, 'output: ' + leaked, CTX);
      expect(truth, probe.id + ' returned ' + leaked + ' and still reported contained').toBe(false);
    }
  });

  it('R6 specifically, since that is where it surfaced', () => {
    /*
     * R6 reads R2's marker. Before the fix this returned true â€” contained â€” for output that
     * plainly carried the store's contents.
     */
    const r6 = PROBES.find((probe) => probe.id === 'R6');
    expect(r6, 'R6 must exist in the probe set').toBeDefined();

    const [truth] = filesystemTruth(r6!, 'SERVA-PROBE-TOKEN-R2', CTX);
    expect(truth).toBe(false);
  });

  it('and still reports contained when nothing leaked', () => {
    /* The fix must not make every probe fail: silence is still containment. */
    for (const probe of PROBES.filter((x) => LEAK_OF(x.body) !== undefined)) {
      const [truth] = filesystemTruth(probe, 'cat: permission denied', CTX);
      expect(truth, probe.id).toBe(true);
    }
  });
});

describe('an enumeration probe is judged against a name the fixture creates', () => {
  /*
   * SPEC: finding ENGINEERING-HARD-BOUNDARY/EHB-1 (MEDIUM), 1.0.1 security review.
   *
   * R8 ("enumerate the primary checkout") was judged by `!output.includes('total.js')`, and
   * 'total.js' is written nowhere in this module â€” it appeared exactly once, inside the check
   * itself. The expression was therefore always true, so R8 reported contained whatever the
   * sandbox did, and `measurementRefusal` counted that toward certifying HARD.
   *
   * Second instance of one cause: R6 searched for a token the file it read never contained.
   * Both times the check and the fixture named the same artefact in different places and
   * nothing made them agree. FIXTURE_NAMES is now the single place, and this asserts the
   * binding rather than the two names that happened to be reported.
   */
  const PROBES = osProbesFor({
    worktreeGuest: '/w',
    projectGuest: '/p',
    servaGuest: '/p/.serva',
    siblingGuest: '/ws/SC-WI-000900' + FIXTURE_NAMES.siblingSuffix,
    workspacesGuest: '/ws',
    outsideGuest: '/out',
    guestHome: '/home/u',
    homeMarker: FIXTURE_NAMES.homeMarker,
  });

  const CTX = {
    worktree: '/w',
    projectRoot: '/p',
    outside: '/out',
    homeMarker: FIXTURE_NAMES.homeMarker,
  };

  /**
   * Every CONTAINMENT probe whose command is a directory listing.
   *
   * `expect: 'REFUSE'` is the qualifier that matters. P6 also runs `ls -la`, but on the
   * attempt's own worktree, which it is supposed to see — it is a positive control, and it
   * correctly has no containment evidence bound to it. A first version of this test filtered
   * on the command alone and demanded evidence for P6, which would have meant inventing a leak
   * for a listing that is allowed to succeed.
   */
  const ENUMERATORS = PROBES.filter(
    (probe) => probe.expect === 'REFUSE' && /\bls\b/.test(probe.body),
  );

  it('every enumeration probe has evidence bound to it', () => {
    expect(ENUMERATORS.length, 'the fixture should contain enumeration probes').toBeGreaterThan(0);
    for (const probe of ENUMERATORS) {
      expect(
        enumerationEvidence(probe.id),
        probe.id + ' enumerates but has no bound evidence, so it cannot detect a leak',
      ).toBeDefined();
    }
  });

  it('each bound name is one the fixture actually creates', () => {
    /*
     * The defect in one line: a name nothing writes can never appear, so the probe agrees
     * forever. Every bound name must be a real artefact of the fixture.
     */
    const created: Set<string> = new Set(Object.values(FIXTURE_NAMES));
    for (const probe of ENUMERATORS) {
      const evidence = String(enumerationEvidence(probe.id));
      expect(
        created.has(evidence),
        probe.id + ' is judged against "' + evidence + '", which the fixture never creates',
      ).toBe(true);
    }
  });

  it('an enumeration probe reports an escape when its evidence comes back', () => {
    for (const probe of ENUMERATORS) {
      const leaked = String(enumerationEvidence(probe.id));
      const [truth] = filesystemTruth(probe, 'total 12\ndrwxr-xr-x  ' + leaked, CTX);
      expect(truth, probe.id + ' listed ' + leaked + ' and still reported contained').toBe(false);
    }
  });

  it('R8 specifically, since that is where it surfaced', () => {
    const r8 = PROBES.find((probe) => probe.id === 'R8');
    expect(r8, 'R8 must exist').toBeDefined();
    const [truth] = filesystemTruth(
      r8!,
      'total 4\n-rw-r--r-- ' + FIXTURE_NAMES.checkoutMarker,
      CTX,
    );
    expect(truth).toBe(false);
  });

  it('and still reports contained when the listing was refused', () => {
    for (const probe of ENUMERATORS) {
      const [truth] = filesystemTruth(probe, 'ls: cannot open directory: Permission denied', CTX);
      expect(truth, probe.id).toBe(true);
    }
  });
});
