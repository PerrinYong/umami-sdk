import type { AnalyticsConfig } from '../core/index.js';

export function baseConfig(overrides: Partial<AnalyticsConfig> = {}): AnalyticsConfig {
  return {
    endpoint: 'https://umami.example.test',
    websiteId: '123e4567-e89b-42d3-a456-426614174000',
    hostname: 'product.example.test',
    product: 'test-product',
    environment: 'staging',
    surface: 'test',
    productVersion: '1.0.0',
    sdkVersion: '0.1.0',
    ...overrides,
  };
}
