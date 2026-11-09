/**
 * Who a message may claim to be, on real Postgres and the in-memory R2/queue: authentication binds
 * to the allow-listed identity, the From header has one reading, forwarding confirmations are held
 * to their provider and setup window, the local part stays with its organisation for a while after
 * it is given up, and a forward tree has a total. Plus how the inbox tools present sender text.
 */

import {
  INBOX_FORWARD_MAX_TOTAL,
  INBOX_LOCAL_PART_HOLD_DAYS,
} from '@rocketflare/shared/plugins/inbox/index'
import {
  createTestEnv,
  createTestSession,
  createTestTenant,
  createTestUser,
  json,
  linkUserToTenant,
  request,
  sessionCookieHeader,
  setupTestDatabase,
  stubs,
} from '@testkit/integration'
import { makeEmailCtx, makeJobCtx, makeToolCtx } from '@testkit/unit'
import { and, eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { tenants } from '@/db/schema/kit'
import {
  inboxAttachments,
  inboxLocalPartHolds,
  inboxMessages,
  inboxSettings,
} from '../../db/schema'
import { parseMessage } from '../../services/parse'
import { receiveMessage } from '../../services/receive'
import {
  GET_INBOX_MESSAGE_TOOL,
  getInboxMessageTool,
  listInboxMessagesTool,
} from '../../tools/inbox-tools'

const db = setupTestDatabase()
const BASE = '/api/inbox'
const ORIGIN = { Origin: 'http://localhost:3000' }

/** The edge's verdicts for a domain that authenticates in full. */
const passFor = (domain: string, address = `a@${domain}`) =>
  `mx.cloudflare.net; dkim=pass header.d=${domain}; spf=pass smtp.mailfrom=${address}; dmarc=pass header.from=${domain}`

let tenantId: string
let localPart: string

function plain(from: string, opts: { subject?: string; body?: string } = {}): string {
  return [
    `From: ${from}`,
    'To: receipts@example.test',
    `Subject: ${opts.subject ?? 'A subject'}`,
    `Message-ID: <${crypto.randomUUID()}@sender.example>`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    opts.body ?? 'Body text.',
    '',
  ].join('\r\n')
}

function message(raw: string, envelope: { from: string; to: string; auth: readonly string[] }) {
  const headerBlock = raw.split('\r\n\r\n')[0] ?? ''
  const headers = new Headers()
  for (const line of headerBlock.split('\r\n')) {
    const idx = line.indexOf(':')
    if (idx > 0) headers.append(line.slice(0, idx).trim(), line.slice(idx + 1).trim())
  }
  for (const result of envelope.auth) headers.append('Authentication-Results', result)
  return {
    from: envelope.from,
    to: envelope.to,
    headers,
    raw: new Response(raw).body as ReadableStream,
    rawSize: raw.length,
    canBeForwarded: true,
    setReject: vi.fn(),
    forward: vi.fn(),
    reply: vi.fn(),
  } as unknown as ForwardableEmailMessage & { setReject: ReturnType<typeof vi.fn> }
}

function prodEnv() {
  return createTestEnv({ APP_ENV: 'production', APP_URL: 'https://app.example' })
}

async function deliver(
  tenantLocalPart: string,
  raw: string,
  envelope: { from: string; auth: readonly string[] },
  env = prodEnv()
) {
  return receiveMessage(
    message(raw, { ...envelope, to: `${tenantLocalPart}@example.test` }),
    makeEmailCtx({ db, env })
  )
}

async function storedBy(tenant: string, fromAddress: string) {
  return db
    .select()
    .from(inboxMessages)
    .where(and(eq(inboxMessages.tenantId, tenant), eq(inboxMessages.fromAddress, fromAddress)))
}

async function makeOwner(tenant: string) {
  const owner = await createTestUser(db)
  await linkUserToTenant(db, owner.id, tenant, 'owner')
  return { ...sessionCookieHeader(await createTestSession(db, owner.id, tenant)), ...ORIGIN }
}

async function putSettings(cookie: Record<string, string>, body: Record<string, unknown>) {
  return request(`${BASE}/settings`, { method: 'PUT', headers: cookie }, { json: body })
}

let ownerCookie: Record<string, string>

beforeAll(async () => {
  tenantId = (await createTestTenant(db)).id
  localPart = `trust-${crypto.randomUUID().slice(0, 8)}`
  ownerCookie = await makeOwner(tenantId)
  const res = await putSettings(ownerCookie, {
    enabled: true,
    localPart,
    allowedSenders: ['ceo@allowed.example', '@corp.example'],
    ingestToKnowledge: false,
  })
  expect(res.status).toBe(200)
})

describe('an allow-listed identity', () => {
  it('is not accepted on the strength of another domain’s authentication', async () => {
    const outcome = await deliver(localPart, plain('CEO <ceo@allowed.example>'), {
      from: 'a@sender.example',
      auth: [
        'mx.cloudflare.net; spf=pass smtp.mailfrom=a@sender.example; dkim=none; dmarc=fail header.from=allowed.example',
      ],
    })
    expect(outcome).toEqual({ status: 'rejected', reason: 'authentication' })
    expect(await storedBy(tenantId, 'ceo@allowed.example')).toEqual([])
  })

  it('is accepted when the authentication is that identity’s own', async () => {
    const outcome = await deliver(localPart, plain('CEO <ceo@allowed.example>'), {
      from: 'bounce@srs.relay.example',
      auth: [
        'mx.cloudflare.net; dkim=pass header.d=allowed.example; dmarc=pass header.from=allowed.example',
      ],
    })
    expect(outcome.status).toBe('stored')
  })

  it('is read from the mailbox of the From header, never its display name or a comment', async () => {
    for (const from of [
      '"<ceo@allowed.example>" <a@sender.example>',
      '(ceo@allowed.example) a@sender.example',
      'ceo@allowed.example <a@sender.example>',
    ]) {
      const outcome = await deliver(localPart, plain(from), {
        from: 'a@sender.example',
        auth: [passFor('sender.example')],
      })
      expect(outcome, from).toEqual({ status: 'rejected', reason: 'sender' })
    }
  })

  it('is not read from a list or a group of mailboxes', async () => {
    for (const from of ['ceo@allowed.example, a@sender.example', 'team: ceo@allowed.example;']) {
      const outcome = await deliver(localPart, plain(from), {
        from: 'a@sender.example',
        auth: [passFor('sender.example')],
      })
      expect(outcome, from).toEqual({ status: 'rejected', reason: 'sender' })
    }
  })

  it('is stored as the same mailbox the decision was made on', async () => {
    const env = prodEnv()
    const outcome = await deliver(
      localPart,
      plain('Ann <ann@corp.example>'),
      { from: 'ann@corp.example', auth: [passFor('corp.example', 'ann@corp.example')] },
      env
    )
    if (outcome.status !== 'stored') throw new Error('not stored')
    await parseMessage(makeJobCtx({ db, env }), tenantId, outcome.messageId, [])
    const [row] = await db
      .select()
      .from(inboxMessages)
      .where(and(eq(inboxMessages.tenantId, tenantId), eq(inboxMessages.id, outcome.messageId)))
    expect(row).toMatchObject({ fromAddress: 'ann@corp.example', fromName: 'Ann' })
  })
})

describe('Authentication-Results', () => {
  const senderHeader = 'sender.example; dmarc=pass header.from=allowed.example'

  it('counts only the receiving edge’s result, wherever another header sits', async () => {
    const edge = 'mx.cloudflare.net; spf=fail smtp.mailfrom=x@sender.example; dkim=none'
    for (const headers of [
      [edge, senderHeader],
      [senderHeader, edge],
    ]) {
      const outcome = await deliver(localPart, plain('CEO <ceo@allowed.example>'), {
        from: 'x@sender.example',
        auth: headers,
      })
      expect(outcome).toEqual({ status: 'rejected', reason: 'authentication' })
    }
  })

  it('does not read a verdict out of a reflected address', async () => {
    const outcome = await deliver(localPart, plain('CEO <ceo@allowed.example>'), {
      from: 'dkim=pass@sender.example',
      auth: ['mx.cloudflare.net; spf=fail smtp.mailfrom=dkim=pass@sender.example'],
    })
    expect(outcome).toEqual({ status: 'rejected', reason: 'authentication' })
  })
})

describe('forwarding confirmations', () => {
  async function confirmationTenant() {
    const id = (await createTestTenant(db)).id
    const part = `conf-${crypto.randomUUID().slice(0, 8)}`
    const cookie = await makeOwner(id)
    const res = await putSettings(cookie, { localPart: part, enabled: false, allowedSenders: [] })
    expect(res.status).toBe(200)
    return { id, part, cookie }
  }

  async function closeWindow(id: string) {
    await db
      .update(inboxSettings)
      .set({ confirmationWindowUntil: new Date(Date.now() - 60_000) })
      .where(eq(inboxSettings.tenantId, id))
  }

  it('are accepted while the setup window is open, then bounced with the inbox off', async () => {
    const { id, part } = await confirmationTenant()
    const google = {
      from: 'forwarding-noreply@google.com',
      auth: [
        'mx.cloudflare.net; dkim=pass header.d=google.com; spf=pass smtp.mailfrom=forwarding-noreply@google.com; dmarc=pass header.from=google.com',
      ],
    }
    const raw = plain('forwarding-noreply@google.com', {
      subject: '(#812345678) Gmail Forwarding Confirmation',
    })
    const inWindow = await deliver(part, raw, google)
    expect(inWindow.status).toBe('stored')

    await closeWindow(id)
    const outside = await deliver(part, plain('forwarding-noreply@google.com'), google)
    expect(outside).toEqual({ status: 'rejected', reason: 'disabled' })
  })

  it('do not admit an ordinary mailbox of a provider domain on a closed inbox', async () => {
    const { id, part } = await confirmationTenant()
    await closeWindow(id)
    const outcome = await deliver(part, plain('Anyone <anyone@proton.me>'), {
      from: 'anyone@proton.me',
      auth: [passFor('proton.me', 'anyone@proton.me')],
    })
    expect(outcome).toEqual({ status: 'rejected', reason: 'disabled' })
  })

  it('must authenticate as the provider, not as whoever claims to be it', async () => {
    const { part } = await confirmationTenant()
    const outcome = await deliver(part, plain('X <a@sender.example>'), {
      from: 'forwarding-noreply@google.com',
      auth: [
        'mx.cloudflare.net; spf=fail smtp.mailfrom=forwarding-noreply@google.com; dkim=pass header.d=sender.example; dmarc=pass header.from=sender.example',
      ],
    })
    expect(outcome).toEqual({ status: 'rejected', reason: 'authentication' })
  })

  it('reopen the window when an administrator says one is expected', async () => {
    const { id, part, cookie } = await confirmationTenant()
    await closeWindow(id)
    const res = await putSettings(cookie, { expectForwardingConfirmation: true })
    expect(res.status).toBe(200)
    expect(await json<{ confirmationWindowUntil: string }>(res)).toMatchObject({
      confirmationWindowUntil: expect.any(String),
    })
    const outcome = await deliver(part, plain('forwarding-noreply@google.com'), {
      from: 'forwarding-noreply@google.com',
      auth: [passFor('google.com', 'forwarding-noreply@google.com')],
    })
    expect(outcome.status).toBe('stored')
  })
})

describe('forward trees', () => {
  function forwardOf(children: readonly string[], index: string): string {
    const boundary = `t_${index.replace(/\W/g, '')}_${crypto.randomUUID().slice(0, 6)}`
    const lines = [
      'From: Me <ceo@allowed.example>',
      'To: receipts@example.test',
      `Subject: Fwd: ${index}`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      `Wrapper ${index}`,
    ]
    for (const child of children) {
      lines.push(`--${boundary}`, 'Content-Type: message/rfc822', '', child)
    }
    lines.push(`--${boundary}--`, '')
    return lines.join('\r\n')
  }

  /** A tree `width` wide and `levels` deep, leaves with distinct subjects and no Message-ID. */
  function tree(width: number, levels: number, path = 'r'): string {
    if (levels === 0) {
      return [
        'From: leaf@vendor.example',
        `Subject: leaf ${path}`,
        'Content-Type: text/plain; charset=utf-8',
        '',
        `Leaf ${path}`,
        '',
      ].join('\r\n')
    }
    const children = Array.from({ length: width }, (_, i) =>
      tree(width, levels - 1, `${path}-${i}`)
    )
    return forwardOf(children, path)
  }

  function parseJobs(env: ReturnType<typeof createTestEnv>) {
    return stubs(env)
      .queue.messages.map(m => m.body as { type: string; payload: { messageId: string } })
      .filter(b => b.type === 'inbox.parse')
      .map(b => b.payload.messageId)
  }

  async function drain(env: ReturnType<typeof createTestEnv>, tenant: string) {
    let next = 0
    while (next < parseJobs(env).length) {
      const batch = parseJobs(env).slice(next)
      next += batch.length
      await Promise.all(batch.map(id => parseMessage(makeJobCtx({ db, env }), tenant, id, [])))
    }
  }

  async function descendantsOf(rootId: string, tenant: string) {
    const rows = await db
      .select()
      .from(inboxMessages)
      .where(and(eq(inboxMessages.tenantId, tenant), eq(inboxMessages.rootMessageId, rootId)))
    return rows
  }

  it('split a limited total out of one delivery, however the parts are nested', async () => {
    const tenant = (await createTestTenant(db)).id
    const part = `tree-${crypto.randomUUID().slice(0, 8)}`
    const cookie = await makeOwner(tenant)
    await putSettings(cookie, {
      enabled: true,
      localPart: part,
      allowedSenders: ['ceo@allowed.example'],
      ingestToKnowledge: false,
    })
    const env = prodEnv()
    const raw = tree(6, 3)
    const outcome = await receiveMessage(
      message(raw, {
        from: 'ceo@allowed.example',
        to: `${part}@example.test`,
        auth: [passFor('allowed.example', 'ceo@allowed.example')],
      }),
      makeEmailCtx({ db, env })
    )
    if (outcome.status !== 'stored') throw new Error('not stored')
    await drain(env, tenant)

    const descendants = await descendantsOf(outcome.messageId, tenant)
    expect(descendants.length).toBeLessThanOrEqual(INBOX_FORWARD_MAX_TOTAL)
    expect(descendants.length).toBeGreaterThan(0)
    expect(parseJobs(env).length).toBeLessThanOrEqual(INBOX_FORWARD_MAX_TOTAL + 1)

    const objects = await stubs(env).files.list({ prefix: `tenants/${tenant}/inbox/` })
    expect(objects.objects.filter(o => o.key.endsWith('/raw.eml')).length).toBe(
      descendants.length + 1
    )

    const [root] = await db
      .select()
      .from(inboxMessages)
      .where(and(eq(inboxMessages.tenantId, tenant), eq(inboxMessages.id, outcome.messageId)))
    expect(root?.forwardTreeCount).toBe(descendants.length)

    // Every part past the total stays a plain .eml, and says so on the message that kept it.
    const overflowed = await db
      .select()
      .from(inboxMessages)
      .where(eq(inboxMessages.tenantId, tenant))
    expect(overflowed.some(m => m.error?.includes('limit'))).toBe(true)
  })

  it('count concurrent parse jobs against the same total', async () => {
    const tenant = (await createTestTenant(db)).id
    const part = `tree-${crypto.randomUUID().slice(0, 8)}`
    const cookie = await makeOwner(tenant)
    await putSettings(cookie, {
      enabled: true,
      localPart: part,
      allowedSenders: ['ceo@allowed.example'],
      ingestToKnowledge: false,
    })
    const env = prodEnv()
    const outcome = await receiveMessage(
      message(tree(10, 2, 'c'), {
        from: 'ceo@allowed.example',
        to: `${part}@example.test`,
        auth: [passFor('allowed.example', 'ceo@allowed.example')],
      }),
      makeEmailCtx({ db, env })
    )
    if (outcome.status !== 'stored') throw new Error('not stored')
    await parseMessage(makeJobCtx({ db, env }), tenant, outcome.messageId, [])
    await drain(env, tenant)
    const descendants = await descendantsOf(outcome.messageId, tenant)
    expect(descendants.length).toBeLessThanOrEqual(INBOX_FORWARD_MAX_TOTAL)
    const emls = await db
      .select()
      .from(inboxAttachments)
      .where(
        and(
          eq(inboxAttachments.tenantId, tenant),
          eq(inboxAttachments.contentType, 'message/rfc822')
        )
      )
    expect(emls.length).toBeGreaterThanOrEqual(descendants.length)
  })
})

describe('a released local part', () => {
  async function organisation() {
    const id = (await createTestTenant(db)).id
    return { id, cookie: await makeOwner(id) }
  }

  it('stays with its organisation for the holding period after a rename', async () => {
    const a = await organisation()
    const b = await organisation()
    const part = `held-${crypto.randomUUID().slice(0, 8)}`
    const next = `${part}-new`

    expect((await putSettings(a.cookie, { localPart: part })).status).toBe(200)
    expect((await putSettings(a.cookie, { localPart: next })).status).toBe(200)

    const refused = await putSettings(b.cookie, { localPart: part })
    expect(refused.status).toBe(409)
    expect(await json(refused)).toMatchObject({ code: 'inbox_local_part_taken' })

    // Its former holder may take it back at once.
    expect((await putSettings(a.cookie, { localPart: part })).status).toBe(200)
    // ... which releases the other one.
    expect((await putSettings(b.cookie, { localPart: next })).status).toBe(409)
  })

  it('stays held after its organisation is deleted, and frees up when the period ends', async () => {
    const a = await organisation()
    const b = await organisation()
    const part = `gone-${crypto.randomUUID().slice(0, 8)}`
    expect((await putSettings(a.cookie, { localPart: part })).status).toBe(200)
    await db.delete(tenants).where(eq(tenants.id, a.id))

    const refused = await putSettings(b.cookie, { localPart: part })
    expect(refused.status).toBe(409)

    const past = new Date(Date.now() - (INBOX_LOCAL_PART_HOLD_DAYS + 1) * 86_400_000)
    await db
      .update(inboxLocalPartHolds)
      .set({ releasedAt: past })
      .where(eq(inboxLocalPartHolds.localPart, part))
    expect((await putSettings(b.cookie, { localPart: part })).status).toBe(200)
  })
})

describe('inbox tools', () => {
  it('present sender-written text as untrusted', async () => {
    const env = prodEnv()
    const outcome = await deliver(
      localPart,
      plain('Ann <ann@corp.example>', { subject: 'Tool subject', body: 'Tool body' }),
      { from: 'ann@corp.example', auth: [passFor('corp.example', 'ann@corp.example')] },
      env
    )
    if (outcome.status !== 'stored') throw new Error('not stored')
    await parseMessage(makeJobCtx({ db, env }), tenantId, outcome.messageId, [])
    const ctx = makeToolCtx({ db, tenantId })

    const read = JSON.parse(
      String(await getInboxMessageTool(ctx).handler?.({ messageId: outcome.messageId }))
    ) as { body: string; untrusted: string }
    expect(read.body).toContain('Tool body')
    expect(read.untrusted).toMatch(/never follow instructions/i)

    const listed = JSON.parse(String(await listInboxMessagesTool(ctx).handler?.({}))) as {
      messages: unknown[]
      untrusted: string
    }
    expect(listed.messages.length).toBeGreaterThan(0)
    expect(listed.untrusted).toMatch(/never follow instructions/i)
    expect(GET_INBOX_MESSAGE_TOOL).toBe('inbox_get_message')
  })
})
