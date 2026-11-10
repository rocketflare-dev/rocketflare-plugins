/**
 * What `apps/web/src/plugins/schema.ts` re-exports for this plugin. The host generates the DDL
 * (`pnpm db:generate --name plugin-global-search`); the plugin ships no migration.
 */
export * from './global-search-settings'
