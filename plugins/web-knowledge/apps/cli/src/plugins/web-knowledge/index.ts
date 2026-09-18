/**
 * `rocketflare web-knowledge …` — the plugin's CLI half.
 *
 *   rocketflare web-knowledge status [--json]   GET /api/web-knowledge/settings
 *
 * Read-only on purpose: pasting an API key belongs in the settings page, not in a shell history.
 * Parses with the same shared schema the server answered with, and throws rather than printing.
 */
import {
  WEB_KNOWLEDGE_ID,
  WEB_SEARCH_PROVIDER_INFO,
  webKnowledgeShared,
  webSearchSettingsSchema,
} from '@rocketflare/shared/plugins/web-knowledge/index'
import type { CliPlugin, CommandContext } from '../api'
import { formatDate, requireClient } from '../api'

export async function runWebKnowledgeStatus(ctx: CommandContext): Promise<void> {
  const { data, raw } = await requireClient(ctx).request('GET', '/api/web-knowledge/settings', {
    schema: webSearchSettingsSchema,
  })
  ctx.out.data(raw, () =>
    [
      `Web search:  ${data.enabled ? 'on' : 'off'}`,
      `Provider:    ${WEB_SEARCH_PROVIDER_INFO[data.provider].name}`,
      `API key:     ${data.hasCredential ? 'saved' : 'not set'}`,
      `Max results: ${data.maxResults}`,
      `Updated:     ${data.updatedAt ? formatDate(data.updatedAt) : 'never'}`,
    ].join('\n')
  )
}

export const webKnowledgeCli: CliPlugin<typeof webKnowledgeShared> = {
  shared: webKnowledgeShared,
  register(program, action) {
    const root = program
      .command(WEB_KNOWLEDGE_ID)
      .description('web search for agents and chat (a plugin)')
    root
      .command('status', { isDefault: true })
      .description('show whether web search is on and which provider it uses')
      .action(action(ctx => runWebKnowledgeStatus(ctx)))
  },
}
