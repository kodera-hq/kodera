const messages = {
  en: {
    workspaces: 'Workspaces',
    create: '+ Create / configure a workspace',
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
    create: '+ Créer / Configurer un nouvel espace',
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
