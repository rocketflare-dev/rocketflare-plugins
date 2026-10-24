/**
 * Two read-only tools for chat and agents: list recent inbound messages, and read one (text body,
 * windowed, plus its attachment list). Nothing here writes, so nothing needs approval. Every
 * member may read the inbox (`read InboxMessage`), so the tenant predicate is the whole scope.
 */
import { and, desc, eq, ilike, or } from 'drizzle-orm'
import { z } from 'zod'
import type { Tool, ToolCtx } from '@/plugins/api'
import { defineTool } from '@/plugins/api'
import { inboxAttachments, inboxMessages } from '../db/schema'

export const LIST_INBOX_MESSAGES_TOOL = 'inbox_list_messages'
export const GET_INBOX_MESSAGE_TOOL = 'inbox_get_message'

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100
const DEFAULT_WINDOW = 8_000

export const listInboxMessagesInputSchema = z.object({
  search: z
    .string()
    .trim()
    .max(200)
    .optional()
    .describe('Match against the sender address, sender name or subject (case-insensitive)'),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .optional()
    .describe(`How many to list (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}), newest first`),
})
export type ListInboxMessagesInput = z.infer<typeof listInboxMessagesInputSchema>

export function listInboxMessagesTool(ctx: ToolCtx): Tool<ListInboxMessagesInput> {
  return defineTool({
    name: LIST_INBOX_MESSAGES_TOOL,
    description:
      'List email received by this workspace’s inbox (forwarded receipts, invoices, notices), ' +
      'newest first: sender, subject, dates and attachment count. Use inbox_get_message to read one.',
    schema: listInboxMessagesInputSchema,
    async handler(input) {
      const filters = [eq(inboxMessages.tenantId, ctx.tenantId)]
      if (input.search) {
        const like = `%${input.search.replace(/[%_\\]/g, m => `\\${m}`)}%`
        const match = or(
          ilike(inboxMessages.fromAddress, like),
          ilike(inboxMessages.fromName, like),
          ilike(inboxMessages.subject, like)
        )
        if (match) filters.push(match)
      }
      const rows = await ctx.db
        .select()
        .from(inboxMessages)
        .where(and(...filters))
        .orderBy(desc(inboxMessages.receivedAt))
        .limit(input.limit ?? DEFAULT_LIMIT)
      if (rows.length === 0) {
        return JSON.stringify({
          messages: [],
          hint: input.search
            ? 'No inbound message matches that search. Try a shorter term, or none.'
            : 'The inbox has received nothing yet. Say so rather than inventing a message.',
        })
      }
      return JSON.stringify({
        messages: rows.map(r => ({
          messageId: r.id,
          from: r.fromAddress,
          fromName: r.fromName,
          subject: r.subject,
          kind: r.kind,
          status: r.status,
          sentAt: r.sentAt?.toISOString() ?? null,
          receivedAt: r.receivedAt.toISOString(),
          attachments: r.attachmentCount,
          source: r.subaddress,
          ...(r.parentMessageId && { forwardedInside: r.parentMessageId }),
          ...(r.forwardedCount > 0 && { forwardedEmails: r.forwardedCount }),
        })),
      })
    },
  })
}

export const getInboxMessageInputSchema = z.object({
  messageId: z.string().uuid().describe('The messageId from inbox_list_messages'),
  offset: z.coerce.number().int().min(0).optional().describe('Character offset into the body'),
  maxChars: z.coerce
    .number()
    .int()
    .min(500)
    .max(20_000)
    .optional()
    .describe(`How much of the body to return (default ${DEFAULT_WINDOW})`),
})
export type GetInboxMessageInput = z.infer<typeof getInboxMessageInputSchema>

export function getInboxMessageTool(ctx: ToolCtx): Tool<GetInboxMessageInput> {
  return defineTool({
    name: GET_INBOX_MESSAGE_TOOL,
    description:
      'Read one inbound email: headers, its plain-text body (windowed by offset/maxChars) and the ' +
      'names and types of its attachments.',
    schema: getInboxMessageInputSchema,
    async handler(input) {
      const [row] = await ctx.db
        .select()
        .from(inboxMessages)
        .where(and(eq(inboxMessages.tenantId, ctx.tenantId), eq(inboxMessages.id, input.messageId)))
        .limit(1)
      if (!row) {
        return JSON.stringify({
          error: 'not_found',
          hint: 'No message with that id in this workspace. List messages with inbox_list_messages.',
        })
      }
      const attachments = await ctx.db
        .select()
        .from(inboxAttachments)
        .where(
          and(eq(inboxAttachments.tenantId, ctx.tenantId), eq(inboxAttachments.messageId, row.id))
        )
      const body = row.textBody ?? ''
      const offset = input.offset ?? 0
      const maxChars = input.maxChars ?? DEFAULT_WINDOW
      return JSON.stringify({
        messageId: row.id,
        from: row.fromAddress,
        fromName: row.fromName,
        forwardedBy: row.forwardedBy ?? row.envelopeFrom,
        ...(row.parentMessageId && {
          forwardedInside: row.parentMessageId,
          context: 'Forwarded as an attachment of forwardedInside; read that message for context.',
        }),
        subject: row.subject,
        sentAt: row.sentAt?.toISOString() ?? null,
        receivedAt: row.receivedAt.toISOString(),
        body: body.slice(offset, offset + maxChars),
        bodyLength: body.length,
        ...(offset + maxChars < body.length && {
          hint: `Body continues — call again with offset ${offset + maxChars}.`,
        }),
        ...(row.status !== 'parsed' && {
          note: `This message is ${row.status}; the body may be empty.`,
        }),
        attachments: attachments
          .filter(a => !a.expandedMessageId)
          .map(a => ({
            attachmentId: a.id,
            filename: a.filename,
            contentType: a.contentType,
            size: a.size,
          })),
        // Embedded emails split into messages of their own — read each with this tool.
        forwardedMessageIds: attachments.flatMap(a =>
          a.expandedMessageId ? [a.expandedMessageId] : []
        ),
      })
    },
  })
}
