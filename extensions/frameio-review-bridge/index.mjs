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
const MARKUP_BLOCK_TAGS = Object.freeze(['script', 'style', 'iframe']);
const MARKUP_TAG_BOUNDARY = Object.freeze([' ', '\t', '\n', '\r', '\f', '\v', '>', '/']);

/**
 * Removes one forward pass of `<script>`, `<style>`, and `<iframe>` blocks — opening
 * tag, inner body, and closing tag — using case-insensitive `indexOf` scans only.
 * No HTML-tag regular expression is involved, so `<SCRIPT>`, `<script\n foo>`, and
 * `</script >` are all handled identically.
 *
 * @param {string} input
 * @returns {string}
 */
function removeMarkupBlocksOnce(input) {
  const lower = input.toLowerCase();
  let out = '';
  let copiedUntil = 0;
  let searchFrom = 0;

  while (searchFrom < input.length) {
    let start = -1;
    let name = '';
    for (const candidate of MARKUP_BLOCK_TAGS) {
      const at = lower.indexOf(`<${candidate}`, searchFrom);
      if (at !== -1 && (start === -1 || at < start)) {
        start = at;
        name = candidate;
      }
    }
    if (start === -1) {
      break;
    }

    const afterName = start + 1 + name.length;
    const boundary = input[afterName];
    if (boundary !== undefined && !MARKUP_TAG_BOUNDARY.includes(boundary)) {
      // `<scripted` opens no block; keep scanning just past this angle bracket.
      searchFrom = start + 1;
      continue;
    }

    let end = input.length;
    const closeAt = lower.indexOf(`</${name}`, afterName);
    if (closeAt !== -1) {
      const closeEnd = input.indexOf('>', closeAt + 2 + name.length);
      end = closeEnd === -1 ? input.length : closeEnd + 1;
    }

    out += input.slice(copiedUntil, start);
    copiedUntil = end;
    searchFrom = end;
  }

  return copiedUntil === 0 ? input : out + input.slice(copiedUntil);
}

/**
 * Strips every HTML construct from untrusted text in linear time: block tags go first
 * with their bodies, repeated until the result stops changing because splicing two
 * halves can reveal a fresh `<script`, then any remaining tag — and any stray angle
 * bracket — is dropped character by character.
 *
 * @param {string} input
 * @returns {string}
 */
function stripMarkupText(input) {
  let text = input;
  for (;;) {
    const next = removeMarkupBlocksOnce(text);
    if (next === text) {
      break;
    }
    text = next;
  }

  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '>') {
      continue;
    }
    if (char !== '<') {
      out += char;
      continue;
    }
    const next = text[i + 1] ?? '';
    const opensTag =
      next === '/'
      || next === '!'
      || next === '?'
      || (next >= 'a' && next <= 'z')
      || (next >= 'A' && next <= 'Z');
    const tagEnd = opensTag ? text.indexOf('>', i + 1) : -1;
    if (tagEnd !== -1) {
      i = tagEnd;
    }
  }
  return out;
}

export function cleanText(value) {
  if (typeof value !== 'string' || value.length > 4096) throw new Error('Invalid comment');
  return stripMarkupText(value).replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/[@*_`\[\]()]/gu, '').trim().slice(0, 1000);
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
