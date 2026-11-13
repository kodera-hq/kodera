import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ExtensionSdkError,
  WebhookVerificationError,
  createExtensionTestHarness,
} from '@kodera/extension-sdk';
import {
  alertsCommand,
  createAlertmanagerWebhookHandler,
  extensionManifest,
  handleAlertsCommand,
  resolveAlertSeverity,
  signAlertmanagerWebhookPayload,
} from '../index.mjs';

const SECRET = 'am_whsec_reference_secret_0123456789abcdef';

test('alertmanager manifest validates reverse-DNS id, scopes, and /alerts slash command', () => {
  assert.equal(extensionManifest.canonicalId, 'io.kodera.ext.alertmanager');
  assert.equal(extensionManifest.slug, 'alertmanager');
  assert.equal(extensionManifest.webhookUrl, 'https://extensions.example.invalid/hooks/alertmanager');
  assert.equal(alertsCommand.name, 'alerts');
  assert.deepEqual(resolveAlertSeverity('critical'), { badge: 'critical', incidentSeverity: 'critical' });
  assert.deepEqual(resolveAlertSeverity('warning'), { badge: 'warning', incidentSeverity: 'medium' });
  assert.deepEqual(resolveAlertSeverity('info'), { badge: 'info', incidentSeverity: 'info' });
});

test('alertmanager v4 firing + resolved lifecycle posts postIncidentCard and threads resolution', async () => {
  const handler = createAlertmanagerWebhookHandler({
    secret: SECRET,
    defaultChannelId: 'chan_oncall',
  });
  const harness = createExtensionTestHarness({ secret: SECRET, handler });

  const firingBody = JSON.stringify({
    version: '4',
    groupKey: '{}:{alertname="SynapseHighFederationLatency"}',
    status: 'firing',
    receiver: 'kodera-oncall',
    commonLabels: {
      alertname: 'SynapseHighFederationLatency',
      service: 'synapse',
      severity: 'critical',
    },
    commonAnnotations: {
      summary: 'p99 federation send latency above 2.5s <script>bad()</script>',
      runbook_url: 'https://runbooks.example.org/synapse/federation-latency',
    },
    externalURL: 'https://alertmanager.example.org',
    alerts: [
      { status: 'firing', labels: { instance: 'synapse-01' } },
      { status: 'firing', labels: { instance: 'synapse-02' } },
    ],
  });

  const firingRes = await handler({
    secret: SECRET,
    rawBody: firingBody,
    headers: {
      'x-alertmanager-signature': signAlertmanagerWebhookPayload(SECRET, firingBody),
    },
    nowUnixSeconds: harness.getNow(),
    client: harness.client,
  });

  assert.equal(firingRes.result.severityBadge, 'critical');
  assert.equal(harness.recordedCalls.length, 1);
  assert.equal(harness.recordedCalls[0].path, '/api/v1/extensions/channels/chan_oncall/incidents');
  assert.equal(harness.recordedCalls[0].body.severity, 'critical');
  assert.ok(!String(harness.recordedCalls[0].body.summary).includes('<script>'));
  assert.ok(String(harness.recordedCalls[0].body.summary).includes('Runbook: https://runbooks.example.org/synapse/federation-latency'));

  // Resolved Alertmanager v4 payload authenticated via Authorization: Bearer <secret>
  const resolvedBody = JSON.stringify({
    version: '4',
    groupKey: '{}:{alertname="SynapseHighFederationLatency"}',
    status: 'resolved',
    commonLabels: {
      alertname: 'SynapseHighFederationLatency',
      service: 'synapse',
      severity: 'critical',
    },
    commonAnnotations: {
      summary: 'Federation latency back under 200ms',
      runbook_url: 'https://runbooks.example.org/synapse/federation-latency',
    },
    externalURL: 'https://alertmanager.example.org',
    alerts: [{ status: 'resolved' }],
  });

  const resolvedRes = await handler({
    secret: SECRET,
    rawBody: resolvedBody,
    headers: {
      authorization: `Bearer ${SECRET}`,
    },
    nowUnixSeconds: harness.getNow() + 60,
    client: harness.client,
  });

  assert.equal(resolvedRes.result.threaded, true);
  assert.equal(harness.recordedCalls.length, 2);
  assert.match(harness.recordedCalls[1].path, /\/threads\/msg_test_1\/replies$/);
  assert.ok(String(harness.recordedCalls[1].body.text).includes('[RESOLVED] **SynapseHighFederationLatency**'));
});

test('alertmanager handles Grafana Unified Alerting warning and info payloads', async () => {
  const handler = createAlertmanagerWebhookHandler({ secret: SECRET, defaultChannelId: 'chan_grafana' });
  const harness = createExtensionTestHarness({ secret: SECRET, handler });

  const grafanaBody = JSON.stringify({
    orgId: 1,
    state: 'alerting',
    status: 'firing',
    title: 'PostgresConnectionPoolSaturation',
    message: 'Pool utilization reached 84%',
    ruleUrl: 'https://grafana.example.org/alerting/list',
    commonLabels: {
      alertname: 'PostgresConnectionPoolSaturation',
      service: 'postgresql',
      severity: 'warning',
    },
    alerts: [
      {
        status: 'firing',
        dashboardURL: 'https://grafana.example.org/d/pg-pool',
      },
    ],
  });

  const res = await handler({
    secret: SECRET,
    rawBody: grafanaBody,
    headers: { authorization: `Bearer ${SECRET}` },
    nowUnixSeconds: harness.getNow(),
    client: harness.client,
  });

  assert.equal(res.result.source, 'grafana');
  assert.equal(res.result.severityBadge, 'warning');
  assert.equal(harness.recordedCalls.length, 1);
  assert.equal(harness.recordedCalls[0].body.severity, 'medium');
});

test('alertmanager refuses forged HMAC, wrong-length Bearer secrets, replays, and SSRF runbook_url', async () => {
  const handler = createAlertmanagerWebhookHandler({ secret: SECRET });
  const body = JSON.stringify({
    version: '4',
    status: 'firing',
    commonLabels: { alertname: 'DiskPressure', severity: 'info' },
    externalURL: 'https://alertmanager.example.org',
    alerts: [{ status: 'firing' }],
  });

  await assert.rejects(
    () =>
      handler({
        secret: SECRET,
        rawBody: `${body} `,
        headers: { 'x-alertmanager-signature': signAlertmanagerWebhookPayload(SECRET, body) },
        nowUnixSeconds: 1_762_525_000,
      }),
    (err) => err instanceof WebhookVerificationError && err.code === 'SIGNATURE_MISMATCH'
  );

  await assert.rejects(
    () =>
      handler({
        secret: SECRET,
        rawBody: body,
        headers: { authorization: 'Bearer wrong_short' },
        nowUnixSeconds: 1_762_525_000,
      }),
    (err) => err instanceof WebhookVerificationError && err.code === 'SIGNATURE_MISMATCH'
  );

  // Replay guard
  await handler({
    secret: SECRET,
    rawBody: body,
    headers: { authorization: `Bearer ${SECRET}` },
    nowUnixSeconds: 1_762_525_000,
  });
  await assert.rejects(
    () =>
      handler({
        secret: SECRET,
        rawBody: body,
        headers: { authorization: `Bearer ${SECRET}` },
        nowUnixSeconds: 1_762_525_005,
      }),
    (err) => err instanceof WebhookVerificationError && err.code === 'REPLAY_DETECTED'
  );

  // SSRF runbook_url rejected
  const ssrfBody = JSON.stringify({
    version: '4',
    status: 'firing',
    commonLabels: { alertname: 'MetadataProbe', severity: 'critical' },
    commonAnnotations: { runbook_url: 'https://169.254.169.254/latest/meta-data/' },
    alerts: [{ status: 'firing' }],
  });
  await assert.rejects(
    () =>
      handler({
        secret: SECRET,
        rawBody: ssrfBody,
        headers: { 'x-alertmanager-signature': signAlertmanagerWebhookPayload(SECRET, ssrfBody) },
        nowUnixSeconds: 1_762_525_010,
      }),
    (err) => err instanceof ExtensionSdkError && err.code === 'SSRF_FORBIDDEN_IP'
  );
});

test('/alerts slash command supports status, firing, and runbook', () => {
  assert.equal(handleAlertsCommand({ args: '' }).subcommand, 'status');
  assert.equal(handleAlertsCommand({ args: 'firing --severity=critical', activeCount: 2 }).activeCount, 2);
  assert.equal(handleAlertsCommand({ args: 'runbook --alert=SynapseFederationLag' }).alertName, 'SynapseFederationLag');
});
