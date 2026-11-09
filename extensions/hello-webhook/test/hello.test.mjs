import test from 'node:test';
import assert from 'node:assert/strict';
import { signWebhookPayload } from '@kodera/extension-sdk';
import { handleIncomingWebhook } from '../src/index.mjs';

test('hello-webhook processes a signed /hello slash command event end-to-end', async () => {
  const secret = 'whsec_hello_starter_0123456789abcdef';
  const now = 1_762_520_100;
  const rawBody = JSON.stringify({
    type: 'command.invoked',
    command: 'hello',
    args: 'sovereign world',
    channelId: '019a5e10-0000-7000-8000-000000000042',
    actorId: 'usr_alice',
  });
  const sig = signWebhookPayload(secret, now, rawBody);

  const reply = await handleIncomingWebhook({
    secret,
    rawBody,
    nowUnixSeconds: now,
    headers: {
      'x-kodera-signature-256': sig,
      'x-kodera-timestamp': String(now),
    },
  });

  assert.equal(reply.text, 'Hello sovereign world from Kodera Extension SDK!');
  assert.equal(reply.ephemeral, false);
});
