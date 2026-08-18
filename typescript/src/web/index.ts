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

export interface UmamiTracker {
  track(): Promise<void>;
  track(eventName: string, data?: AnalyticsProperties): Promise<void>;
  track(
    transform: (properties: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<void>;
  identify(subjectId: string, data?: AnalyticsProperties): Promise<void>;
}

declare global {
  interface Window {
    umami?: UmamiTracker;
    [key: string]: unknown;
  }
}

export interface WebAnalyticsConfig extends AnalyticsConfig {
  domains?: string[];
  allowUtm?: boolean;
  performance?: boolean;
  autoTrack?: boolean;
  queueCapacity?: number;
  timeoutMs?: number;
  tracker?: UmamiTracker;
}

export class WebAnalyticsClient implements AnalyticsClient {
  private static readonly MAX_QUEUE_CAPACITY = 10_000;
  private readonly policy: PolicyEngine;
  private readonly queueCapacity: number;
  private consent: ConsentState;
  private tracker: UmamiTracker | undefined;
  private subjectId: string | undefined;
  private disabled = false;
  private queue: UmamiRequest[] = [];
  private loadPromise: Promise<void> | undefined;
  private activeFlush: Promise<void> | undefined;
  private drainScheduled = false;

  constructor(private readonly config: WebAnalyticsConfig) {
    this.policy = new PolicyEngine(config);
    const capacity = config.queueCapacity ?? 100;
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > WebAnalyticsClient.MAX_QUEUE_CAPACITY) {
      throw new RangeError(
        `queueCapacity must be an integer between 1 and ${WebAnalyticsClient.MAX_QUEUE_CAPACITY}`,
      );
    }
    const timeout = config.timeoutMs ?? 3000;
    if (!Number.isFinite(timeout) || timeout < 250 || timeout > 60_000) {
      throw new RangeError('timeoutMs must be between 250 and 60000');
    }
    const domains = config.domains ?? [];
    if (domains.length > 100) throw new RangeError('domains must contain at most 100 hostnames');
    for (const domain of domains) {
      if (!domain || domain.length > 253 || !/^[A-Za-z0-9.-]+$/.test(domain)) {
        throw new TypeError('domains contains an invalid hostname');
      }
    }
    this.queueCapacity = capacity;
    this.consent = config.initialConsent ?? 'unknown';
    this.tracker = config.tracker;
    if (this.consent === 'granted') this.enable();
  }

  track(eventName: string, properties: AnalyticsProperties = {}): TrackResult {
    if (!this.canAccept(eventName)) return this.stateRejection(eventName);
    try {
      const { request, eventId } = this.policy.createEventRequest(
        eventName,
        properties,
        this.subjectId,
      );
      this.enqueueOrSend(request, eventName);
      return accepted(eventId);
    } catch (error) {
      return rejected(this.config.onDiagnostic, error, eventName);
    }
  }

  identify(subjectId: string, properties: AnalyticsProperties = {}): TrackResult {
    if (!this.canAccept()) return this.stateRejection();
    try {
      const request = this.policy.createIdentifyRequest(subjectId, properties);
      this.subjectId = subjectId;
      this.enqueueOrSend(request);
      return accepted();
    } catch (error) {
      return rejected(this.config.onDiagnostic, error);
    }
  }

  page(properties: PageProperties = {}): TrackResult {
    if (!this.canAccept()) return this.stateRejection();
    try {
      const request = this.policy.createPageRequest(
        properties,
        this.subjectId,
        this.config.allowUtm,
      );
      this.enqueueOrSend(request);
      return accepted();
    } catch (error) {
      return rejected(this.config.onDiagnostic, error);
    }
  }

  setConsent(state: ConsentState): void {
    if (this.disabled) return;
    this.consent = state;
    if (state === 'granted') {
      this.enable();
      return;
    }
    this.queue = [];
    this.subjectId = undefined;
    this.setTrackerDisabled(true);
  }

  async flush(): Promise<void> {
    if (this.activeFlush) return this.activeFlush;
    if (!this.canAccept() || !this.tracker || this.queue.length === 0) return;
    const pending = this.queue;
    this.queue = [];
    this.activeFlush = Promise.all(pending.map(request => this.send(request)))
      .then(() => undefined)
      .finally(() => {
        this.activeFlush = undefined;
        if (this.queue.length > 0) this.scheduleDrain();
      });
    return this.activeFlush;
  }

  disable(): void {
    this.disabled = true;
    this.consent = 'withdrawn';
    this.queue = [];
    this.subjectId = undefined;
    this.setTrackerDisabled(true);
  }

  private enable(): void {
    this.setTrackerDisabled(false);
    if (this.tracker) {
      this.scheduleDrain();
      return;
    }
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    if (!this.loadPromise) {
      this.loadPromise = this.loadTracker()
        .catch(() => {
          emit(this.config.onDiagnostic, { code: 'tracker_load_failed' });
        })
        .finally(() => {
          if (!this.tracker) this.loadPromise = undefined;
        });
    }
  }

  private canAccept(eventName?: string): boolean {
    if (this.disabled) return false;
    if (this.consent !== 'granted') return false;
    return true;
  }

  private stateRejection(eventName?: string): TrackResult {
    const code = this.disabled ? 'disabled' : 'consent_not_granted';
    emit(this.config.onDiagnostic, { code, ...(eventName ? { eventName } : {}) });
    return { accepted: false, code };
  }

  private enqueueOrSend(request: UmamiRequest, eventName?: string): void {
    if (this.queue.length >= this.queueCapacity) {
      this.queue.shift();
      emit(this.config.onDiagnostic, {
        code: 'queue_full',
        ...(eventName ? { eventName } : {}),
      });
    }
    this.queue.push(request);
    this.enable();
    this.scheduleDrain();
  }

  private scheduleDrain(): void {
    if (this.drainScheduled || !this.tracker) return;
    this.drainScheduled = true;
    queueMicrotask(() => {
      this.drainScheduled = false;
      void this.flush();
    });
  }

  private async send(request: UmamiRequest): Promise<void> {
    const tracker = this.tracker;
    if (!tracker || !this.canAccept()) return;
    try {
      const operation = request.type === 'identify'
        ? tracker.identify(request.payload.id!, request.payload.data)
        : request.payload.name
          ? tracker.track(properties => ({
              ...properties,
              name: request.payload.name,
              data: request.payload.data,
              timestamp: request.payload.timestamp,
              ...(request.payload.id ? { id: request.payload.id } : {}),
            }))
          : tracker.track(properties => ({
              ...properties,
              url: request.payload.url,
              title: request.payload.title,
              ...(request.payload.id ? { id: request.payload.id } : {}),
            }));
      await this.withTimeout(operation);
    } catch {
      emit(this.config.onDiagnostic, { code: 'transport_retryable_failure' });
    }
  }

  private async withTimeout(operation: Promise<void>): Promise<void> {
    const timeoutMs = this.config.timeoutMs ?? 3000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        operation,
        new Promise<void>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('tracker_timeout')), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async loadTracker(): Promise<void> {
    if (window.umami) {
      this.tracker = window.umami;
      await this.flush();
      return;
    }
    const existing = document.querySelector<HTMLScriptElement>(
      'script[data-analytics-provider="pystone-umami"]',
    );
    if (existing) {
      await new Promise<void>((resolve, reject) => {
        existing.addEventListener('load', () => resolve(), { once: true });
        existing.addEventListener('error', () => reject(new Error('tracker_load_failed')), {
          once: true,
        });
      });
      this.tracker = window.umami;
      await this.flush();
      return;
    }

    const handlerName = `__pystoneUmamiBeforeSend_${this.config.websiteId.replaceAll('-', '_')}`;
    window[handlerName] = (type: string, payload: Record<string, unknown>) =>
      this.beforeSend(type, payload);

    const script = document.createElement('script');
    script.defer = true;
    script.src = `${this.policy.endpoint}/script.js`;
    script.dataset.analyticsProvider = 'pystone-umami';
    script.dataset.websiteId = this.config.websiteId;
    script.dataset.hostUrl = this.policy.endpoint;
    script.dataset.domains = (this.config.domains ?? [this.config.hostname]).join(',');
    script.dataset.excludeSearch = this.config.allowUtm ? 'false' : 'true';
    script.dataset.excludeHash = 'true';
    script.dataset.doNotTrack = 'true';
    script.dataset.autoTrack = this.config.autoTrack === false ? 'false' : 'true';
    script.dataset.beforeSend = handlerName;
    if (this.config.performance) script.dataset.performance = 'true';

    await new Promise<void>((resolve, reject) => {
      script.addEventListener('load', () => resolve(), { once: true });
      script.addEventListener('error', () => {
        script.remove();
        reject(new Error('tracker_load_failed'));
      }, { once: true });
      document.head.appendChild(script);
    });
    this.tracker = window.umami;
    await this.flush();
  }

  private beforeSend(type: string, payload: Record<string, unknown>): Record<string, unknown> | false {
    if (!this.canAccept()) return false;
    try {
      const rawData = payload.data;
      if (rawData && typeof rawData === 'object' && !Array.isArray(rawData)) {
        if (type === 'identify') {
          if (typeof payload.id !== 'string') return false;
          this.policy.validateSubjectId(payload.id);
          this.policy.validateSessionProperties(rawData as AnalyticsProperties);
        } else if (typeof payload.name === 'string') {
          this.policy.validateTrackerEvent(payload.name, rawData as AnalyticsProperties);
        } else {
          this.policy.validateRawProperties(rawData as AnalyticsProperties);
        }
      } else if (type === 'identify' || typeof payload.name === 'string') {
        return false;
      }
      const normalized = this.policy.normalizePage(
        {
          path: typeof payload.url === 'string' ? payload.url : '/',
          title: typeof payload.title === 'string' ? payload.title : '',
        },
        this.config.allowUtm,
      );
      payload.url = normalized.path;
      if (normalized.title) payload.title = normalized.title;
      return payload;
    } catch {
      return false;
    }
  }

  private setTrackerDisabled(value: boolean): void {
    try {
      if (typeof window === 'undefined') return;
      if (value) window.localStorage.setItem('umami.disabled', '1');
      else window.localStorage.removeItem('umami.disabled');
    } catch {
      // Storage can be unavailable in hardened browsers.
    }
  }
}

export function createWebAnalytics(config: WebAnalyticsConfig): WebAnalyticsClient {
  return new WebAnalyticsClient(config);
}
