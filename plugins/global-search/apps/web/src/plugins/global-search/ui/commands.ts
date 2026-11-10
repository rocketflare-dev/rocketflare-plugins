/**
 * The commands this plugin registers for the kit's own pages, through the same
 * `extensions['global-search.commands']` key any plugin uses. Only routes the kit keeps stable,
 * each guarded as its page is:
 *
 * - New chat — `/chat` opens an empty conversation (`read Conversation`, the chat route's guard).
 * - Invite people — Settings → People, where the invite button is (`admin`, then
 *   `manage TenantMember`, which the invite needs).
 * - Upload a document — the knowledge base, where upload lives (`read Document`).
 * - Create an API key — Settings → API keys (`admin`).
 *
 * Plain data: this ships in the main bundle with the UI entry.
 */
import type { SearchCommand } from '@rocketflare/shared/plugins/global-search/index'

export const KIT_COMMANDS: readonly SearchCommand[] = [
  {
    id: 'global-search:new-chat',
    label: 'New chat',
    to: '/chat',
    keywords: ['conversation', 'ask', 'start'],
    guard: { action: 'read', subject: 'Conversation' },
  },
  {
    id: 'global-search:invite-people',
    label: 'Invite people',
    to: '/settings?tab=people',
    keywords: ['members', 'add', 'invitation', 'team'],
    guard: ['admin', { action: 'manage', subject: 'TenantMember' }],
  },
  {
    id: 'global-search:upload-document',
    label: 'Upload a document',
    to: '/documents',
    keywords: ['knowledge', 'file', 'add'],
    guard: { action: 'read', subject: 'Document' },
  },
  {
    id: 'global-search:create-api-key',
    label: 'Create an API key',
    to: '/settings?tab=api-keys',
    keywords: ['token', 'cli'],
    guard: 'admin',
  },
]
