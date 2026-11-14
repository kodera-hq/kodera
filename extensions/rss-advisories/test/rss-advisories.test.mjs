import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ExtensionSdkError,
  WebhookVerificationError,
  createExtensionTestHarness,
} from '@kodera/extension-sdk';
import {
  advisoriesCommand,
  assertSafeXmlFeed,
  createRssAdvisoriesWebhookHandler,
  extensionManifest,
  formatCvssSeverity,
  formatVersionConstraint,
  handleAdvisoriesCommand,
  parseXmlAdvisoryFeed,
  sanitizeAdvisoryText,
  signAdvisoryWebhookPayload,
} from '../index.mjs';

const SECRET = 'adv_whsec_reference_secret_0123456789abcdef';

test('rss-advisories manifest validates reverse-DNS id, scopes, and /advisories slash command', () => {
  assert.equal(extensionManifest.canonicalId, 'io.kodera.ext.rss-advisories');
  assert.equal(extensionManifest.slug, 'rss-advisories');
  assert.equal(extensionManifest.webhookUrl, 'https://extensions.example.invalid/hooks/rss-advisories');
  assert.equal(advisoriesCommand.name, 'advisories');
});

test('rss-advisories formats GHSA, CVE, and CERT-FR advisories across Synapse, PostgreSQL, Keycloak, Rust, and Node.js with bounded deduplication', async () => {
  const handler = createRssAdvisoriesWebhookHandler({
    secret: SECRET,
    defaultChannelId: 'chan_secops',
    maxSeenEntries: 4,
  });
  const harness = createExtensionTestHarness({ secret: SECRET, handler });

  // 1. Critical GHSA + CVE for Synapse -> posts structured incident card
  const firstRes = await harness.sendWebhook({
    event: 'advisory.published',
    deliveryId: 'adv_synapse_1',
    payload: {
      type: 'advisory.published',
      guid: 'https://github.com/advisories/GHSA-xxxx-yyyy-zzzz',
      ghsaId: 'GHSA-xxxx-yyyy-zzzz',
      cveId: 'CVE-2026-41001',
      component: 'synapse',
      title: 'Federation signature bypass in state resolution',
      cvssScore: 9.4,
      affectedVersions: '>= 1.100.0, < 1.114.1',
      patchedVersions: '1.114.1',
      summary: '<p>Upgrade Matrix Synapse immediately.</p><script>evil()</script>',
      url: 'https://github.com/advisories/GHSA-xxxx-yyyy-zzzz',
    },
  });

  assert.equal(firstRes.response.result.posted, true);
  assert.equal(firstRes.response.result.kind, 'incident');
  assert.equal(harness.recordedCalls.length, 1);
  assert.equal(harness.recordedCalls[0].path, '/api/v1/extensions/channels/chan_secops/incidents');
  assert.equal(harness.recordedCalls[0].body.severity, 'critical');
  assert.ok(String(harness.recordedCalls[0].body.summary).includes('CRITICAL (CVSS 9.4) · Component: Synapse'));
  assert.ok(String(harness.recordedCalls[0].body.summary).includes('Affected: >= 1.100.0, < 1.114.1 · Patched: 1.114.1'));
  assert.ok(!String(harness.recordedCalls[0].body.summary).includes('<script>'));
  assert.ok(!String(harness.recordedCalls[0].body.summary).includes('evil()'));

  // 2. Same CVE arriving via CERT-FR feed with a different GUID is deduplicated by CVE-2026-41001!
  const dupRes = await harness.sendWebhook({
    event: 'advisory.published',
    deliveryId: 'adv_certfr_dup',
    payload: {
      type: 'advisory.published',
      guid: 'https://www.cert.ssi.gouv.fr/avis/CERTFR-2026-AVI-401/',
      certFrId: 'CERTFR-2026-AVI-401',
      cveId: 'CVE-2026-41001',
      component: 'synapse',
      title: 'Multiples vulnérabilités dans Matrix Synapse',
      cvssScore: 9.4,
      url: 'https://www.cert.ssi.gouv.fr/avis/CERTFR-2026-AVI-401/',
    },
  });

  assert.equal(dupRes.response.result.deduplicated, true);
  assert.equal(harness.recordedCalls.length, 1);

  // 3. Medium CERT-FR advisory for PostgreSQL -> posts channel message card
  const pgRes = await harness.sendWebhook({
    event: 'advisory.published',
    deliveryId: 'adv_pg_1',
    payload: {
      type: 'advisory.published',
      guid: 'certfr-pg-2026-402',
      certFrId: 'CERTFR-2026-AVI-402',
      cveId: 'CVE-2026-41002',
      component: 'postgresql',
      title: 'Privilege check omission in row-level security view',
      cvssScore: 5.5,
      affectedVersions: '>= 16.0, < 16.5',
      patchedVersions: '16.5',
      summary: 'Apply PostgreSQL minor update 16.5.',
      url: 'https://www.postgresql.org/support/security/CVE-2026-41002/',
    },
  });

  assert.equal(pgRes.response.result.kind, 'message');
  assert.equal(harness.recordedCalls.length, 2);
  assert.equal(harness.recordedCalls[1].path, '/api/v1/extensions/channels/chan_secops/messages');
  assert.ok(String(harness.recordedCalls[1].body.text).includes('[ADVISORY · MEDIUM (CVSS 5.5)] **PostgreSQL**'));
});

test('rss-advisories parses signed Atom 1.0 and RSS 2.0 XML feeds for Keycloak, Rust, and Node.js without HTML tag regexes', async () => {
  const handler = createRssAdvisoriesWebhookHandler({ secret: SECRET, defaultChannelId: 'chan_feeds' });
  const harness = createExtensionTestHarness({ secret: SECRET, handler });

  const atomXml = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Upstream Security Advisories</title>
  <entry>
    <id>urn:advisory:keycloak:2026-01</id>
    <title>Keycloak OIDC PKCE validation advisory CVE-2026-50001</title>
    <link href="https://www.keycloak.org/2026/11/security-advisory"/>
    <summary>&lt;div&gt;Update Keycloak realms &lt;script&gt;steal()&lt;/script&gt; to 26.0.6.&lt;/div&gt;</summary>
    <updated>2026-11-13T10:00:00Z</updated>
  </entry>
  <entry>
    <id>urn:advisory:rust:2026-02</id>
    <title>Rust standard library path canonicalization GHSA-abcd-efgh-ijkl</title>
    <link href="https://blog.rust-lang.org/2026/11/13/security-update.html"/>
    <summary><![CDATA[<p>Upgrade rustc to 1.84.1.</p><style>body{display:none}</style>]]></summary>
    <updated>2026-11-13T11:00:00Z</updated>
  </entry>
</feed>`;

  const atomRes = await handler({
    secret: SECRET,
    rawBody: atomXml,
    headers: {
      'x-advisory-signature-256': signAdvisoryWebhookPayload(SECRET, atomXml),
      'x-advisory-timestamp': String(harness.getNow()),
      'x-advisory-delivery': 'atom_feed_1',
    },
    nowUnixSeconds: harness.getNow(),
    client: harness.client,
  });

  assert.equal(atomRes.event, 'feed.xml');
  assert.equal(atomRes.result.count, 2);
  assert.equal(atomRes.result.entries[0].component, 'keycloak');
  assert.equal(atomRes.result.entries[1].component, 'rust');
  assert.equal(harness.recordedCalls.length, 2);
  assert.ok(!String(harness.recordedCalls[0].body.text).includes('steal()'));
  assert.ok(!String(harness.recordedCalls[0].body.text).includes('<'));
  assert.ok(!String(harness.recordedCalls[1].body.text).includes('display:none'));

  const rssXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Node.js Security Releases</title>
    <item>
      <guid>nodejs-sec-2026-11</guid>
      <title>Node.js 22.x HTTP/2 Rapid Reset hardening (CVE-2026-60009)</title>
      <link>https://nodejs.org/en/blog/vulnerability/november-2026-security-releases</link>
      <description>&lt;p&gt;Patched in Node.js 22.22.3.&lt;/p&gt;</description>
    </item>
  </channel>
</rss>`;

  const rssRes = await handler({
    secret: SECRET,
    rawBody: rssXml,
    headers: {
      'x-advisory-signature-256': signAdvisoryWebhookPayload(SECRET, rssXml),
      'x-advisory-timestamp': String(harness.getNow() + 10),
    },
    nowUnixSeconds: harness.getNow() + 10,
    client: harness.client,
  });

  assert.equal(rssRes.result.entries[0].component, 'nodejs');
  assert.equal(harness.recordedCalls.length, 3);
});

test('rss-advisories strictly refuses XML <!DOCTYPE and <!ENTITY payloads, tampered signatures, replays, and unsafe markup', async () => {
  const xxeXml = `<?xml version="1.0"?>
<!DOCTYPE feed [
  <!ENTITY xxe SYSTEM "file:///etc/passwd">
]>
<rss version="2.0"><channel><item><title>&xxe;</title></item></channel></rss>`;

  assert.throws(
    () => assertSafeXmlFeed(xxeXml),
    (err) => err instanceof ExtensionSdkError && err.code === 'XML_ENTITY_FORBIDDEN'
  );
  assert.throws(
    () => parseXmlAdvisoryFeed('<!DOCTYPE html><feed></feed>'),
    (err) => err instanceof ExtensionSdkError && err.code === 'XML_ENTITY_FORBIDDEN'
  );

  const handler = createRssAdvisoriesWebhookHandler({ secret: SECRET });
  await assert.rejects(
    () =>
      handler({
        secret: SECRET,
        rawBody: xxeXml,
        headers: {
          'x-advisory-signature-256': signAdvisoryWebhookPayload(SECRET, xxeXml),
        },
        nowUnixSeconds: 1_762_525_000,
      }),
    (err) => err instanceof ExtensionSdkError && err.code === 'XML_ENTITY_FORBIDDEN'
  );

  // Tampered HMAC signature
  const cleanJson = JSON.stringify({
    guid: 'adv-1',
    title: 'CVE-2026-70001 in Rust crate',
    url: 'https://advisories.example.org/1',
  });
  const sig = signAdvisoryWebhookPayload(SECRET, cleanJson);

  await assert.rejects(
    () =>
      handler({
        secret: SECRET,
        rawBody: `${cleanJson} `,
        headers: { 'x-advisory-signature-256': sig },
        nowUnixSeconds: 1_762_525_000,
      }),
    (err) => err instanceof WebhookVerificationError && err.code === 'SIGNATURE_MISMATCH'
  );

  // Replay guard
  await handler({
    secret: SECRET,
    rawBody: cleanJson,
    headers: { 'x-advisory-signature-256': sig },
    nowUnixSeconds: 1_762_525_000,
  });
  await assert.rejects(
    () =>
      handler({
        secret: SECRET,
        rawBody: cleanJson,
        headers: { 'x-advisory-signature-256': sig },
        nowUnixSeconds: 1_762_525_005,
      }),
    (err) => err instanceof WebhookVerificationError && err.code === 'REPLAY_DETECTED'
  );

  // Double-encoded & nested tag sanitization
  const nested = sanitizeAdvisoryText('<<script>alert(1)</script> &amp;lt;img src=x onerror=alert(2)&amp;gt; <img src=x onerror=alert(3)');
  assert.ok(!nested.includes('<'));
  assert.ok(!nested.includes('>'));
  assert.ok(!nested.includes('onerror=alert(3)'));

  assert.throws(
    () => formatVersionConstraint('<script>1.0.0</script>'),
    (err) => err instanceof ExtensionSdkError && err.code === 'INVALID_VERSION_CONSTRAINT'
  );
  assert.throws(
    () => formatCvssSeverity(11.2, 'CRITICAL'),
    (err) => err instanceof ExtensionSdkError && err.code === 'INVALID_CVSS_SCORE'
  );
});

test('/advisories slash command supports status, list, and sources', () => {
  assert.equal(handleAdvisoriesCommand({ args: '' }).subcommand, 'status');
  assert.equal(handleAdvisoriesCommand({ args: 'list --component=synapse --min-cvss=7.5' }).minCvss, 7.5);
  assert.equal(handleAdvisoriesCommand({ args: 'sources --source=cert-fr' }).source, 'cert-fr');
});
