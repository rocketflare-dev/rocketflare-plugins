/**
 * What `apps/web/src/plugins/schema.ts` re-exports for this plugin. The host generates the DDL
 * (`pnpm db:generate --name plugin-web-knowledge-<version>`); the plugin ships no migration.
 */
export * from './web-search-settings'
