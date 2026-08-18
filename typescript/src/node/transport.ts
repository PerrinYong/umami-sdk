import type { UmamiRequest } from '../core/index.js';

export type TransportResult =
  | { kind: 'success'; partialErrors?: number }
  | { kind: 'retryable'; retryAfterMs?: number }
  | { kind: 'permanent' };

export interface AnalyticsTransport {
  send(requests: UmamiRequest[]): Promise<TransportResult>;
  resetSession?(): void;
}

export interface UmamiHttpTransportConfig {
  endpoint: string;
  userAgent: string;
  timeoutMs: number;
  fetchImplementation?: typeof fetch;
}

export class UmamiHttpTransport implements AnalyticsTransport {
  private static readonly MAX_RESPONSE_BYTES = 64 * 1024;
  private cache: string | undefined;
  private sessionGeneration = 0;
  private readonly fetchImplementation: typeof fetch;

  constructor(private readonly config: UmamiHttpTransportConfig) {
    this.fetchImplementation = config.fetchImplementation ?? globalThis.fetch;
  }

  async send(requests: UmamiRequest[]): Promise<TransportResult> {
    if (requests.length === 0) return { kind: 'success' };
    const generation = this.sessionGeneration;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    timeout.unref?.();
    try {
      const response = await this.fetchImplementation(`${this.config.endpoint}/api/batch`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': this.config.userAgent,
          ...(this.cache ? { 'x-umami-cache': this.cache } : {}),
        },
        body: JSON.stringify(requests),
        signal: controller.signal,
      });
      if (response.ok) {
        const body = await this.readResponse(response);
        if (
          generation === this.sessionGeneration &&
          typeof body?.cache === 'string' &&
          /^[A-Za-z0-9_.-]{1,2048}$/.test(body.cache)
        ) {
          this.cache = body.cache;
        }
        const errors = body?.errors;
        const partialErrors = Number.isSafeInteger(errors) && (errors ?? 0) > 0
          ? errors
          : 0;
        return {
          kind: 'success',
          ...(partialErrors ? { partialErrors } : {}),
        };
      }
      if (response.status === 408 || response.status === 429 || response.status >= 500) {
        const retryAfter = response.headers.get('retry-after');
        const seconds = this.retryAfterSeconds(retryAfter);
        return {
          kind: 'retryable',
          ...(Number.isFinite(seconds) && seconds >= 0
            ? { retryAfterMs: Math.min(seconds * 1000, 60_000) }
            : {}),
        };
      }
      return { kind: 'permanent' };
    } catch {
      return { kind: 'retryable' };
    } finally {
      clearTimeout(timeout);
    }
  }

  resetSession(): void {
    this.sessionGeneration += 1;
    this.cache = undefined;
  }

  private async readResponse(response: Response): Promise<{ cache?: string; errors?: number } | null> {
    if (!response.body) return null;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > UmamiHttpTransport.MAX_RESPONSE_BYTES) {
          await reader.cancel().catch(() => undefined);
          return null;
        }
        chunks.push(value);
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const text = new TextDecoder().decode(bytes);
      if (!text) return null;
      const parsed = JSON.parse(text) as unknown;
      return parsed && typeof parsed === 'object'
        ? parsed as { cache?: string; errors?: number }
        : null;
    } catch {
      return null;
    }
  }

  private retryAfterSeconds(value: string | null): number {
    if (!value) return Number.NaN;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds;
    const date = Date.parse(value);
    return Number.isFinite(date) ? Math.max(0, (date - Date.now()) / 1000) : Number.NaN;
  }
}
