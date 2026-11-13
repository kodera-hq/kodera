import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_MAX_SKEW_SECONDS,
  ExtensionSdkError,
  MANIFEST_SCHEMA_VERSION,
  MAX_WEBHOOK_BODY_BYTES,
  MAX_WEBHOOK_REPLAY_ENTRIES,
  SIGNATURE_HEADER,
  WebhookVerificationError,
  createExtensionClient,
  createWebhookHandler,
  defineSlashCommand,
  getHeaderValue,
  parseCommandInvocation,
  validateEndpointUrl,
  validateManifest,
} from '@kodera/extension-sdk';

const rawManifest = JSON.parse(
  readFileSync(new URL('./manifest.json', import.meta.url), 'utf8')
);

const REVERSE_DNS_ID_PREFIX = 'io.kodera.ext.';
const REVERSE_DNS_ID_PATTERN = /^io\.kodera\.ext\.([a-z0-9][a-z0-9-]{1,62})$/;
const SLUG_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;
const NAMESPACE_PATH_PATTERN = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/;
const SAFE_REF_PATTERN = /^[A-Za-z0-9_./-]{1,128}$/;
const EVENT_UUID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_MR_THREADS = 1024;

export const GITLAB_SUPPORTED_SUBCOMMANDS = Object.freeze([
  'mr',
  'pipelines',
  'issues',
  'status',
]);

export const GITLAB_EVENT_HEADER_MAP = Object.freeze({
  merge_request: 'Merge Request Hook',
  pipeline: 'Pipeline Hook',
  push: 'Push Hook',
  tag_push: 'Tag Push Hook',
  issue: 'Issue Hook',
  release: 'Release Hook',
});

/**
 * Validates and normalizes the `gitlab` extension manifest.
 *
 * @param {Record<string, unknown>} [input]
 * @param {{ allowLocalhostHttp?: boolean }} [options]
 */
export function validateGitlabManifest(input = rawManifest, options = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ExtensionSdkError('INVALID_MANIFEST', 'Extension manifest must be a non-null JSON object.');
  }

  const schemaVersion = String(input.schemaVersion ?? input.schema ?? MANIFEST_SCHEMA_VERSION);
  const rawId = typeof input.id === 'string' ? input.id.trim() : '';
  let slugId = rawId;
  let canonicalId = rawId;

  const reverseMatch = REVERSE_DNS_ID_PATTERN.exec(rawId);
  if (reverseMatch) {
    slugId = reverseMatch[1];
    canonicalId = rawId;
  } else if (SLUG_ID_PATTERN.test(rawId)) {
    slugId = rawId;
    canonicalId = `${REVERSE_DNS_ID_PREFIX}${rawId}`;
  } else {
    throw new ExtensionSdkError('INVALID_MANIFEST_ID', `Invalid GitLab extension manifest id "${rawId}".`);
  }

  const rawScopes = Array.isArray(input.scopes)
    ? input.scopes
    : Array.isArray(input.permissions)
      ? input.permissions
      : [];

  const rawCommands = Array.isArray(input.commands) ? input.commands : [];
  const normalizedCommands = rawCommands.map((entry) => {
    if (!entry || typeof entry !== 'object') return entry;
    const rec = /** @type {Record<string, unknown>} */ (entry);
    return {
      ...rec,
      name: String(rec.name ?? rec.command ?? ''),
      description: String(rec.description ?? ''),
    };
  });

  const sdkValidated = validateManifest(
    {
      ...input,
      schemaVersion,
      id: slugId,
      scopes: rawScopes,
      commands: normalizedCommands,
    },
    options
  );

  return Object.freeze({
    ...sdkValidated,
    schema: schemaVersion,
    canonicalId,
    slug: slugId,
    permissions: sdkValidated.scopes,
  });
}

export const extensionManifest = validateGitlabManifest(rawManifest);
export const manifest = extensionManifest;

/**
 * Deterministic linear-time plain-text sanitizer without HTML-tag regular expressions.
 *
 * @param {unknown} rawValue
 * @param {string} [fallback]
 * @param {number} [maxLength]
 * @returns {string}
 */
export function sanitizeGitlabText(rawValue, fallback = '', maxLength = 240) {
  if (typeof rawValue !== 'string') {
    return fallback;
  }
  const bounded = rawValue.length > 16_384 ? rawValue.slice(0, 16_384) : rawValue;
  let out = '';
  let inTag = false;
  let lastSpace = true;

  for (let i = 0; i < bounded.length; i += 1) {
    const ch = bounded[i];
    const code = bounded.charCodeAt(i);
    if (ch === '<') {
      inTag = true;
      if (!lastSpace && out.length > 0) {
        out += ' ';
        lastSpace = true;
      }
      continue;
    }
    if (ch === '>') {
      inTag = false;
      continue;
    }
    if (inTag) {
      continue;
    }
    if (code < 0x20 || code === 0x7f) {
      if ((ch === '\n' || ch === '\r' || ch === '\t') && !lastSpace && out.length > 0) {
        out += ' ';
        lastSpace = true;
      }
      continue;
    }
    if (ch === '*' || ch === '_' || ch === '`' || ch === '~' || ch === '[' || ch === ']') {
      continue;
    }
    if (ch === ' ') {
      if (!lastSpace && out.length > 0) {
        out += ' ';
        lastSpace = true;
      }
      continue;
    }
    out += ch;
    lastSpace = false;
  }

  let cleaned = out.trim();
  if (cleaned.includes(':')) {
    cleaned = cleaned
      .replaceAll(/javascript\s*:/gi, 'blocked-scheme:')
      .replaceAll(/vbscript\s*:/gi, 'blocked-scheme:')
      .replaceAll(/data\s*:/gi, 'blocked-scheme:');
  }
  if (!cleaned) {
    return fallback;
  }
  if (cleaned.length > maxLength) {
    return `${cleaned.slice(0, maxLength)}…`;
  }
  return cleaned;
}

/**
 * Validates a GitLab `namespace/project` or nested `group/subgroup/project` path.
 *
 * @param {unknown} rawPath
 * @returns {string}
 */
export function validateGitlabProjectPath(rawPath) {
  if (typeof rawPath !== 'string') {
    throw new ExtensionSdkError('INVALID_GITLAB_PROJECT', 'GitLab project path must be a non-empty string.');
  }
  const trimmed = rawPath.trim();
  if (
    trimmed.length > 240 ||
    !NAMESPACE_PATH_PATTERN.test(trimmed) ||
    trimmed.includes('..') ||
    trimmed.startsWith('/') ||
    trimmed.endsWith('/')
  ) {
    throw new ExtensionSdkError('INVALID_GITLAB_PROJECT', `Invalid GitLab project path "${trimmed}".`);
  }
  return trimmed;
}

/**
 * Validates a GitLab or self-hosted GitLab CE/EE instance origin (`https://gitlab.example.org`).
 *
 * @param {unknown} rawOrigin
 * @returns {string}
 */
export function validateGitlabOrigin(rawOrigin = 'https://gitlab.com') {
  const validated = validateEndpointUrl(String(rawOrigin ?? ''), { allowLocalhostHttp: false });
  const parsed = new URL(validated);
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new ExtensionSdkError(
      'INVALID_GITLAB_ORIGIN',
      'GitLab instanceOrigin must be a bare HTTPS origin without path, query, or hash.'
    );
  }
  return parsed.origin;
}

/**
 * Validates a GitLab project/resource URL against SSRF vectors and pins it to the configured origin.
 *
 * @param {unknown} rawUrl
 * @param {string} expectedOrigin
 * @returns {string}
 */
export function validateGitlabUrl(rawUrl, expectedOrigin = 'https://gitlab.com') {
  const safeOrigin = validateGitlabOrigin(expectedOrigin);
  const validated = validateEndpointUrl(String(rawUrl ?? ''), { allowLocalhostHttp: false });
  const parsed = new URL(validated);
  if (parsed.origin !== safeOrigin) {
    throw new ExtensionSdkError(
      'UNTRUSTED_GITLAB_ORIGIN',
      `GitLab URL origin "${parsed.origin}" does not match configured origin "${safeOrigin}".`
    );
  }
  return validated;
}

/**
 * Formats seconds as a compact human-readable duration (`1m 24s`, `42s`).
 *
 * @param {unknown} rawSeconds
 * @returns {string}
 */
export function formatPipelineDuration(rawSeconds) {
  const sec = Number(rawSeconds);
  if (!Number.isFinite(sec) || sec < 0) {
    return '0s';
  }
  const rounded = Math.round(sec);
  if (rounded < 60) {
    return `${rounded}s`;
  }
  const minutes = Math.floor(rounded / 60);
  const rem = rounded % 60;
  return rem > 0 ? `${minutes}m ${rem}s` : `${minutes}m`;
}

/**
 * Verifies a GitLab `X-Gitlab-Token` header in constant time by comparing 32-byte SHA-256 digests
 * so the configured secret's length never leaks, then parses and validates the event payload.
 *
 * @param {{
 *   secret: string,
 *   rawBody: string | Uint8Array,
 *   tokenHeader: string | undefined,
 *   eventHeader: string | undefined,
 * }} params
 */
export function verifyGitlabWebhookRequest({ secret, rawBody, tokenHeader, eventHeader }) {
  if (typeof secret !== 'string' || secret.length < 16) {
    throw new WebhookVerificationError('INVALID_SECRET', 'GitLab webhook secret must be at least 16 characters.');
  }
  if (typeof rawBody !== 'string' && !(rawBody instanceof Uint8Array)) {
    throw new WebhookVerificationError('INVALID_BODY', 'Webhook rawBody must be a string or Uint8Array.');
  }
  const bodyBuf = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : Buffer.from(rawBody);
  if (bodyBuf.byteLength === 0 || bodyBuf.byteLength > MAX_WEBHOOK_BODY_BYTES) {
    throw new WebhookVerificationError('BODY_TOO_LARGE', 'GitLab webhook body is empty or exceeds the byte limit.');
  }
  if (typeof tokenHeader !== 'string' || tokenHeader.length === 0 || tokenHeader.length > 4096) {
    throw new WebhookVerificationError('MISSING_SIGNATURE', 'Missing or invalid X-Gitlab-Token header.');
  }

  const expectedDigest = createHash('sha256').update(secret, 'utf8').digest();
  const actualDigest = createHash('sha256').update(tokenHeader, 'utf8').digest();
  if (!timingSafeEqual(expectedDigest, actualDigest)) {
    throw new WebhookVerificationError('SIGNATURE_MISMATCH', 'GitLab X-Gitlab-Token verification failed.');
  }

  let payload;
  try {
    payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bodyBuf));
  } catch {
    throw new WebhookVerificationError('INVALID_JSON', 'GitLab webhook body is not valid UTF-8 JSON.');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new WebhookVerificationError('INVALID_JSON_OBJECT', 'GitLab webhook payload must be a JSON object.');
  }

  const objectKind = String(payload.object_kind ?? '');
  const expectedEventHeader = Object.prototype.hasOwnProperty.call(GITLAB_EVENT_HEADER_MAP, objectKind)
    ? GITLAB_EVENT_HEADER_MAP[/** @type {keyof typeof GITLAB_EVENT_HEADER_MAP} */ (objectKind)]
    : null;
  if (!expectedEventHeader || typeof eventHeader !== 'string' || eventHeader.trim() !== expectedEventHeader) {
    throw new WebhookVerificationError(
      'INVALID_EVENT',
      'X-Gitlab-Event header must match the payload object_kind.'
    );
  }

  const bodyDigest = createHash('sha256').update(bodyBuf).digest('hex');
  return {
    objectKind,
    eventHeader: expectedEventHeader,
    payload: /** @type {Record<string, unknown>} */ (payload),
    bodyDigest,
  };
}

/**
 * Executes the `/gitlab` slash command (`mr`, `pipelines`, `issues`, `status`).
 *
 * @param {{
 *   rawCommand?: string,
 *   args?: string,
 *   channelId?: string,
 *   actorId?: string,
 *   instanceOrigin?: string,
 * }} input
 */
export function handleGitlabCommand(input) {
  const origin = validateGitlabOrigin(input.instanceOrigin ?? 'https://gitlab.com');
  const channelId = typeof input.channelId === 'string' && input.channelId.trim()
    ? input.channelId.trim()
    : 'chan_gitlab';
  const actorId = typeof input.actorId === 'string' && input.actorId.trim()
    ? input.actorId.trim()
    : 'usr_unknown';
  const rawLine =
    typeof input.rawCommand === 'string' && input.rawCommand.trim().startsWith('/')
      ? input.rawCommand.trim()
      : `/gitlab ${String(input.args ?? '').trim()}`.trim();

  const parsed = parseCommandInvocation(rawLine);
  const subcommand = parsed.subcommand ? parsed.subcommand.toLowerCase() : 'status';
  if (!GITLAB_SUPPORTED_SUBCOMMANDS.includes(subcommand)) {
    throw new ExtensionSdkError(
      'UNSUPPORTED_GITLAB_SUBCOMMAND',
      `Unsupported /gitlab subcommand "${subcommand}"; expected: ${GITLAB_SUPPORTED_SUBCOMMANDS.join(', ')}.`
    );
  }

  const projectPath = validateGitlabProjectPath(parsed.flags.project ?? parsed.args[0] ?? 'kodera/platform');

  if (subcommand === 'mr') {
    const state = typeof parsed.flags.state === 'string' ? parsed.flags.state.toLowerCase() : 'opened';
    if (!['opened', 'merged', 'closed', 'all'].includes(state)) {
      throw new ExtensionSdkError('INVALID_MR_STATE', `Unsupported MR state "${state}".`);
    }
    const iid = parsed.flags.iid !== undefined ? Number(parsed.flags.iid) : null;
    if (iid !== null && (!Number.isSafeInteger(iid) || iid < 1)) {
      throw new ExtensionSdkError('INVALID_MR_IID', 'Merge request iid must be a positive integer.');
    }
    const url = validateGitlabUrl(
      iid ? `${origin}/${projectPath}/-/merge_requests/${iid}` : `${origin}/${projectPath}/-/merge_requests`,
      origin
    );
    return {
      text: `[GitLab MR] **${projectPath}**${iid ? `!${iid}` : ''} [state=${state}] requested by <@${actorId}> (${url}).`,
      ephemeral: true,
      subcommand: 'mr',
      projectPath,
      state,
      iid,
      url,
    };
  }

  if (subcommand === 'pipelines') {
    const ref = typeof parsed.flags.ref === 'string' ? parsed.flags.ref.trim() : 'main';
    if (!SAFE_REF_PATTERN.test(ref) || ref.includes('..')) {
      throw new ExtensionSdkError('INVALID_PIPELINE_REF', `Invalid GitLab ref "${ref}".`);
    }
    const url = validateGitlabUrl(`${origin}/${projectPath}/-/pipelines`, origin);
    return {
      text: `[GitLab Pipelines] **${projectPath}** ref \`${ref}\` requested by <@${actorId}> (${url}).`,
      ephemeral: true,
      subcommand: 'pipelines',
      projectPath,
      ref,
      url,
    };
  }

  if (subcommand === 'issues') {
    const iid = parsed.flags.iid !== undefined ? Number(parsed.flags.iid) : null;
    if (iid !== null && (!Number.isSafeInteger(iid) || iid < 1)) {
      throw new ExtensionSdkError('INVALID_ISSUE_IID', 'Issue iid must be a positive integer.');
    }
    const url = validateGitlabUrl(
      iid ? `${origin}/${projectPath}/-/issues/${iid}` : `${origin}/${projectPath}/-/issues`,
      origin
    );
    return {
      text: `[GitLab Issues] **${projectPath}**${iid ? `#${iid}` : ''} inspected in <#${channelId}> by <@${actorId}> (${url}).`,
      ephemeral: true,
      subcommand: 'issues',
      projectPath,
      iid,
      url,
    };
  }

  return {
    text: `[GitLab] Bridge ready in <#${channelId}> for **${projectPath}** on \`${origin}\` — subcommands: \`mr\`, \`pipelines\`, \`issues\`, \`status\`.`,
    ephemeral: true,
    subcommand: 'status',
    projectPath,
    origin,
  };
}

export const gitlabCommand = defineSlashCommand({
  name: '/gitlab',
  description: 'Inspect merge requests, pipeline stages, or issues for a GitLab project',
  scopes: ['messages:write', 'commands:register'],
  handler: ({ args, channelId, actorId }) => handleGitlabCommand({ args, channelId, actorId }),
});

export const slashCommand = gitlabCommand;

/**
 * Normalizes and posts GitLab hooks (`merge_request`, `pipeline`, `push`, `tag_push`, `issue`, `release`).
 *
 * @param {string} objectKind
 * @param {Record<string, unknown>} payload
 * @param {{
 *   defaultChannelId: string,
 *   instanceOrigin: string,
 *   mrThreads: Map<string, string>,
 *   client?: ReturnType<typeof createExtensionClient>,
 * }} state
 */
async function processGitlabEvent(objectKind, payload, state) {
  const { defaultChannelId, instanceOrigin, mrThreads, client } = state;
  const projectObj = /** @type {Record<string, unknown> | undefined} */ (payload.project);
  const projectPath = validateGitlabProjectPath(
    projectObj?.path_with_namespace ?? payload.projectPath ?? payload.repository
  );
  const channelId = String(payload.channelId ?? defaultChannelId);
  const attrs = /** @type {Record<string, unknown> | undefined} */ (payload.object_attributes);

  const rememberMrThread = (mrKey, threadId) => {
    if (mrThreads.size >= MAX_MR_THREADS && !mrThreads.has(mrKey)) {
      const oldest = mrThreads.keys().next().value;
      if (oldest !== undefined) mrThreads.delete(oldest);
    }
    mrThreads.set(mrKey, threadId);
  };

  if (objectKind === 'merge_request') {
    const iid = Number(attrs?.iid ?? payload.iid);
    if (!Number.isSafeInteger(iid) || iid < 1) {
      throw new ExtensionSdkError('INVALID_MR_PAYLOAD', 'Merge Request Hook requires a positive integer iid.');
    }
    const rawAction = String(attrs?.action ?? payload.action ?? 'open').toLowerCase();
    const becameReady =
      rawAction === 'update' &&
      Boolean(payload.changes?.draft?.previous) === true &&
      Boolean(payload.changes?.draft?.current) === false;
    const transition =
      rawAction === 'open' || rawAction === 'reopen' || rawAction === 'approved' || rawAction === 'unapproved' || rawAction === 'merge' || rawAction === 'close'
        ? rawAction
        : becameReady
          ? 'ready'
          : null;

    if (!transition) {
      return { posted: false, ignored: true, reason: 'unsupported_mr_action', projectPath, iid };
    }

    const title = sanitizeGitlabText(attrs?.title, `Merge request !${iid}`, 160);
    const author = sanitizeGitlabText(payload.user?.username ?? payload.user?.name, 'contributor', 60);
    const sourceBranch = sanitizeGitlabText(attrs?.source_branch, 'feature', 80);
    const targetBranch = sanitizeGitlabText(attrs?.target_branch, 'main', 80);
    const url = validateGitlabUrl(
      attrs?.url ?? `${instanceOrigin}/${projectPath}/-/merge_requests/${iid}`,
      instanceOrigin
    );
    const text = `[MR ${transition.toUpperCase()}] **${projectPath}!${iid}** ${title} (\`${sourceBranch}\` → \`${targetBranch}\`) by **${author}**\n${url}`;
    const idempotencyKey = `gitlab:mr:${projectPath}:${iid}:${transition}`;
    const blocks = [
      {
        type: 'gitlab_mr_card',
        projectPath,
        iid,
        transition,
        title,
        author,
        sourceBranch,
        targetBranch,
        url,
      },
    ];

    const mrKey = `${projectPath}!${iid}`;
    if (client) {
      const existingThread = mrThreads.get(mrKey);
      if (existingThread && transition !== 'open') {
        const delivery = await client.postThreadReply({
          channelId,
          threadRootId: existingThread,
          text,
          blocks,
          idempotencyKey,
        });
        return { posted: true, threaded: true, projectPath, iid, transition, idempotencyKey, delivery };
      }
      const delivery = await client.postChannelMessage({ channelId, text, blocks, idempotencyKey });
      if (typeof delivery.id === 'string') {
        rememberMrThread(mrKey, delivery.id);
      }
      return { posted: true, threaded: false, projectPath, iid, transition, idempotencyKey, delivery };
    }
    return { posted: false, projectPath, iid, transition, idempotencyKey, text, blocks };
  }

  if (objectKind === 'pipeline') {
    const pipelineId = Number(attrs?.id ?? payload.pipelineId);
    if (!Number.isSafeInteger(pipelineId) || pipelineId < 1) {
      throw new ExtensionSdkError('INVALID_PIPELINE_PAYLOAD', 'Pipeline Hook requires a positive integer id.');
    }
    const status = String(attrs?.status ?? payload.status ?? '').toLowerCase();
    if (!['failed', 'success', 'canceled'].includes(status)) {
      return { posted: false, ignored: true, reason: 'non_terminal_pipeline', projectPath, pipelineId };
    }
    const ref = sanitizeGitlabText(attrs?.ref, 'main', 80);
    const duration = formatPipelineDuration(attrs?.duration ?? attrs?.queued_duration ?? 0);
    const stages = Array.isArray(attrs?.stages)
      ? attrs.stages.map((s) => sanitizeGitlabText(s, '', 40)).filter(Boolean).slice(0, 10)
      : [];
    const builds = Array.isArray(payload.builds) ? payload.builds : [];
    const failedJobs = builds
      .filter((job) => job && typeof job === 'object' && String(job.status).toLowerCase() === 'failed')
      .map((job) => sanitizeGitlabText(job.name, 'job', 60))
      .slice(0, 8);
    const url = validateGitlabUrl(
      attrs?.url ?? `${instanceOrigin}/${projectPath}/-/pipelines/${pipelineId}`,
      instanceOrigin
    );

    const stageLine = stages.length > 0 ? ` · stages: ${stages.join(' → ')}` : '';
    const failedLine = failedJobs.length > 0 ? `\nFailed jobs: ${failedJobs.join(', ')}` : '';
    const badge = status === 'success' ? '[PIPELINE PASSED]' : `[PIPELINE ${status.toUpperCase()}]`;
    const text = `${badge} **${projectPath}** pipeline #${pipelineId} on \`${ref}\` (${duration}${stageLine})${failedLine}\n${url}`;
    const idempotencyKey = `gitlab:pipeline:${projectPath}:${pipelineId}:${status}`;
    const blocks = [
      {
        type: 'gitlab_pipeline_card',
        projectPath,
        pipelineId,
        status,
        ref,
        duration,
        stages,
        failedJobs,
        url,
      },
    ];
    if (client) {
      const delivery = await client.postChannelMessage({ channelId, text, blocks, idempotencyKey });
      return { posted: true, projectPath, pipelineId, status, failedJobs, duration, idempotencyKey, delivery };
    }
    return { posted: false, projectPath, pipelineId, status, failedJobs, duration, idempotencyKey, text, blocks };
  }

  if (objectKind === 'push') {
    const rawRef = String(payload.ref ?? 'refs/heads/main');
    const branch = sanitizeGitlabText(rawRef.replace(/^refs\/heads\//, ''), 'main', 80);
    const commits = Array.isArray(payload.commits) ? payload.commits : [];
    if (commits.length === 0) {
      return { posted: false, ignored: true, reason: 'empty_push', projectPath };
    }
    const actor = sanitizeGitlabText(payload.user_username ?? payload.user_name, 'developer', 60);
    const topSubject = sanitizeGitlabText(commits[0]?.title ?? commits[0]?.message, 'Commit pushed', 120);
    const afterSha = typeof payload.after === 'string' && /^[0-9a-fA-F]{7,40}$/.test(payload.after)
      ? payload.after.slice(0, 8)
      : 'head';
    const url = validateGitlabUrl(
      projectObj?.web_url ? `${projectObj.web_url}/-/commits/${encodeURIComponent(branch)}` : `${instanceOrigin}/${projectPath}/-/commits/${encodeURIComponent(branch)}`,
      instanceOrigin
    );
    const text = `[PUSH] **${projectPath}** \`${branch}\` (${commits.length} commit${commits.length === 1 ? '' : 's'} by **${actor}**): ${topSubject}\n${url}`;
    const idempotencyKey = `gitlab:push:${projectPath}:${branch}:${afterSha}`;
    const blocks = [{ type: 'gitlab_push_card', projectPath, branch, commitCount: commits.length, actor, url }];
    if (client) {
      const delivery = await client.postChannelMessage({ channelId, text, blocks, idempotencyKey });
      return { posted: true, projectPath, branch, commitCount: commits.length, idempotencyKey, delivery };
    }
    return { posted: false, projectPath, branch, commitCount: commits.length, idempotencyKey, text, blocks };
  }

  if (objectKind === 'tag_push') {
    const rawRef = String(payload.ref ?? '');
    const tag = rawRef.replace(/^refs\/tags\//, '').trim();
    if (!tag || !SAFE_REF_PATTERN.test(tag) || tag.includes('..')) {
      throw new ExtensionSdkError('INVALID_TAG_REF', `Invalid GitLab tag ref "${rawRef}".`);
    }
    const actor = sanitizeGitlabText(payload.user_username ?? payload.user_name, 'maintainer', 60);
    const url = validateGitlabUrl(`${instanceOrigin}/${projectPath}/-/tags/${encodeURIComponent(tag)}`, instanceOrigin);
    const text = `[TAG] **${projectPath}** tag \`${tag}\` pushed by **${actor}**\n${url}`;
    const idempotencyKey = `gitlab:tag:${projectPath}:${tag}`;
    const blocks = [{ type: 'gitlab_tag_card', projectPath, tag, actor, url }];
    if (client) {
      const delivery = await client.postChannelMessage({ channelId, text, blocks, idempotencyKey });
      return { posted: true, projectPath, tag, idempotencyKey, delivery };
    }
    return { posted: false, projectPath, tag, idempotencyKey, text, blocks };
  }

  if (objectKind === 'issue') {
    const iid = Number(attrs?.iid ?? payload.iid);
    if (!Number.isSafeInteger(iid) || iid < 1) {
      throw new ExtensionSdkError('INVALID_ISSUE_PAYLOAD', 'Issue Hook requires a positive integer iid.');
    }
    const action = String(attrs?.action ?? payload.action ?? 'open').toLowerCase();
    if (!['open', 'close', 'reopen', 'update'].includes(action)) {
      return { posted: false, ignored: true, reason: 'unsupported_issue_action', projectPath, iid };
    }
    const title = sanitizeGitlabText(attrs?.title, `Issue #${iid}`, 160);
    const author = sanitizeGitlabText(payload.user?.username ?? payload.user?.name, 'reporter', 60);
    const url = validateGitlabUrl(
      attrs?.url ?? `${instanceOrigin}/${projectPath}/-/issues/${iid}`,
      instanceOrigin
    );
    const text = `[ISSUE ${action.toUpperCase()}] **${projectPath}#${iid}** ${title} by **${author}**\n${url}`;
    const idempotencyKey = `gitlab:issue:${projectPath}:${iid}:${action}`;
    const blocks = [{ type: 'gitlab_issue_card', projectPath, iid, action, title, url }];
    if (client) {
      const delivery = await client.postChannelMessage({ channelId, text, blocks, idempotencyKey });
      return { posted: true, projectPath, iid, action, idempotencyKey, delivery };
    }
    return { posted: false, projectPath, iid, action, idempotencyKey, text, blocks };
  }

  if (objectKind === 'release') {
    const action = String(payload.action ?? 'create').toLowerCase();
    if (action !== 'create') {
      return { posted: false, ignored: true, reason: 'non_create_release', projectPath };
    }
    const tag = String(payload.tag ?? '').trim();
    if (!tag || !SAFE_REF_PATTERN.test(tag) || tag.includes('..')) {
      throw new ExtensionSdkError('INVALID_RELEASE_TAG', `Invalid GitLab release tag "${tag}".`);
    }
    const description = sanitizeGitlabText(payload.description ?? payload.name, 'Release created.', 280);
    const url = validateGitlabUrl(
      payload.url ?? `${instanceOrigin}/${projectPath}/-/releases/${encodeURIComponent(tag)}`,
      instanceOrigin
    );
    const text = `[RELEASE] **${projectPath} ${tag}** — ${description}\n${url}`;
    const idempotencyKey = `gitlab:release:${projectPath}:${tag}`;
    const blocks = [{ type: 'gitlab_release_card', projectPath, tag, description, url }];
    if (client) {
      const delivery = await client.postChannelMessage({ channelId, text, blocks, idempotencyKey });
      return { posted: true, projectPath, tag, idempotencyKey, delivery };
    }
    return { posted: false, projectPath, tag, idempotencyKey, text, blocks };
  }

  return { posted: false, ignored: true, reason: 'unhandled_event', objectKind };
}

/**
 * Creates a webhook handler supporting canonical Kodera `x-kodera-signature-256` signatures
 * and constant-time SHA-256-digested `X-Gitlab-Token` verification for GitLab.com and self-hosted GitLab CE/EE.
 *
 * @param {{
 *   secret: string,
 *   gitlabToken?: string,
 *   instanceOrigin?: string,
 *   defaultChannelId?: string,
 *   maxSkewSeconds?: number,
 *   maxReplayEntries?: number,
 *   client?: ReturnType<typeof createExtensionClient>,
 * }} config
 */
export function createGitlabWebhookHandler(config) {
  if (!config || typeof config.secret !== 'string' || config.secret.length < 16) {
    throw new WebhookVerificationError('INVALID_SECRET', 'Webhook handler requires a secret of at least 16 characters.');
  }

  const instanceOrigin = validateGitlabOrigin(config.instanceOrigin ?? 'https://gitlab.com');
  const gitlabToken = config.gitlabToken ?? config.secret;
  const defaultChannelId = config.defaultChannelId ?? 'chan_gitlab';
  const maxSkewSeconds = config.maxSkewSeconds ?? DEFAULT_MAX_SKEW_SECONDS;
  const maxReplayEntries = config.maxReplayEntries ?? MAX_WEBHOOK_REPLAY_ENTRIES;

  /** @type {Map<string, string>} */
  const mrThreads = new Map();
  /** @type {Map<string, number>} */
  const seenEventUuids = new Map();
  /** @type {Map<string, number>} */
  const seenBodyDigests = new Map();

  const pruneReplay = (nowSec) => {
    for (const [key, ts] of seenEventUuids.entries()) {
      if (nowSec - ts > maxSkewSeconds) seenEventUuids.delete(key);
    }
    for (const [key, ts] of seenBodyDigests.entries()) {
      if (nowSec - ts > maxSkewSeconds) seenBodyDigests.delete(key);
    }
  };

  const stateBase = {
    defaultChannelId,
    instanceOrigin,
    mrThreads,
  };

  const koderaHandler = createWebhookHandler({
    secret: config.secret,
    maxSkewSeconds,
    maxReplayEntries,
    client: config.client,
    handlers: {
      merge_request: (payload, { client }) => processGitlabEvent('merge_request', payload, { ...stateBase, client }),
      pipeline: (payload, { client }) => processGitlabEvent('pipeline', payload, { ...stateBase, client }),
      push: (payload, { client }) => processGitlabEvent('push', payload, { ...stateBase, client }),
      tag_push: (payload, { client }) => processGitlabEvent('tag_push', payload, { ...stateBase, client }),
      issue: (payload, { client }) => processGitlabEvent('issue', payload, { ...stateBase, client }),
      release: (payload, { client }) => processGitlabEvent('release', payload, { ...stateBase, client }),
      'release.published': (payload, { client }) =>
        processGitlabEvent('release', { ...payload, action: 'create' }, { ...stateBase, client }),
      'command.invoked': async (payload) =>
        handleGitlabCommand({
          args: String(payload.args ?? ''),
          channelId: String(payload.channelId ?? defaultChannelId),
          actorId: String(payload.actorId ?? 'usr_unknown'),
          instanceOrigin,
        }),
    },
  });

  return async function handleIncomingGitlabWebhook(req) {
    const koderaSig = getHeaderValue(req.headers, SIGNATURE_HEADER);
    const tokenHeader = getHeaderValue(req.headers, 'x-gitlab-token');

    if (koderaSig !== undefined || tokenHeader === undefined) {
      return koderaHandler(req);
    }

    const nowSec = req.nowUnixSeconds ?? req.nowSeconds ?? Math.floor(Date.now() / 1000);
    const eventUuid = getHeaderValue(req.headers, 'x-gitlab-event-uuid');
    if (eventUuid !== undefined && !EVENT_UUID_PATTERN.test(eventUuid)) {
      throw new WebhookVerificationError('INVALID_DELIVERY_ID', 'X-Gitlab-Event-UUID must be a bounded identifier.');
    }

    const { objectKind, eventHeader, payload, bodyDigest } = verifyGitlabWebhookRequest({
      secret: gitlabToken,
      rawBody: req.rawBody,
      tokenHeader,
      eventHeader: getHeaderValue(req.headers, 'x-gitlab-event'),
    });

    pruneReplay(nowSec);
    if (seenBodyDigests.has(bodyDigest) || (eventUuid !== undefined && seenEventUuids.has(eventUuid))) {
      throw new WebhookVerificationError('REPLAY_DETECTED', 'Duplicate GitLab webhook delivery rejected.');
    }
    if (seenBodyDigests.size >= maxReplayEntries) {
      throw new WebhookVerificationError('REPLAY_CAPACITY_EXCEEDED', 'GitLab replay cache is full.');
    }
    seenBodyDigests.set(bodyDigest, nowSec);
    if (eventUuid !== undefined) {
      seenEventUuids.set(eventUuid, nowSec);
    }

    const activeClient = req.client ?? config.client;
    const result = await processGitlabEvent(objectKind, payload, { ...stateBase, client: activeClient });
    return {
      ok: true,
      status: result.ignored ? 202 : 200,
      event: eventHeader,
      deliveryId: eventUuid ?? bodyDigest.slice(0, 16),
      result,
    };
  };
}

export const createExtensionWebhookHandler = createGitlabWebhookHandler;

export default {
  manifest,
  extensionManifest,
  slashCommand,
  gitlabCommand,
  handleGitlabCommand,
  createGitlabWebhookHandler,
  createExtensionWebhookHandler,
};
