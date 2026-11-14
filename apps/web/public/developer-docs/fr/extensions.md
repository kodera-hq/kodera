# Extension SDK & 22 connecteurs

> Amenez les événements signés dans les salons, avec des frontières de confiance explicites.

## Signer les octets exacts

Le SDK ESM/TypeScript est sans dépendance externe. Son enveloppe signe timestamp.rawBody en HMAC-SHA256, avec une signature hexadécimale v1=. Les en-têtes sont x-kodera-signature-256 et x-kodera-timestamp.

Le timestamp est un entier canonique positif ou nul, dans la fenêtre inclusive de 300 secondes. Le SDK accepte au plus 1 MiB de corps brut ; ce laboratoire limite volontairement les exemples à 64 KiB.

> Le secret local d’exemple est public. Ne collez jamais de secret de signature de production dans ce laboratoire.

```typescript
import { signWebhookPayload, verifyWebhookRequest } from "@kodera/extension-sdk";

const rawBody = JSON.stringify({ type: "asset.ready", assetId: "demo-1" });
const timestamp = Math.floor(Date.now() / 1000);
const secret = "local-example-secret-only";
const signature = signWebhookPayload(secret, timestamp, rawBody);
const verified = verifyWebhookRequest({
  secret, rawBody, signatureHeader: signature,
  timestampHeader: String(timestamp), nowUnixSeconds: timestamp,
});
```

## Router les événements avant les effets de bord

createWebhookHandler exige un marqueur type ou event signé dans le corps ; ils doivent être identiques si les deux sont présents. Un en-tête d’événement éventuel doit correspondre au marqueur signé.

Le handler déduplique signatures authentifiées et identifiants de livraison avant les effets de bord. Son historique mémoire borné ne survit pas aux redémarrages. Utilisez une idempotence durable à la frontière des effets de bord.

GitHub natif utilise sha256= sur rawBody, sans préfixe temporel SDK. L’adaptateur Frame.io utilise l’enveloppe du SDK Kodera. Les signatures natives demandent un adaptateur d’entrée de confiance ; elles ne sont pas interchangeables.

> Une signature valide ne constitue ni une autorisation de locataire ni une garantie antirejeu persistante.

## Vingt-deux implémentations de référence

La liste ci-dessous décrit les implémentations du dépôt, pas des comptes de production connectés. Les connecteurs studio routent les marqueurs Frame.io timecode/OTIO et la télémétrie de rendu Flamenco/Deadline sans récupérer les médias.

Les services externes hors de ces vingt-deux exemples restent des intégrations possibles via le SDK. Ce checkout ne contient pas de connecteur de référence supplémentaire au-delà de la liste ci-dessous.

> Les contrôles de syntaxe HTTPS et le refus des redirections ne figent pas le DNS. L’egress de production doit aussi contrôler les adresses résolues et le réseau.

## Connecteurs

- [Hello Webhook](https://github.com/kodera-hq/kodera/blob/main/extensions/hello-webhook/README.md): hello-webhook

- [GitHub Release Notifier](https://github.com/kodera-hq/kodera/blob/main/extensions/github-release-notifier/README.md): github-release-notifier

- [Uptime Incident Bridge](https://github.com/kodera-hq/kodera/blob/main/extensions/uptime-incident-bridge/README.md): uptime-incident-bridge

- [Docs Collab Announcer](https://github.com/kodera-hq/kodera/blob/main/extensions/docs-collab-announcer/manifest.json): docs-collab-announcer

- [GitHub Repo Tracker](https://github.com/kodera-hq/kodera/blob/main/extensions/github-repo-tracker/manifest.json): github-repo-tracker

- [Qonto Treasury Feed](https://github.com/kodera-hq/kodera/blob/main/extensions/qonto-treasury-feed/manifest.json): qonto-treasury-feed

- [Notion Workspace Bridge](https://github.com/kodera-hq/kodera/blob/main/extensions/notion-workspace-bridge/manifest.json): notion-workspace-bridge

- [GDrive Document Share](https://github.com/kodera-hq/kodera/blob/main/extensions/gdrive-document-share/manifest.json): gdrive-document-share

- [Social Pulse Bridge](https://github.com/kodera-hq/kodera/blob/main/extensions/social-pulse-bridge/manifest.json): social-pulse-bridge

- [Frame.io Review Bridge](https://github.com/kodera-hq/kodera/blob/main/extensions/frameio-review-bridge/README.md): frameio-review-bridge

- [Frame.io Timecode & OTIO](https://github.com/kodera-hq/kodera/blob/main/extensions/frameio/README.md): frameio

- [Render-Farm Monitor (Flamenco & Deadline)](https://github.com/kodera-hq/kodera/blob/main/extensions/renderfarm/README.md): renderfarm

- [GitHub Dev & PR Bridge](https://github.com/kodera-hq/kodera/blob/main/extensions/github/README.md): github

- [GitLab MR & Pipeline Bridge](https://github.com/kodera-hq/kodera/blob/main/extensions/gitlab/README.md): gitlab

- [Linear Issue & Cycle Triage](https://github.com/kodera-hq/kodera/blob/main/extensions/linear/README.md): linear

- [Sentry Issue & Regression Triage](https://github.com/kodera-hq/kodera/blob/main/extensions/sentry/README.md): sentry

- [Alertmanager & Grafana Incident Bridge](https://github.com/kodera-hq/kodera/blob/main/extensions/alertmanager/README.md): alertmanager

- [RSS & Security Advisories Digest](https://github.com/kodera-hq/kodera/blob/main/extensions/rss-advisories/README.md): rss-advisories

- [Release Notes & Triage Assistant](https://github.com/kodera-hq/kodera/blob/main/extensions/release-assistant/README.md): release-assistant

- [OpenProject & Jira Work Bridge](https://github.com/kodera-hq/kodera/blob/main/extensions/openproject/README.md): openproject

- [Cal.com Scheduling & Voice Bridge](https://github.com/kodera-hq/kodera/blob/main/extensions/calcom/README.md): calcom

- [Billing & Quota Ops Webhooks](https://github.com/kodera-hq/kodera/blob/main/extensions/billing-webhooks/README.md): billing-webhooks

## Sources

- [packages/extension-sdk/README.md](https://github.com/kodera-hq/kodera/blob/main/packages/extension-sdk/README.md)

- [extensions/frameio-review-bridge/README.md](https://github.com/kodera-hq/kodera/blob/main/extensions/frameio-review-bridge/README.md)
