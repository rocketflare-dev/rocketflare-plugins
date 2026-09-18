/**
 * The kit tables this plugin reads that `@/db/schema/kit` does not export (D31).
 *
 * `@/db/schema/kit` is the declared, module-scope-safe way to name a kit table, and it carries
 * `tenants`, `users` and `groups` — the three a plugin's own TABLE file wants, which is what it was
 * built for. Analytics also reads three it does not carry: `activity_events` (the `ActivityEvents`
 * cube and the one fact table's source), `tenant_users` (the `TenantUsers` cube and the membership
 * subquery the `Users` cube scopes through) and `group_types` (the type NAME on a dashboard's
 * grant rows). The only declared route to those is `allTables()`.
 *
 * **Which is why everything here is behind a function.** `allTables()` lives in
 * `@/plugins/api/peers`, and that module imports the server barrel — the barrel that imports this
 * plugin. Read at MODULE scope the cycle resolves with one side still evaluating, and the failure
 * is at IMPORT time rather than in one request. Read at call time, live bindings are always
 * resolved. It is the same rule that makes `allCubes()`, `factTables()` and `DASHBOARD_TEMPLATES()`
 * functions, and the memo is what keeps it free after the first call.
 *
 * This file is the ONE place the plugin widens beyond `@/db/schema/kit`, so the day those three
 * tables join the schema kit, it is the only file that changes.
 */
import { allTables } from '@/plugins/api/peers'

type KitTables = ReturnType<typeof allTables>

let memo: KitTables | null = null

/** The merged schema, read once per isolate. Never called at module scope — see the header. */
export function kitTables(): KitTables {
  if (memo === null) memo = allTables()
  return memo
}

/** `activity_events` — the kit's audit log: the `ActivityEvents` cube and the fact table's source. */
export const activityEventsTable = () => kitTables().activityEvents
/** `tenant_users` — memberships: the `TenantUsers` cube, and how the `Users` cube scopes itself. */
export const tenantUsersTable = () => kitTables().tenantUsers
/** `group_types` — only for the type NAME beside a group on a dashboard's grant rows (D29). */
export const groupTypesTable = () => kitTables().groupTypes
