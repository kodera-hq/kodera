const messages = {
  en: {
    title: 'Test a webhook signature',
    hint: 'Sign and verify a sample locally. Nothing is sent to the destination URL. The secret stays in memory until this panel closes.',
    secret: 'Test signing secret',
    generate: 'Generate a test secret',
    payload: 'Raw JSON body',
    timestamp: 'x-kodera-timestamp (Unix seconds)',
    signature: 'x-kodera-signature-256',
    sign: 'Sign sample',
    verify: 'Verify signature',
    clear: 'Clear test',
    signed: 'Sample signed. You can edit the body or headers to test verification.',
    verified: 'Signature verified. The JSON object and timestamp are valid.',
    protocol:
      'HMAC-SHA256 over timestamp.body; v1=hex signature. Verification accepts timestamps within 5 minutes. This local tester does not track duplicate deliveries.',
    errors: {
      INVALID_SECRET: 'Use a test secret with at least 16 characters.',
      INVALID_TIMESTAMP: 'Enter a non-negative whole Unix timestamp without leading zeroes.',
      TIMESTAMP_OUT_OF_RANGE:
        'The timestamp must be within 5 minutes of now. Sign the sample again.',
      SIGNATURE_MISMATCH: 'The signature does not match the secret, timestamp, and exact body.',
      INVALID_JSON: 'The signed body must be a valid JSON object.',
      UNAVAILABLE:
        'Cryptographic operations are unavailable. Open this page over HTTPS or localhost.',
    },
  },
  fr: {
    title: 'Tester une signature de webhook',
    hint: 'Signez et vérifiez un exemple localement. Rien n’est envoyé à l’URL de destination. Le secret reste en mémoire jusqu’à la fermeture de ce panneau.',
    secret: 'Secret de signature de test',
    generate: 'Générer un secret de test',
    payload: 'Corps JSON brut',
    timestamp: 'x-kodera-timestamp (secondes Unix)',
    signature: 'x-kodera-signature-256',
    sign: 'Signer l’exemple',
    verify: 'Vérifier la signature',
    clear: 'Effacer le test',
    signed:
      'Exemple signé. Vous pouvez modifier le corps ou les en-têtes pour tester la vérification.',
    verified: 'Signature vérifiée. L’objet JSON et l’horodatage sont valides.',
    protocol:
      'HMAC-SHA256 sur timestamp.body ; signature v1=hex. La vérification accepte un écart de 5 minutes. Ce testeur local ne suit pas les livraisons en double.',
    errors: {
      INVALID_SECRET: 'Utilisez un secret de test d’au moins 16 caractères.',
      INVALID_TIMESTAMP: 'Saisissez un horodatage Unix entier positif ou nul, sans zéro initial.',
      TIMESTAMP_OUT_OF_RANGE:
        'L’horodatage doit dater de moins de 5 minutes. Signez à nouveau l’exemple.',
      SIGNATURE_MISMATCH:
        'La signature ne correspond pas au secret, à l’horodatage et au corps exact.',
      INVALID_JSON: 'Le corps signé doit être un objet JSON valide.',
      UNAVAILABLE:
        'La cryptographie est indisponible. Ouvrez cette page en HTTPS ou sur localhost.',
    },
  },
} as const

export function webhookTesterCopy(language: string | undefined) {
  return language?.startsWith('en') ? messages.en : messages.fr
}
