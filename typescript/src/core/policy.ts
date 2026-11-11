import { EVENT_REGISTRY_JSON, PRIVACY_POLICY_JSON } from './generated-policy.js';
import type {
  AnalyticsConfig,
  AnalyticsProperties,
  AnalyticsValue,
  Diagnostic,
  EventDefinition,
  EventRegistry,
  PageProperties,
  PrivacyPolicy,
  UmamiRequest,
} from './types.js';

const EVENT_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;
const PROPERTY_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;
const SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
const CONTEXT_VALUE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const HOSTNAME_PATTERN = /^[A-Za-z0-9.-]+$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SUBJECT_PATTERN = /^[A-Za-z0-9_-]+$/;
const CONSENT_STATES = new Set(['unknown', 'granted', 'denied', 'withdrawn']);

export class PolicyViolation extends Error {
  constructor(
    public readonly diagnostic: Diagnostic,
  ) {
    super(diagnostic.code);
  }
}

function compileSensitivePattern(source: string): RegExp {
  if (source.startsWith('(?i)')) {
    return new RegExp(source.slice(4), 'i');
  }
  return new RegExp(source);
}

function decimalPlaces(value: number): number {
  if (!Number.isFinite(value)) return Number.POSITIVE_INFINITY;
  const text = value.toString().toLowerCase();
  if (text.includes('e-')) {
    const [coefficient, exponentText] = text.split('e-');
    return Number(exponentText) + (coefficient?.split('.')[1]?.length ?? 0);
  }
  return text.split('.')[1]?.length ?? 0;
}

function createEventId(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export class PolicyEngine {
  readonly registry: EventRegistry;
  readonly policy: PrivacyPolicy;
  readonly endpoint: string;
  private readonly sensitivePatterns: RegExp[];
  private readonly forbiddenTokens: Set<string>;
  private readonly sessionProperties: Set<string>;

  constructor(public readonly config: AnalyticsConfig) {
    this.registry = JSON.parse(EVENT_REGISTRY_JSON) as EventRegistry;
    this.policy = JSON.parse(PRIVACY_POLICY_JSON) as PrivacyPolicy;
    this.sensitivePatterns = this.policy.sensitive_value_patterns.map(compileSensitivePattern);
    this.forbiddenTokens = new Set(this.policy.forbidden_key_tokens);
    this.sessionProperties = new Set(this.policy.session_properties);
    this.endpoint = this.validateConfig(config);
  }

  private validateConfig(config: AnalyticsConfig): string {
    let endpoint: URL;
    try {
      endpoint = new URL(config.endpoint);
    } catch {
      throw new PolicyViolation({ code: 'invalid_config', detail: 'endpoint' });
    }
    const insecureLocalhost =
      config.allowInsecureLocalhost === true &&
      endpoint.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '::1'].includes(endpoint.hostname);
    if (endpoint.protocol !== 'https:' && !insecureLocalhost) {
      throw new PolicyViolation({ code: 'invalid_config', detail: 'endpoint_protocol' });
    }
    if (
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash ||
      (endpoint.pathname !== '/' && endpoint.pathname !== '')
    ) {
      throw new PolicyViolation({ code: 'invalid_config', detail: 'endpoint_shape' });
    }
    if (!UUID_PATTERN.test(config.websiteId)) {
      throw new PolicyViolation({ code: 'invalid_config', detail: 'website_id' });
    }
    if (config.initialConsent !== undefined && !CONSENT_STATES.has(config.initialConsent)) {
      throw new PolicyViolation({ code: 'invalid_config', detail: 'initial_consent' });
    }
    for (const [key, value] of [
      ['product', config.product],
      ['environment', config.environment],
      ['surface', config.surface],
    ] as const) {
      if (!SLUG_PATTERN.test(value) || value.length > 64) {
        throw new PolicyViolation({ code: 'invalid_config', detail: key });
      }
    }
    if (
      !config.hostname ||
      config.hostname.length > 253 ||
      !HOSTNAME_PATTERN.test(config.hostname)
    ) {
      throw new PolicyViolation({ code: 'invalid_config', detail: 'hostname' });
    }
    for (const [key, value] of [
      ['product_version', config.productVersion],
      ['sdk_version', config.sdkVersion ?? '0.1.1'],
      ['platform', config.platform],
      ['architecture', config.architecture],
      ['locale', config.locale],
      ['channel', config.channel],
    ] as const) {
      if (value !== undefined && (!CONTEXT_VALUE_PATTERN.test(value) || value.length > 64)) {
        throw new PolicyViolation({ code: 'invalid_config', detail: key });
      }
    }
    if (
      config.policyVersion !== undefined &&
      config.policyVersion !== this.policy.policy_version
    ) {
      throw new PolicyViolation({ code: 'invalid_config', detail: 'policy_version' });
    }
    if (config.accessType !== undefined && !['manual', 'automated'].includes(config.accessType)) {
      throw new PolicyViolation({ code: 'invalid_config', detail: 'access_type' });
    }
    return endpoint.origin;
  }

  validateEvent(eventName: string, properties: AnalyticsProperties = {}): EventDefinition {
    if (
      !EVENT_NAME_PATTERN.test(eventName) ||
      eventName.length > this.policy.limits.event_name
    ) {
      throw new PolicyViolation({ code: 'invalid_event_name', eventName });
    }
    const definition = this.registry.events[eventName];
    if (!definition) {
      throw new PolicyViolation({ code: 'unregistered_event', eventName });
    }
    const allowed = new Set([...definition.required, ...definition.optional]);
    for (const required of definition.required) {
      if (!(required in properties)) {
        throw new PolicyViolation({ code: 'missing_property', eventName, detail: required });
      }
    }
    this.validateProperties(properties, allowed, eventName);
    return definition;
  }

  validateSessionProperties(properties: AnalyticsProperties = {}): void {
    this.validateProperties(properties, this.sessionProperties);
  }

  validateRawProperties(properties: AnalyticsProperties = {}): void {
    const keys = Object.keys(properties);
    if (keys.length > this.policy.limits.property_count) {
      throw new PolicyViolation({ code: 'invalid_property', detail: 'property_count' });
    }
    for (const [key, value] of Object.entries(properties)) {
      this.validateKey(key);
      this.validateValue(key, value);
    }
  }

  validateTrackerEvent(eventName: string, data: AnalyticsProperties): void {
    if (!EVENT_NAME_PATTERN.test(eventName) || eventName.length > this.policy.limits.event_name) {
      throw new PolicyViolation({ code: 'invalid_event_name', eventName });
    }
    const definition = this.registry.events[eventName];
    if (!definition) throw new PolicyViolation({ code: 'unregistered_event', eventName });
    this.validateRawProperties(data);

    const eventKeys = new Set([...definition.required, ...definition.optional]);
    const expectedCommon: AnalyticsProperties = {
      event_version: definition.version,
      product: this.config.product,
      environment: this.config.environment,
      surface: this.config.surface,
      product_version: this.config.productVersion,
      sdk_version: this.config.sdkVersion ?? '0.1.1',
      consent_state: 'granted',
      policy_version: this.policy.policy_version,
      ...this.optionalContext(),
    };
    for (const [key, value] of Object.entries(expectedCommon)) {
      if (!eventKeys.has(key) && data[key] !== value) {
        throw new PolicyViolation({ code: 'invalid_property', eventName, detail: key });
      }
    }

    const common = new Set(this.policy.common_properties);
    const eventData: AnalyticsProperties = {};
    for (const [key, value] of Object.entries(data)) {
      if (eventKeys.has(key)) eventData[key] = value;
      else if (!common.has(key)) {
        throw new PolicyViolation({ code: 'unknown_property', eventName, detail: key });
      } else if (!(key in expectedCommon)) {
        throw new PolicyViolation({ code: 'invalid_property', eventName, detail: key });
      }
    }
    this.validateEvent(eventName, eventData);
  }

  validateSubjectId(subjectId: string): void {
    if (
      !subjectId ||
      subjectId.length > this.policy.limits.subject_id ||
      !SUBJECT_PATTERN.test(subjectId) ||
      this.containsSensitiveValue(subjectId)
    ) {
      throw new PolicyViolation({ code: 'invalid_subject_id' });
    }
  }

  normalizePage(page: PageProperties = {}, allowUtm = false): Required<PageProperties> {
    const input = page.path ?? '/';
    let parsed: URL;
    try {
      parsed = new URL(input, 'https://analytics.invalid');
    } catch {
      throw new PolicyViolation({ code: 'invalid_page', detail: 'path' });
    }
    const query = new URLSearchParams();
    if (allowUtm) {
      for (const key of this.policy.allowed_url_query_keys) {
        const value = parsed.searchParams.get(key);
        if (value && value.length <= 100 && !this.containsSensitiveValue(value)) {
          query.set(key, value);
        }
      }
    }
    const path = `${parsed.pathname}${query.size ? `?${query}` : ''}`;
    if (path.length > this.policy.limits.page_path) {
      throw new PolicyViolation({ code: 'invalid_page', detail: 'path_length' });
    }
    const title = page.title ?? '';
    if (
      title.length > this.policy.limits.page_title ||
      this.containsSensitiveValue(title)
    ) {
      throw new PolicyViolation({ code: 'invalid_page', detail: 'title' });
    }
    return { path, title };
  }

  createEventRequest(
    eventName: string,
    properties: AnalyticsProperties,
    subjectId?: string,
    occurredAt = new Date(),
  ): { request: UmamiRequest; eventId: string } {
    const definition = this.validateEvent(eventName, properties);
    if (subjectId) this.validateSubjectId(subjectId);
    const eventId = createEventId();
    const data: AnalyticsProperties = {
      event_version: definition.version,
      product: this.config.product,
      environment: this.config.environment,
      surface: this.config.surface,
      product_version: this.config.productVersion,
      sdk_version: this.config.sdkVersion ?? '0.1.1',
      consent_state: 'granted',
      policy_version: this.policy.policy_version,
      ...this.optionalContext(),
      ...properties,
    };
    if (Object.keys(data).length > this.policy.limits.property_count) {
      throw new PolicyViolation({
        code: 'invalid_property',
        ...(eventName ? { eventName } : {}),
        detail: 'property_count',
      });
    }
    return {
      eventId,
      request: {
        type: 'event',
        payload: {
          website: this.config.websiteId,
          hostname: this.config.hostname,
          url: `/events/${eventName}`,
          name: eventName,
          ...(subjectId ? { id: subjectId } : {}),
          timestamp: Math.floor(occurredAt.getTime() / 1000),
          data,
        },
      },
    };
  }

  createIdentifyRequest(subjectId: string, properties: AnalyticsProperties): UmamiRequest {
    this.validateSubjectId(subjectId);
    this.validateSessionProperties(properties);
    return {
      type: 'identify',
      payload: {
        website: this.config.websiteId,
        id: subjectId,
        data: properties,
      },
    };
  }

  createPageRequest(page: PageProperties, subjectId?: string, allowUtm = false): UmamiRequest {
    if (subjectId) this.validateSubjectId(subjectId);
    const normalized = this.normalizePage(page, allowUtm);
    return {
      type: 'event',
      payload: {
        website: this.config.websiteId,
        hostname: this.config.hostname,
        url: normalized.path,
        ...(this.config.accessType ? { data: { access_type: this.config.accessType } } : {}),
        ...(normalized.title ? { title: normalized.title } : {}),
        ...(subjectId ? { id: subjectId } : {}),
      },
    };
  }

  private optionalContext(): AnalyticsProperties {
    const result: AnalyticsProperties = {};
    for (const [key, value] of [
      ['platform', this.config.platform],
      ['architecture', this.config.architecture],
      ['locale', this.config.locale],
      ['channel', this.config.channel],
      ['access_type', this.config.accessType],
    ] as const) {
      if (value !== undefined && value !== '') result[key] = value;
    }
    return result;
  }

  private validateProperties(
    properties: AnalyticsProperties,
    allowed: Set<string>,
    eventName?: string,
  ): void {
    if (Object.keys(properties).length > this.policy.limits.property_count) {
      throw new PolicyViolation({
        code: 'invalid_property',
        ...(eventName ? { eventName } : {}),
        detail: 'property_count',
      });
    }
    for (const [key, value] of Object.entries(properties)) {
      if (!allowed.has(key)) {
        throw new PolicyViolation({
          code: 'unknown_property',
          ...(eventName ? { eventName } : {}),
          detail: key,
        });
      }
      this.validateKey(key, eventName);
      this.validateValue(key, value, eventName);
    }
  }

  private validateKey(key: string, eventName?: string): void {
    if (!PROPERTY_NAME_PATTERN.test(key) || key.length > this.policy.limits.property_name) {
      throw new PolicyViolation({
        code: 'invalid_property',
        ...(eventName ? { eventName } : {}),
        detail: key,
      });
    }
    const tokens = key.toLowerCase().split(/[_\-.]+/);
    if (this.forbiddenTokens.has(key.toLowerCase()) || tokens.some(token => this.forbiddenTokens.has(token))) {
      throw new PolicyViolation({
        code: 'sensitive_key',
        ...(eventName ? { eventName } : {}),
        detail: key,
      });
    }
  }

  private validateValue(key: string, value: AnalyticsValue, eventName?: string): void {
    if (key === 'access_type' && value !== 'manual' && value !== 'automated') {
      throw new PolicyViolation({ code: 'invalid_property', detail: key });
    }
    if (value === null || typeof value === 'boolean') return;
    if (typeof value === 'number') {
      if (
        !Number.isFinite(value) ||
        Math.abs(value) > this.policy.limits.number_absolute ||
        decimalPlaces(value) > this.policy.limits.number_decimal_places
      ) {
        throw new PolicyViolation({
          code: 'invalid_property',
          ...(eventName ? { eventName } : {}),
          detail: key,
        });
      }
      return;
    }
    if (typeof value !== 'string' || value.length > this.policy.limits.string_value) {
      throw new PolicyViolation({
        code: 'invalid_property',
        ...(eventName ? { eventName } : {}),
        detail: key,
      });
    }
    if (this.containsSensitiveValue(value)) {
      throw new PolicyViolation({
        code: 'sensitive_value',
        ...(eventName ? { eventName } : {}),
        detail: key,
      });
    }
  }

  private containsSensitiveValue(value: string): boolean {
    return this.sensitivePatterns.some(pattern => pattern.test(value));
  }
}
