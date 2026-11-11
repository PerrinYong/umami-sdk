import assert from 'node:assert/strict';
import test from 'node:test';
import type { AnalyticsProperties } from '../core/index.js';
import { WebAnalyticsClient, type UmamiTracker } from '../web/index.js';
import { baseConfig } from './helpers.js';

class FakeTracker {
  readonly events: Array<Record<string, unknown>> = [];
  readonly identities: Array<{ id: string; data?: AnalyticsProperties }> = [];

  async track(
    input?: string | ((properties: Record<string, unknown>) => Record<string, unknown>),
    data?: AnalyticsProperties,
  ): Promise<void> {
    if (typeof input === 'function') this.events.push(input({ website: 'test' }));
    else this.events.push({ name: input, data });
  }

  async identify(id: string, data?: AnalyticsProperties): Promise<void> {
    this.identities.push({ id, ...(data ? { data } : {}) });
  }
}

test('access type reaches page and named-event tracker data without adding a page event', async () => {
  for (const accessType of ['manual', 'automated'] as const) {
    const tracker = new FakeTracker();
    const client = new WebAnalyticsClient({ ...baseConfig({ initialConsent: 'granted' }), accessType, tracker });
    assert.equal(client.page({ path: '/' }).accepted, true);
    assert.equal(client.track('contact_requested', { contact_type: 'email' }).accepted, true);
    await client.flush();
    assert.equal(tracker.events.length, 2);
    for (const event of tracker.events) assert.equal((event.data as AnalyticsProperties).access_type, accessType);
    const beforeSend = (client as unknown as { beforeSend: (type: string, payload: Record<string, unknown>) => unknown }).beforeSend.bind(client);
    for (const event of tracker.events) assert.notEqual(beforeSend('event', event), false);
    assert.equal(beforeSend('event', { url: '/', data: { access_type: 'anything' } }), false);
  }
});

test('web adapter maps validated events to the tracker', async () => {
  const tracker = new FakeTracker();
  const client = new WebAnalyticsClient({
    ...baseConfig({ initialConsent: 'granted' }),
    tracker: tracker as UmamiTracker,
  });
  const result = client.track('operation_completed', {
    feature: 'scan',
    duration_bucket: '1_3s',
  });
  assert.equal(result.accepted, true);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(tracker.events[0]?.name, 'operation_completed');
  assert.equal((tracker.events[0]?.data as AnalyticsProperties).product, 'test-product');
});

test('web adapter blocks sensitive values and clears on withdrawal', async () => {
  const tracker = new FakeTracker();
  const client = new WebAnalyticsClient({
    ...baseConfig({ initialConsent: 'granted' }),
    tracker: tracker as UmamiTracker,
  });
  assert.equal(client.track('feature_used', { feature: 'person@example.com' }).accepted, false);
  assert.equal(client.identify('valid_subject_id', { plan: 'free' }).accepted, true);
  client.setConsent('withdrawn');
  assert.equal(client.track('feature_used', { feature: 'scan' }).code, 'consent_not_granted');
  await client.flush();
});

test('web track returns before a blocked tracker is invoked', async () => {
  let calls = 0;
  let release: (() => void) | undefined;
  const blocked = new Promise<void>(resolve => {
    release = resolve;
  });
  const tracker: UmamiTracker = {
    track: async () => {
      calls += 1;
      await blocked;
    },
    identify: async () => undefined,
  };
  const client = new WebAnalyticsClient({
    ...baseConfig({ initialConsent: 'granted' }),
    tracker,
  });

  const result = client.track('feature_used', { feature: 'scan' });
  assert.equal(result.accepted, true);
  assert.equal(calls, 0);

  await new Promise<void>(resolve => queueMicrotask(() => resolve()));
  assert.equal(calls, 1);
  release?.();
  await client.flush();
});

test('beforeSend blocks direct tracker calls that bypass the SDK policy', async () => {
  const tracker = new FakeTracker();
  const client = new WebAnalyticsClient({
    ...baseConfig({ initialConsent: 'granted' }),
    tracker: tracker as UmamiTracker,
  });
  client.track('feature_used', { feature: 'scan' });
  await client.flush();
  const valid = tracker.events[0]!;
  const beforeSend = (client as unknown as {
    beforeSend: (type: string, payload: Record<string, unknown>) => Record<string, unknown> | false;
  }).beforeSend.bind(client);

  assert.notEqual(beforeSend('event', { ...valid }), false);
  assert.equal(beforeSend('event', { ...valid, name: 'unregistered_event' }), false);
  assert.equal(beforeSend('event', { name: 'feature_used', data: { feature: 'scan' } }), false);
  assert.notEqual(beforeSend('identify', { id: 'valid_subject_id', data: { plan: 'free' } }), false);
  assert.equal(
    beforeSend('identify', { id: 'valid_subject_id', data: { email: 'person@example.com' } }),
    false,
  );
});

test('tracker script failure is isolated and the next event retries loading', async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const tracker = new FakeTracker();
  const diagnostics: string[] = [];
  let appendCount = 0;
  const fakeWindow: Record<string, unknown> = {
    localStorage: {
      setItem: () => undefined,
      removeItem: () => undefined,
    },
  };
  const fakeDocument = {
    querySelector: () => null,
    createElement: () => {
      const listeners = new Map<string, () => void>();
      return {
        dataset: {} as Record<string, string>,
        addEventListener: (name: string, handler: () => void) => listeners.set(name, handler),
        remove: () => undefined,
        listeners,
      };
    },
    head: {
      appendChild: (script: { listeners: Map<string, () => void> }) => {
        appendCount += 1;
        queueMicrotask(() => {
          if (appendCount === 1) script.listeners.get('error')?.();
          else {
            fakeWindow.umami = tracker;
            script.listeners.get('load')?.();
          }
        });
      },
    },
  };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: fakeDocument });

  try {
    const client = new WebAnalyticsClient({
      ...baseConfig({ initialConsent: 'granted' }),
      onDiagnostic: diagnostic => diagnostics.push(diagnostic.code),
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.ok(diagnostics.includes('tracker_load_failed'));

    client.track('feature_used', { feature: 'scan' });
    await new Promise(resolve => setTimeout(resolve, 0));
    await client.flush();
    assert.equal(appendCount, 2);
    assert.equal(tracker.events.length, 1);
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});
