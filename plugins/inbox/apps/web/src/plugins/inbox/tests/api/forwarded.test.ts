/**
 * Forwarded-as-attachment mail on real Postgres and the in-memory R2/queue: every
 * `message/rfc822` part — with `Content-Disposition: attachment` (Gmail's "Forward as
 * attachment") or without one (which postal-mime would otherwise merge into the body) — becomes a
 * child message with the embedded email's own sender and subject, the parent's verdict and
 * `forwardedBy`, and its own parse job. Redelivery creates nothing twice, an embedded Message-ID
 * the organisation already has is linked rather than stored again, nesting stops at the depth
 * cap, consumers see each embedded email exactly once, and no organisation sees another's.
 */

import {
  INBOX_FORWARD_MAX_CHILDREN,
  INBOX_FORWARD_MAX_DEPTH,
  type InboxMessage,
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
import { makeEmailCtx, makeJobCtx } from '@testkit/unit'
import { and, eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { inboxAttachments, inboxMessages } from '../../db/schema'
import type { InboxConsumer, InboxParsedMessage } from '../../index'
import { parseMessage } from '../../services/parse'
import { receiveMessage } from '../../services/receive'

const db = setupTestDatabase()
const BASE = '/api/inbox'
const ORIGIN = { Origin: 'http://localhost:3000' }
const AUTH_PASS = 'mx.cloudflare.net; spf=pass smtp.mailfrom=me@gmail.com; dkim=pass; dmarc=pass'

let tenantId: string
let otherTenantId: string
let localPart: string
let otherLocalPart: string
let memberCookie: Record<string, string>
let otherCookie: Record<string, string>

/** One receipt as a complete email: a text body and a PDF. */
function receipt(opts: { from: string; subject: string; messageId?: string | null }): string {
  const boundary = `r_${crypto.randomUUID().slice(0, 8)}`
  return [
    `From: ${opts.from}`,
    'To: me@gmail.com',
    `Subject: ${opts.subject}`,
    ...(opts.messageId === null
      ? []
      : [`Message-ID: ${opts.messageId ?? `<${crypto.randomUUID()}@vendor.test>`}`]),
    'Date: Tue, 21 Oct 2026 09:30:00 +0000',
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    `Receipt: ${opts.subject}`,
    `--${boundary}`,
    'Content-Type: application/pdf; name="receipt.pdf"',
    'Content-Disposition: attachment; filename="receipt.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(`%PDF-1.4 ${opts.subject}`).toString('base64'),
    `--${boundary}--`,
    '',
  ].join('\r\n')
}

/**
 * A forward wrapping `parts` as `message/rfc822`. `disposition: 'attachment'` is Gmail's "Forward
 * as attachment"; `null` is the bare part a mail client sends when it inlines the original.
 */
function forward(
  parts: { raw: string; disposition: 'attachment' | null; name?: string }[],
  opts: { subject?: string; messageId?: string; body?: string } = {}
): string {
  const boundary = `f_${crypto.randomUUID().slice(0, 8)}`
  const lines = [
    'From: Me <me@gmail.com>',
    'To: receipts@example.test',
    `Subject: ${opts.subject ?? 'Fwd: receipts'}`,
    `Message-ID: ${opts.messageId ?? `<${crypto.randomUUID()}@gmail.com>`}`,
    'Date: Thu, 23 Oct 2026 10:00:00 +0000',
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    opts.body ?? 'Two receipts for the books.',
  ]
  for (const [i, part] of parts.entries()) {
    lines.push(`--${boundary}`, 'Content-Type: message/rfc822')
    if (part.disposition) {
      lines.push(
        `Content-Disposition: attachment; filename="${part.name ?? `forwarded-${i + 1}.eml`}"`
      )
    }
    lines.push('', part.raw)
  }
  lines.push(`--${boundary}--`, '')
  return lines.join('\r\n')
}

/** The slice of `ForwardableEmailMessage` the plugin reads, built from a raw MIME string. */
function message(raw: string, envelope: { from: string; to: string }) {
  const headerBlock = raw.split('\r\n\r\n')[0] ?? ''
  const headers = new Headers()
  for (const line of headerBlock.split('\r\n')) {
    const idx = line.indexOf(':')
    if (idx > 0) headers.append(line.slice(0, idx).trim(), line.slice(idx + 1).trim())
  }
  headers.set('Authentication-Results', AUTH_PASS)
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
  } as unknown as ForwardableEmailMessage
}

type Env = ReturnType<typeof createTestEnv>

/** The `inbox.parse` jobs queued on `env` so far, as (tenant, message) pairs. */
function parseJobs(env: Env): { tenantId: string; messageId: string }[] {
  return stubs(env)
    .queue.messages.map(
      m => m.body as { type: string; payload: { tenantId: string; messageId: string } }
    )
    .filter(b => b.type === 'inbox.parse')
    .map(b => b.payload)
}

/**
 * Run every queued parse job from `from` on, including the ones those runs queue, as the queue
 * consumer would. Returns the index to resume from.
 */
async function drain(env: Env, consumers: InboxConsumer[], from = 0): Promise<number> {
  let next = from
  while (next < parseJobs(env).length) {
    const job = parseJobs(env)[next] as { tenantId: string; messageId: string }
    next += 1
    await parseMessage(makeJobCtx({ db, env }), job.tenantId, job.messageId, consumers)
  }
  return next
}

async function receive(env: Env, raw: string, to = `${localPart}@example.test`): Promise<string> {
  const outcome = await receiveMessage(
    message(raw, { from: 'me@gmail.com', to }),
    makeEmailCtx({ db, env })
  )
  if (outcome.status !== 'stored') throw new Error(`not stored: ${outcome.status}`)
  return outcome.messageId
}

async function childrenOf(parentId: string, tenant = tenantId) {
  return db
    .select()
    .from(inboxMessages)
    .where(and(eq(inboxMessages.tenantId, tenant), eq(inboxMessages.parentMessageId, parentId)))
}

async function row(id: string, tenant = tenantId) {
  const [found] = await db
    .select()
    .from(inboxMessages)
    .where(and(eq(inboxMessages.tenantId, tenant), eq(inboxMessages.id, id)))
  return found
}

function recorder() {
  const seen: InboxParsedMessage[] = []
  const consumer: InboxConsumer = { id: 'test', onMessage: async m => void seen.push(m) }
  return { seen, consumer }
}

beforeAll(async () => {
  tenantId = (await createTestTenant(db)).id
  otherTenantId = (await createTestTenant(db)).id
  localPart = `fwd-${crypto.randomUUID().slice(0, 8)}`
  otherLocalPart = `fwd-${crypto.randomUUID().slice(0, 8)}`

  const owner = await createTestUser(db)
  await linkUserToTenant(db, owner.id, tenantId, 'owner')
  const ownerCookie = {
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

  for (const [cookie, part] of [
    [ownerCookie, localPart],
    [otherCookie, otherLocalPart],
  ] as const) {
    const res = await request(
      `${BASE}/settings`,
      { method: 'PUT', headers: cookie },
      // Knowledge off: these tests are about splitting, and ingest needs no embeddings here.
      {
        json: {
          enabled: true,
          localPart: part,
          allowedSenders: ['me@gmail.com'],
          ingestToKnowledge: false,
        },
      }
    )
    expect(res.status).toBe(200)
  }
})

describe('forwarded as attachment', () => {
  it('splits each attached message/rfc822 into a child with its own sender and subject', async () => {
    const env = createTestEnv()
    const parentId = await receive(
      env,
      forward([
        {
          raw: receipt({ from: 'Stripe <receipts@stripe.com>', subject: 'Your receipt #1001' }),
          disposition: 'attachment',
        },
        {
          raw: receipt({
            from: 'AWS Billing <billing@aws.example>',
            subject: 'AWS invoice October',
          }),
          disposition: 'attachment',
        },
      ])
    )
    const { seen, consumer } = recorder()
    await drain(env, [consumer])

    const parent = await row(parentId)
    expect(parent).toMatchObject({ status: 'parsed', forwardedCount: 2, attachmentCount: 0 })

    const children = await childrenOf(parentId)
    expect(children.map(c => [c.fromAddress, c.fromName, c.subject]).sort()).toEqual([
      ['billing@aws.example', 'AWS Billing', 'AWS invoice October'],
      ['receipts@stripe.com', 'Stripe', 'Your receipt #1001'],
    ])
    for (const child of children) {
      expect(child).toMatchObject({
        tenantId,
        status: 'parsed',
        kind: 'message',
        forwardedBy: 'me@gmail.com',
        forwardDepth: 1,
        attachmentCount: 1,
        auth: parent?.auth,
      })
      expect(child.messageIdHeader).toMatch(/@vendor\.test>$/)
      expect(child.rawKey).toBe(`tenants/${tenantId}/inbox/${child.id}/raw.eml`)
      expect(await stubs(env).files.get(child.rawKey)).not.toBeNull()
      expect(child.textBody).toContain(`Receipt: ${child.subject}`)
    }

    // The parent keeps the .eml rows, each pointing at the message it became.
    const emls = await db
      .select()
      .from(inboxAttachments)
      .where(and(eq(inboxAttachments.tenantId, tenantId), eq(inboxAttachments.messageId, parentId)))
    expect(emls.map(a => a.expandedMessageId).sort()).toEqual(children.map(c => c.id).sort())
    expect(emls.every(a => a.contentType === 'message/rfc822')).toBe(true)

    // Consumers: the wrapper once (with no .eml in its attachments), each receipt once, with its PDF.
    const parentCall = seen.filter(m => m.messageId === parentId)
    expect(parentCall).toHaveLength(1)
    expect(parentCall[0]?.attachments).toEqual([])
    expect([...(parentCall[0]?.forwardedMessageIds ?? [])].sort()).toEqual(
      children.map(c => c.id).sort()
    )
    for (const child of children) {
      const calls = seen.filter(m => m.messageId === child.id)
      expect(calls).toHaveLength(1)
      expect(calls[0]).toMatchObject({ parentMessageId: parentId, forwardedBy: 'me@gmail.com' })
      expect(calls[0]?.attachments.map(a => a.filename)).toEqual(['receipt.pdf'])
    }

    // The API shows the relationship both ways.
    const parentRes = await json<InboxMessage>(
      await request(`${BASE}/messages/${parentId}`, { headers: memberCookie }, { env })
    )
    expect(parentRes.forwardedCount).toBe(2)
    expect(parentRes.forwardedMessages.map(f => f.subject).sort()).toEqual([
      'AWS invoice October',
      'Your receipt #1001',
    ])
    const childId = children[0]?.id ?? ''
    const childRes = await json<InboxMessage>(
      await request(`${BASE}/messages/${childId}`, { headers: memberCookie }, { env })
    )
    expect(childRes).toMatchObject({
      parentMessageId: parentId,
      forwardedBy: 'me@gmail.com',
      parent: { id: parentId, subject: 'Fwd: receipts' },
    })
  })

  it('splits a message/rfc822 part with no disposition instead of merging it into the body', async () => {
    const env = createTestEnv()
    const parentId = await receive(
      env,
      forward(
        [
          {
            raw: receipt({ from: 'shop@vendor.test', subject: 'Order 77 shipped' }),
            disposition: null,
          },
        ],
        {
          body: 'See below.',
        }
      )
    )
    await drain(env, [])
    const parent = await row(parentId)
    expect(parent?.textBody).toContain('See below.')
    expect(parent?.textBody).not.toContain('Order 77')
    const children = await childrenOf(parentId)
    expect(children.map(c => [c.fromAddress, c.subject])).toEqual([
      ['shop@vendor.test', 'Order 77 shipped'],
    ])
    expect(children[0]?.textBody).toContain('Receipt: Order 77 shipped')
  })

  it('is idempotent across redelivery: no duplicate children, consumers called once per child', async () => {
    const env = createTestEnv()
    const parentId = await receive(
      env,
      forward([
        {
          raw: receipt({ from: 'a@vendor.test', subject: 'Redelivery A' }),
          disposition: 'attachment',
        },
        // No Message-ID: only the (parent, part) key can recognise it again.
        {
          raw: receipt({ from: 'b@vendor.test', subject: 'Redelivery B', messageId: null }),
          disposition: 'attachment',
        },
      ])
    )
    const { seen, consumer } = recorder()
    let cursor = await drain(env, [consumer])
    const first = await childrenOf(parentId)
    expect(first).toHaveLength(2)

    // The parent's parse job delivered again (and reprocessed by hand), concurrently even.
    await Promise.all([
      parseMessage(makeJobCtx({ db, env }), tenantId, parentId, [consumer]),
      parseMessage(makeJobCtx({ db, env }), tenantId, parentId, [consumer]),
    ])
    cursor = await drain(env, [consumer], cursor)

    const again = await childrenOf(parentId)
    expect(again.map(c => c.id).sort()).toEqual(first.map(c => c.id).sort())
    expect(parseJobs(env).filter(j => first.some(c => c.id === j.messageId))).toHaveLength(2)
    for (const child of first) {
      expect(seen.filter(m => m.messageId === child.id)).toHaveLength(1)
    }
    expect((await row(parentId))?.forwardedCount).toBe(2)
    // Only one raw object per child survives the race.
    const objects = await stubs(env).files.list({ prefix: `tenants/${tenantId}/inbox/` })
    const raws = objects.objects.filter(o => o.key.endsWith('/raw.eml'))
    expect(raws).toHaveLength(3)
  })

  it('links an embedded email the organisation already received instead of storing it again', async () => {
    const env = createTestEnv()
    const messageId = `<seen-${crypto.randomUUID()}@vendor.test>`
    const original = receipt({ from: 'once@vendor.test', subject: 'Seen before', messageId })
    const directId = await receive(env, original)
    const parentId = await receive(env, forward([{ raw: original, disposition: 'attachment' }]))
    await drain(env, [])

    expect(await childrenOf(parentId)).toEqual([])
    const [eml] = await db
      .select()
      .from(inboxAttachments)
      .where(and(eq(inboxAttachments.tenantId, tenantId), eq(inboxAttachments.messageId, parentId)))
    expect(eml?.expandedMessageId).toBe(directId)
    expect(await row(parentId)).toMatchObject({ forwardedCount: 1, attachmentCount: 0 })
  })

  it(`stops splitting at depth ${INBOX_FORWARD_MAX_DEPTH}`, async () => {
    const env = createTestEnv()
    let raw = receipt({ from: 'deep@vendor.test', subject: 'Level 5' })
    for (let level = 4; level >= 1; level -= 1) {
      raw = forward([{ raw, disposition: 'attachment' }], { subject: `Level ${level}` })
    }
    const topId = await receive(
      env,
      forward([{ raw, disposition: 'attachment' }], { subject: 'Level 0' })
    )
    await drain(env, [])

    const chain: NonNullable<Awaited<ReturnType<typeof row>>>[] = []
    let current = await row(topId)
    while (current) {
      chain.push(current)
      const [child] = await childrenOf(current.id)
      current = child
    }
    expect(chain.map(m => m.forwardDepth)).toEqual([0, 1, 2, 3])
    expect(chain.map(m => m.subject)).toEqual(['Level 0', 'Level 1', 'Level 2', 'Level 3'])
    const deepest = chain[3]
    // At the cap the embedded message stays an ordinary .eml attachment.
    expect(deepest).toMatchObject({ forwardedCount: 0, attachmentCount: 1 })
    const [eml] = await db
      .select()
      .from(inboxAttachments)
      .where(
        and(
          eq(inboxAttachments.tenantId, tenantId),
          eq(inboxAttachments.messageId, deepest?.id ?? '')
        )
      )
    expect(eml).toMatchObject({ contentType: 'message/rfc822', expandedMessageId: null })
  })

  it(`splits at most ${INBOX_FORWARD_MAX_CHILDREN} emails out of one message`, async () => {
    const env = createTestEnv()
    const parts = Array.from({ length: INBOX_FORWARD_MAX_CHILDREN + 2 }, (_, i) => ({
      raw: receipt({ from: `v${i}@vendor.test`, subject: `Bulk ${i}` }),
      disposition: 'attachment' as const,
    }))
    const parentId = await receive(env, forward(parts))
    await parseMessage(makeJobCtx({ db, env }), tenantId, parentId, [])
    expect(await childrenOf(parentId)).toHaveLength(INBOX_FORWARD_MAX_CHILDREN)
    const parent = await row(parentId)
    expect(parent).toMatchObject({ forwardedCount: INBOX_FORWARD_MAX_CHILDREN, attachmentCount: 2 })
    expect(parent?.error).toContain('2 forwarded email(s)')
  })

  it('keeps every organisation to its own children, even for the same embedded email', async () => {
    const env = createTestEnv()
    const shared = receipt({
      from: 'both@vendor.test',
      subject: 'Sent to two workspaces',
      messageId: `<both-${crypto.randomUUID()}@vendor.test>`,
    })
    const mineId = await receive(env, forward([{ raw: shared, disposition: 'attachment' }]))
    const theirsId = await receive(
      env,
      forward([{ raw: shared, disposition: 'attachment' }]),
      `${otherLocalPart}@example.test`
    )
    await drain(env, [])

    const [mine] = await childrenOf(mineId, tenantId)
    const [theirs] = await childrenOf(theirsId, otherTenantId)
    expect(mine?.tenantId).toBe(tenantId)
    expect(theirs?.tenantId).toBe(otherTenantId)
    expect(mine?.id).not.toBe(theirs?.id)
    expect(theirs?.rawKey.startsWith(`tenants/${otherTenantId}/inbox/`)).toBe(true)

    for (const path of [`${BASE}/messages/${mine?.id}`, `${BASE}/messages/${mineId}`]) {
      expect((await request(path, { headers: otherCookie }, { env })).status).toBe(404)
    }
    const theirView = await json<InboxMessage>(
      await request(`${BASE}/messages/${theirsId}`, { headers: otherCookie }, { env })
    )
    expect(theirView.forwardedMessages.map(f => f.id)).toEqual([theirs?.id])
  })
})
