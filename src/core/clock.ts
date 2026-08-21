/**
 * Injectable clock.
 *
 * 27 NFR-1 requires the deterministic core to be a pure function of stored state.
 * Wall-clock time and randomness are the two impurities; both are injected so the
 * core is testable without patching globals.
 */

export interface Clock {
  /** ISO-8601 UTC, millisecond precision. */
  now(): string;
  /** Milliseconds since epoch. */
  epochMs(): number;
}

export const systemClock: Clock = {
  now: () => new Date().toISOString(),
  epochMs: () => Date.now(),
};

/** Deterministic clock for tests. Advances by a fixed step on each read. */
export class FixedClock implements Clock {
  private cursor: number;

  constructor(
    startIso = '2026-01-01T00:00:00.000Z',
    private readonly stepMs = 1,
  ) {
    this.cursor = Date.parse(startIso);
  }

  now(): string {
    const iso = new Date(this.cursor).toISOString();
    this.cursor += this.stepMs;
    return iso;
  }

  epochMs(): number {
    const v = this.cursor;
    this.cursor += this.stepMs;
    return v;
  }

  /** Jump forward without consuming a tick. Used to test time-based expiry. */
  advance(ms: number): void {
    this.cursor += ms;
  }

  peekIso(): string {
    return new Date(this.cursor).toISOString();
  }
}
