/**
 * Every provider the installed plugins register under `global-search.providers` parses — so a
 * plugin whose registration this plugin would refuse at request time fails the host's gate first.
 * It reads the REAL installed set (whatever plugins this app has), not a fixture.
 */
import { describe, expect, it } from 'vitest'
import { installedProviders } from '../../services/registry'

describe('the installed providers', () => {
  it('all parse, and include this plugin’s own two', () => {
    const ids = installedProviders().map(p => p.id)
    expect(ids).toContain('global-search:nav')
    expect(ids).toContain('global-search:documents')
  })
})
