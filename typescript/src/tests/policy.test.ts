import assert from 'node:assert/strict';
import test from 'node:test';
import { PolicyEngine, PolicyViolation } from '../core/index.js';
import { baseConfig } from './helpers.js';

test('builds a registered event with controlled context', () => {
  const policy = new PolicyEngine(baseConfig());
  const { request, eventId } = policy.createEventRequest('operation_completed', {
    feature: 'scan',
    duration_bucket: '1_3s',
  });
  assert.equal(request.type, 'event');
  assert.equal(request.payload.name, 'operation_completed');
  assert.equal(request.payload.data?.product, 'test-product');
  assert.equal(request.payload.data?.event_id, undefined);
  assert.match(eventId, /^[0-9a-f-]{36}$/);
});

test('rejects unregistered events and unknown properties', () => {
  const policy = new PolicyEngine(baseConfig());
  assert.throws(
    () => policy.createEventRequest('made_up_event', {}),
    (error: unknown) =>
      error instanceof PolicyViolation && error.diagnostic.code === 'unregistered_event',
  );
  assert.throws(
    () =>
      policy.createEventRequest('feature_used', {
        feature: 'scan',
        arbitrary: 'value',
      }),
    (error: unknown) =>
      error instanceof PolicyViolation && error.diagnostic.code === 'unknown_property',
  );
});

test('rejects missing, sensitive and high precision values', () => {
  const policy = new PolicyEngine(baseConfig());
  assert.throws(
    () => policy.createEventRequest('operation_failed', { feature: 'scan' }),
    (error: unknown) =>
      error instanceof PolicyViolation && error.diagnostic.code === 'missing_property',
  );
  assert.throws(
    () => policy.createEventRequest('feature_used', { feature: 'person@example.com' }),
    (error: unknown) =>
      error instanceof PolicyViolation && error.diagnostic.code === 'sensitive_value',
  );
  assert.throws(
    () => policy.createEventRequest('purchase_completed', { revenue: 1.12345, currency: 'USD' }),
    (error: unknown) =>
      error instanceof PolicyViolation && error.diagnostic.code === 'invalid_property',
  );
});

test('normalizes pages and keeps only allowlisted UTM parameters', () => {
  const policy = new PolicyEngine(baseConfig());
  const page = policy.normalizePage(
    {
      path: '/pricing?utm_source=newsletter&token=secret#account',
      title: 'Pricing',
    },
    true,
  );
  assert.equal(page.path, '/pricing?utm_source=newsletter');
  assert.equal(page.title, 'Pricing');
});

test('requires HTTPS except explicit localhost development', () => {
  assert.throws(() => new PolicyEngine(baseConfig({ endpoint: 'http://example.test' })));
  assert.doesNotThrow(
    () =>
      new PolicyEngine(
        baseConfig({ endpoint: 'http://localhost:3000', allowInsecureLocalhost: true }),
      ),
  );
});
