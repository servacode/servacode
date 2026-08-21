import { ServaRuntime } from '../../app/runtime.js';
import type { ParsedArgs } from '../main.js';

export function openRuntime(args: ParsedArgs): ServaRuntime {
  const root = args.flags['root'];
  return ServaRuntime.open({ ...(typeof root === 'string' ? { root } : {}) });
}

export function tryOpenRuntime(args: ParsedArgs): ServaRuntime | undefined {
  try {
    return openRuntime(args);
  } catch {
    return undefined;
  }
}

export function wantsJson(args: ParsedArgs): boolean {
  return args.flags['json'] === true || args.flags['json'] === 'true';
}

export function emitJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}
