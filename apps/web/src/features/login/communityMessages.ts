const messages = {
  en: {
    title: 'Kodera Community',
    subtitle: 'Meet the community, share what you build, and get help from the Kodera team.',
    signIn: 'Sign in',
    signUp: 'Create an account',
    hint: 'Your account gives you access to the community and its support channels.',
    dedicatedOrgSignIn: 'Dedicated organisation sign-in',
    mfaTitle: 'Two-factor authentication required',
    mfaBody:
      'Administrator and owner access to Kodera Community requires two-factor authentication. Set up an authenticator app on your account, or sign in again with your 2FA code if it is already configured.',
    mfaConfigure: 'Set up two-factor authentication',
    mfaVerify: 'Sign in with my 2FA code',
    mfaSignOut: 'Sign out',
    pending: 'Opening secure sign-in…',
    error: 'Sign-in could not start. Please try again.',
  },
  fr: {
    title: 'Kodera Community',
    subtitle: 'Rencontrez la communauté, partagez vos projets et échangez avec l’équipe Kodera.',
    signIn: 'Se connecter',
    signUp: 'Créer un compte',
    hint: 'Votre compte vous donne accès à la communauté et à ses salons de support.',
    dedicatedOrgSignIn: 'Connexion organisation dédiée',
    mfaTitle: 'Double authentification requise',
    mfaBody:
      'L’accès administrateur ou propriétaire à Kodera Community requiert la double authentification. Configurez une application d’authentification sur votre compte, ou reconnectez-vous avec votre code 2FA s’il est déjà activé.',
    mfaConfigure: 'Configurer la double authentification',
    mfaVerify: 'Vérifier avec mon code 2FA',
    mfaSignOut: 'Se déconnecter',
    pending: 'Ouverture de la connexion sécurisée…',
    error: 'La connexion n’a pas pu démarrer. Réessayez.',
  },
} as const
export const communityCopy = (language: string | undefined) =>
  language?.startsWith('en') ? messages.en : messages.fr
