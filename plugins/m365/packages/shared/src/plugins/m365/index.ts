/**
 * `m365` — Microsoft 365 as a `connectors` provider (D34). Shared half: the plugin's id and the two
 * secrets its operator sets.
 *
 * There is almost nothing here, deliberately. Everything a reader sees — the Connections card, the
 * synced directory, My calendar — belongs to the `connectors` plugin, which this one REQUIRES;
 * `m365` contributes only the conversation with Microsoft Graph, through `extensions`. So it has no
 * contracts, no routes, no UI and no CLI of its own.
 *
 * `M365_CLIENT_ID` and `M365_CLIENT_SECRET` are the deployment's multi-tenant Entra app (kit
 * `docs/CONNECTORS.md` → "Operator setup"). Both optional: without them the Connections card says
 * the deployment has no app, and an organisation may still bring its own.
 *
 * **This module never imports a composer at runtime** — see the kit's `plugins/CLAUDE.md`.
 */
import { z } from 'zod'
import type { SharedPlugin } from '../types'

export const M365_ID = 'm365'

export const m365Shared = {
  id: M365_ID,
  label: 'Microsoft 365',
  version: '3.1.0',
  config: {
    M365_CLIENT_ID: z.string().trim().min(1).optional(),
    M365_CLIENT_SECRET: z.string().trim().min(1).optional(),
  },
} as const satisfies SharedPlugin
