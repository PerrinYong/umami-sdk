export type ConsentState = 'unknown' | 'granted' | 'denied' | 'withdrawn';
export type AnalyticsValue = string | number | boolean | null;
export type AnalyticsProperties = Record<string, AnalyticsValue>;
export type IdentityScope = 'session' | 'installation' | 'account';

export interface EventDefinition {
  version: number;
  purpose: string;
  identity_scope: IdentityScope;
  required: string[];
  optional: string[];
}

export interface EventRegistry {
  schema_version: number;
  events: Record<string, EventDefinition>;
}

export interface PrivacyPolicy {
  policy_version: number;
  limits: {
    event_name: number;
    property_count: number;
    property_name: number;
    string_value: number;
    number_absolute: number;
    number_decimal_places: number;
    subject_id: number;
    page_path: number;
    page_title: number;
  };
  common_properties: string[];
  session_properties: string[];
  forbidden_key_tokens: string[];
  sensitive_value_patterns: string[];
  allowed_url_query_keys: string[];
}

export interface AnalyticsContext {
  product: string;
  environment: string;
  surface: string;
  productVersion: string;
  sdkVersion?: string;
  platform?: string;
  architecture?: string;
  locale?: string;
  channel?: string;
  accessType?: 'manual' | 'automated';
  policyVersion?: number;
}

export interface AnalyticsConfig extends AnalyticsContext {
  endpoint: string;
  websiteId: string;
  hostname: string;
  initialConsent?: ConsentState;
  allowInsecureLocalhost?: boolean;
  onDiagnostic?: DiagnosticHandler;
}

export type DiagnosticCode =
  | 'accepted'
  | 'consent_not_granted'
  | 'disabled'
  | 'invalid_config'
  | 'invalid_event_name'
  | 'unregistered_event'
  | 'missing_property'
  | 'unknown_property'
  | 'invalid_property'
  | 'sensitive_key'
  | 'sensitive_value'
  | 'invalid_subject_id'
  | 'invalid_page'
  | 'queue_full'
  | 'event_expired'
  | 'retry_exhausted'
  | 'transport_permanent_failure'
  | 'transport_retryable_failure'
  | 'tracker_load_failed';

export interface Diagnostic {
  code: DiagnosticCode;
  eventName?: string;
  detail?: string;
}

export type DiagnosticHandler = (diagnostic: Diagnostic) => void;

export interface TrackResult {
  accepted: boolean;
  code: DiagnosticCode;
  eventId?: string;
}

export interface PageProperties {
  path?: string;
  title?: string;
}

export interface AnalyticsClient {
  track(eventName: string, properties?: AnalyticsProperties): TrackResult;
  identify(subjectId: string, properties?: AnalyticsProperties): TrackResult;
  page(properties?: PageProperties): TrackResult;
  setConsent(state: ConsentState): void;
  flush(): Promise<void>;
  disable(): void;
}

export interface UmamiPayload {
  website: string;
  hostname?: string;
  url?: string;
  title?: string;
  name?: string;
  id?: string;
  timestamp?: number;
  data?: AnalyticsProperties;
}

export interface UmamiRequest {
  type: 'event' | 'identify' | 'performance';
  payload: UmamiPayload;
}
