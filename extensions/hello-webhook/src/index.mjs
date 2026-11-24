import {
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  defineSlashCommand,
  defineWidgetCard,
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
 * Builds a sandboxed `kodera.widget.v1` greeting card for channel interactions.
 *
 * @param {{ target?: string, acknowledged?: boolean }} [params]
 */
export function buildHelloWidgetCard(params = {}) {
  const target = params.target ?? 'team';
  const acknowledged = Boolean(params.acknowledged);
  return defineWidgetCard({
    widgetId: 'hello-greeting-card',
    blocks: [
      {
        type: 'header',
        title: `Greeting for ${target}`,
        subtitle: 'Declarative kodera.widget.v1 card',
      },
      {
        type: 'status_pill',
        label: acknowledged ? 'Wave acknowledged' : 'Awaiting wave',
        state: acknowledged ? 'success' : 'info',
      },
      {
        type: 'progress_bar',
        label: 'Onboarding readiness',
        value: acknowledged ? 100 : 50,
        valueText: acknowledged ? '100%' : '50%',
      },
      {
        type: 'button_row',
        actions: [
          { actionId: 'wave', label: 'Wave back', variant: 'primary', value: 'wave' },
        ],
      },
      {
        type: 'link_button',
        label: 'Starter documentation',
        href: 'https://docs.example.org/extensions/hello-webhook',
        variant: 'secondary',
      },
    ],
  });
}

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
    const reply = await helloCommand.handler({
      command: 'hello',
      args: String(event.args ?? ''),
      channelId: String(event.channelId ?? ''),
      actorId: String(event.actorId ?? ''),
    });
    return {
      ...reply,
      widget: buildHelloWidgetCard({
        target: String(event.args ?? '').trim() || String(event.actorId ?? 'team'),
        acknowledged: false,
      }),
    };
  }

  if (event.type === 'widget.action') {
    const data =
      event.data && typeof event.data === 'object'
        ? /** @type {Record<string, unknown>} */ (event.data)
        : event;
    const actionId = String(data.action_id ?? data.actionId ?? 'wave');
    return {
      text: `Widget action "${actionId}" processed.`,
      ephemeral: false,
      widget: buildHelloWidgetCard({
        target: String(data.actor_id ?? data.actorId ?? 'team'),
        acknowledged: actionId === 'wave',
      }),
    };
  }

  return { text: 'Ignored event', ephemeral: true };
}
