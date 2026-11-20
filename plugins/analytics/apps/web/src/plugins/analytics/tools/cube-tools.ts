/**
 * drizzle-cube's own MCP tools — `discover`, `validate`, `load` — offered to the app's MCP server and
 * to agent runs through `ServerPlugin.tools`, as `analytics_discover`, `analytics_validate` and
 * `analytics_load`.
 *
 * **The library's tools, not a re-implementation.** `getCubeTools` (`drizzle-cube/mcp`) hands back
 * its tool definitions and a `handle(name, args)` that runs them against a semantic layer. This
 * file adapts that pair to the kit's `Tool`: the input schema is the library's own JSON Schema
 * (converted with `z.fromJSONSchema`, so its patterns and enums still hold), the description is the
 * library's own, renamed to our tool names, and the answer is the library's own JSON.
 *
 * **What it compiles against is exactly what `/cubejs-api` compiles against**: the same semantic
 * layer (`../services/semantic-layer.ts` — the same cubes, schema and feature filter), the same
 * security context (`../cubes/security.ts` — tenant, admin level, groups; admin-only cubes such as
 * `ActivityEvents` stay admin-only), and the same statement timeout (`../services/cube-limits.ts`).
 * The tenant is the caller's, from `ToolCtx`; nothing a client or a model sends can name another.
 *
 * **Pinned, and upgraded by hand.** {@link CUBE_TOOLS} names every library tool this plugin wraps
 * and {@link EXCLUDED_CUBE_TOOLS} every one it deliberately leaves out. The tripwire test
 * (`tests/api/cube-tools-pinned.test.ts`) compares both with what the installed drizzle-cube
 * actually offers, and with the definitions recorded when they were last reviewed, and fails on any
 * new, removed or changed tool. Upgrading drizzle-cube therefore means reviewing its tools — the
 * procedure is in `../CLAUDE.md`.
 */
import { ANALYTICS_SUBJECT } from '@rocketflare/shared/plugins/analytics/index'
import type { CubeTools, MCPToolDefinition } from 'drizzle-cube/mcp'
import { getCubeTools } from 'drizzle-cube/mcp'
import { and, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { groups, groupTypes, tenantUsers } from '@/db/schema/kit'
import type { Database, Tool, ToolCtx, ToolMcpOptions } from '@/plugins/api'
import { defineTool } from '@/plugins/api'
import { type AnalyticsSecurityContext, analyticsSecurityContext } from '../cubes/security'
import { CUBE_STATEMENT_TIMEOUT_MS, withStatementTimeout } from '../services/cube-limits'
import { buildSemanticLayer } from '../services/semantic-layer'

/** Every tool name this plugin offers starts with it — the plugin's id, and never a dot. */
export const CUBE_TOOL_PREFIX = 'analytics_'

type LibraryToolName = 'discover' | 'validate' | 'load'

/**
 * The drizzle-cube tools this plugin wraps, keyed by the library's own name. All three only read,
 * so every one is `mcp:read` and listed under the default "all read-only tools" exposure.
 */
export const CUBE_TOOLS: Record<LibraryToolName, { title: string; mcp: ToolMcpOptions }> = {
  discover: {
    title: 'Discover analytics data',
    mcp: { title: 'Discover analytics data', annotations: { openWorldHint: false } },
  },
  validate: {
    title: 'Validate an analytics query',
    mcp: { title: 'Validate an analytics query', annotations: { openWorldHint: false } },
  },
  load: {
    title: 'Run an analytics query',
    mcp: { title: 'Run an analytics query', annotations: { openWorldHint: false } },
  },
}

/**
 * Library tools deliberately NOT offered, with the reason. The tripwire fails on a library tool
 * that is in neither list, so a new one is a decision rather than a surprise.
 */
export const EXCLUDED_CUBE_TOOLS: Record<string, string> = {
  chart:
    'An MCP App (an interactive UI resource) — only offered by drizzle-cube with `app: true`; the ' +
    "app's MCP server serves tools, not UI resources.",
}

/** `load` → `analytics_load`: the name a client and an agent see for a library tool. */
export function cubeToolName(name: LibraryToolName): string {
  return `${CUBE_TOOL_PREFIX}${name}`
}

/** The library sentence pointing at `chart`, which is not offered here. */
const CHART_SENTENCE =
  /\s*Use "load" for data retrieval\. Use "chart" to visualise results with an interactive chart\./

/**
 * The library's description, speaking our tool names: `discover` → `analytics_discover`, and the
 * sentence about the unoffered `chart` tool dropped. Exported for the tripwire, which pins the
 * library's ORIGINAL text — a change there is reviewed before this rewrite is trusted again.
 */
export function describeCubeTool(description: string): string {
  return description
    .replace(CHART_SENTENCE, '')
    .replace(/(?<![\w.])(discover|validate|load)(?![\w.])/g, `${CUBE_TOOL_PREFIX}$1`)
}

/** The library's tool definitions, unprefixed — what the tripwire compares and the tools adapt. */
export function libraryCubeToolDefinitions(cubeTools: Pick<CubeTools, 'definitions'>) {
  return new Map<string, MCPToolDefinition>(cubeTools.definitions.map(d => [d.name, d]))
}

/**
 * The reader behind this call, as the cubes see it — the same shape `/cubejs-api` builds from
 * `ctx.detached()`. `ToolCtx` carries the tenant, the user, the group ids and the admin-level flag
 * (`scope.bypass`, which the kit sets exactly where a request's `isAdmin` is true); the role and the
 * group TYPE names `groupFilter` narrows on are read here, in one query each, under the caller's
 * own tenant.
 */
export async function toolSecurityContext(
  db: Database,
  ctx: Pick<ToolCtx, 'tenantId' | 'scope'>
): Promise<AnalyticsSecurityContext> {
  const userId = ctx.scope.userId
  if (!userId) throw new Error('A cube tool needs a person behind the call')
  const [membership] = await db
    .select({ role: tenantUsers.role })
    .from(tenantUsers)
    .where(and(eq(tenantUsers.tenantId, ctx.tenantId), eq(tenantUsers.userId, userId)))
    .limit(1)
  const isAdmin = ctx.scope.bypass
  const memberships =
    isAdmin || ctx.scope.groupIds.length === 0
      ? []
      : await db
          .select({ id: groups.id, name: groups.name, typeName: groupTypes.name })
          .from(groups)
          .innerJoin(groupTypes, eq(groupTypes.id, groups.groupTypeId))
          .where(and(eq(groups.tenantId, ctx.tenantId), inArray(groups.id, ctx.scope.groupIds)))
  return analyticsSecurityContext(
    { tenantId: ctx.tenantId, userId, role: membership?.role ?? null, isAdmin },
    memberships
  )
}

/**
 * What `ServerPlugin.tools` contributes: the three cube tools, for a caller who may read analytics.
 * A run with no person behind it holds no grant, so it is offered none — the cubes scope by the
 * reader, and there is no reader to scope by.
 */
export async function analyticsCubeTools(ctx: ToolCtx): Promise<Tool[]> {
  if (!ctx.scope.userId || !ctx.can('read', ANALYTICS_SUBJECT)) return []
  const features = await ctx.features()
  // Definitions only — no database work happens until a handler runs.
  const definitions = libraryCubeToolDefinitions(
    getCubeTools({
      semanticLayer: buildSemanticLayer(ctx.db, features),
      getSecurityContext: () => ({}),
      toolPrefix: '',
      tools: Object.keys(CUBE_TOOLS) as LibraryToolName[],
      prompts: [],
      resources: [],
    })
  )
  return (Object.keys(CUBE_TOOLS) as LibraryToolName[]).flatMap(name => {
    const definition = definitions.get(name)
    return definition ? [cubeTool(ctx, features, name, definition) as Tool] : []
  })
}

function cubeTool(
  ctx: ToolCtx,
  features: readonly string[],
  name: LibraryToolName,
  definition: MCPToolDefinition
): Tool<Record<string, unknown>> {
  return defineTool({
    name: cubeToolName(name),
    description: describeCubeTool(definition.description),
    schema: z.fromJSONSchema(
      definition.inputSchema as Parameters<typeof z.fromJSONSchema>[0]
    ) as z.ZodType<Record<string, unknown>>,
    surfaces: ['mcp', 'agents'],
    mcp: CUBE_TOOLS[name].mcp,
    async handler(input) {
      return withStatementTimeout(ctx.db, CUBE_STATEMENT_TIMEOUT_MS, async tx => {
        const securityContext = await toolSecurityContext(tx, ctx)
        const result = await getCubeTools({
          semanticLayer: buildSemanticLayer(tx, features),
          getSecurityContext: () => securityContext,
          toolPrefix: '',
          tools: [name],
          prompts: [],
          resources: [],
        }).handle(name, input)
        const text = result.content.map(part => part.text).join('\n')
        // The kit's convention for a tool's own dead end: JSON with an `error` the model acts on.
        return result.isError
          ? JSON.stringify({
              error: text,
              hint: `Call ${CUBE_TOOL_PREFIX}discover for the exact cube and field names, then ${CUBE_TOOL_PREFIX}validate the query.`,
            })
          : text
      })
    },
  })
}
