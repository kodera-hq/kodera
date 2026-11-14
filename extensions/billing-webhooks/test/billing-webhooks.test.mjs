import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ExtensionSdkError,
  WebhookVerificationError,
  createExtensionTestHarness,
} from '@kodera/extension-sdk';
import {
  createBillingWebhooksHandler,
  extensionManifest,
  extractRedactedBillingSummary,
  formatBillingAmount,
  handleBillingOpsCommand,
  redactBillingText,
  signBillingWebhookPayload,
  validateBillingWebhooksManifest,
  verifyBillingWebhookSignature,
} from '../index.mjs';

const FIXTURE_SIGNING_MATERIAL = 'a'.repeat(32);

test('billing-webhooks manifest validates cleanly and rejects SSRF webhookUrl overrides', () => {
  assert.equal(extensionManifest.canonicalId, 'io.kodera.ext.billing-webhooks');
  assert.equal(extensionManifest.slug, 'billing-webhooks');
  assert.equal(extensionManifest.commands[0].name, 'billing-ops');

  assert.throws(
    () => validateBillingWebhooksManifest({ ...extensionManifest, webhookUrl: 'https://10.0.0.5/hooks' }),
    (err) => err instanceof ExtensionSdkError && err.code === 'SSRF_FORBIDDEN_IP'
  );
});

test('PII redaction guarantee: customer emails, street addresses, phone numbers, card PAN/last4, and IBANs never leak into channel cards or incidents', async () => {
  const postedMessages = [];
  const upsertedIncidents = [];
  const mockClient = {
    async postChannelMessage(msg) {
      const id = `msg_bill_${postedMessages.length + 1}`;
      postedMessages.push({ id, ...msg });
      return { id };
    },
    async upsertIncidentCard(inc) {
      const id = `inc_bill_${upsertedIncidents.length + 1}`;
      upsertedIncidents.push({ id, ...inc });
      return { id };
    },
  };

  const handler = createBillingWebhooksHandler({
    secret: FIXTURE_SIGNING_MATERIAL,
    defaultChannelId: 'chan_billing_ops',
    authorizedOpsChannels: ['chan_billing_ops', 'chan_ops'],
    client: mockClient,
  });

  const nowSec = 1_763_140_000;
  const piiHeavyPayload = {
    id: 'evt_inv_fail_9001',
    type: 'invoice.payment_failed',
    data: {
      object: {
        id: 'in_9001',
        amount_due: 49900,
        currency: 'eur',
        status: 'open',
        customer_email: 'billing-owner@secret-client.example.org',
        customer_name: 'Jean-Luc Picard',
        customer_phone: '+33698765432',
        customer_details: {
          email: 'billing-owner@secret-client.example.org',
          name: 'Jean-Luc Picard',
          phone: '+33698765432',
          address: {
            line1: '42 Rue de Rivoli',
            postal_code: '75004',
            city: 'Paris',
            country: 'FR',
          },
          tax_ids: [{ type: 'eu_vat', value: 'FR99123456789' }],
        },
        payment_method_details: {
          card: {
            brand: 'visa',
            number: '4242424242424242',
            last4: '4242',
            exp_month: 12,
            exp_year: 2029,
            cvc: '987',
            fingerprint: 'fp_secret_card_token',
          },
          sepa_debit: {
            iban: 'FR7630006000011234567890189',
          },
        },
        metadata: {
          workspace_slug: 'studio-lumiere',
          plan_tier: 'enterprise',
        },
      },
    },
  };

  const rawBody = JSON.stringify(piiHeavyPayload);
  const sigHeader = signBillingWebhookPayload(FIXTURE_SIGNING_MATERIAL, nowSec, rawBody);

  const response = await handler({
    rawBody,
    headers: { 'stripe-signature': sigHeader },
    nowUnixSeconds: nowSec,
  });

  assert.equal(response.ok, true);
  assert.equal(postedMessages.length, 1);
  assert.equal(upsertedIncidents.length, 1);

  const combinedSerialized = JSON.stringify({
    messages: postedMessages,
    incidents: upsertedIncidents,
    result: response.result,
  });

  // Positive assertions: operational summary fields ARE present
  assert.ok(combinedSerialized.includes('studio-lumiere'));
  assert.ok(combinedSerialized.includes('enterprise'));
  assert.ok(combinedSerialized.includes('499.00 EUR'));
  assert.ok(combinedSerialized.includes('payment_failed'));

  // Negative assertions: ZERO PII/PCI substrings anywhere in emitted text, blocks, or incident card
  const forbiddenSubstrings = [
    'billing-owner@secret-client.example.org',
    'secret-client.example.org',
    'Jean-Luc Picard',
    '+33698765432',
    '698765432',
    '42 Rue de Rivoli',
    '75004',
    'FR99123456789',
    '4242424242424242',
    '4242',
    'fp_secret_card_token',
    'FR7630006000011234567890189',
  ];
  for (const leak of forbiddenSubstrings) {
    assert.ok(!combinedSerialized.includes(leak), `Expected PII substring "${leak}" to be completely absent`);
  }

  // Also test redactBillingText directly on untrusted free-text strings
  const scrubbed = redactBillingText(
    'Contact owner@client.example.org or +33612345678 regarding IBAN FR7630006000011234567890189 card 4242424242424242'
  );
  assert.ok(!scrubbed.includes('owner@client.example.org'));
  assert.ok(!scrubbed.includes('33612345678'));
  assert.ok(!scrubbed.includes('FR7630006000011234567890189'));
  assert.ok(!scrubbed.includes('4242424242424242'));
});

test('supports all 5 lifecycle & quota events, key rotation v1 candidates, replay rejection, and unauthorized channel refusal', async () => {
  const nowSec = 1_763_145_000;
  const handler = createBillingWebhooksHandler({
    secret: FIXTURE_SIGNING_MATERIAL,
    defaultChannelId: 'chan_billing_ops',
    authorizedOpsChannels: ['chan_billing_ops'],
  });

  // Key rotation header with old + current v1 signatures succeeds
  const checkoutBody = JSON.stringify({
    id: 'evt_chk_101',
    type: 'checkout.session.completed',
    data: {
      object: {
        amount_total: 12000,
        currency: 'EUR',
        metadata: { workspace_slug: 'vfx-paris', plan_tier: 'studio' },
      },
    },
  });
  const currentPart = signBillingWebhookPayload(FIXTURE_SIGNING_MATERIAL, nowSec, checkoutBody).split(',')[1];
  const rotatedHeader = `t=${nowSec},v1=${'0'.repeat(64)},${currentPart}`;
  const verified = verifyBillingWebhookSignature({
    secret: FIXTURE_SIGNING_MATERIAL,
    rawBody: checkoutBody,
    signatureHeader: rotatedHeader,
    nowUnixSeconds: nowSec,
  });
  assert.equal(verified.event, 'checkout.session.completed');

  const firstDelivery = await handler({
    rawBody: checkoutBody,
    headers: { 'stripe-signature': rotatedHeader },
    nowUnixSeconds: nowSec,
  });
  assert.equal(firstDelivery.result.summary.formattedAmount, '120.00 EUR');

  // Replay must fail
  await assert.rejects(
    () =>
      handler({
        rawBody: checkoutBody,
        headers: { 'stripe-signature': rotatedHeader },
        nowUnixSeconds: nowSec + 2,
      }),
    (err) => err instanceof WebhookVerificationError && err.code === 'REPLAY_DETECTED'
  );

  // Expired timestamp must fail
  const staleBody = JSON.stringify({ id: 'evt_paid_102', type: 'invoice.paid', amountMinor: 5000, currency: 'EUR' });
  const staleSig = signBillingWebhookPayload(FIXTURE_SIGNING_MATERIAL, nowSec - 900, staleBody);
  await assert.rejects(
    () =>
      handler({
        rawBody: staleBody,
        headers: { 'x-billing-signature': staleSig },
        nowUnixSeconds: nowSec,
      }),
    (err) => err instanceof WebhookVerificationError && err.code === 'TIMESTAMP_OUT_OF_RANGE'
  );

  // Quota threshold event & subscription update & invoice.paid summaries
  const quotaSummary = extractRedactedBillingSummary('quota.threshold_reached', {
    id: 'evt_quota_88',
    workspaceSlug: 'render-west',
    planTier: 'studio',
    metric: 'egress_bandwidth_gb',
    usagePercent: 96.4,
  });
  assert.equal(quotaSummary.status, 'critical');
  assert.equal(quotaSummary.quotaUsagePercent, 96.4);

  const subSummary = extractRedactedBillingSummary('customer.subscription.updated', {
    id: 'evt_sub_89',
    workspaceSlug: 'render-west',
    planTier: 'enterprise',
    amountMinor: 99000,
    currency: 'EUR',
    status: 'active',
  });
  assert.equal(subSummary.formattedAmount, '990.00 EUR');
  assert.equal(formatBillingAmount(1500, 'JPY').formattedAmount, '1500 JPY');

  // Unauthorized channel routing must be refused
  const unauthorizedBody = JSON.stringify({
    id: 'evt_paid_999',
    type: 'invoice.paid',
    channelId: 'chan_public_general',
    amountMinor: 2500,
    currency: 'EUR',
  });
  const unauthorizedSig = signBillingWebhookPayload(FIXTURE_SIGNING_MATERIAL, nowSec + 10, unauthorizedBody);
  await assert.rejects(
    () =>
      handler({
        rawBody: unauthorizedBody,
        headers: { 'x-billing-signature': unauthorizedSig },
        nowUnixSeconds: nowSec + 10,
      }),
    (err) => err instanceof ExtensionSdkError && err.code === 'UNAUTHORIZED_BILLING_CHANNEL'
  );

  // /billing-ops status works cleanly via Kodera harness, while summary in public channel throws
  assert.throws(
    () => handleBillingOpsCommand({ rawCommand: '/billing-ops summary', channelId: 'chan_general' }),
    (err) => err instanceof ExtensionSdkError && err.code === 'UNAUTHORIZED_BILLING_CHANNEL'
  );

  const harness = createExtensionTestHarness({
    secret: FIXTURE_SIGNING_MATERIAL,
    handler,
  });
  const cmdRes = await harness.sendWebhook({
    event: 'command.invoked',
    payload: {
      type: 'command.invoked',
      command: 'billing-ops',
      args: '',
      channelId: 'chan_conformance',
      actorId: 'usr_conformance',
    },
  });
  assert.equal(cmdRes.response.result.subcommand, 'status');
  assert.equal(cmdRes.response.result.piiRedacted, true);
});
