import { securityWorkerClient } from './security-worker-client'
import type { VerificationPrincipal } from './cross-signing-client'

export interface BackupContext extends VerificationPrincipal {
  readonly backupEpoch: number
}
export type BackupSealOptions =
  | Readonly<{ kind: 'recovery-key' }>
  | Readonly<{ kind: 'passphrase'; passphrase: string; iterations: number }>
export type BackupOpenOptions =
  | Readonly<{ kind: 'recovery-key'; recoveryKey: string }>
  | Readonly<{ kind: 'passphrase'; passphrase: string }>
export interface SealedBackup {
  readonly capsule: Uint8Array<ArrayBuffer>
  readonly recoveryKey: string | null
}
/** vaultPort must be transferred from the vault worker; this API has no plaintext parameter/result. */
export function createKeyBackupClient(context: BackupContext, vaultPort: MessagePort) {
  const client = securityWorkerClient(
    new Worker(new URL('./key-backup.worker.ts', import.meta.url), {
      type: 'module',
      name: 'key-backup',
    }),
    context,
    vaultPort
  )
  return Object.freeze({
    close: client.close,
    seal: (options: BackupSealOptions) => client.run('seal', options) as Promise<SealedBackup>,
    restore: (capsule: Uint8Array, options: BackupOpenOptions, backupEpoch?: number) =>
      client.run(
        'restore',
        backupEpoch === undefined ? { capsule, options } : { capsule, options, backupEpoch }
      ) as Promise<boolean>,
    advanceEpoch: (backupEpoch: number) =>
      client.run('advance-epoch', { backupEpoch }) as Promise<number>,
  })
}
