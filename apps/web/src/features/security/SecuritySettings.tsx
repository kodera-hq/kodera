import { LINK_TEXT } from '../../ui/linkText'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuthLifetime } from '../../auth/AuthProvider'
import { registerSecuritySessionCleanup } from './localSecuritySession'
import { Button } from '../../ui/Button/Button'
import { LinkButton } from '../../ui/LinkButton/LinkButton'
import { TextField } from '../../ui/TextField/TextField'
import { InlineAlert } from '../../ui/InlineAlert/InlineAlert'
import { PAGE_TITLE } from '../../ui/pageTitle'
import { createCrossSigningClient } from '../confidential/cross-signing-client'
import type {
  Endorsement,
  PublicEndorser,
  SecurityCodes,
} from '../confidential/cross-signing-client'
import { createKeyBackupClient } from '../confidential/key-backup-client'
import {
  discardConfidentialKeyBackup,
  encodeCapsuleBase64,
  getConfidentialKeyBackup,
  publishConfidentialKeyBackup,
  type ConfidentialKeyBackupPublishBody,
  type ConfidentialKeyBackupPublished,
  type ConfidentialKeyBackupRemote,
} from '../confidential/key-backup-http'
import { createBackupVaultClient } from '../confidential/key-backup-vault-client'

export type KeyBackupDeviceSigner = (unsignedBody: {
  readonly backupEpoch: number
  readonly capsule: string
}) => Promise<ConfidentialKeyBackupPublishBody>

export interface SecuritySettingsProps {
  org?: string | undefined
  organisationId: string
  accountId: string
  membershipId: string
  deviceSigner?: KeyBackupDeviceSigner | undefined
}
interface Session {
  cross: ReturnType<typeof createCrossSigningClient>
  backup: ReturnType<typeof createKeyBackupClient>
  vault: ReturnType<typeof createBackupVaultClient>
  identity: PublicEndorser
  stamp: object
  active: boolean
  backupEpoch: number
}
export default function SecuritySettings(props: SecuritySettingsProps) {
  const { t, i18n } = useTranslation(),
    lifetime = useAuthLifetime()
  const isEnglish = i18n.resolvedLanguage?.startsWith('en') === true
  const mfaHref = props.org ? `/${props.org}/security/mfa` : '/security/mfa'
  const revision = useRef(0)
  const current = useRef<Session | null>(null),
    downloadUrl = useRef<string | null>(null)
  const [identity, setIdentity] = useState<PublicEndorser | null>(null)
  const [available, setAvailable] = useState(false),
    [busy, setBusy] = useState(false)
  const [error, setError] = useState(false),
    [success, setSuccess] = useState(false)
  const [peer, setPeer] = useState(''),
    [nonce, setNonce] = useState(''),
    [peerCodes, setPeerCodes] = useState('')
  const [codes, setCodes] = useState<SecurityCodes | null>(null),
    [endorsement, setEndorsement] = useState<Endorsement | null>(null)
  const [peerEndorsement, setPeerEndorsement] = useState(''),
    [verified, setVerified] = useState(false)
  const [mode, setMode] = useState<'recovery-key' | 'passphrase'>('recovery-key')
  const [passphrase, setPassphrase] = useState(''),
    [recovery, setRecovery] = useState('')
  const [saved, setSaved] = useState(false),
    [archive, setArchive] = useState<string | null>(null)
  const [imported, setImported] = useState<Uint8Array | null>(null),
    [restoreKey, setRestoreKey] = useState('')
  const [remoteBackup, setRemoteBackup] = useState<ConfidentialKeyBackupRemote | null>(null),
    [publishedMeta, setPublishedMeta] = useState<ConfidentialKeyBackupPublished | null>(null),
    [discardedNextEpoch, setDiscardedNextEpoch] = useState<number | null>(null)
  const sealedCapsuleRef = useRef<{ bytes: Uint8Array; epoch: number } | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  function clearSealedCapsule() {
    if (sealedCapsuleRef.current) {
      sealedCapsuleRef.current.bytes.fill(0)
      sealedCapsuleRef.current = null
    }
  }
  function revokeUrl() {
    if (downloadUrl.current) URL.revokeObjectURL(downloadUrl.current)
    downloadUrl.current = null
  }
  useEffect(() => {
    const stamp = lifetime.getRetirementStamp()
    const retire = () => {
      revision.current++
      const session = current.current
      current.current = null
      if (session) {
        session.active = false
        session.cross.close()
        session.backup.close()
        session.vault.close()
      }
      revokeUrl()
      clearSealedCapsule()
      if (fileInput.current) fileInput.current.value = ''
      setIdentity(null)
      setAvailable(false)
      setCodes(null)
      setEndorsement(null)
      setVerified(false)
      setPeer('')
      setNonce('')
      setPeerCodes('')
      setPeerEndorsement('')
      setPassphrase('')
      setRecovery('')
      setRestoreKey('')
      setArchive(null)
      setImported(null)
      setRemoteBackup(null)
      setPublishedMeta(null)
      setDiscardedNextEpoch(null)
      setSaved(false)
      setBusy(false)
      setSuccess(false)
    }
    const unregister = registerSecuritySessionCleanup(retire)
    const unsubscribe = lifetime.subscribe(() => {
      if (!lifetime.hasUsableCredential() || lifetime.getRetirementStamp() !== stamp) retire()
    })
    return () => {
      unregister()
      unsubscribe()
      retire()
    }
  }, [lifetime, props.accountId, props.organisationId, props.membershipId])
  function live(session: Session): boolean {
    return (
      session.active &&
      current.current === session &&
      lifetime.hasUsableCredential() &&
      lifetime.getRetirementStamp() === session.stamp
    )
  }
  async function run(action: (session: Session) => Promise<void>) {
    const session = current.current
    if (busy || !session || !live(session)) return
    setBusy(true)
    setError(false)
    setSuccess(false)
    try {
      await action(session)
    } catch {
      if (live(session)) setError(true)
    } finally {
      if (live(session)) setBusy(false)
    }
  }
  async function start() {
    if (busy || current.current || !lifetime.hasUsableCredential()) return
    setBusy(true)
    setError(false)
    let cross: Session['cross'] | undefined,
      vault: Session['vault'] | undefined,
      backup: Session['backup'] | undefined
    const stamp = lifetime.getRetirementStamp(),
      version = revision.current
    try {
      const remoteLookup = await getConfidentialKeyBackup(props.organisationId).catch(() => null)
      cross = createCrossSigningClient({
        organisationId: props.organisationId,
        accountId: props.accountId,
        deviceId: crypto.randomUUID(),
      })
      const probeContext = {
        organisationId: props.organisationId,
        accountId: props.accountId,
        backupEpoch:
          remoteLookup?.status === 'active'
            ? remoteLookup.backup.backupEpoch
            : (remoteLookup?.nextBackupEpoch ?? 1),
      }
      vault = createBackupVaultClient({ ...probeContext, membershipId: props.membershipId })
      backup = createKeyBackupClient(probeContext, vault.vaultPort)
      const publicIdentity = await cross.publicIdentity(),
        status = await vault.status()
      let activeEpoch = probeContext.backupEpoch
      if (remoteLookup?.status === 'active' && status.available) {
        activeEpoch = remoteLookup.backup.backupEpoch + 1
        await backup.advanceEpoch?.(activeEpoch)
      }
      if (
        revision.current !== version ||
        !lifetime.hasUsableCredential() ||
        lifetime.getRetirementStamp() !== stamp
      )
        throw new Error('Session changed.')
      const session: Session = {
        cross,
        vault,
        backup,
        identity: publicIdentity,
        active: true,
        stamp,
        backupEpoch: activeEpoch,
      }
      current.current = session
      setIdentity(publicIdentity)
      setAvailable(status.available)
      if (remoteLookup?.status === 'active') {
        setRemoteBackup(remoteLookup.backup)
        if (!status.available) setMode(remoteLookup.backup.kdfKind)
      } else {
        setRemoteBackup(null)
      }
      setNonce(btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))))
    } catch {
      cross?.close()
      vault?.close()
      backup?.close()
      if (revision.current === version) setError(true)
    } finally {
      if (revision.current === version) setBusy(false)
    }
  }
  const invalidateComparison = () => {
    setCodes(null)
    setPeerCodes('')
    setEndorsement(null)
    setVerified(false)
  }
  async function compare(session: Session) {
    const target = JSON.parse(peer) as PublicEndorser
    const result = await session.cross.securityCodes({
      organisationId: props.organisationId,
      accountId: props.accountId,
      deviceA: { id: session.identity.id, pub: session.identity.pub },
      deviceB: { id: target.id, pub: target.pub },
      sessionNonce: nonce,
    })
    if (live(session)) {
      setCodes(result)
      setPeerCodes('')
      setEndorsement(null)
    }
  }
  async function endorse(session: Session) {
    if (!codes || peerCodes !== codes.decimal.join(' ')) return
    const target = JSON.parse(peer) as PublicEndorser
    const result = await session.cross.endorse({ id: target.id, pub: target.pub })
    if (live(session)) setEndorsement(result)
  }
  async function verify(session: Session) {
    const result = await session.cross.verify(
      JSON.parse(peerEndorsement) as Endorsement,
      JSON.parse(peer) as PublicEndorser,
      { id: session.identity.id, pub: session.identity.pub }
    )
    if (live(session)) setVerified(result)
  }
  async function seal(session: Session) {
    revokeUrl()
    clearSealedCapsule()
    setArchive(null)
    setRecovery('')
    setSaved(false)
    setPublishedMeta(null)
    setDiscardedNextEpoch(null)
    const options =
      mode === 'passphrase'
        ? { kind: 'passphrase' as const, passphrase, iterations: 600_000 }
        : { kind: 'recovery-key' as const }
    setPassphrase('')
    const sealEpoch = session.backupEpoch
    const result = await session.backup.seal(options)
    if (!live(session)) return
    sealedCapsuleRef.current = { bytes: result.capsule.slice(), epoch: sealEpoch }
    const url = URL.createObjectURL(
      new Blob([result.capsule], { type: 'application/octet-stream' })
    )
    downloadUrl.current = url
    setArchive(url)
    setRecovery(result.recoveryKey ?? '')
    setSaved(result.recoveryKey === null)
  }
  async function publishToServer(session: Session) {
    const pending = sealedCapsuleRef.current
    if (!pending || !props.deviceSigner || !saved) return
    const capsuleB64 = encodeCapsuleBase64(pending.bytes)
    const signed = await props.deviceSigner({
      backupEpoch: pending.epoch,
      capsule: capsuleB64,
    })
    const published = await publishConfidentialKeyBackup(props.organisationId, signed)
    if (!live(session)) return
    const nextEpoch = published.backupEpoch + 1
    await session.backup.advanceEpoch?.(nextEpoch)
    session.backupEpoch = nextEpoch
    const retainedBytes = pending.bytes.slice()
    clearSealedCapsule()
    setPublishedMeta(published)
    setDiscardedNextEpoch(null)
    setRemoteBackup({
      ...published,
      capsule: capsuleB64,
      capsuleBytes: retainedBytes,
    })
  }
  async function restore(session: Session) {
    if (!imported || available) return
    const options =
      mode === 'passphrase'
        ? { kind: 'passphrase' as const, passphrase }
        : { kind: 'recovery-key' as const, recoveryKey: restoreKey }
    setPassphrase('')
    setRestoreKey('')
    await session.backup.restore(imported, options)
    if (live(session)) {
      setAvailable(true)
      setImported(null)
      if (fileInput.current) fileInput.current.value = ''
      setSuccess(true)
    }
  }
  async function restoreFromServer(session: Session) {
    if (!remoteBackup || available) return
    const options =
      mode === 'passphrase'
        ? { kind: 'passphrase' as const, passphrase }
        : { kind: 'recovery-key' as const, recoveryKey: restoreKey }
    setPassphrase('')
    setRestoreKey('')
    await session.backup.restore(remoteBackup.capsuleBytes, options)
    if (live(session)) {
      const nextEpoch = remoteBackup.backupEpoch + 1
      await session.backup.advanceEpoch?.(nextEpoch)
      session.backupEpoch = nextEpoch
      setAvailable(true)
      setImported(null)
      if (fileInput.current) fileInput.current.value = ''
      setSuccess(true)
    }
  }
  async function discardServerBackup(session: Session) {
    if (!remoteBackup) return
    const previousEpoch = remoteBackup.backupEpoch
    const result = await discardConfidentialKeyBackup(props.organisationId)
    if (!live(session)) return
    const nextEpoch = result.nextBackupEpoch ?? previousEpoch + 1
    if (nextEpoch > session.backupEpoch) {
      await session.backup.advanceEpoch?.(nextEpoch)
      session.backupEpoch = nextEpoch
    }
    remoteBackup.capsuleBytes.fill(0)
    setRemoteBackup(null)
    setPublishedMeta(null)
    setDiscardedNextEpoch(nextEpoch)
  }
  const section = 'flex flex-col gap-4 rounded-lg border border-c-border bg-c-surface p-6'
  return (
    <div className="flex flex-col gap-6">
      <h1 className={PAGE_TITLE}>{t('console.security.settings.title')}</h1>
      <InlineAlert kind="info">{t('console.security.settings.status')}</InlineAlert>
      {error && <InlineAlert kind="warning">{t('console.security.settings.error')}</InlineAlert>}
      {success && <p role="status">{t('console.security.settings.restored')}</p>}
      {!identity && (
        <Button className="w-fit self-start" disabled={busy} onClick={() => void start()}>
          {t('console.security.settings.start')}
        </Button>
      )}
      <section className={section} aria-labelledby="mfa-settings-title">
        <h2 id="mfa-settings-title" className="text-xl font-semibold text-c-ink">
          {isEnglish ? 'Two-factor authentication (2FA)' : 'Double authentification (2FA)'}
        </h2>
        <p className="text-sm text-c-ink-2">
          {isEnglish
            ? 'Protect your Kodera account with an authenticator app (TOTP) or a hardware security key.'
            : 'Protégez votre compte Kodera avec une application d’authentification (TOTP) ou une clé de sécurité matérielle.'}
        </p>
        <LinkButton
          href={mfaHref}
          variant="secondary"
          data-testid="security-mfa-link"
          className="w-fit self-start"
        >
          {isEnglish ? 'Configure two-factor authentication' : 'Configurer la double authentification'}
        </LinkButton>
      </section>
      <section className={section} aria-labelledby="verification-title">
        <h2 id="verification-title" className="text-xl font-semibold text-c-ink">
          {t('console.security.settings.verification')}
        </h2>
        <p>{t('console.security.settings.verification-help')}</p>
        {identity && (
          <>
            <TextField
              label={t('console.security.settings.local-identity')}
              value={JSON.stringify(identity)}
              readOnly
            />
            <TextField
              label={t('console.security.settings.peer')}
              value={peer}
              disabled={busy}
              onChange={(e) => {
                setPeer(e.target.value)
                invalidateComparison()
              }}
            />
            <TextField
              label={t('console.security.settings.nonce')}
              value={nonce}
              disabled={busy}
              onChange={(e) => {
                setNonce(e.target.value)
                invalidateComparison()
              }}
            />
            <Button disabled={busy || !peer || !nonce} onClick={() => void run(compare)}>
              {t('console.security.settings.compare')}
            </Button>
            {codes && (
              <>
                <output
                  className="font-mono text-lg break-words text-c-ink"
                  aria-label={t('console.security.settings.codes')}
                >
                  {codes.decimal.join(' ')}
                </output>
                <p className="text-c-ink-2">{codes.symbols.join(' · ')}</p>
                <TextField
                  label={t('console.security.settings.peer-codes')}
                  value={peerCodes}
                  disabled={busy}
                  onChange={(e) => setPeerCodes(e.target.value)}
                />
                <Button
                  disabled={busy || peerCodes !== codes.decimal.join(' ')}
                  onClick={() => void run(endorse)}
                >
                  {t('console.security.settings.endorse')}
                </Button>
              </>
            )}
            {endorsement && (
              <TextField
                label={t('console.security.settings.endorsement')}
                value={JSON.stringify(endorsement)}
                readOnly
              />
            )}
            <TextField
              label={t('console.security.settings.peer-endorsement')}
              value={peerEndorsement}
              disabled={busy}
              onChange={(e) => {
                setPeerEndorsement(e.target.value)
                setVerified(false)
              }}
            />
            <Button disabled={busy || !peer || !peerEndorsement} onClick={() => void run(verify)}>
              {t('console.security.settings.verify')}
            </Button>
            {verified && <p role="status">{t('console.security.settings.verified')}</p>}
          </>
        )}
      </section>
      <section className={section} aria-labelledby="backup-title">
        <h2 id="backup-title" className="text-xl font-semibold text-c-ink">
          {t('console.security.settings.backup')}
        </h2>
        <p>{t('console.security.settings.backup-help')}</p>
        {identity && (
          <>
            <p role="status">
              {t(
                available
                  ? 'console.security.settings.vault-present'
                  : 'console.security.settings.vault-absent'
              )}
            </p>
            <fieldset className="flex flex-col gap-2" disabled={busy}>
              <legend>{t('console.security.settings.mode')}</legend>
              <label>
                <input
                  type="radio"
                  name="backup-mode"
                  checked={mode === 'recovery-key'}
                  onChange={() => {
                    setMode('recovery-key')
                    setPassphrase('')
                  }}
                />{' '}
                {t('console.security.settings.recovery-mode')}
              </label>
              <label>
                <input
                  type="radio"
                  name="backup-mode"
                  checked={mode === 'passphrase'}
                  onChange={() => {
                    setMode('passphrase')
                    setRestoreKey('')
                  }}
                />{' '}
                {t('console.security.settings.passphrase-mode')}
              </label>
            </fieldset>
            {mode === 'passphrase' && (
              <TextField
                label={t('console.security.settings.passphrase')}
                help={t('console.security.settings.passphrase-help')}
                type="password"
                autoComplete="off"
                value={passphrase}
                disabled={busy}
                onChange={(e) => setPassphrase(e.target.value)}
              />
            )}
            <Button
              disabled={busy || !available || (mode === 'passphrase' && passphrase.length < 12)}
              onClick={() => void run(seal)}
            >
              {t('console.security.settings.seal')}
            </Button>
            {recovery && (
              <div className="flex flex-col gap-3">
                <TextField
                  label={t('console.security.settings.recovery-key')}
                  help={t('console.security.settings.recovery-help')}
                  value={recovery}
                  readOnly
                  autoComplete="off"
                />
                <Button
                  disabled={busy}
                  onClick={() => {
                    void navigator.clipboard.writeText(recovery).catch(() => setError(true))
                  }}
                >
                  {t('console.security.settings.copy')}
                </Button>
                <label>
                  <input
                    type="checkbox"
                    checked={saved}
                    onChange={(e) => setSaved(e.target.checked)}
                  />{' '}
                  {t('console.security.settings.saved')}
                </label>
                <Button disabled={!saved} onClick={() => setRecovery('')}>
                  {t('console.security.settings.dismiss')}
                </Button>
              </div>
            )}
            {archive && saved && (
              <div className="flex flex-wrap items-center gap-3">
                <a
                  className={LINK_TEXT.standalone}
                  href={archive}
                  download="kodera-key-backup.kvkb"
                >
                  {t('console.security.settings.download')}
                </a>
                {props.deviceSigner && !publishedMeta && (
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() => void run(publishToServer)}
                  >
                    {t('console.security.settings.server-backup-publish')}
                  </Button>
                )}
              </div>
            )}
            {publishedMeta && (
              <p role="status">
                {t('console.security.settings.server-backup-published', {
                  epoch: publishedMeta.backupEpoch,
                })}
              </p>
            )}
            {discardedNextEpoch !== null && (
              <p role="status">
                {t('console.security.settings.server-backup-discarded', {
                  epoch: discardedNextEpoch,
                })}
              </p>
            )}
            {remoteBackup && (
              <div className="flex flex-col gap-3 rounded-md border border-c-border p-4">
                <p role="status">
                  {t('console.security.settings.server-backup-active', {
                    epoch: remoteBackup.backupEpoch,
                    mode: remoteBackup.kdfKind,
                  })}
                </p>
                <div className="flex flex-wrap gap-3">
                  {!available && (
                    <Button
                      disabled={
                        busy ||
                        (mode === 'passphrase' ? passphrase.length < 12 : !restoreKey)
                      }
                      onClick={() => void run(restoreFromServer)}
                    >
                      {t('console.security.settings.server-backup-restore')}
                    </Button>
                  )}
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() => void run(discardServerBackup)}
                  >
                    {t('console.security.settings.server-backup-discard')}
                  </Button>
                </div>
              </div>
            )}
            <TextField
              ref={fileInput}
              type="file"
              accept=".kvkb"
              label={t('console.security.settings.import')}
              disabled={busy || available}
              onChange={(event) => {
                const file = event.target.files?.[0],
                  session = current.current
                setImported(null)
                setError(false)
                if (!file || !session || !live(session)) return
                if (file.size > 20 * 1024 * 1024 + 4096 || !file.name.endsWith('.kvkb')) {
                  setError(true)
                  return
                }
                void file
                  .arrayBuffer()
                  .then((bytes) => {
                    if (live(session)) setImported(new Uint8Array(bytes))
                  })
                  .catch(() => {
                    if (live(session)) setError(true)
                  })
              }}
            />
            {mode === 'recovery-key' && (
              <TextField
                label={t('console.security.settings.restore-key')}
                type="password"
                autoComplete="off"
                value={restoreKey}
                disabled={busy || available}
                onChange={(e) => setRestoreKey(e.target.value)}
              />
            )}
            <Button
              disabled={
                busy ||
                available ||
                !imported ||
                (mode === 'passphrase' ? passphrase.length < 12 : !restoreKey)
              }
              onClick={() => void run(restore)}
            >
              {t('console.security.settings.restore')}
            </Button>
          </>
        )}
      </section>
    </div>
  )
}
