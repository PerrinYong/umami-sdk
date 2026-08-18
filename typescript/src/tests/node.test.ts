import assert from 'node:assert/strict';
import test from 'node:test';
import type { UmamiRequest } from '../core/index.js';
import {
  deriveInstallationSubjectId,
  deriveUserSubjectId,
  NodeAnalyticsClient,
  type AnalyticsTransport,
  type TransportResult,
} from '../node/index.js';
import { baseConfig } from './helpers.js';

class FakeTransport implements AnalyticsTransport {
  readonly batches: UmamiRequest[][] = [];
  readonly results: TransportResult[] = [];
  resets = 0;

  async send(requests: UmamiRequest[]): Promise<TransportResult> {
    this.batches.push(requests);
    return this.results.shift() ?? { kind: 'success' };
  }

  resetSession(): void {
    this.resets += 1;
  }
}

test('does not accept before consent and flushes after grant', async () => {
  const transport = new FakeTransport();
  const client = new NodeAnalyticsClient({
    ...baseConfig(),
    userAgent: 'Test/1.0 Analytics/0.1.1',
    transport,
    flushIntervalMs: 60_000,
  });
  assert.equal(client.track('feature_used', { feature: 'scan' }).code, 'consent_not_granted');
  client.setConsent('granted');
  assert.equal(client.track('feature_used', { feature: 'scan' }).accepted, true);
  assert.equal(client.pendingCount, 1);
  await client.flush();
  assert.equal(client.pendingCount, 0);
  assert.equal(transport.batches.length, 1);
  await client.close();
});

test('retries retryable transport results without blocking callers', async () => {
  const transport = new FakeTransport();
  transport.results.push({ kind: 'retryable' }, { kind: 'success' });
  let now = 1_000;
  const client = new NodeAnalyticsClient({
    ...baseConfig({ initialConsent: 'granted' }),
    userAgent: 'Test/1.0 Analytics/0.1.1',
    transport,
    flushIntervalMs: 60_000,
    retryBaseMs: 100,
    now: () => now,
    random: () => 0,
  });
  client.track('feature_used', { feature: 'scan' });
  await client.flush();
  assert.equal(client.pendingCount, 1);
  now += 100;
  await client.flush();
  assert.equal(client.pendingCount, 0);
  await client.close();
});

test('track only enqueues and never invokes a blocked transport inline', async () => {
  let sendCalled = false;
  const transport: AnalyticsTransport = {
    send: async () => {
      sendCalled = true;
      return await new Promise<TransportResult>(() => undefined);
    },
  };
  const client = new NodeAnalyticsClient({
    ...baseConfig({ initialConsent: 'granted' }),
    userAgent: 'Test/1.0 Analytics/0.1.1',
    transport,
    flushIntervalMs: 60_000,
  });

  const result = client.track('feature_used', { feature: 'scan' });
  assert.equal(result.accepted, true);
  assert.equal(sendCalled, false);
  assert.equal(client.pendingCount, 1);

  client.disable();
  await client.close();
});

test('withdrawal clears identity and queued events', async () => {
  const transport = new FakeTransport();
  const client = new NodeAnalyticsClient({
    ...baseConfig({ initialConsent: 'granted' }),
    userAgent: 'Test/1.0 Analytics/0.1.1',
    transport,
    flushIntervalMs: 60_000,
  });
  client.identify('valid_subject_id', { plan: 'free' });
  client.track('feature_used', { feature: 'scan' });
  assert.equal(client.pendingCount, 2);
  client.setConsent('withdrawn');
  assert.equal(client.pendingCount, 0);
  assert.equal(transport.resets, 1);
  assert.equal(client.track('feature_used', { feature: 'scan' }).accepted, false);
  await client.close();
});

test('subject switch drops the old queue and resets the Umami session cache', async () => {
  const transport = new FakeTransport();
  const client = new NodeAnalyticsClient({
    ...baseConfig({ initialConsent: 'granted' }),
    userAgent: 'Test/1.0 Analytics/0.1.1',
    transport,
    flushIntervalMs: 60_000,
  });
  client.identify('subject_a');
  client.track('feature_used', { feature: 'scan' });
  client.identify('subject_b');
  assert.equal(client.pendingCount, 1);
  assert.equal(transport.resets, 1);
  client.disable();
  await client.close();
});

test('identity derivation is deterministic, product-scoped and <= 50 characters', () => {
  const one = deriveInstallationSubjectId('product-a', 'installation');
  const two = deriveInstallationSubjectId('product-b', 'installation');
  assert.notEqual(one, two);
  assert.equal(one.length, 43);
  assert.equal(deriveUserSubjectId(Buffer.alloc(32, 1), 'user-1').length, 43);
});
