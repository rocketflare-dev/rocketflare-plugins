/**
 * `global-search:chats` — the reader's OWN conversations, by title. Chats are private to whoever
 * started them (the kit's `/chat` routes filter on the user id, whatever the role), so this does
 * too: tenant AND user, for an owner as for a member. Guarded by `read Conversation`.
 *
 * `conversations` is not in the schema kit, so it is read from `allTables()` at call time.
 */
import { and, asc, desc, eq } from 'drizzle-orm'
import { allTables } from '@/plugins/api/peers'
import type { SearchProvider } from '../types'
import { containsText, matchRank } from './match'

export const CHATS_PROVIDER_ID = 'global-search:chats'
export const CHAT_KIND = 'chat'

export const chatsProvider: SearchProvider = {
  id: CHATS_PROVIDER_ID,
  label: 'Chats',
  kinds: [{ kind: CHAT_KIND, label: 'Chats', badge: 'chat', tone: 'neutral', order: 30 }],
  guard: { action: 'read', subject: 'Conversation' },
  async search(ctx, { q, pool }) {
    const { conversations } = allTables()
    const rows = await ctx.db
      .select({
        id: conversations.id,
        title: conversations.title,
        at: conversations.lastMessageAt,
      })
      .from(conversations)
      .where(
        and(
          eq(conversations.tenantId, ctx.tenantId),
          eq(conversations.userId, ctx.userId),
          containsText(conversations.title, q)
        )
      )
      .orderBy(asc(matchRank(conversations.title, q)), desc(conversations.lastMessageAt))
      .limit(pool)
    return rows.map(r => ({
      kind: CHAT_KIND,
      title: r.title,
      snippet: r.at ? `Last message ${r.at.toISOString().slice(0, 10)}` : null,
      ref: r.id,
      href: `/chat/${encodeURIComponent(r.id)}`,
    }))
  },
}
