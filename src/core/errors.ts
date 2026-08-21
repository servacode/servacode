/**
 * Structured, actionable errors.
 * 27 §6: no silent exception swallowing; every error names what failed and what to do.
 */

export type ServaErrorCode =
  | 'E_NOT_A_PROJECT'
  | 'E_PROJECT_EXISTS'
  | 'E_STORE_CORRUPT'
  | 'E_SCHEMA_VERSION'
  | 'E_VALIDATION'
  | 'E_IMMUTABLE_VIOLATION'
  | 'E_TRANSACTION'
  | 'E_NOT_FOUND'
  | 'E_CONFLICT'
  | 'E_INVALID_TRANSITION'
  | 'E_GATE_DEFINITION'
  | 'E_GATE_AUTHORITY'
  | 'E_CAPABILITY_NOT_ENABLED'
  | 'E_ENGINE'
  | 'E_CONTEXT_INSUFFICIENT'
  | 'E_MAPPING'
  | 'E_ISOLATION'
  | 'E_CONFIG'
  | 'E_UNSUPPORTED'
  | 'E_INTERNAL';

export interface ServaErrorOptions {
  readonly code: ServaErrorCode;
  readonly message: string;
  /** What the caller can do about it. Required: an error with no remedy is a dead end. */
  readonly remedy: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
  /** Specification clause this error enforces, where one exists. */
  readonly specRef?: string;
}

export class ServaError extends Error {
  readonly code: ServaErrorCode;
  readonly remedy: string;
  readonly details: Readonly<Record<string, unknown>>;
  readonly specRef: string | undefined;

  constructor(opts: ServaErrorOptions) {
    super(opts.message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'ServaError';
    this.code = opts.code;
    this.remedy = opts.remedy;
    this.details = Object.freeze({ ...(opts.details ?? {}) });
    this.specRef = opts.specRef;
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      remedy: this.remedy,
      details: this.details,
      specRef: this.specRef,
    };
  }

  /** Human-facing rendering for the CLI. */
  format(): string {
    const lines = [this.code + ': ' + this.message, '  remedy: ' + this.remedy];
    if (this.specRef !== undefined) lines.push('  spec:   ' + this.specRef);
    if (Object.keys(this.details).length > 0) {
      lines.push('  detail: ' + JSON.stringify(this.details));
    }
    return lines.join('\n');
  }
}

export function isServaError(e: unknown): e is ServaError {
  return e instanceof ServaError;
}

export function fail(opts: ServaErrorOptions): never {
  throw new ServaError(opts);
}
