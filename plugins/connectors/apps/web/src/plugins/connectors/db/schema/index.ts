/**
 * What `apps/web/src/plugins/schema.ts` re-exports for this plugin. The host generates the DDL
 * (`pnpm db:generate --name plugin-connectors-<version>`); the plugin ships no migration.
 */
export * from './calendar-events'
export * from './connections'
export * from './directory'
export * from './installations'
export * from './sync-cursors'
