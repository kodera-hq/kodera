const messages = {
  en: {
    workspaces: 'Workspaces',
    communitySupport: 'Community & Support',
    create: '+ Create or configure a workspace',
    admin: 'Workspace administration…',
    settings: 'Personal settings…',
    extensions: 'Connectors & extensions',
    appearance: 'Theme & appearance',
    light: 'Light',
    dark: 'Dark',
    black: 'OLED black',
    studio: 'Theme Studio',
    hosting: 'Hosting & plan',
    developer: 'Developer documentation & API',
  },
  fr: {
    workspaces: 'Espaces de travail',
    communitySupport: 'Communauté & Support',
    create: '+ Créer ou configurer un nouvel espace',
    admin: 'Administration de l’espace…',
    settings: 'Paramètres personnels…',
    extensions: 'Connecteurs & Extensions',
    appearance: 'Thème & Apparence',
    light: 'Clair',
    dark: 'Sombre',
    black: 'Noir OLED',
    studio: 'Theme Studio',
    hosting: 'Hébergement & Offre',
    developer: 'Documentation Développeur & API',
  },
} as const
export function workspaceMenuCopy(language: string | undefined) {
  return language?.startsWith('en') ? messages.en : messages.fr
}
