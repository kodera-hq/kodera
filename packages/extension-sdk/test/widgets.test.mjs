import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ALLOWED_EXTENSION_SCOPES,
  EXTENSION_EVENTS,
  ExtensionSdkError,
  MAX_WIDGET_CARD_BYTES,
  WIDGET_SCHEMA_VERSION,
  createExtensionTestHarness,
  defineWidgetCard,
  validateManifest,
  validateWidgetCard,
} from '../src/index.mjs';

test('extension scopes and events include widgets:write and widget.action', () => {
  assert.ok(ALLOWED_EXTENSION_SCOPES.includes('widgets:write'));
  assert.ok(EXTENSION_EVENTS.includes('widget.action'));
});

test('validateManifest validates widgets declarations and enforces widgets:write scope', () => {
  const valid = validateManifest({
    schemaVersion: 'kodera.extension.v1',
    id: 'release-readiness',
    name: 'Release Readiness Card',
    version: '0.2.0',
    description: 'Reference implementation: release status widget card.',
    scopes: ['messages:write', 'webhooks:incoming', 'widgets:write'],
    events: ['widget.action'],
    webhookUrl: 'https://extensions.example.invalid/hooks/release-readiness',
    commands: [],
    widgets: [
      {
        id: 'readiness-card',
        title: 'Readiness Summary',
        description: 'Tracks deployment gate progress',
      },
    ],
  });
  assert.equal(valid.widgets.length, 1);
  assert.equal(valid.widgets[0].id, 'readiness-card');

  assert.throws(
    () =>
      validateManifest({
        schemaVersion: 'kodera.extension.v1',
        id: 'missing-scope',
        name: 'Missing Scope',
        version: '0.2.0',
        description: 'Reference implementation: missing widgets:write.',
        scopes: ['messages:write'],
        events: ['widget.action'],
        widgets: [{ id: 'some-card', title: 'Some Card' }],
      }),
    (err) => err instanceof ExtensionSdkError && err.code === 'INVALID_MANIFEST_WIDGETS'
  );
});

test('defineWidgetCard and validateWidgetCard accept all closed kodera.widget.v1 block types', () => {
  const card = defineWidgetCard({
    widgetId: 'deploy-gate-card',
    title: 'Deploy Gate',
    blocks: [
      { type: 'header', title: 'Release 2026.11', subtitle: 'Staging smoke checks' },
      { type: 'text', body: 'All preflight gates passed without warnings.', tone: 'muted' },
      {
        type: 'kv_list',
        items: [
          { label: 'Commit', value: 'e1bd898e', mono: true },
          { label: 'Region', value: 'fr-par-1' },
        ],
      },
      { type: 'status_pill', label: 'Ready to promote', state: 'success' },
      { type: 'progress_bar', label: 'Canary rollout', value: 75, valueText: '75%', tone: 'success' },
      {
        type: 'button_row',
        actions: [
          { actionId: 'promote', label: 'Promote', variant: 'primary', value: 'prod' },
          { actionId: 'hold', label: 'Hold', variant: 'secondary', value: 'hold' },
          { actionId: 'abort', label: 'Abort', variant: 'destructive', value: 'abort' },
        ],
      },
      {
        type: 'link_button',
        label: 'View runbook',
        href: 'https://docs.example.org/runbooks/deploy-gate',
        variant: 'secondary',
      },
    ],
  });

  assert.equal(card.schemaVersion, WIDGET_SCHEMA_VERSION);
  assert.equal(card.blocks.length, 7);
  assert.ok(Object.isFrozen(card));
  assert.ok(Object.isFrozen(card.blocks));
});

test('validateWidgetCard rejects prototype pollution, excess depth, >16 KiB size, >5 actions, invalid progress, and unsafe URLs', () => {
  // 1. Prototype pollution via JSON.parse('{"__proto__": ...}')
  const pollutedRoot = JSON.parse(
    '{"schemaVersion":"kodera.widget.v1","widgetId":"safe-card","__proto__":{"polluted":true},"blocks":[{"type":"text","body":"hi"}]}'
  );
  assert.throws(
    () => validateWidgetCard(pollutedRoot),
    (err) => err instanceof ExtensionSdkError && err.code === 'WIDGET_PROTOTYPE_POLLUTION'
  );

  for (const forbiddenKey of ['constructor', 'prototype']) {
    const obj = {
      schemaVersion: 'kodera.widget.v1',
      widgetId: 'safe-card',
      blocks: [{ type: 'text', body: 'hi' }],
    };
    Object.defineProperty(obj, forbiddenKey, {
      value: 'boom',
      enumerable: true,
      configurable: true,
    });
    assert.throws(
      () => validateWidgetCard(obj),
      (err) => err instanceof ExtensionSdkError && err.code === 'WIDGET_PROTOTYPE_POLLUTION'
    );
  }

  // 2. Max depth > 4 rejected
  const tooDeep = {
    schemaVersion: 'kodera.widget.v1',
    widgetId: 'deep-card',
    blocks: [
      {
        type: 'button_row',
        actions: [
          {
            actionId: 'act',
            label: 'Act',
            nested: { deeper: true },
          },
        ],
      },
    ],
  };
  assert.throws(
    () => validateWidgetCard(tooDeep),
    (err) => err instanceof ExtensionSdkError && err.code === 'WIDGET_DEPTH_EXCEEDED'
  );

  // 3. > 16 KiB serialized size rejected
  const hugeBlocks = Array.from({ length: 10 }, (_, idx) => ({
    type: 'text',
    body: `block-${idx}-` + 'x'.repeat(1800),
  }));
  const oversized = {
    schemaVersion: 'kodera.widget.v1',
    widgetId: 'huge-card',
    blocks: hugeBlocks,
  };
  assert.ok(Buffer.byteLength(JSON.stringify(oversized), 'utf8') > MAX_WIDGET_CARD_BYTES);
  assert.throws(
    () => validateWidgetCard(oversized),
    (err) => err instanceof ExtensionSdkError && err.code === 'WIDGET_TOO_LARGE'
  );

  // 4. Progress bar outside 0..100 rejected
  for (const badProgress of [-1, 100.1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () =>
        defineWidgetCard({
          widgetId: 'progress-card',
          blocks: [{ type: 'progress_bar', label: 'Load', value: badProgress }],
        }),
      (err) =>
        err instanceof ExtensionSdkError &&
        (err.code === 'INVALID_WIDGET_PROGRESS' || err.code === 'INVALID_WIDGET_CARD')
    );
  }

  // 5. button_row > 5 actions rejected
  assert.throws(
    () =>
      defineWidgetCard({
        widgetId: 'buttons-card',
        blocks: [
          {
            type: 'button_row',
            actions: [1, 2, 3, 4, 5, 6].map((n) => ({
              actionId: `act-${n}`,
              label: `Action ${n}`,
            })),
          },
        ],
      }),
    (err) => err instanceof ExtensionSdkError && err.code === 'WIDGET_TOO_MANY_ACTIONS'
  );

  // 6. link_button rejects http:, localhost, private IP, and javascript: URLs
  for (const unsafeHref of [
    'http://docs.example.org/insecure',
    'http://localhost:3000/local',
    'https://127.0.0.1/loopback',
    'https://169.254.169.254/latest/meta-data/',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
  ]) {
    assert.throws(
      () =>
        defineWidgetCard({
          widgetId: 'link-card',
          blocks: [{ type: 'link_button', label: 'Unsafe', href: unsafeHref }],
        }),
      (err) => err instanceof ExtensionSdkError
    );
  }
});

test('extension client postWidgetCard validates card and posts to widgets endpoint', async () => {
  const harness = createExtensionTestHarness({
    handler: async ({ client }) => {
      return client.postWidgetCard({
        channelId: 'chan_ops',
        card: defineWidgetCard({
          widgetId: 'ops-card',
          blocks: [{ type: 'status_pill', label: 'Healthy', state: 'success' }],
        }),
        idempotencyKey: 'widget:ops:1',
      });
    },
  });

  await harness.sendWebhook({
    event: 'widget.action',
    payload: { type: 'widget.action', data: { action_id: 'ping' } },
  });

  assert.equal(harness.recordedCalls.length, 1);
  assert.equal(harness.recordedCalls[0].path, '/api/v1/extensions/channels/chan_ops/widgets');
  assert.equal(harness.recordedCalls[0].idempotencyKey, 'widget:ops:1');
});
