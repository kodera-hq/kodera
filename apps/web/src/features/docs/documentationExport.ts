import content from './developerDocsContent.json' with { type: 'json' }
export { content as developerDocsContent }
export type DeveloperDocPage = (typeof content.pages.en)[number]
export type DeveloperDocId = 'quickstart' | 'extensions' | 'api' | 'security'
export type { CommunityChannelId } from './communityStructure'
export function documentationPages(language?: string): readonly DeveloperDocPage[] {
  return content.pages[language?.startsWith('fr') ? 'fr' : 'en']
}
export function sourceUrl(path: string) {
  return `${content.repository}/blob/main/${path.split('/').map(encodeURIComponent).join('/')}`
}
export function exportDocumentationPage(page: DeveloperDocPage): string {
  const labels = content.exportLabels[page.locale === 'fr' ? 'fr' : 'en']
  const parts = [`# ${page.title}`, `> ${page.summary}`]
  for (const section of page.sections) {
    parts.push(`## ${section.title}`, ...section.paragraphs)
    if (section.callout) parts.push(`> ${section.callout}`)
    if (section.code)
      parts.push(
        `\`\`\`${section.language === 'TypeScript' ? 'typescript' : 'bash'}\n${section.code}\n\`\`\``
      )
  }
  if (page.id === 'extensions') {
    parts.push(
      `## ${labels.connectors}`,
      ...content.connectors.map((c) => `- [${c.name}](${sourceUrl(c.path)}): ${c.slug}`)
    )
  }
  parts.push(
    `## ${labels.sources}`,
    ...page.sources.map((path) => `- [${path}](${sourceUrl(path)})`)
  )
  return parts.join('\n\n') + '\n'
}
export function buildLlmsText(): string {
  return (
    [
      '# Kodera',
      '> Open-Core organisation workspace: Web, native clients, signed extensions and operator-owned Community deployment.',
      'This is a source-oriented local pre-cutover reference for kodera-hq/kodera. Linked source URLs identify the target repository; public publication and community.kodera.io availability are not confirmed. Read the linked guides for scope and integration limits.',
      `Core API ${content.versions.core}; Agent API ${content.versions.agent}; OpenAPI 3.1. The console calls authenticated Core only. Matrix/Synapse rooms and LiveKit grants are control-plane responsibilities, not local-preview authority.`,
      'Community uses Docker Compose and an external operator-owned HTTPS OIDC issuer/public trust registry. It brings no identity provider. No installation-time or memory-footprint claim is made.',
      'The create-kodera package is a local pre-release. Run node packages/create-kodera/bin/create-kodera.mjs --selftest from a checkout. After publication: npx create-kodera --self-host --domain chat.example.org --oidc-issuer https://id.example.org/realms/studio --oidc-client-id console --template audiovisual-production --dry-run. The kodera-deploy executable aliases the same CLI. The repository shell entry is bash deploy/community/kodera-deploy.sh; real generation requires public-trust.json. Configuration generation does not provision live channels or start services.',
      `@kodera/extension-sdk ${content.versions.sdk} uses HMAC-SHA256, v1= signatures over timestamp.rawBody, a 300-second window, bounded in-memory signature/delivery replay protection and signed body routing metadata. Native GitHub sha256= signs rawBody and is not wire-compatible. Production needs durable idempotency and resolved-address egress policy; lexical SSRF checks do not pin DNS.`,
      `synapse-policy ${content.versions.policy} enforces room policy. kodera-rs provides bounded native identifiers/metadata/codecs and EmergencyFrame v1. Ed25519 verification is not membership or measured proximity; TTL is unsigned. Native MLS/radio/hardware seams are not finished integrations. Web sound synthesis uses 48000 Hz; this is not a shipping Rust audio-hardware claim. kodera-theme:v1: is bounded visual metadata, not encryption or authority.`,
      'Clients/Rust/SDK: Apache-2.0. Server and Synapse policy: AGPL-3.0-or-later. Enterprise Edition: separate commercial licence. Never commit environment secrets, private keys or real tenant identifiers. No secrets belong in prompts, example payloads or theme codes.',
      'Exactly ten official connector implementations are indexed below; this is not a list of live connected accounts. Linear, Stripe and Sentry are potential custom SDK integrations, not additional official connectors in this checkout.',
      '## Developer guides',
      ...content.pages.en.map(
        (page) => `- [${page.title}](/developer-docs/en/${page.id}.md): ${page.summary}`
      ),
      '## French guides',
      ...content.pages.fr.map(
        (page) => `- [${page.title}](/developer-docs/fr/${page.id}.md): ${page.summary}`
      ),
      '## Official connectors',
      ...content.connectors.map((c) => `- [${c.name}](${sourceUrl(c.path)}): ${c.slug}`),
      '## Optional',
      ...[
        'README.md',
        'ARCHITECTURE.md',
        'deploy/community/README.md',
        'packages/extension-sdk/README.md',
        'packages/api-contract/core-api.openapi.yaml',
        'packages/api-contract/agent-api.openapi.yaml',
        'packages/kodera-rs/README.md',
      ].map((path) => `- [${path}](${sourceUrl(path)}): Authoritative repository source.`),
    ].join('\n\n') + '\n'
  )
}
