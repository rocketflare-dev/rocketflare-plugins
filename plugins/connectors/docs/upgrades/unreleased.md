---
version: unreleased
previous: 3.8.2
date: null
breaking: true
migrations:
  - "unique index on connectors_installations (provider, external_tenant_id)"
areas: [api, db, cli]
touches_surfaces: []
requires_surfaces: []
manual: false
---

## What changed

A connection now requires provider-authenticated proof of the external organisation, and one external organisation backs one workspace.

- A consent callback re-reads the admin who started it with `memberCan`, and changes nothing if they no longer hold `manage`.
- `ConnectorProvider.completeConsent` takes `{ query, credentials, redirectUri, fetch, continuation? }`, may be async and may continue through a fresh signed state.
- A second workspace claiming the same external organisation gets `connectError=external_tenant_in_use`.
- CLI status and sync lines neutralise server text.

## How to apply

1. Install on kit 0.29.0 or later, which carries the plugin entries this version imports.
2. Run `select provider, external_tenant_id, count(*) from connectors_installations where external_tenant_id is not null group by 1, 2 having count(*) > 1` and disconnect any extra installation before migrating.
3. Run `pnpm db:generate --name plugin-connectors-<version>` and `pnpm db:migrate`.
4. Change a third-party provider to the new `completeConsent` input, answering `{ externalTenantId }` only on evidence the vendor authenticated.

## Conflicts to expect

None.

## Verify

1. `pnpm plugin check` passes.
2. A second workspace connecting the same organisation stays pending.
