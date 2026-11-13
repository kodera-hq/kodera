/** Fixed application settings; provider credentials are never admitted here. */
export function configuration(environment) {
  const fail = () => { throw new Error('collaboration configuration refused') }
  const admitted = new Set(['KODERA_COLLAB_TICKET_KEY', 'GPG_KEY'])
  for (const name of Object.keys(environment)) {
    if (/(?:^|_)(?:API)?KEYS?(?:_|$)|APIKEY|SECRET|PASSW(?:OR)?D|TOKEN|CREDENTIAL|PRIVATE|(?:^|_)PAT(?:_|$)/i.test(name) && !admitted.has(name)) fail()
  }
  const encoded = environment.KODERA_COLLAB_TICKET_KEY
  if (typeof encoded !== 'string' || !/^[A-Za-z0-9_-]+={0,2}$/.test(encoded)) fail()
  const key = Buffer.from(encoded, 'base64url')
  const stripped = encoded.endsWith('==') ? encoded.slice(0, -2) : encoded.endsWith('=') ? encoded.slice(0, -1) : encoded
  if (key.length !== 32 || key.toString('base64url') !== stripped) fail()
  const connectionString = environment.DATABASE_URL
  try {
    const database = new URL(connectionString)
    if (!['postgres:', 'postgresql:'].includes(database.protocol) || !database.hostname || !database.username || !database.password || database.pathname === '/') fail()
  } catch { fail() }
  const declared = environment.KODERA_COLLAB_ALLOWED_ORIGINS
  if (typeof declared !== 'string') fail()
  const origins = new Set(declared.split(','))
  if (origins.size < 1 || origins.size > 8) fail()
  for (const entry of origins) {
    try {
      const value = new URL(entry)
      if (value.protocol !== 'https:' || value.origin !== entry || value.hostname.includes('*')) fail()
    } catch { fail() }
  }
  const port = environment.KODERA_COLLAB_PORT === undefined ? 8098 : Number(environment.KODERA_COLLAB_PORT)
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail()
  return {key, connectionString, origins, port}
}
