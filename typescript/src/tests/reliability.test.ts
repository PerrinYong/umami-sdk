import assert from 'node:assert/strict';
import test from 'node:test';
import type { UmamiRequest } from '../core/index.js';
import {
  NodeAnalyticsClient,
  UmamiHttpTransport,
  type AnalyticsTransport,
  type TransportResult,
} from '../node/index.js';
import { WebAnalyticsClient, type UmamiTracker } from '../web/index.js';
import { baseConfig } from './helpers.js';

const userAgent = 'Test/1.0 Analytics/0.1.0';

class ScriptedTransport implements AnalyticsTransport {
  readonly batches: UmamiRequest[][] = [];
  readonly results: Array<TransportResult | Error> = [];

  async send(requests: UmamiRequest[]): Promise<TransportResult> {
    this.batches.push(requests);
    const result = this.results.shift() ?? { kind: 'success' as const };
    if (result instanceof Error) throw result;
    return result;
  }
}

test('node queue remains bounded and a throwing diagnostic handler is isolated', async () => {
  const transport = new ScriptedTransport();
  const client = new NodeAnalyticsClient({
    ...baseConfig({ initialConsent: 'granted' }),
    userAgent,
    transport,
    queueCapacity: 3,
    flushIntervalMs: 60_000,
    onDiagnostic: () => {
      throw new Error('host diagnostic failed');
    },
  });

  for (let index = 0; index < 10_000; index += 1) {
    assert.equal(client.track('feature_used', { feature: `scan_${index}` }).accepted, true);
  }
  assert.equal(client.pendingCount, 3);
  await client.flush();
  assert.equal(transport.batches[0]?.length, 3);
  await client.close();
});

test('node handles thrown, permanent, retryable, exhausted and expired sends', async () => {
  const diagnostics: string[] = [];
  const transport = new ScriptedTransport();
  transport.results.push(
    new Error('network down'),
    { kind: 'retryable' },
    { kind: 'permanent' },
  );
  let now = 1_000;
  const client = new NodeAnalyticsClient({
    ...baseConfig({ initialConsent: 'granted' }),
    userAgent,
    transport,
    flushIntervalMs: 60_000,
    retryBaseMs: 100,
    maxRetries: 1,
    maxEventAgeMs: 1_000,
    now: () => now,
    random: () => Number.NaN,
    onDiagnostic: diagnostic => diagnostics.push(diagnostic.code),
  });

  client.track('feature_used', { feature: 'first' });
  await client.flush();
  now += 100;
  await client.flush();
  assert.equal(client.pendingCount, 0, 'retry exhaustion must drop the item');
  assert.ok(diagnostics.includes('retry_exhausted'));

  client.track('feature_used', { feature: 'permanent' });
  await client.flush();
  assert.equal(client.pendingCount, 0);
  assert.ok(diagnostics.includes('transport_permanent_failure'));

  client.track('feature_used', { feature: 'expired' });
  now += 1_001;
  await client.flush();
  assert.equal(client.pendingCount, 0);
  assert.ok(diagnostics.includes('event_expired'));
  await client.close();
});

test('unexpected retry calculation failures never reject flush or the host', async () => {
  const transport = new ScriptedTransport();
  transport.results.push({ kind: 'retryable' });
  const diagnostics: string[] = [];
  const client = new NodeAnalyticsClient({
    ...baseConfig({ initialConsent: 'granted' }),
    userAgent,
    transport,
    flushIntervalMs: 60_000,
    random: () => {
      throw new Error('entropy source failed');
    },
    onDiagnostic: diagnostic => diagnostics.push(diagnostic.detail ?? diagnostic.code),
  });
  client.track('feature_used', { feature: 'scan' });
  await assert.doesNotReject(client.flush());
  assert.equal(client.pendingCount, 1);
  assert.ok(diagnostics.includes('flush'));
  await client.close();
});

test('node transport timeout and close are bounded even when a custom transport never settles', async () => {
  const transport: AnalyticsTransport = {
    send: async () => await new Promise<TransportResult>(() => undefined),
  };
  const client = new NodeAnalyticsClient({
    ...baseConfig({ initialConsent: 'granted' }),
    userAgent,
    transport,
    timeoutMs: 250,
    flushIntervalMs: 60_000,
  });
  client.track('feature_used', { feature: 'scan' });

  const flushStarted = Date.now();
  await client.flush();
  assert.ok(Date.now() - flushStarted < 1_500, 'flush exceeded its transport deadline');
  assert.equal(client.pendingCount, 1);

  const closeStarted = Date.now();
  await client.close();
  assert.ok(Date.now() - closeStarted < 1_500, 'close exceeded its deadline');
  assert.equal(client.track('feature_used', { feature: 'scan' }).code, 'disabled');
});

test('node rejects reliability settings that could make resource use unbounded', () => {
  const make = (overrides: Record<string, unknown>) => new NodeAnalyticsClient({
    ...baseConfig(),
    userAgent,
    ...overrides,
  });
  assert.throws(() => make({ queueCapacity: Number.NaN }), RangeError);
  assert.throws(() => make({ queueCapacity: 10_001 }), RangeError);
  assert.throws(() => make({ batchSize: 0 }), RangeError);
  assert.throws(() => make({ maxRetries: Number.POSITIVE_INFINITY }), RangeError);
  assert.throws(() => make({ timeoutMs: 60_001 }), RangeError);
});

test('HTTP transport treats malformed success bodies as accepted and bounds cache state', async () => {
  const seenCache: Array<string | null> = [];
  const responses = [
    new Response('{"cache":"valid-cache","errors":0}', { status: 200 }),
    new Response('not-json', { status: 200 }),
    new Response('x'.repeat(65 * 1024), { status: 200 }),
  ];
  const fetchImplementation = (async (_input: unknown, init?: RequestInit) => {
    seenCache.push(new Headers(init?.headers).get('x-umami-cache'));
    return responses.shift()!;
  }) as typeof fetch;
  const transport = new UmamiHttpTransport({
    endpoint: 'https://umami.example.test',
    userAgent,
    timeoutMs: 250,
    fetchImplementation,
  });
  const request = { type: 'event', payload: { website: baseConfig().websiteId } } as UmamiRequest;

  assert.equal((await transport.send([request])).kind, 'success');
  assert.equal((await transport.send([request])).kind, 'success');
  transport.resetSession();
  assert.equal((await transport.send([request])).kind, 'success');
  assert.deepEqual(seenCache, [null, 'valid-cache', null]);
});

test('HTTP transport classifies retryable statuses and enforces its deadline', async () => {
  const statuses = [408, 429, 503, 400];
  const statusTransport = new UmamiHttpTransport({
    endpoint: 'https://umami.example.test',
    userAgent,
    timeoutMs: 250,
    fetchImplementation: (async () => new Response('', { status: statuses.shift()! })) as typeof fetch,
  });
  const request = { type: 'event', payload: { website: baseConfig().websiteId } } as UmamiRequest;
  assert.equal((await statusTransport.send([request])).kind, 'retryable');
  assert.equal((await statusTransport.send([request])).kind, 'retryable');
  assert.equal((await statusTransport.send([request])).kind, 'retryable');
  assert.equal((await statusTransport.send([request])).kind, 'permanent');

  const blockedTransport = new UmamiHttpTransport({
    endpoint: 'https://umami.example.test',
    userAgent,
    timeoutMs: 20,
    fetchImplementation: (async (_input: unknown, init?: RequestInit) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      })) as typeof fetch,
  });
  const started = Date.now();
  assert.equal((await blockedTransport.send([request])).kind, 'retryable');
  assert.ok(Date.now() - started < 1_000);
});

test('web queue is bounded, transport failures are swallowed, and configuration fails fast', async () => {
  let calls = 0;
  const tracker: UmamiTracker = {
    track: async () => {
      calls += 1;
      throw new Error('tracker unavailable');
    },
    identify: async () => {
      throw new Error('tracker unavailable');
    },
  };
  const client = new WebAnalyticsClient({
    ...baseConfig({ initialConsent: 'granted' }),
    tracker,
    queueCapacity: 3,
    timeoutMs: 250,
    onDiagnostic: () => {
      throw new Error('diagnostic unavailable');
    },
  });
  for (let index = 0; index < 20; index += 1) {
    assert.equal(client.track('feature_used', { feature: `scan_${index}` }).accepted, true);
  }
  await client.flush();
  assert.equal(calls, 3);
  client.disable();
  assert.equal(client.track('feature_used', { feature: 'scan' }).code, 'disabled');

  assert.throws(() => new WebAnalyticsClient({ ...baseConfig(), queueCapacity: Number.NaN }));
  assert.throws(() => new WebAnalyticsClient({ ...baseConfig(), timeoutMs: 60_001 }));
  assert.throws(() => new WebAnalyticsClient({ ...baseConfig(), domains: ['bad/domain'] }));
  assert.throws(() => new WebAnalyticsClient({ ...baseConfig(), domains: Array(101).fill('example.test') }));
});
