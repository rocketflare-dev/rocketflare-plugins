/**
 * `global-search:agents` — the registered agents (the kit's and every installed plugin's), by
 * title, key and description, from `listAgents()`. Guarded by `read AgentRun`, the guard on the
 * kit's `/agents`. Each links to the agents page filtered to that agent (`/agents?agentKey=`),
 * where it is started and its runs are listed.
 *
 * The catalogue is code, the same for every tenant, so nothing here is tenant data; the guard is
 * what decides who sees it.
 */
import { listAgents } from '@/plugins/api'
import type { SearchProvider } from '../types'
import { textRank } from './match'

export const AGENTS_PROVIDER_ID = 'global-search:agents'
export const AGENT_KIND = 'agent'

export const agentsProvider: SearchProvider = {
  id: AGENTS_PROVIDER_ID,
  label: 'Agents',
  kinds: [{ kind: AGENT_KIND, label: 'Agents', badge: 'agent', tone: 'accent', order: 20 }],
  guard: { action: 'read', subject: 'AgentRun' },
  async search(_ctx, { q, pool }) {
    const agents = await listAgents()
    return agents
      .map(a => ({
        a,
        rank: Math.min(
          textRank(a.title, q),
          textRank(a.key, q),
          // A description match is a weaker signal than any name match.
          textRank(a.description, q) === 4 ? 4 : 3.5
        ),
      }))
      .filter(x => x.rank < 4)
      .sort((x, y) => x.rank - y.rank || x.a.title.localeCompare(y.a.title))
      .slice(0, pool)
      .map(({ a }) => ({
        kind: AGENT_KIND,
        title: a.title,
        snippet: a.description || null,
        ref: a.key,
        href: `/agents?agentKey=${encodeURIComponent(a.key)}`,
      }))
  },
}
