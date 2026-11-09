import { readFileSync } from 'node:fs';
import { createWebhookHandler, defineSlashCommand, validateEndpointUrl, validateManifest } from '@kodera/extension-sdk';

export const manifest = validateManifest(JSON.parse(readFileSync(new URL('./manifest.json', import.meta.url), 'utf8')));
export const EVENTS = Object.freeze(['asset.ready', 'comment.created', 'review.status_changed']);
export function validateAssetUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\\\s]/u.test(value)) throw new Error('Invalid asset URL');
  const validated = validateEndpointUrl(value);
  const url = new URL(validated);
  if (!['app.frame.io', 'next.frame.io', 'api.frame.io'].includes(url.hostname) || url.port || url.hash) throw new Error('Untrusted asset host');
  return validated;
}
export function cleanText(value) {
  if (typeof value !== 'string' || value.length > 4096) throw new Error('Invalid comment');
  return value.replace(/<[^>]*>/gu, '').replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/[@<>*_`\[\]()]/gu, '').trim().slice(0, 1000);
}
export function buildReviewCard(event, payload) {
  if (!EVENTS.includes(event) || !payload || typeof payload !== 'object') throw new Error('Unsupported event');
  if (typeof payload.id !== 'string' || !/^[A-Za-z0-9-]{1,100}$/u.test(payload.id)) throw new Error('Invalid event id');
  const url = validateAssetUrl(payload.url);
  const channelId = event === 'asset.ready' ? 'dailies-rushes' : 'post-production';
  let detail = '';
  if (event === 'comment.created') {
    if (typeof payload.timecode !== 'string' || !/^\d{2}:[0-5]\d:[0-5]\d:[0-2]\d$/u.test(payload.timecode)) throw new Error('Invalid SMPTE timecode');
    detail = `${payload.timecode} ${cleanText(payload.comment)}`;
  } else if (event === 'review.status_changed') {
    if (!['Approved', 'Needs Changes'].includes(payload.status)) throw new Error('Invalid review status');
    detail = payload.status;
  } else detail = cleanText(payload.title ?? 'Asset ready');
  return { channelId, text: `@post-production ${detail}\n${url}`, idempotencyKey: `frameio:${event}:${payload.id}` };
}
export const frameioReviewCommand = defineSlashCommand({
  name: '/frameio-review', description: 'Share a Frame.io review in the current production channel',
  scopes: ['messages:write', 'commands:register'],
  handler: ({ args, channelId }) => {
    if (!['post-production', 'dailies-rushes'].includes(channelId)) throw new Error('Unsupported production channel');
    return { text: `@post-production ${validateAssetUrl(args.trim())}`, ephemeral: false };
  },
});
export function createFrameioWebhookHandler({ secret, client }) {
  return createWebhookHandler({ secret, client, handlers: Object.fromEntries(EVENTS.map(event => [event, async (payload, context) => {
    const card = buildReviewCard(event, payload);
    const activeClient = context.client ?? client;
    if (!activeClient) return { posted: false, ...card };
    return { posted: true, delivery: await activeClient.postChannelMessage(card) };
  }])) });
}
