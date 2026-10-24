/** The inbox's pure decisions, as tables (`services/rules.ts`). */
import { describe, expect, it } from 'vitest'
import {
  acceptMessage,
  confirmationProvider,
  extractConfirmation,
  extractForwardedOriginal,
  isForwardSubject,
  keepPart,
  normaliseAddress,
  parseAuthenticationResults,
  safeFilename,
  senderMatches,
} from '../../services/rules'

const PASS = { spf: 'pass', dkim: null, dmarc: null }
const FAIL = { spf: 'fail', dkim: 'fail', dmarc: 'fail' }

describe('addresses', () => {
  it('normalises case and drops the subaddress', () => {
    expect(normaliseAddress(' Me+Caf_=x@Gmail.COM ')).toBe('me@gmail.com')
    expect(normaliseAddress('no-at-sign')).toBe('no-at-sign')
  })

  it('matches whole addresses and @domains, ignoring +tags', () => {
    expect(senderMatches('me+caf_=receipts=x.dev@gmail.com', ['me@gmail.com'])).toBe(true)
    expect(senderMatches('billing@stripe.com', ['@stripe.com'])).toBe(true)
    expect(senderMatches('billing@evilstripe.com', ['@stripe.com'])).toBe(false)
    expect(senderMatches('you@gmail.com', ['me@gmail.com'])).toBe(false)
  })
})

describe('authentication', () => {
  it('reads the first verdict per method across headers', () => {
    expect(
      parseAuthenticationResults([
        'mx.cloudflare.net; dkim=pass header.d=gmail.com; spf=pass smtp.mailfrom=me@gmail.com; dmarc=pass',
        'other; spf=fail',
      ])
    ).toEqual({ spf: 'pass', dkim: 'pass', dmarc: 'pass' })
    expect(parseAuthenticationResults([])).toEqual({ spf: null, dkim: null, dmarc: null })
  })
})

describe('acceptMessage', () => {
  const base = {
    enabled: true,
    allowedSenders: ['me@gmail.com'],
    requireAuthentication: true,
    envelopeFrom: 'me@gmail.com',
    headerFrom: 'receipts@vendor.com',
    auth: PASS,
  }

  it('accepts an allow-listed, authenticated forwarder', () => {
    expect(acceptMessage(base)).toEqual({ accept: true, confirmationProvider: null })
  })

  it('accepts on the From header when the envelope is not listed', () => {
    expect(
      acceptMessage({ ...base, envelopeFrom: 'bounce@srs.vendor.com', headerFrom: 'me@gmail.com' })
    ).toEqual({ accept: true, confirmationProvider: null })
  })

  it('refuses an unlisted sender, a failed authentication and a disabled inbox', () => {
    expect(acceptMessage({ ...base, envelopeFrom: 'x@y.com', headerFrom: null })).toEqual({
      accept: false,
      reason: 'sender',
    })
    expect(acceptMessage({ ...base, auth: FAIL })).toEqual({
      accept: false,
      reason: 'authentication',
    })
    expect(acceptMessage({ ...base, enabled: false })).toEqual({
      accept: false,
      reason: 'disabled',
    })
  })

  it('skips authentication only when the organisation does not require it', () => {
    expect(acceptMessage({ ...base, auth: FAIL, requireAuthentication: false }).accept).toBe(true)
  })

  it('lets an authenticated Gmail confirmation through before anyone is allow-listed', () => {
    const confirmation = {
      ...base,
      enabled: false,
      allowedSenders: [],
      envelopeFrom: 'forwarding-noreply@google.com',
      headerFrom: 'forwarding-noreply@google.com',
    }
    expect(acceptMessage(confirmation)).toEqual({ accept: true, confirmationProvider: 'gmail' })
    expect(acceptMessage({ ...confirmation, auth: FAIL })).toEqual({
      accept: false,
      reason: 'authentication',
    })
  })

  it('treats an allow-listed Proton mailbox as a sender, not a confirmation', () => {
    expect(
      acceptMessage({ ...base, allowedSenders: ['me@proton.me'], envelopeFrom: 'me@proton.me' })
    ).toEqual({ accept: true, confirmationProvider: null })
    expect(confirmationProvider('noreply@proton.me')).toBe('proton')
    expect(confirmationProvider('me@gmail.com')).toBeNull()
  })
})

describe('extractConfirmation', () => {
  it('finds Gmail’s code in the body or the subject, and its link', () => {
    const text =
      'me@gmail.com has requested to automatically forward mail to your email address.\n' +
      'Confirmation code: 812345678\n\nTo allow, click: https://mail-settings.google.com/mail/vf-%5BANGjdJ%5D-abc\n' +
      'Other: https://support.google.com/mail'
    expect(extractConfirmation('gmail', null, text)).toEqual({
      provider: 'gmail',
      code: '812345678',
      url: 'https://mail-settings.google.com/mail/vf-%5BANGjdJ%5D-abc',
    })
    expect(
      extractConfirmation('gmail', '(#998877665) Gmail Forwarding Confirmation', 'no code here')
        .code
    ).toBe('998877665')
  })

  it('finds Proton’s link', () => {
    expect(
      extractConfirmation(
        'proton',
        'Confirm forwarding',
        'Open https://account.proton.me/confirm?x=1'
      ).url
    ).toBe('https://account.proton.me/confirm?x=1')
  })
})

describe('forwarded originals', () => {
  it('recognises forward subjects', () => {
    expect(isForwardSubject('Fwd: Your receipt')).toBe(true)
    expect(isForwardSubject('FW: Invoice')).toBe(true)
    expect(isForwardSubject('Your receipt')).toBe(false)
  })

  it('reads the Gmail, Apple and Outlook header blocks', () => {
    expect(
      extractForwardedOriginal(
        'hi\n\n---------- Forwarded message ---------\nFrom: Stripe <receipts@stripe.com>\nDate: Mon\nSubject: Your receipt #1234\nTo: me@gmail.com\n'
      )
    ).toEqual({
      fromAddress: 'receipts@stripe.com',
      fromName: 'Stripe',
      subject: 'Your receipt #1234',
    })
    expect(
      extractForwardedOriginal(
        'Begin forwarded message:\n\n> From: "AWS" <no-reply@aws.amazon.com>\n> Subject: Invoice\n'
      )
    ).toMatchObject({ fromAddress: 'no-reply@aws.amazon.com', fromName: 'AWS' })
    expect(
      extractForwardedOriginal(
        '-----Original Message-----\nFrom: billing@vendor.co.uk\nSent: Tuesday\nSubject: Bill\n'
      )
    ).toMatchObject({ fromAddress: 'billing@vendor.co.uk', fromName: null })
    expect(extractForwardedOriginal('just a note')).toBeNull()
  })
})

describe('parts and filenames', () => {
  it('keeps attachments and big inline images, drops logos', () => {
    expect(keepPart({ inline: false, contentType: 'image/png', size: 10 })).toBe(true)
    expect(keepPart({ inline: true, contentType: 'image/png', size: 2_000 })).toBe(false)
    expect(keepPart({ inline: true, contentType: 'image/jpeg', size: 200_000 })).toBe(true)
    expect(keepPart({ inline: true, contentType: 'application/pdf', size: 10 })).toBe(true)
  })

  it('makes filenames safe for keys and headers', () => {
    expect(safeFilename('Invoice "March"/2026.pdf', 'x')).toBe('Invoice March2026.pdf')
    expect(safeFilename('', 'attachment-1')).toBe('attachment-1')
    expect(safeFilename(null, 'attachment-2')).toBe('attachment-2')
  })
})
