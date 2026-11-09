import {
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  defineSlashCommand,
  getHeaderValue,
  verifyWebhookRequest,
} from '@kodera/extension-sdk';

export const helloCommand = defineSlashCommand({
  name: '/hello',
  description: 'Reply with a greeting in the current Kodera channel',
  scopes: ['messages:write'],
  handler: ({ args, actorId }) => {
    const target = args.trim() || `<@${actorId}>`;
    return {
      text: `Hello ${target} from Kodera Extension SDK!`,
      ephemeral: false,
    };
  },
});

/**
 * Minimal Node / Web Fetch HTTP webhook handler skeleton.
 *
 * @param {{ secret: string, rawBody: string | Uint8Array, headers: Headers | Record<string, string | string[] | undefined>, nowUnixSeconds?: number }} req
 */
export async function handleIncomingWebhook(req) {
  const event = verifyWebhookRequest({
    secret: req.secret,
    rawBody: req.rawBody,
    signatureHeader: getHeaderValue(req.headers, SIGNATURE_HEADER),
    timestampHeader: getHeaderValue(req.headers, TIMESTAMP_HEADER),
    nowUnixSeconds: req.nowUnixSeconds,
  });

  if (event.type === 'command.invoked' && event.command === 'hello') {
    return helloCommand.handler({
      command: 'hello',
      args: String(event.args ?? ''),
      channelId: String(event.channelId ?? ''),
      actorId: String(event.actorId ?? ''),
    });
  }
  return { text: 'Ignored event', ephemeral: true };
}
