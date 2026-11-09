import { readFileSync } from 'node:fs';
import {
  ExtensionSdkError,
  INCIDENT_SEVERITIES,
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

const INCIDENT_KEY_PATTERN = /^[A-Za-z0-9_.:-]{2,120}$/;

/**
 * Validates and normalizes an external monitoring incident key.
 *
 * @param {unknown} rawKey
 * @returns {string}
 */
export function normalizeIncidentKey(rawKey) {
  if (typeof rawKey !== 'string' || !INCIDENT_KEY_PATTERN.test(rawKey.trim())) {
    throw new ExtensionSdkError(
      'INVALID_INCIDENT_KEY',
      'Incident key must be an alphanumeric identifier (2-120 chars).'
    );
  }
  return rawKey.trim();
}

export const incidentBridgeCommand = defineSlashCommand({
  name: '/incident-bridge',
  description: 'Inspect or declare a monitored service incident',
  scopes: ['messages:write', 'incidents:write'],
  handler: ({ args, actorId }) => {
    const parsed = parseCommandInvocation(`/incident-bridge ${args}`);
    const sub = parsed.subcommand ?? 'status';
    const service = typeof parsed.flags.service === 'string' ? parsed.flags.service : 'core-api';
    const severity = typeof parsed.flags.severity === 'string' ? parsed.flags.severity : 'high';
    return {
      text: `Incident bridge (${sub}) for service **${service}** [severity=${severity}] triggered by <@${actorId}>.`,
      ephemeral: sub === 'status',
    };
  },
});

/**
 * Creates a stateful webhook handler for bridging uptime and alerting events into
 * Kodera incident cards and thread follow-ups, deduplicating flapping alerts
 * within a configurable window (`dedupWindowSeconds`).
 *
 * @param {{
 *   secret: string,
 *   defaultChannelId?: string,
 *   dedupWindowSeconds?: number,
 * }} config
 */
export function createUptimeIncidentBridgeHandler(config) {
  const defaultChannelId = config.defaultChannelId ?? 'chan_incidents';
  const dedupWindowSeconds = config.dedupWindowSeconds ?? 300;

  /**
   * @type {Map<string, {
   *   channelId: string,
   *   threadRootId: string,
   *   title: string,
   *   severity: 'critical' | 'high' | 'medium' | 'low' | 'info',
   *   status: 'open' | 'acknowledged' | 'resolved',
   *   lastOpenedAt: number,
   * }>}
   */
  const incidentRegistry = new Map();

  return createWebhookHandler({
    secret: config.secret,
    handlers: {
      'incident.opened': async (payload, { timestamp, client }) => {
        const incidentKey = normalizeIncidentKey(payload.incidentKey ?? payload.alertId ?? payload.id);
        const channelId = String(payload.channelId ?? defaultChannelId);
        const title = typeof payload.title === 'string' && payload.title.trim()
          ? payload.title.trim()
          : `Monitor alert: ${incidentKey}`;
        const rawSeverity = String(payload.severity ?? 'high').toLowerCase();
        if (!INCIDENT_SEVERITIES.includes(/** @type {any} */ (rawSeverity))) {
          throw new ExtensionSdkError(
            'INVALID_SEVERITY',
            `Unsupported incident severity "${rawSeverity}".`
          );
        }
        const severity = /** @type {'critical' | 'high' | 'medium' | 'low' | 'info'} */ (rawSeverity);
        const summary = typeof payload.summary === 'string' && payload.summary.trim()
          ? payload.summary.trim()
          : `Automated monitor alert triggered for ${incidentKey}.`;
        const externalUrl =
          payload.externalUrl !== undefined
            ? validateEndpointUrl(String(payload.externalUrl))
            : undefined;

        const existing = incidentRegistry.get(incidentKey);
        if (existing && timestamp - existing.lastOpenedAt < dedupWindowSeconds) {
          return {
            deduplicated: true,
            incidentKey,
            threadRootId: existing.threadRootId,
          };
        }

        const idempotencyKey = `incident:open:${incidentKey}:${timestamp}`;
        let threadRootId = existing?.threadRootId ?? `thread_${incidentKey}`;

        if (client) {
          const response = await client.postIncidentCard({
            channelId,
            title,
            severity,
            summary,
            ...(externalUrl ? { externalUrl } : {}),
            status: 'open',
            idempotencyKey,
          });
          if (typeof response.id === 'string') {
            threadRootId = response.id;
          }
        }

        incidentRegistry.set(incidentKey, {
          channelId,
          threadRootId,
          title,
          severity,
          status: 'open',
          lastOpenedAt: timestamp,
        });

        return {
          deduplicated: false,
          incidentKey,
          threadRootId,
          idempotencyKey,
        };
      },

      'incident.acknowledged': async (payload, { timestamp, client }) => {
        const incidentKey = normalizeIncidentKey(payload.incidentKey ?? payload.alertId ?? payload.id);
        const existing = incidentRegistry.get(incidentKey);
        if (!existing) {
          throw new ExtensionSdkError(
            'UNKNOWN_INCIDENT',
            `Cannot acknowledge unknown incident "${incidentKey}".`
          );
        }

        const responder = typeof payload.responder === 'string' && payload.responder.trim()
          ? payload.responder.trim()
          : 'on-call';
        const note = typeof payload.note === 'string' && payload.note.trim()
          ? ` — ${payload.note.trim()}`
          : '';
        const text = `[ACKNOWLEDGED] Incident **${incidentKey}** acknowledged by **${responder}**${note}`;
        const idempotencyKey = `incident:ack:${incidentKey}:${timestamp}`;

        existing.status = 'acknowledged';

        if (client) {
          await client.postThreadReply({
            channelId: existing.channelId,
            threadRootId: existing.threadRootId,
            text,
            idempotencyKey,
          });
        }

        return {
          incidentKey,
          status: 'acknowledged',
          threadRootId: existing.threadRootId,
          idempotencyKey,
        };
      },

      'incident.resolved': async (payload, { timestamp, client }) => {
        const incidentKey = normalizeIncidentKey(payload.incidentKey ?? payload.alertId ?? payload.id);
        const existing = incidentRegistry.get(incidentKey);
        if (!existing) {
          throw new ExtensionSdkError(
            'UNKNOWN_INCIDENT',
            `Cannot resolve unknown incident "${incidentKey}".`
          );
        }

        const durationSeconds = Math.max(0, timestamp - existing.lastOpenedAt);
        const resolutionSummary = typeof payload.summary === 'string' && payload.summary.trim()
          ? payload.summary.trim()
          : 'Monitor checks returned to healthy state.';
        const text = `[RESOLVED] Incident **${incidentKey}** resolved after ${durationSeconds}s: ${resolutionSummary}`;
        const idempotencyKey = `incident:resolve:${incidentKey}:${timestamp}`;

        existing.status = 'resolved';

        if (client) {
          await client.postThreadReply({
            channelId: existing.channelId,
            threadRootId: existing.threadRootId,
            text,
            idempotencyKey,
          });
        }

        return {
          incidentKey,
          status: 'resolved',
          durationSeconds,
          threadRootId: existing.threadRootId,
          idempotencyKey,
        };
      },

      'command.invoked': async (payload) => {
        return incidentBridgeCommand.handler({
          command: 'incident-bridge',
          args: String(payload.args ?? ''),
          channelId: String(payload.channelId ?? defaultChannelId),
          actorId: String(payload.actorId ?? 'usr_oncall'),
        });
      },
    },
  });
}
