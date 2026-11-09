import { readFileSync } from 'node:fs';
import {
  ExtensionSdkError,
  createWebhookHandler,
  defineSlashCommand,
  parseCommandInvocation,
  validateEndpointUrl,
  validateManifest,
} from '@kodera/extension-sdk';

const rawManifest = JSON.parse(
  readFileSync(new URL('../kodera-extension.json', import.meta.url), 'utf8')
);

export const extensionManifest = validateManifest(rawManifest);

const REPO_SLUG_PATTERN = /^[A-Za-z0-9_.-]{1,64}\/[A-Za-z0-9_.-]{1,64}$/;
const SEMVER_TAG_PATTERN = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const MAX_SANITIZED_NOTES_LENGTH = 1800;

/**
 * Validates a repository `owner/name` slug.
 *
 * @param {unknown} repo
 * @returns {string}
 */
export function validateRepositorySlug(repo) {
  if (typeof repo !== 'string' || !REPO_SLUG_PATTERN.test(repo.trim())) {
    throw new ExtensionSdkError('INVALID_REPOSITORY_SLUG', 'Repository must match "owner/name".');
  }
  return repo.trim();
}

/**
 * Validates a SemVer release tag (`v1.2.3` or `1.2.3-rc.1`).
 *
 * @param {unknown} tag
 * @returns {string}
 */
export function validateReleaseTag(tag) {
  if (typeof tag !== 'string' || !SEMVER_TAG_PATTERN.test(tag.trim())) {
    throw new ExtensionSdkError('INVALID_RELEASE_TAG', `Invalid SemVer release tag "${String(tag)}".`);
  }
  const trimmed = tag.trim();
  return trimmed.startsWith('v') ? trimmed : `v${trimmed}`;
}

/**
 * Sanitizes untrusted release notes markdown by stripping embedded HTML tags,
 * neutralizing `javascript:` / `data:` / `vbscript:` markdown link schemes,
 * removing control characters, and bounding output length.
 *
 * @param {unknown} rawNotes
 * @returns {string}
 */
export function sanitizeReleaseNotes(rawNotes) {
  if (typeof rawNotes !== 'string' || rawNotes.trim().length === 0) {
    return 'No release notes provided.';
  }
  let cleaned = rawNotes
    .replace(/\r\n/g, '\n')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, '')
    .replace(/<\/?[A-Za-z][^>]*>/g, '')
    .replace(/\[([^\]]+)\]\(\s*(?:javascript|data|vbscript):[^)]*\)/gi, '$1 (blocked-unsafe-link)');

  cleaned = cleaned.trim();
  if (!cleaned) {
    return 'No release notes provided.';
  }
  if (cleaned.length > MAX_SANITIZED_NOTES_LENGTH) {
    return `${cleaned.slice(0, MAX_SANITIZED_NOTES_LENGTH)}…`;
  }
  return cleaned;
}

export const releaseNotesCommand = defineSlashCommand({
  name: '/release-notes',
  description: 'Format or preview a release announcement for a repository tag',
  scopes: ['messages:write'],
  handler: ({ args, actorId }) => {
    const parsed = parseCommandInvocation(`/release-notes ${args}`);
    const repo = typeof parsed.flags.repo === 'string' ? validateRepositorySlug(parsed.flags.repo) : 'kodera-hq/kodera';
    const rawTag = parsed.subcommand ?? 'v0.1.0';
    const tag = validateReleaseTag(rawTag);
    const channelFlag = typeof parsed.flags.channel === 'string' ? parsed.flags.channel : 'current';
    return {
      text: `Release preview for **${repo}@${tag}** (target: ${channelFlag}) requested by <@${actorId}>.`,
      ephemeral: Boolean(parsed.flags.preview ?? true),
    };
  },
});

/**
 * Creates a configured webhook handler for the GitHub Release & CI Notifier extension.
 *
 * @param {{ secret: string, defaultChannelId?: string }} config
 */
export function createReleaseNotifierWebhookHandler(config) {
  const defaultChannelId = config.defaultChannelId ?? 'chan_releases';

  return createWebhookHandler({
    secret: config.secret,
    handlers: {
      'release.published': async (payload, { client }) => {
        const repo = validateRepositorySlug(payload.repository ?? payload.repo);
        const tag = validateReleaseTag(payload.tag ?? payload.tagName);
        const channelId = String(payload.channelId ?? defaultChannelId);
        const author = typeof payload.author === 'string' && payload.author.trim() ? payload.author.trim() : 'release-bot';
        const releaseUrl = validateEndpointUrl(String(payload.htmlUrl ?? payload.url ?? `https://github.com/${repo}/releases/tag/${tag}`));
        const notes = sanitizeReleaseNotes(payload.body ?? payload.notes ?? '');
        const isPrerelease = Boolean(payload.prerelease);
        const idempotencyKey = `release:${repo}:${tag}`;

        const badge = isPrerelease ? '[PRE-RELEASE]' : '[RELEASE]';
        const text = `${badge} **${repo} ${tag}** published by **${author}**\n\n${notes}\n\nRelease URL: ${releaseUrl}`;
        const blocks = [
          {
            type: 'release_card',
            repository: repo,
            tag,
            prerelease: isPrerelease,
            author,
            releaseUrl,
            notes,
          },
        ];

        if (client) {
          const delivery = await client.postChannelMessage({
            channelId,
            text,
            blocks,
            idempotencyKey,
          });
          return { posted: true, idempotencyKey, delivery };
        }
        return { posted: false, idempotencyKey, text, blocks };
      },

      'ci.workflow_failed': async (payload, { client }) => {
        const repo = validateRepositorySlug(payload.repository ?? payload.repo);
        const workflow = typeof payload.workflow === 'string' && payload.workflow.trim()
          ? payload.workflow.trim().slice(0, 120)
          : 'CI';
        const branch = typeof payload.branch === 'string' && payload.branch.trim()
          ? payload.branch.trim().slice(0, 120)
          : 'main';
        const runId = String(payload.runId ?? payload.id ?? '0');
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(runId)) {
          throw new ExtensionSdkError('INVALID_RUN_ID', 'CI workflow runId must be alphanumeric.');
        }
        const channelId = String(payload.channelId ?? defaultChannelId);
        const runUrl = validateEndpointUrl(
          String(payload.runUrl ?? `https://github.com/${repo}/actions/runs/${runId}`)
        );
        const summary = sanitizeReleaseNotes(payload.failureSummary ?? payload.summary ?? 'Workflow job failed.');
        const idempotencyKey = `ci-failure:${repo}:${runId}`;
        const text = `[CI FAILURE] **${repo}** workflow **${workflow}** failed on \`${branch}\` (run #${runId})\n\n${summary}\n\nLogs: ${runUrl}`;

        if (client) {
          const delivery = await client.postChannelMessage({
            channelId,
            text,
            blocks: [
              {
                type: 'ci_failure_card',
                repository: repo,
                workflow,
                branch,
                runId,
                runUrl,
              },
            ],
            idempotencyKey,
          });
          return { posted: true, idempotencyKey, delivery };
        }
        return { posted: false, idempotencyKey, text };
      },

      'command.invoked': async (payload) => {
        return releaseNotesCommand.handler({
          command: 'release-notes',
          args: String(payload.args ?? ''),
          channelId: String(payload.channelId ?? defaultChannelId),
          actorId: String(payload.actorId ?? 'usr_unknown'),
        });
      },
    },
  });
}
