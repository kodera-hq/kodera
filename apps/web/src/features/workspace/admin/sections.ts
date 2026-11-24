// The two settings surfaces (issue 211): what a person sets for themselves, and what an
// administrator sets for the whole workspace. A section belongs to exactly one of them.

export const PERSONAL_SECTIONS = [
  'profile',
  'security',
  'appearance',
  'audio',
  'notifications',
  'privacy',
  'shortcuts',
  'labs',
] as const

export const ADMIN_SECTIONS = [
  'overview',
  'members',
  'roles',
  'channels',
  'invites',
  'extensions',
  'posture',
  'moderation',
  'governance',
  'audit',
  'community',
  'quotas',
  'hosting',
] as const

export type PersonalSection = (typeof PERSONAL_SECTIONS)[number]
export type AdminSection = (typeof ADMIN_SECTIONS)[number]
export type Section = PersonalSection | AdminSection
export type SettingsMode = 'personal' | 'admin'

const ALL: readonly string[] = [...PERSONAL_SECTIONS, ...ADMIN_SECTIONS]

export function isSection(value: unknown): value is Section {
  return typeof value === 'string' && ALL.includes(value)
}

export function isAdminSection(value: unknown): value is AdminSection {
  return typeof value === 'string' && (ADMIN_SECTIONS as readonly string[]).includes(value)
}

export function modeOf(section: Section): SettingsMode {
  return (PERSONAL_SECTIONS as readonly string[]).includes(section) ? 'personal' : 'admin'
}

/** The categories of the administration rail, in reading order. */
export const ADMIN_GROUPS: readonly {
  key: 'workspace' | 'people' | 'safety' | 'platform'
  items: readonly AdminSection[]
}[] = [
  { key: 'workspace', items: ['overview', 'community', 'channels', 'extensions'] },
  { key: 'people', items: ['members', 'roles', 'invites'] },
  { key: 'safety', items: ['posture', 'moderation', 'governance', 'audit'] },
  { key: 'platform', items: ['quotas', 'hosting'] },
]

/** What a delegated manager (an assigned `manage_roles` / `view_audit_log`) may open. */
export function delegatedSections(capabilities: {
  manageRoles: boolean
  viewAudit: boolean
}): AdminSection[] {
  return [
    ...(capabilities.manageRoles ? (['members', 'roles', 'channels'] as const) : []),
    ...(capabilities.viewAudit ? (['audit'] as const) : []),
  ]
}
