/**
 * The inbox end to end on real Postgres and the in-memory R2/queue: settings, the receive
 * decisions (address, sender, authentication, confirmations, duplicates), parsing a real MIME
 * message into a text body and attachments, the consumer call, the download routes, and tenant
 * isolation — another organisation can neither list, read, download nor delete.
 */
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
import { makeEmailCtx, makeJobCtx } from '@testkit/unit'
import { and, eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { inboxAttachments, inboxMessages } from '../../db/schema'
import type { InboxConsumer, InboxParsedMessage } from '../../index'
import { parseMessage, readInboxAttachment } from '../../services/parse'
import { receiveMessage } from '../../services/receive'

const db = setupTestDatabase()
const BASE = '/api/inbox'
const ORIGIN = { Origin: 'http://localhost:3000' }
const AUTH_PASS = 'mx.cloudflare.net; spf=pass smtp.mailfrom=me@gmail.com; dkim=pass; dmarc=pass'

let tenantId: string
let localPart: string
let ownerCookie: Record<string, string>
let memberCookie: Record<string, string>
let otherCookie: Record<string, string>

/** A small multipart message: a text body and one PDF attachment. */
function mime(opts: {
  from?: string
  subject?: string
  messageId?: string
  body?: string
  pdf?: string
}): string {
  const boundary = 'b1_inbox_test'
  const pdf = Buffer.from(opts.pdf ?? '%PDF-1.4 receipt').toString('base64')
  return [
    `From: ${opts.from ?? 'Stripe <receipts@stripe.com>'}`,
    'To: me@gmail.com',
    `Subject: ${opts.subject ?? 'Your receipt #1234'}`,
    `Message-ID: ${opts.messageId ?? `<${crypto.randomUUID()}@stripe.com>`}`,
    'Date: Thu, 23 Oct 2026 10:00:00 +0000',
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    opts.body ?? 'Thanks for your payment of £12.00.',
    `--${boundary}`,
    'Content-Type: application/pdf; name="receipt.pdf"',
    'Content-Disposition: attachment; filename="receipt.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    pdf,
    `--${boundary}--`,
    '',
  ].join('\r\n')
}

/** The slice of `ForwardableEmailMessage` the plugin reads, built from a raw MIME string. */
function message(raw: string, envelope: { from: string; to: string; auth?: string | null }) {
  const headerBlock = raw.split('\r\n\r\n')[0] ?? ''
  const headers = new Headers()
  for (const line of headerBlock.split('\r\n')) {
    const idx = line.indexOf(':')
    if (idx > 0) headers.append(line.slice(0, idx).trim(), line.slice(idx + 1).trim())
  }
  if (envelope.auth !== null) headers.set('Authentication-Results', envelope.auth ?? AUTH_PASS)
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

beforeAll(async () => {
  tenantId = (await createTestTenant(db)).id
  const otherTenantId = (await createTestTenant(db)).id
  localPart = `receipts-${crypto.randomUUID().slice(0, 8)}`

  const owner = await createTestUser(db)
  await linkUserToTenant(db, owner.id, tenantId, 'owner')
  ownerCookie = {
    ...sessionCookieHeader(await createTestSession(db, owner.id, tenantId)),
    ...ORIGIN,
  }

  const member = await createTestUser(db)
  await linkUserToTenant(db, member.id, tenantId, 'member')
  memberCookie = {
    ...sessionCookieHeader(await createTestSession(db, member.id, tenantId)),
    ...ORIGIN,
  }

  const outsider = await createTestUser(db)
  await linkUserToTenant(db, outsider.id, otherTenantId, 'owner')
  otherCookie = {
    ...sessionCookieHeader(await createTestSession(db, outsider.id, otherTenantId)),
    ...ORIGIN,
  }

  const res = await request(
    `${BASE}/settings`,
    { method: 'PUT', headers: ownerCookie },
    { json: { enabled: true, localPart, allowedSenders: ['me@gmail.com'] } }
  )
  expect(res.status).toBe(200)
})

describe('settings', () => {
  it('lets members read and only admins write', async () => {
    const read = await request(`${BASE}/settings`, { headers: memberCookie })
    expect(await json(read)).toMatchObject({
      enabled: true,
      localPart,
      requireAuthentication: true,
    })
    const write = await request(
      `${BASE}/settings`,
      { method: 'PUT', headers: memberCookie },
      { json: { enabled: false } }
    )
    expect(write.status).toBe(403)
  })

  it('refuses a local part another organisation owns', async () => {
    const res = await request(
      `${BASE}/settings`,
      { method: 'PUT', headers: otherCookie },
      { json: { localPart } }
    )
    expect(res.status).toBe(409)
    expect(await json(res)).toMatchObject({ code: 'inbox_local_part_taken' })
  })

  it('refuses turning on without an address', async () => {
    const res = await request(
      `${BASE}/settings`,
      { method: 'PUT', headers: otherCookie },
      { json: { enabled: true } }
    )
    expect(res.status).toBe(400)
  })
})

describe('receive', () => {
  it('rejects an address no organisation owns, before touching storage', async () => {
    const env = createTestEnv()
    const msg = message(mime({}), { from: 'me@gmail.com', to: 'nobody-here@example.test' })
    const outcome = await receiveMessage(msg, makeEmailCtx({ db, env }))
    expect(outcome).toEqual({ status: 'rejected', reason: 'address' })
    expect(msg.setReject).toHaveBeenCalledWith('Unknown recipient')
    expect(stubs(env).queue.messages).toHaveLength(0)
  })

  it('rejects a sender not on the allow-list, and one that failed authentication', async () => {
    const env = createTestEnv()
    const stranger = message(mime({ from: 'x@spam.test' }), {
      from: 'x@spam.test',
      to: `${localPart}@example.test`,
    })
    expect(await receiveMessage(stranger, makeEmailCtx({ db, env }))).toEqual({
      status: 'rejected',
      reason: 'sender',
    })
    const forged = message(mime({}), {
      from: 'me@gmail.com',
      to: `${localPart}@example.test`,
      auth: 'mx.cloudflare.net; spf=fail; dkim=none; dmarc=fail',
    })
    expect(await receiveMessage(forged, makeEmailCtx({ db, env }))).toEqual({
      status: 'rejected',
      reason: 'authentication',
    })
  })

  it('stores, queues and parses an allowed message, then calls consumers', async () => {
    const env = createTestEnv()
    const msg = message(mime({}), {
      from: 'me+caf_=x@gmail.com',
      to: `${localPart}+gmail@example.test`,
    })
    const outcome = await receiveMessage(msg, makeEmailCtx({ db, env }))
    expect(outcome.status).toBe('stored')
    if (outcome.status !== 'stored') return
    expect(msg.setReject).not.toHaveBeenCalled()
    expect(stubs(env).queue.messages.map(m => (m.body as { type: string }).type)).toEqual([
      'inbox.parse',
    ])

    const seen: InboxParsedMessage[] = []
    const consumer: InboxConsumer = { id: 'test', onMessage: async m => void seen.push(m) }
    const jobCtx = makeJobCtx({ db, env })
    await parseMessage(jobCtx, tenantId, outcome.messageId, [consumer])

    const [row] = await db
      .select()
      .from(inboxMessages)
      .where(and(eq(inboxMessages.tenantId, tenantId), eq(inboxMessages.id, outcome.messageId)))
    expect(row).toMatchObject({
      status: 'parsed',
      kind: 'message',
      fromAddress: 'receipts@stripe.com',
      subaddress: 'gmail',
      subject: 'Your receipt #1234',
      attachmentCount: 1,
    })
    expect(row?.textBody).toContain('£12.00')

    expect(seen).toHaveLength(1)
    expect(seen[0]?.attachments).toEqual([
      expect.objectContaining({ filename: 'receipt.pdf', contentType: 'application/pdf' }),
    ])
    const attachmentId = seen[0]?.attachments[0]?.id ?? ''
    const file = await readInboxAttachment(jobCtx, tenantId, attachmentId)
    expect(new TextDecoder().decode(file?.bytes)).toBe('%PDF-1.4 receipt')

    // A reprocess finds the same bytes and keeps the same attachment row.
    await parseMessage(jobCtx, tenantId, outcome.messageId, [consumer])
    const attachments = await db
      .select()
      .from(inboxAttachments)
      .where(eq(inboxAttachments.messageId, outcome.messageId))
    expect(attachments.map(a => a.id)).toEqual([attachmentId])
    expect(seen).toHaveLength(2)
  })

  it('stores a message delivered twice only once', async () => {
    const env = createTestEnv()
    const raw = mime({ messageId: `<dup-${crypto.randomUUID()}@stripe.com>` })
    const to = `${localPart}@example.test`
    const first = await receiveMessage(
      message(raw, { from: 'me@gmail.com', to }),
      makeEmailCtx({ db, env })
    )
    const second = await receiveMessage(
      message(raw, { from: 'me@gmail.com', to }),
      makeEmailCtx({ db, env })
    )
    expect(first.status).toBe('stored')
    expect(second).toEqual({
      status: 'duplicate',
      messageId: first.status === 'stored' ? first.messageId : '',
    })
  })

  it('records a hand-forwarded message under its original sender', async () => {
    const env = createTestEnv()
    const raw = mime({
      from: 'Me <me@gmail.com>',
      subject: 'Fwd: Invoice INV-9',
      body: 'fyi\n\n---------- Forwarded message ---------\nFrom: AWS <billing@aws.example>\nSubject: Invoice INV-9\n',
    })
    const outcome = await receiveMessage(
      message(raw, { from: 'me@gmail.com', to: `${localPart}@example.test` }),
      makeEmailCtx({ db, env })
    )
    if (outcome.status !== 'stored') throw new Error('not stored')
    await parseMessage(makeJobCtx({ db, env }), tenantId, outcome.messageId, [])
    const [row] = await db
      .select()
      .from(inboxMessages)
      .where(eq(inboxMessages.id, outcome.messageId))
    expect(row).toMatchObject({ fromAddress: 'billing@aws.example', fromName: 'AWS' })
  })

  it('accepts a Gmail forwarding confirmation and surfaces its code', async () => {
    const env = createTestEnv()
    const raw = [
      'From: Gmail Team <forwarding-noreply@google.com>',
      'Subject: (#812345678) Gmail Forwarding Confirmation - Receive Mail from me@gmail.com',
      `Message-ID: <${crypto.randomUUID()}@google.com>`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Confirmation code: 812345678',
      'https://mail-settings.google.com/mail/vf-abc',
      '',
    ].join('\r\n')
    const outcome = await receiveMessage(
      message(raw, { from: 'forwarding-noreply@google.com', to: `${localPart}@example.test` }),
      makeEmailCtx({ db, env })
    )
    if (outcome.status !== 'stored') throw new Error('not stored')
    const seen: InboxParsedMessage[] = []
    await parseMessage(makeJobCtx({ db, env }), tenantId, outcome.messageId, [
      { id: 'test', onMessage: async m => void seen.push(m) },
    ])
    const res = await request(`${BASE}/messages/${outcome.messageId}`, { headers: memberCookie })
    expect(await json(res)).toMatchObject({
      kind: 'confirmation',
      confirmation: {
        provider: 'gmail',
        code: '812345678',
        url: 'https://mail-settings.google.com/mail/vf-abc',
      },
    })
    // A confirmation is not mail anybody subscribed to.
    expect(seen).toEqual([])
  })
})

describe('routes and tenant isolation', () => {
  let messageId: string
  let attachmentId: string
  const env = createTestEnv()

  beforeAll(async () => {
    const outcome = await receiveMessage(
      message(mime({ subject: 'Isolation receipt' }), {
        from: 'me@gmail.com',
        to: `${localPart}@example.test`,
      }),
      makeEmailCtx({ db, env })
    )
    if (outcome.status !== 'stored') throw new Error('not stored')
    messageId = outcome.messageId
    await parseMessage(makeJobCtx({ db, env }), tenantId, messageId, [])
    const [att] = await db
      .select()
      .from(inboxAttachments)
      .where(eq(inboxAttachments.messageId, messageId))
    attachmentId = att?.id ?? ''
  })

  it('lists and downloads for a member, always as an attachment', async () => {
    const list = await request(`${BASE}/messages`, { headers: memberCookie }, { env })
    const body = await json<{ items: { id: string }[] }>(list)
    expect(body.items.map(m => m.id)).toContain(messageId)

    const file = await request(
      `${BASE}/attachments/${attachmentId}`,
      { headers: memberCookie },
      { env }
    )
    expect(file.status).toBe(200)
    expect(file.headers.get('content-disposition')).toBe('attachment; filename="receipt.pdf"')
    expect(file.headers.get('x-content-type-options')).toBe('nosniff')
    expect(await file.text()).toBe('%PDF-1.4 receipt')

    const raw = await request(
      `${BASE}/messages/${messageId}/raw`,
      { headers: memberCookie },
      { env }
    )
    expect(raw.headers.get('content-type')).toBe('message/rfc822')
  })

  it('never lets another organisation list, read, download or delete', async () => {
    const list = await request(`${BASE}/messages`, { headers: otherCookie }, { env })
    const body = await json<{ items: { id: string }[] }>(list)
    expect(body.items.map(m => m.id)).not.toContain(messageId)
    for (const path of [
      `${BASE}/messages/${messageId}`,
      `${BASE}/messages/${messageId}/raw`,
      `${BASE}/attachments/${attachmentId}`,
    ]) {
      expect((await request(path, { headers: otherCookie }, { env })).status).toBe(404)
    }
    const deleted = await request(
      `${BASE}/messages/${messageId}`,
      { method: 'DELETE', headers: otherCookie },
      { env }
    )
    expect(deleted.status).toBe(404)
    const [row] = await db.select().from(inboxMessages).where(eq(inboxMessages.id, messageId))
    expect(row).toBeDefined()
  })

  it('lets a member read but not delete; an owner deletes the row and its objects', async () => {
    const denied = await request(
      `${BASE}/messages/${messageId}`,
      { method: 'DELETE', headers: memberCookie },
      { env }
    )
    expect(denied.status).toBe(403)
    const res = await request(
      `${BASE}/messages/${messageId}`,
      { method: 'DELETE', headers: ownerCookie },
      { env }
    )
    expect(res.status).toBe(204)
    const [row] = await db.select().from(inboxMessages).where(eq(inboxMessages.id, messageId))
    expect(row).toBeUndefined()
    const left = await stubs(env).files.list({ prefix: `tenants/${tenantId}/inbox/${messageId}/` })
    expect(left.objects).toHaveLength(0)
  })
})
