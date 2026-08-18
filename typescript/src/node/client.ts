import { randomUUID } from 'node:crypto';
import {
  accepted,
  emit,
  PolicyEngine,
  rejected,
  type AnalyticsClient,
  type AnalyticsConfig,
  type AnalyticsProperties,
  type ConsentState,
  type PageProperties,
  type TrackResult,
  type UmamiRequest,
} from '../core/index.js';
import {
  type AnalyticsTransport,
  type TransportResult,
  UmamiHttpTransport,
} from './transport.js';

interface QueueItem {
  id: string;
  request: UmamiRequest;
  createdAtMs: number;
  attempts: number;
  nextAttemptAtMs: number;
  eventName?: string;
}

export interface NodeAnalyticsConfig extends AnalyticsConfig {
  userAgent: string;
  queueCapacity?: number;
  batchSize?: number;
  flushIntervalMs?: number;
  timeoutMs?: number;
  maxRetries?: number;
  maxEventAgeMs?: number;
  retryBaseMs?: number;
  transport?: AnalyticsTransport;
  now?: () => number;
  random?: () => number;
}

export class NodeAnalyticsClient implements AnalyticsClient {
  private static readonly MAX_QUEUE_CAPACITY = 10_000;
  private static readonly MAX_RETRIES = 10;
  private readonly policy: PolicyEngine;
  private readonly transport: AnalyticsTransport;
  private readonly queueCapacity: number;
  private readonly batchSize: number;
  private readonly maxRetries: number;
  private readonly maxEventAgeMs: number;
  private readonly retryBaseMs: number;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly closeTimeoutMs: number;
  private consent: ConsentState;
  private subjectId: string | undefined;
  private disabled = false;
  private queue: QueueItem[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private activeFlush: Promise<void> | undefined;

  constructor(private readonly config: NodeAnalyticsConfig) {
    this.policy = new PolicyEngine(config);
    if (!config.userAgent.trim() || config.userAgent.length > 200 || /[\r\n]/.test(config.userAgent)) {
      throw new Error('userAgent is invalid');
    }
    this.queueCapacity = this.integerOption(
      'queueCapacity',
      config.queueCapacity ?? 1000,
      1,
      NodeAnalyticsClient.MAX_QUEUE_CAPACITY,
    );
    this.batchSize = this.integerOption('batchSize', config.batchSize ?? 25, 1, 100);
    this.maxRetries = this.integerOption(
      'maxRetries',
      config.maxRetries ?? 3,
      0,
      NodeAnalyticsClient.MAX_RETRIES,
    );
    this.maxEventAgeMs = this.numberOption(
      'maxEventAgeMs',
      config.maxEventAgeMs ?? 24 * 60 * 60 * 1000,
      1000,
    );
    this.retryBaseMs = this.numberOption('retryBaseMs', config.retryBaseMs ?? 500, 100);
    this.now = config.now ?? Date.now;
    this.random = config.random ?? Math.random;
    this.closeTimeoutMs = this.numberOption('timeoutMs', config.timeoutMs ?? 3000, 250, 60_000);
    this.consent = config.initialConsent ?? 'unknown';
    this.transport =
      config.transport ??
      new UmamiHttpTransport({
        endpoint: this.policy.endpoint,
        userAgent: config.userAgent,
        timeoutMs: Math.max(250, config.timeoutMs ?? 3000),
      });
    const interval = this.numberOption(
      'flushIntervalMs',
      config.flushIntervalMs ?? 5000,
      250,
      24 * 60 * 60 * 1000,
    );
    this.timer = setInterval(() => void this.flush(), interval);
    this.timer.unref?.();
  }

  track(eventName: string, properties: AnalyticsProperties = {}): TrackResult {
    if (!this.canAccept()) return this.stateRejection(eventName);
    try {
      const { request, eventId } = this.policy.createEventRequest(
        eventName,
        properties,
        this.subjectId,
      );
      this.enqueue(request, eventName, eventId);
      return accepted(eventId);
    } catch (error) {
      return rejected(this.config.onDiagnostic, error, eventName);
    }
  }

  identify(subjectId: string, properties: AnalyticsProperties = {}): TrackResult {
    if (!this.canAccept()) return this.stateRejection();
    try {
      const request = this.policy.createIdentifyRequest(subjectId, properties);
      if (this.subjectId && this.subjectId !== subjectId) {
        this.queue = [];
        this.resetTransportSession();
      }
      this.subjectId = subjectId;
      this.enqueue(request);
      return accepted();
    } catch (error) {
      return rejected(this.config.onDiagnostic, error);
    }
  }

  page(properties: PageProperties = {}): TrackResult {
    if (!this.canAccept()) return this.stateRejection();
    try {
      const request = this.policy.createPageRequest(properties, this.subjectId);
      this.enqueue(request);
      return accepted();
    } catch (error) {
      return rejected(this.config.onDiagnostic, error);
    }
  }

  setConsent(state: ConsentState): void {
    if (this.disabled) return;
    this.consent = state;
    if (state !== 'granted') {
      this.subjectId = undefined;
      this.queue = [];
      this.resetTransportSession();
    }
  }

  flush(): Promise<void> {
    if (this.activeFlush) return this.activeFlush;
    this.activeFlush = this.flushInternal()
      .catch(() => {
        emit(this.config.onDiagnostic, {
          code: 'transport_retryable_failure',
          detail: 'flush',
        });
      })
      .finally(() => {
        this.activeFlush = undefined;
      });
    return this.activeFlush;
  }

  disable(): void {
    this.disabled = true;
    this.consent = 'withdrawn';
    this.subjectId = undefined;
    this.queue = [];
    this.resetTransportSession();
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.flush(),
        new Promise<void>(resolve => {
          timeout = setTimeout(resolve, this.closeTimeoutMs);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
      this.disabled = true;
      this.consent = 'withdrawn';
      this.subjectId = undefined;
      this.queue = [];
      this.resetTransportSession();
    }
  }

  get pendingCount(): number {
    return this.queue.length;
  }

  private canAccept(): boolean {
    return !this.disabled && this.consent === 'granted';
  }

  private stateRejection(eventName?: string): TrackResult {
    const code = this.disabled ? 'disabled' : 'consent_not_granted';
    emit(this.config.onDiagnostic, { code, ...(eventName ? { eventName } : {}) });
    return { accepted: false, code };
  }

  private enqueue(request: UmamiRequest, eventName?: string, knownId?: string): void {
    if (this.queue.length >= this.queueCapacity) {
      this.queue.shift();
      emit(this.config.onDiagnostic, {
        code: 'queue_full',
        ...(eventName ? { eventName } : {}),
      });
    }
    const now = this.now();
    this.queue.push({
      id: knownId ?? randomUUID(),
      request,
      createdAtMs: now,
      attempts: 0,
      nextAttemptAtMs: now,
      ...(eventName ? { eventName } : {}),
    });
  }

  private async flushInternal(): Promise<void> {
    if (!this.canAccept()) return;
    while (this.canAccept()) {
      this.dropExpired();
      const now = this.now();
      const batch = this.queue
        .filter(item => item.nextAttemptAtMs <= now)
        .slice(0, this.batchSize);
      if (batch.length === 0) return;

      let result: TransportResult;
      try {
        result = await this.sendWithTimeout(batch.map(item => item.request));
      } catch {
        result = { kind: 'retryable' };
      }
      if (result.kind === 'success') {
        this.remove(batch);
        if (result.partialErrors) {
          emit(this.config.onDiagnostic, {
            code: 'transport_permanent_failure',
            detail: `partial:${result.partialErrors}`,
          });
        }
        continue;
      }
      if (result.kind === 'permanent') {
        this.remove(batch);
        emit(this.config.onDiagnostic, { code: 'transport_permanent_failure' });
        continue;
      }

      emit(this.config.onDiagnostic, { code: 'transport_retryable_failure' });
      for (const item of batch) {
        item.attempts += 1;
        if (item.attempts > this.maxRetries) {
          this.remove([item]);
          emit(this.config.onDiagnostic, {
            code: 'retry_exhausted',
            ...(item.eventName ? { eventName: item.eventName } : {}),
          });
          continue;
        }
        const exponential = this.retryBaseMs * 2 ** (item.attempts - 1);
        const random = this.random();
        const safeRandom = Number.isFinite(random) && random >= 0 && random <= 1 ? random : 0;
        const jitter = Math.floor(exponential * 0.25 * safeRandom);
        item.nextAttemptAtMs =
          now + Math.max(result.retryAfterMs ?? 0, exponential + jitter);
      }
      return;
    }
  }

  private dropExpired(): void {
    const cutoff = this.now() - this.maxEventAgeMs;
    const expired = this.queue.filter(item => item.createdAtMs < cutoff);
    if (expired.length === 0) return;
    this.remove(expired);
    for (const item of expired) {
      emit(this.config.onDiagnostic, {
        code: 'event_expired',
        ...(item.eventName ? { eventName: item.eventName } : {}),
      });
    }
  }

  private remove(items: QueueItem[]): void {
    const ids = new Set(items.map(item => item.id));
    this.queue = this.queue.filter(item => !ids.has(item.id));
  }

  private resetTransportSession(): void {
    try {
      this.transport.resetSession?.();
    } catch {
      emit(this.config.onDiagnostic, {
        code: 'transport_retryable_failure',
        detail: 'session_reset',
      });
    }
  }

  private async sendWithTimeout(requests: UmamiRequest[]): Promise<TransportResult> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(() => this.transport.send(requests)),
        new Promise<TransportResult>(resolve => {
          timeout = setTimeout(() => resolve({ kind: 'retryable' }), this.closeTimeoutMs);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private integerOption(name: string, value: number, minimum: number, maximum: number): number {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new RangeError(`${name} must be an integer between ${minimum} and ${maximum}`);
    }
    return value;
  }

  private numberOption(
    name: string,
    value: number,
    minimum: number,
    maximum = Number.MAX_SAFE_INTEGER,
  ): number {
    if (!Number.isFinite(value) || value < minimum || value > maximum) {
      throw new RangeError(`${name} must be between ${minimum} and ${maximum}`);
    }
    return value;
  }
}

export function createNodeAnalytics(config: NodeAnalyticsConfig): NodeAnalyticsClient {
  return new NodeAnalyticsClient(config);
}
