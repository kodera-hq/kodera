import { z } from 'zod'

export const documentCommentSchema = z.object({
  id: z.string().min(1),
  authorName: z.string().min(1).max(120),
  authorId: z.string().min(1),
  createdAtLabel: z.string().max(120),
  body: z.string().min(1).max(4000),
  quote: z.string().max(65536).optional(),
  resolved: z.boolean(),
})

export type DocumentComment = z.infer<typeof documentCommentSchema>
export interface DocumentMember {
  userId: string
  name?: string
}
