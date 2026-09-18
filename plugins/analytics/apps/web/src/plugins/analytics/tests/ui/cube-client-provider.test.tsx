/**
 * `CubeClientProvider` (D19, D20, D31): the REAL drizzle-cube `CubeProvider` is mounted so what is
 * asserted is the library's own fetch — same-origin cookie credentials and the kit's
 * `X-Requested-With` marker on `/cubejs-api/v1/meta` — and that a 401 from the cube API still ends
 * up in the kit's global unauthorized handling.
 *
 * **How that last assertion is made changed with the plugin contract.** It used to register a spy
 * through `setUnauthorizedHandler` from `@/ui/lib/api-client`; neither that nor `notifyUnauthorized`
 * is published by `@/plugins/api/ui`, and reaching for them directly is exactly the coupling the
 * contract removes (it is reported to the kit as a missing member). So the provider routes a cube
 * 401 back through the declared `api` client — which calls the kit's handler itself — and what this
 * file asserts is that ONE such probe is made, once, per burst of failures.
 */
import { render, screen, waitFor } from '@testing-library/react'
import { stubFetch, unauthorizedResponse } from '@testkit/integration'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CubeClientProvider,
  createCubeQueryClient,
  cubeApiOptions,
  isCubeUnauthorized,
  syncDarkClass,
} from '../../ui/components/CubeClientProvider'

const flushMicrotasks = () => new Promise<void>(r => queueMicrotask(r))

describe('CubeClientProvider', () => {
  beforeEach(() => {
    // drizzle-cube consults the OS preference when the theme attribute is not one it knows
    vi.stubGlobal('matchMedia', () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    }))
    document.documentElement.setAttribute('data-theme', 'rocketflare-light')
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    document.documentElement.classList.remove('dark')
  })

  it('declares cookie credentials and the kit request marker', () => {
    expect(cubeApiOptions).toEqual({
      apiUrl: '/cubejs-api/v1',
      credentials: 'include',
      headers: { 'X-Requested-With': 'fetch' },
    })
  })

  it("the library's meta request carries credentials: include and X-Requested-With", async () => {
    const fetchMock = stubFetch({ '/cubejs-api/v1/meta': { cubes: [] } })
    render(
      <CubeClientProvider>
        <div>child</div>
      </CubeClientProvider>
    )
    expect(screen.getByText('child')).toBeInTheDocument()
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([input]) => String(input).includes('/cubejs-api/v1/meta'))
      ).toBe(true)
    )
    const call = fetchMock.mock.calls.find(([input]) =>
      String(input).includes('/cubejs-api/v1/meta')
    )
    const init = call?.[1]
    expect(init?.credentials).toBe('include')
    const headers = new Headers(init?.headers)
    expect(headers.get('X-Requested-With')).toBe('fetch')
  })

  it('a 401 from the cube API reaches the kit’s handling through the declared client', async () => {
    const fetchMock = stubFetch({
      '/cubejs-api/v1/meta': () => unauthorizedResponse(),
      '/api/me': () => unauthorizedResponse(),
    })
    render(
      <CubeClientProvider>
        <div>child</div>
      </CubeClientProvider>
    )
    // The probe IS the notification: `api` calls the kit's `notifyUnauthorized` on any 401, and
    // `/api/me` is a route the session must already satisfy.
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/api/me'))).toBe(true)
    )
    const probes = fetchMock.mock.calls.filter(([input]) => String(input).includes('/api/me'))
    expect(probes).toHaveLength(1)
  })

  it('createCubeQueryClient never retries a 4xx, and only a 401 probes', async () => {
    const fetchMock = stubFetch({ '/api/me': () => unauthorizedResponse() })
    const client = createCubeQueryClient()
    const fail = (status: number) =>
      client
        .fetchQuery({
          queryKey: ['t', status],
          queryFn: () => Promise.reject(Object.assign(new Error('boom'), { status })),
        })
        .catch(() => undefined)
    const probes = () => fetchMock.mock.calls.filter(([i]) => String(i).includes('/api/me')).length
    await fail(403)
    await flushMicrotasks()
    expect(probes()).toBe(0)
    await fail(401)
    await flushMicrotasks()
    await waitFor(() => expect(probes()).toBe(1))
    expect(client.getQueryState(['t', 401])?.fetchFailureCount).toBe(1) // one attempt, no retry
    expect(isCubeUnauthorized({ status: 401 })).toBe(true)
    expect(isCubeUnauthorized(new Error('x'))).toBe(false)
  })

  it('mirrors rocketflare-dark into the `dark` class drizzle-cube reads, and cleans up', async () => {
    const root = document.documentElement
    const stop = syncDarkClass(root)
    expect(root.classList.contains('dark')).toBe(false)
    root.setAttribute('data-theme', 'rocketflare-dark')
    await waitFor(() => expect(root.classList.contains('dark')).toBe(true))
    root.setAttribute('data-theme', 'rocketflare-light')
    await waitFor(() => expect(root.classList.contains('dark')).toBe(false))
    root.setAttribute('data-theme', 'rocketflare-dark')
    await waitFor(() => expect(root.classList.contains('dark')).toBe(true))
    stop()
    expect(root.classList.contains('dark')).toBe(false)
  })
})
