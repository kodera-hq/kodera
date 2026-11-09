import { z } from 'zod'
import { readDemoView } from '../../app/interactiveDemo'
import { createChannelDocsWorkspace, type ChannelDocsWorkspace } from '../docs/ChannelDocsEditor'
import type { WorkspaceChannel } from './workspace'

const channel = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(80),
  kind: z.enum(['text', 'audio']),
  topic: z.string(),
  access: z.enum(['members', 'invite']).optional(),
  template_key: z.string().nullable(),
  lifecycle: z.enum(['active', 'archived']),
  room_state: z.enum(['pending', 'ready', 'failed']),
})
const savedView = z.object({
  channels: z.record(z.string(), z.array(channel)),
  docs: z.object({
    docs: z
      .array(
        z.object({
          id: z.string(),
          channelId: z.string(),
          title: z.string().max(120),
          content: z.string().max(65536),
        })
      )
      .max(64),
    selectedByChannel: z.record(z.string(), z.string()),
  }),
})
export interface LocalWorkspaceView {
  channels: Record<string, WorkspaceChannel[]>
  docs: ChannelDocsWorkspace
}
export function readLocalWorkspaceView(key: string): LocalWorkspaceView {
  const result = savedView.safeParse(readDemoView(key))
  return result.success ? result.data : { channels: {}, docs: createChannelDocsWorkspace() }
}
