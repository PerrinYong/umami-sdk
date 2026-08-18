import type { Diagnostic, DiagnosticHandler, TrackResult } from './types.js';
import { PolicyViolation } from './policy.js';

export function emit(handler: DiagnosticHandler | undefined, diagnostic: Diagnostic): void {
  try {
    handler?.(diagnostic);
  } catch {
    // Diagnostics must never affect product behavior.
  }
}

export function rejected(
  handler: DiagnosticHandler | undefined,
  error: unknown,
  eventName?: string,
): TrackResult {
  const diagnostic =
    error instanceof PolicyViolation
      ? { ...error.diagnostic, ...(eventName ? { eventName } : {}) }
      : { code: 'invalid_property' as const, ...(eventName ? { eventName } : {}) };
  emit(handler, diagnostic);
  return { accepted: false, code: diagnostic.code };
}

export function accepted(eventId?: string): TrackResult {
  return {
    accepted: true,
    code: 'accepted',
    ...(eventId ? { eventId } : {}),
  };
}
