import { describe, expect, it } from 'vitest';
import { hostEscapeRan } from '../src/engineering/osQualification.js';

/**
 * A HOST ESCAPE THAT PRODUCED NO HOST OUTPUT DID NOT HAPPEN.
 *
 * SPEC: Phase 6 qualification transport invariant §6; LIVE-SERVA H1 diagnosis.
 *
 * `hostEscapeRunsUnsandboxed` decides whether the H1 probe is real containment evidence or an
 * environmental non-event, by running the escape command in the guest with no sandbox. Its
 * original test was `/EXIT=0\b/.test(out)` — and `EXIT=$?` reports the status of the SHELL,
 * not of the Windows binary.
 *
 * That gap is small and the direction it fails in is not: a command that never executed, in a
 * shell that exited 0, reads as "the host escape works". H1 is then attributed to the SANDBOX,
 * becomes a live probe whose containment nothing can decide, and the whole qualification stops
 * at SANDBOX_NOT_MEASURED. It fails closed, which is the correct direction — but a measurement
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
