import type { WorkspacePageRecord } from '../docs/WorkspaceCollaborativeDocs'
import { z } from '@/validation-policy'
import { documentCommentSchema } from '../docs/documentComments'
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
  is_confidential: z.boolean(),
})
const savedView = z.object({
  pages: z
    .array(
      z.object({
        id: z.string(),
        parentId: z.string().nullable(),
        title: z.string().max(120),
        markdown: z.string().max(262144),
        role: z.enum(['editor', 'viewer']),
        updatedAt: z.string(),
        order: z.number().optional(),
      })
    )
    .max(500)
    .default([]),
  channels: z.record(z.string(), z.array(channel)),
  docs: z.object({
    docs: z
      .array(
        z.object({
          id: z.string(),
          channelId: z.string(),
          title: z.string().max(120),
          content: z
            .string()
            .max(262144)
            .refine((value) => new TextEncoder().encode(value).length <= 262144),
          comments: z.array(documentCommentSchema).max(100).optional(),
        })
      )
      .max(64),
    selectedByChannel: z.record(z.string(), z.string()),
  }),
})
export interface LocalWorkspaceView {
  channels: Record<string, WorkspaceChannel[]>
  docs: ChannelDocsWorkspace
  pages: readonly WorkspacePageRecord[]
}
export function readLocalWorkspaceView(
  key: string,
  initialDocs = createChannelDocsWorkspace()
): LocalWorkspaceView {
  const result = savedView.safeParse(readDemoView(key))
  return result.success ? result.data : { channels: {}, docs: initialDocs, pages: [] }
}
