import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ExtensionSdkError,
  createExtensionTestHarness,
} from '@kodera/extension-sdk';
import {
  createQontoTreasuryWebhookHandler,
  extensionManifest,
  handleQontoFeedCommand,
  manifest,
  maskIban,
  qontoFeedCommand,
  validateQontoManifest,
} from '../index.mjs';

const SECRET = 'whsec_qonto_treasury_feed_0123456789abcdef';

test('qonto-treasury-feed manifest validates against kodera.extension.v1 and /qonto-feed', () => {
  assert.equal(manifest.schemaVersion, 'kodera.extension.v1');
  assert.equal(manifest.canonicalId, 'io.kodera.ext.qonto-treasury-feed');
  assert.equal(extensionManifest.id, 'qonto-treasury-feed');
  assert.equal(manifest.commands.length, 1);
  assert.equal(manifest.commands[0].command, '/qonto-feed');
  assert.equal(manifest.commands[0].name, 'qonto-feed');

  assert.throws(
    () =>
      validateQontoManifest({
        ...manifest,
        webhookUrl: 'https://127.0.0.1/hooks/qonto',
      }),
    (err) => err instanceof ExtensionSdkError && err.code === 'SSRF_FORBIDDEN_IP'
  );
});

test('maskIban deterministically redacts full IBANs to country + check digits + masked middle + last 4 chars', () => {
  const rawFrIban = 'FR76 3000 6000 0112 3456 7890 189';
  assert.equal(maskIban(rawFrIban), 'FR76 **** **** **** **** ***0 189');
  assert.equal(maskIban('fr76-3000-6000-0112-3456-7890-189'), 'FR76 **** **** **** **** ***0 189');
  assert.equal(maskIban('DE89 3704 0044 0532 0130 00'), 'DE89 **** **** **** **30 00');

  assert.throws(
    () => maskIban('NOT_AN_IBAN'),
    (err) => err instanceof ExtensionSdkError && err.code === 'INVALID_IBAN'
  );
});

test('handles incoming/outgoing transfers, missing invoice reminders, and spend threshold alerts without leaking raw IBANs', async () => {
  const handler = createQontoTreasuryWebhookHandler({
    secret: SECRET,
    defaultChannelId: 'chan_compta',
  });
  const harness = createExtensionTestHarness({
    secret: SECRET,
    handler,
    nowSeconds: 1_762_531_000,
  });

  const rawCorporateIban = 'FR76 3000 6000 0112 3456 7890 189';
  const rawSupplierIban = 'FR76 1009 6000 5098 7654 3210 942';

  await harness.sendWebhook({
    event: 'transfer.incoming',
    deliveryId: 'qonto_deliv_in_1',
    payload: {
      transactionId: 'tx_in_901',
      amountEur: 14500,
      iban: rawCorporateIban,
      counterparty: 'Client Entreprise SAS',
      counterpartyIban: rawSupplierIban,
      reference: `Règlement facture F-2026-88 sur ${rawCorporateIban}`,
      transactionUrl: 'https://app.qonto.com/organizations/kodera/transactions/tx_in_901',
    },
  });

  await harness.sendWebhook({
    event: 'transfer.outgoing',
    deliveryId: 'qonto_deliv_out_2',
    payload: {
      transactionId: 'tx_out_902',
      amountEur: 3200.5,
      iban: rawCorporateIban,
      counterparty: 'Scaleway SAS',
      reference: 'Infrastructure Cloud souveraine',
      transactionUrl: 'https://app.qonto.com/organizations/kodera/transactions/tx_out_902',
    },
  });

  await harness.sendWebhook({
    event: 'invoice.missing_attachment',
    deliveryId: 'qonto_deliv_inv_3',
    payload: {
      transactionId: 'tx_inv_903',
      amountEur: 490,
      iban: rawCorporateIban,
      counterparty: 'SNCF Voyageurs',
      reference: 'Justificatif PDF requis pour clôture mensuelle',
      transactionUrl: 'https://app.qonto.com/organizations/kodera/transactions/tx_inv_903',
    },
  });

  await harness.sendWebhook({
    event: 'spend.threshold_exceeded',
    deliveryId: 'qonto_deliv_thr_4',
    payload: {
      transactionId: 'tx_thr_904',
      amountEur: 8500,
      iban: rawCorporateIban,
      counterparty: 'Fournisseur Matériel',
      reference: 'Dépassement du plafond hebdomadaire de 5 000,00 EUR',
      transactionUrl: 'https://app.qonto.com/organizations/kodera/transactions/tx_thr_904',
    },
  });

  assert.equal(harness.recordedCalls.length, 4);
  for (const call of harness.recordedCalls) {
    const serialized = JSON.stringify(call.body);
    assert.ok(serialized.includes('FR76 **** **** **** **** ***0 189'));
    assert.ok(!serialized.includes('3000 6000 0112 3456 7890'));
    assert.ok(!serialized.includes('30006000011234567890'));
    assert.ok(!serialized.includes('1009 6000 5098 7654 3210'));
  }

  const cmdRes = handleQontoFeedCommand({
    rawCommand: `/qonto-feed threshold --iban="${rawCorporateIban}" --threshold-eur=7500`,
    channelId: 'chan_compta',
    actorId: 'usr_zxxma',
  });
  assert.equal(cmdRes.maskedIban, 'FR76 **** **** **** **** ***0 189');
  assert.ok(cmdRes.text.includes('FR76 **** **** **** **** ***0 189'));
  assert.ok(!cmdRes.text.includes('3000 6000'));
  assert.equal(qontoFeedCommand.name, 'qonto-feed');
});
