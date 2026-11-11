const messages = {
  en: {
    title: 'Kodera Community',
    subtitle: 'Meet the community, share what you build, and get help from the Kodera team.',
    signIn: 'Sign in',
    signUp: 'Create an account',
    hint: 'Your account gives you access to the community and its support channels.',
    pending: 'Opening secure sign-in…',
    error: 'Sign-in could not start. Please try again.',
  },
  fr: {
    title: 'Kodera Community',
    subtitle: 'Rencontrez la communauté, partagez vos projets et échangez avec l’équipe Kodera.',
    signIn: 'Se connecter',
    signUp: 'Créer un compte',
    hint: 'Votre compte vous donne accès à la communauté et à ses salons de support.',
    pending: 'Ouverture de la connexion sécurisée…',
    error: 'La connexion n’a pas pu démarrer. Réessayez.',
  },
} as const
export const communityCopy = (language: string | undefined) =>
  language?.startsWith('en') ? messages.en : messages.fr
