import { securityWorkerClient } from './security-worker-client'
import type { BackupContext } from './key-backup-client'

export interface BackupVaultContext extends BackupContext {
  readonly membershipId: string
}
export function createBackupVaultClient(context: BackupVaultContext) {
  const channel = new MessageChannel()
  const client = securityWorkerClient(
    new Worker(new URL('./key-backup-vault.worker.ts', import.meta.url), {
      type: 'module',
      name: 'backup-vault',
    }),
    context,
    channel.port2
  )
  return Object.freeze({
    vaultPort: channel.port1,
    close: () => {
      channel.port1.close()
      client.close()
    },
    status: () =>
      client.run('status', null) as Promise<{
        readonly available: boolean
        readonly devicePublicKey: string | null
      }>,
  })
}
