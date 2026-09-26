/**
 * `m365` — SERVER entry (D34).
 *
 * One line of substance: the Microsoft 365 provider, contributed to the `connectors` plugin through
 * `extensions`. No mounts (the consent callback is `connectors`' public mount, parameterised by
 * provider id), no jobs, no cron, no tables — every row a sync writes belongs to `connectors`.
 * That is why `plugin.json` REQUIRES `connectors`: installed alone, this would contribute to a
 * registry nobody reads.
 */
import { connectorExtensions } from '@rocketflare/shared/plugins/connectors/index'
import { m365Shared } from '@rocketflare/shared/plugins/m365/index'
import type { ServerPlugin } from '@/plugins/api'
import type { ConnectorProvider } from '@/plugins/connectors'
import { m365Provider } from './provider'

/**
 * The builder comes from `connectors`' SHARED half, not its server entry: this runs at module
 * scope, and the server entry can be mid-evaluation here (it sits on the server-barrel cycle).
 */
const providers: readonly ConnectorProvider[] = [m365Provider]

export const m365Server = {
  shared: m365Shared,
  extensions: connectorExtensions({ providers }),
} satisfies ServerPlugin<typeof m365Shared>
