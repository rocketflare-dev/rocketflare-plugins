/**
 * `inbox` — inbound email for an organisation, shared half (D31).
 *
 * Mail reaches the Worker through Cloudflare Email Routing ("Send to a Worker") and the kit's
 * `emailHandlers` slot. This plugin claims the catch-all (`*`), resolves the organisation from the
 * recipient's local part (`inbox_settings.local_part`, unique across tenants), checks the sender
 * against the organisation's allow-list and the authentication Cloudflare recorded, stores the raw
 * message in R2 and queues `inbox.parse`. Parsing extracts the bodies and attachments, recognises
 * forwarding confirmations (Gmail, Proton) so their codes can be shown, and then hands the parsed
 * message to every plugin that contributed an `inbox:consumers` extension.
 *
 * Everything it keys carries the id: tables `inbox_*`, jobs `inbox.*`, `/api/inbox`, query-key
 * roots `inbox:…`, the CLI command `rocketflare inbox`.
 */
import { z } from 'zod'
import { paginatedResponse, paginationQuerySchema } from '../../pagination'
import type { SharedPlugin } from '../types'

export const INBOX_ID = 'inbox'

/** Knowledge-base `source` values (D34): one per kind, each unique by `externalId`. */
export const INBOX_KNOWLEDGE_SOURCES = {
  message: `${INBOX_ID}:message`,
  attachment: `${INBOX_ID}:attachment`,
} as const

/** The job that turns a stored raw message into bodies, attachments and consumer calls. */
export const INBOX_PARSE_JOB = 'inbox.parse'

/** CASL subjects: the messages, and the organisation's address/allow-list. */
export const INBOX_MESSAGE_SUBJECT = 'InboxMessage'
export const INBOX_SETTINGS_SUBJECT = 'InboxSettings'

/** Query-key roots, and the `entity.changed` entities the server nudges. */
export const INBOX_MESSAGES_ENTITY = 'inbox:messages'
export const INBOX_SETTINGS_ENTITY = 'inbox:settings'

/**
 * The extension key a consumer plugin contributes under (D31 decision 6). Lives in the shared half
 * because the shared half is a leaf: a consumer reaching for the server entry at module scope
 * could find it half-evaluated through the server barrel.
 */
export const INBOX_EXTENSION_KEYS = { consumers: `${INBOX_ID}:consumers` } as const

export function inboxExtensions(contribution: {
  consumers: readonly unknown[]
}): Record<string, readonly unknown[]> {
  return { [INBOX_EXTENSION_KEYS.consumers]: contribution.consumers }
}

/** A local part as the kit's dispatcher compares it: lower-case, no `+`, `@` or space. */
export const INBOX_LOCAL_PART_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/

/** An allow-list entry: a whole address, or `@domain` for anyone at that domain. */
export const INBOX_SENDER_RE = /^([^\s@]+@|@)[^\s@]+\.[^\s@]+$/

export const INBOX_MAX_ALLOWED_SENDERS = 50
/** The text body is kept in Postgres up to this many characters; the HTML body lives in R2. */
export const INBOX_TEXT_BODY_MAX = 100_000

/**
 * Forwarded-as-attachment mail: every `message/rfc822` part becomes a child message of its own.
 * A child is its parent's depth + 1, and a message at the cap keeps its embedded parts as plain
 * `.eml` attachments; past the per-message cap, the rest stay attachments too.
 */
export const INBOX_FORWARD_MAX_DEPTH = 3
export const INBOX_FORWARD_MAX_CHILDREN = 50

// ---- Vocabulary ---------------------------------------------------------------------------------

export const INBOX_MESSAGE_STATUSES = ['received', 'parsed', 'failed'] as const
export const inboxMessageStatusSchema = z.enum(INBOX_MESSAGE_STATUSES)
export type InboxMessageStatus = z.infer<typeof inboxMessageStatusSchema>

/** `message` is ordinary mail; `confirmation` is a mailbox asking us to confirm forwarding. */
export const INBOX_MESSAGE_KINDS = ['message', 'confirmation'] as const
export const inboxMessageKindSchema = z.enum(INBOX_MESSAGE_KINDS)
export type InboxMessageKind = z.infer<typeof inboxMessageKindSchema>

export const inboxConfirmationSchema = z.object({
  provider: z.enum(['gmail', 'proton', 'other']),
  code: z.string().nullable(),
  url: z.string().url().nullable(),
})
export type InboxConfirmation = z.infer<typeof inboxConfirmationSchema>

/** What Cloudflare recorded in `Authentication-Results` — `null` where the header said nothing. */
export const inboxAuthSchema = z.object({
  spf: z.string().nullable(),
  dkim: z.string().nullable(),
  dmarc: z.string().nullable(),
})
export type InboxAuth = z.infer<typeof inboxAuthSchema>

// ---- Settings -----------------------------------------------------------------------------------

export const inboxSettingsSchema = z.object({
  enabled: z.boolean(),
  /** Null until the organisation picks one; nothing is accepted before then. */
  localPart: z.string().nullable(),
  allowedSenders: z.array(z.string()),
  /** Refuse mail whose SPF, DKIM and DMARC all failed or are missing (off only for local tests). */
  requireAuthentication: z.boolean(),
  /** Index parsed messages and their PDF/document attachments into the knowledge base. */
  ingestToKnowledge: z.boolean(),
  updatedAt: z.coerce.date().nullable(),
})
export type InboxSettings = z.infer<typeof inboxSettingsSchema>

export const updateInboxSettingsSchema = z
  .object({
    enabled: z.boolean(),
    localPart: z
      .string()
      .trim()
      .toLowerCase()
      .regex(INBOX_LOCAL_PART_RE, 'Use lower-case letters, digits, dots, dashes or underscores'),
    allowedSenders: z
      .array(
        z
          .string()
          .trim()
          .toLowerCase()
          .regex(INBOX_SENDER_RE, 'Use an address (me@example.com) or a domain (@example.com)')
      )
      .max(INBOX_MAX_ALLOWED_SENDERS),
    requireAuthentication: z.boolean(),
    ingestToKnowledge: z.boolean(),
  })
  .partial()
  .refine(body => Object.keys(body).length > 0, { message: 'Nothing to update' })
export type UpdateInboxSettings = z.infer<typeof updateInboxSettingsSchema>

// ---- Messages -----------------------------------------------------------------------------------

export const inboxAttachmentSchema = z.object({
  id: z.string().uuid(),
  filename: z.string(),
  contentType: z.string(),
  size: z.number().int().nonnegative(),
  sha256: z.string(),
  inline: z.boolean(),
  /** For an embedded `.eml`: the inbox message it became. Null for an ordinary attachment. */
  expandedMessageId: z.string().uuid().nullable(),
})
export type InboxAttachment = z.infer<typeof inboxAttachmentSchema>

export const inboxMessageSummarySchema = z.object({
  id: z.string().uuid(),
  status: inboxMessageStatusSchema,
  kind: inboxMessageKindSchema,
  /** The SMTP envelope sender — the mailbox that forwarded it, when it was forwarded. */
  envelopeFrom: z.string(),
  /** The `From:` header, or the original sender when a forwarded message names one. */
  fromAddress: z.string().nullable(),
  fromName: z.string().nullable(),
  toAddress: z.string(),
  /** The `+tag` of the recipient (`receipts+gmail@` → `gmail`), a free label for the source. */
  subaddress: z.string().nullable(),
  subject: z.string().nullable(),
  sentAt: z.coerce.date().nullable(),
  receivedAt: z.coerce.date(),
  attachmentCount: z.number().int().nonnegative(),
  rawSize: z.number().int().nonnegative(),
  /** The message this one was forwarded inside (as a `message/rfc822` part), else null. */
  parentMessageId: z.string().uuid().nullable(),
  /** Who forwarded a child — its authentication verdict is inherited from that forward. */
  forwardedBy: z.string().nullable(),
  /** How many embedded emails this message was split into. */
  forwardedCount: z.number().int().nonnegative(),
})
export type InboxMessageSummary = z.infer<typeof inboxMessageSummarySchema>

/** Just enough of another message to link to it. */
export const inboxMessageLinkSchema = z.object({
  id: z.string().uuid(),
  subject: z.string().nullable(),
  fromAddress: z.string().nullable(),
  fromName: z.string().nullable(),
})
export type InboxMessageLink = z.infer<typeof inboxMessageLinkSchema>

export const inboxMessageSchema = inboxMessageSummarySchema.extend({
  messageIdHeader: z.string().nullable(),
  auth: inboxAuthSchema,
  textBody: z.string().nullable(),
  hasHtmlBody: z.boolean(),
  confirmation: inboxConfirmationSchema.nullable(),
  error: z.string().nullable(),
  attachments: z.array(inboxAttachmentSchema),
  /** The message this one was forwarded inside, for the "forwarded inside …" link. */
  parent: inboxMessageLinkSchema.nullable(),
  /** The emails embedded in this one (children, or earlier copies they were deduplicated to). */
  forwardedMessages: z.array(inboxMessageLinkSchema),
})
export type InboxMessage = z.infer<typeof inboxMessageSchema>

export const inboxMessageListQuerySchema = paginationQuerySchema.extend({
  status: inboxMessageStatusSchema.optional(),
  kind: inboxMessageKindSchema.optional(),
})
export type InboxMessageListQuery = z.infer<typeof inboxMessageListQuerySchema>

export const inboxMessageListResponseSchema = paginatedResponse(inboxMessageSummarySchema)
export type InboxMessageListResponse = z.infer<typeof inboxMessageListResponseSchema>

/** `POST /api/inbox/messages/:id/reprocess` — the envelope of the queued parse. */
export const inboxReprocessResponseSchema = z.object({
  jobId: z.string().uuid(),
  type: z.literal(INBOX_PARSE_JOB),
})
export type InboxReprocessResponse = z.infer<typeof inboxReprocessResponseSchema>

// ---- Jobs ---------------------------------------------------------------------------------------

export const inboxParsePayloadSchema = z.object({
  tenantId: z.string().uuid(),
  messageId: z.string().uuid(),
})
export type InboxParsePayload = z.infer<typeof inboxParsePayloadSchema>

// ---- The plugin ---------------------------------------------------------------------------------

export const inboxShared = {
  id: INBOX_ID,
  label: 'Inbox',
  version: '3.7.0',
  subjects: [INBOX_MESSAGE_SUBJECT, INBOX_SETTINGS_SUBJECT],
  jobs: [z.object({ type: z.literal(INBOX_PARSE_JOB), payload: inboxParsePayloadSchema })],
} as const satisfies SharedPlugin
