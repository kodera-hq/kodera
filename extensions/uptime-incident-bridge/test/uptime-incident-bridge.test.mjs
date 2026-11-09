import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ExtensionSdkError,
  createExtensionTestHarness,
} from '@kodera/extension-sdk';
import {
  createUptimeIncidentBridgeHandler,
  extensionManifest,
} from '../src/index.mjs';

const SECRET = 'whsec_uptime_incident_bridge_0123456789';

test('uptime-incident-bridge manifest validates cleanly against kodera.extension.v1', () => {
  assert.equal(extensionManifest.id, 'uptime-incident-bridge');
  assert.ok(extensionManifest.scopes.includes('incidents:write'));
  assert.ok(extensionManifest.scopes.includes('threads:write'));
  assert.ok(extensionManifest.events.includes('incident.opened'));
});

test('bridges incident lifecycle (opened -> acknowledged -> resolved) and deduplicates flapping alerts', async () => {
  const handler = createUptimeIncidentBridgeHandler({
    secret: SECRET,
    defaultChannelId: 'chan_sre_incidents',
    dedupWindowSeconds: 180,
  });
  const harness = createExtensionTestHarness({
    secret: SECRET,
    handler,
    nowSeconds: 1_762_521_000,
  });

  // 1. Open incident -> creates incident card
  const opened = await harness.sendWebhook({
    event: 'incident.opened',
    deliveryId: 'up_deliv_1',
    payload: {
      incidentKey: 'eu-fr1:livekit-sfu',
      title: 'SFU packet loss above 3% threshold',
      severity: 'critical',
      summary: 'Probe detected 3.8% UDP loss on edge node sfu-par-02.',
      externalUrl: 'https://status.kodera.io/incidents/sfu-par-02',
    },
  });

  assert.equal(harness.recordedCalls.length, 1);
  assert.equal(harness.recordedCalls[0].path, '/api/v1/extensions/channels/chan_sre_incidents/incidents');
  assert.equal(harness.recordedCalls[0].body.severity, 'critical');
  const rootId = harness.recordedCalls[0].id;
  assert.equal((/** @type {any} */ (opened.response)).result.deduplicated, false);

  // 2. Flapping duplicate open 45 seconds later (within 180s window) -> suppressed!
  harness.advanceTime(45);
  const flapped = await harness.sendWebhook({
    event: 'incident.opened',
    deliveryId: 'up_deliv_2',
    payload: {
      incidentKey: 'eu-fr1:livekit-sfu',
      title: 'SFU packet loss above 3% threshold',
      severity: 'critical',
      summary: 'Duplicate flapping probe alert.',
    },
  });

  assert.equal((/** @type {any} */ (flapped.response)).result.deduplicated, true);
  assert.equal(harness.recordedCalls.length, 1, 'Flapping alert within window must not emit a new outbound call');

  // 3. Acknowledge incident -> posts threaded reply under root incident card
  harness.advanceTime(15);
  await harness.sendWebhook({
    event: 'incident.acknowledged',
    deliveryId: 'up_deliv_3',
    payload: {
      incidentKey: 'eu-fr1:livekit-sfu',
      responder: 'lours',
      note: 'Draining traffic from sfu-par-02 to sfu-par-03',
    },
  });

  assert.equal(harness.recordedCalls.length, 2);
  assert.equal(
    harness.recordedCalls[1].path,
    `/api/v1/extensions/channels/chan_sre_incidents/threads/${rootId}/replies`
  );
  assert.ok(String(harness.recordedCalls[1].body.text).includes('acknowledged by **lours**'));

  // 4. Resolve incident -> posts threaded resolution summary with duration
  harness.advanceTime(60);
  const resolved = await harness.sendWebhook({
    event: 'incident.resolved',
    deliveryId: 'up_deliv_4',
    payload: {
      incidentKey: 'eu-fr1:livekit-sfu',
      summary: 'Packet loss back to 0.01% after node drain.',
    },
  });

  assert.equal(harness.recordedCalls.length, 3);
  assert.equal((/** @type {any} */ (resolved.response)).result.durationSeconds, 120);
  assert.ok(String(harness.recordedCalls[2].body.text).includes('resolved after 120s'));

  // 5. After dedupWindowSeconds (180s) elapses from initial open, a new incident with same key is allowed
  harness.advanceTime(100);
  const reopened = await harness.sendWebhook({
    event: 'incident.opened',
    deliveryId: 'up_deliv_5',
    payload: {
      incidentKey: 'eu-fr1:livekit-sfu',
      title: 'SFU packet loss regression',
      severity: 'high',
      summary: 'Secondary spike detected.',
    },
  });
  assert.equal((/** @type {any} */ (reopened.response)).result.deduplicated, false);
  assert.equal(harness.recordedCalls.length, 4);
});

test('rejects SSRF externalUrl, invalid severity, and unknown incident acknowledgements', async () => {
  const handler = createUptimeIncidentBridgeHandler({ secret: SECRET });
  const harness = createExtensionTestHarness({ secret: SECRET, handler });

  await assert.rejects(
    () =>
      harness.sendWebhook({
        event: 'incident.opened',
        deliveryId: 'up_bad_ssrf',
        payload: {
          incidentKey: 'db-primary',
          title: 'DB alert',
          severity: 'critical',
          summary: 'Latency spike',
          externalUrl: 'https://10.0.0.42/internal-runbook',
        },
      }),
    (err) => err instanceof ExtensionSdkError && err.code === 'SSRF_FORBIDDEN_IP'
  );

  await assert.rejects(
    () =>
      harness.sendWebhook({
        event: 'incident.acknowledged',
        deliveryId: 'up_bad_unknown',
        payload: {
          incidentKey: 'non-existent-incident',
          responder: 'lours',
        },
      }),
    (err) => err instanceof ExtensionSdkError && err.code === 'UNKNOWN_INCIDENT'
  );
});
