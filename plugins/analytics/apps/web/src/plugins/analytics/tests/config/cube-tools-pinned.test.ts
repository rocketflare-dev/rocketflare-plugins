/**
 * The upgrade tripwire for drizzle-cube's MCP tools. This plugin offers the library's own tools
 * (`../../tools/cube-tools.ts`), so a drizzle-cube upgrade can change what MCP clients and agents
 * are handed — a new tool, a removed one, a different input schema or description — without a line
 * of this plugin changing. These cases fail on any such difference and name it, so an upgrade is
 * reviewed rather than absorbed. The procedure is in `../../CLAUDE.md` ("Upgrading drizzle-cube").
 *
 * `../fixtures/drizzle-cube-mcp-tools.json` is the record of the definitions last reviewed. After
 * reviewing a change, regenerate it from `apps/web`:
 *
 *   node --input-type=module -e "
 *     import { getCubeTools } from 'drizzle-cube/mcp'
 *     import { SemanticLayerCompiler } from 'drizzle-cube/server'
 *     import { readFileSync, writeFileSync } from 'node:fs'
 *     const t = getCubeTools({ semanticLayer: new SemanticLayerCompiler({ engineType: 'postgres' }),
 *       getSecurityContext: () => ({}), toolPrefix: '', app: true, prompts: [], resources: [] })
 *     const { version } = JSON.parse(readFileSync('node_modules/drizzle-cube/package.json', 'utf8'))
 *     const tools = t.definitions.map(({ name, description, inputSchema }) =>
 *       ({ name, description, inputSchema }))
 *     writeFileSync('src/plugins/analytics/tests/fixtures/drizzle-cube-mcp-tools.json',
 *       JSON.stringify({ drizzleCube: version, tools }, null, 2) + '\\n')"
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { getCubeTools } from 'drizzle-cube/mcp'
import { SemanticLayerCompiler } from 'drizzle-cube/server'
import { describe, expect, it } from 'vitest'
import {
  CUBE_TOOL_PREFIX,
  CUBE_TOOLS,
  describeCubeTool,
  EXCLUDED_CUBE_TOOLS,
} from '../../tools/cube-tools'
import pinned from '../fixtures/drizzle-cube-mcp-tools.json'

/** Every tool the installed library can offer — `app: true` adds the ones behind its MCP App. */
function libraryTools() {
  return getCubeTools({
    semanticLayer: new SemanticLayerCompiler({ engineType: 'postgres' }),
    getSecurityContext: () => ({}),
    toolPrefix: '',
    app: true,
    prompts: [],
    resources: [],
  }).definitions.map(d => ({
    name: d.name,
    description: d.description,
    inputSchema: d.inputSchema,
  }))
}

const REVIEW =
  'drizzle-cube changed its MCP tools. Review the difference, update CUBE_TOOLS / ' +
  'EXCLUDED_CUBE_TOOLS in tools/cube-tools.ts, then regenerate tests/fixtures/' +
  'drizzle-cube-mcp-tools.json — see "Upgrading drizzle-cube" in the plugin CLAUDE.md.'

describe('drizzle-cube MCP tools (pinned)', () => {
  it('names every library tool as either wrapped or deliberately excluded', () => {
    const decided = [...Object.keys(CUBE_TOOLS), ...Object.keys(EXCLUDED_CUBE_TOOLS)].sort()
    expect(
      libraryTools()
        .map(t => t.name)
        .sort(),
      REVIEW
    ).toEqual(decided)
  })

  it('matches the definitions recorded at the last review, tool by tool', () => {
    const live = new Map(libraryTools().map(t => [t.name, t]))
    for (const recorded of pinned.tools) {
      expect(live.get(recorded.name), `${recorded.name}: ${REVIEW}`).toEqual(recorded)
    }
    expect([...live.keys()].sort(), REVIEW).toEqual(pinned.tools.map(t => t.name).sort())
  })

  it('records the drizzle-cube version it was reviewed against', () => {
    // The package's `exports` do not publish its package.json, so it is read from beside the entry.
    const entry = createRequire(import.meta.url).resolve('drizzle-cube/mcp')
    const root = entry.slice(0, entry.lastIndexOf('/drizzle-cube/') + '/drizzle-cube/'.length)
    const { version } = JSON.parse(readFileSync(`${root}package.json`, 'utf8')) as {
      version: string
    }
    expect(version, REVIEW).toBe(pinned.drizzleCube)
  })

  it('rewrites the descriptions to our tool names and drops the unoffered chart tool', () => {
    for (const recorded of pinned.tools) {
      if (!(recorded.name in CUBE_TOOLS)) continue
      const text = describeCubeTool(recorded.description)
      expect(text).not.toMatch(/"chart"/)
      expect(text).not.toMatch(/rocketflare/i)
      // Every bare library tool name became ours; nothing is double-prefixed.
      expect(text).not.toMatch(/(?<![\w.])(discover|validate|load)(?![\w.])/)
      expect(text).not.toContain(`${CUBE_TOOL_PREFIX}${CUBE_TOOL_PREFIX}`)
    }
    const load = pinned.tools.find(t => t.name === 'load')
    expect(describeCubeTool(load?.description ?? '')).toContain(
      `You MUST have called '${CUBE_TOOL_PREFIX}discover' first`
    )
  })
})
