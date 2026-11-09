/** The inbox's pure decisions, as tables (`services/rules.ts`). */
import { describe, expect, it } from 'vitest'
import {
  type AuthenticationResults,
  acceptMessage,
  confirmationProvider,
  extractConfirmation,
  extractForwardedOriginal,
  isForwardSubject,
  keepPart,
  normaliseAddress,
  parseAddressHeader,
  parseAuthenticationResults,
  safeFilename,
  senderMatches,
} from '../../services/rules'

/** Verdicts plus the identity each one vouches for. */
function auth(partial: Partial<AuthenticationResults>): AuthenticationResults {
  return {
    spf: null,
    dkim: null,
    dmarc: null,
    spfDomain: null,
    dkimDomains: [],
    dmarcDomain: null,
    ...partial,
  }
}

const PASS = auth({ spf: 'pass', spfDomain: 'gmail.com' })
const FAIL = auth({ spf: 'fail', dkim: 'fail', dmarc: 'fail' })

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

describe('the From header', () => {
  it('reads one mailbox, ignoring an address in a display name or a comment', () => {
    expect(parseAddressHeader('"<ceo@allowed.example>" <a@sender.example>')).toEqual({
      address: 'a@sender.example',
      name: '<ceo@allowed.example>',
    })
    expect(parseAddressHeader('(ceo@allowed.example) a@sender.example')?.address).toBe(
      'a@sender.example'
    )
    expect(parseAddressHeader('Stripe <Receipts@Stripe.com>')).toEqual({
      address: 'receipts@stripe.com',
      name: 'Stripe',
    })
    expect(parseAddressHeader('billing@vendor.co.uk')).toEqual({
      address: 'billing@vendor.co.uk',
      name: null,
    })
  })

  it('reads no mailbox from a list, a group or an empty value', () => {
    expect(parseAddressHeader('ceo@allowed.example, a@sender.example')).toBeNull()
    expect(parseAddressHeader('team: ceo@allowed.example;')).toBeNull()
    expect(parseAddressHeader('not an address')).toBeNull()
    expect(parseAddressHeader(null)).toBeNull()
  })
})

describe('authentication', () => {
  const EDGE =
    'mx.cloudflare.net; dkim=pass header.d=gmail.com header.s=x; spf=pass (mx.cloudflare.net: permitted sender) smtp.mailfrom=me+caf_=x@gmail.com; dmarc=pass header.from=gmail.com policy.dmarc=none'

  it('reads each method with the identity it vouches for, from the edge header alone', () => {
    expect(parseAuthenticationResults([EDGE, 'other; spf=fail'])).toMatchObject({
      spf: 'pass',
      dkim: 'pass',
      dmarc: 'pass',
      spfDomain: 'gmail.com',
      dkimDomains: ['gmail.com'],
      dmarcDomain: 'gmail.com',
    })
    expect(parseAuthenticationResults([])).toEqual(auth({}))
  })

  it('ignores any header that is not the edge’s, wherever it comes', () => {
    const sender = 'sender.example; spf=pass smtp.mailfrom=a@sender.example; dmarc=pass'
    const edgeFail = 'mx.cloudflare.net; spf=fail smtp.mailfrom=x@sender.example; dkim=none'
    for (const joined of [`${edgeFail}, ${sender}`, `${sender}, ${edgeFail}`]) {
      expect(parseAuthenticationResults([joined])).toMatchObject({
        spf: 'fail',
        dkim: 'none',
        dmarc: null,
      })
    }
    expect(parseAuthenticationResults([sender])).toEqual(auth({}))
  })

  it('reads a verdict only from where a verdict goes', () => {
    expect(
      parseAuthenticationResults([
        'mx.cloudflare.net; spf=fail smtp.mailfrom=dkim=pass@sender.example (dmarc=pass); arc=none; dkim=none',
      ])
    ).toMatchObject({ spf: 'fail', dkim: 'none', dmarc: null })
    expect(
      parseAuthenticationResults([
        'mx.cloudflare.net; spf=fail smtp.mailfrom="x;dkim=pass"@sender.example',
      ])
    ).toMatchObject({ spf: 'fail', dkim: null })
  })

  it('collects every DKIM signature that passed', () => {
    expect(
      parseAuthenticationResults([
        'mx.cloudflare.net; dkim=fail header.d=a.example; dkim=pass header.d=b.example; dkim=pass header.d=c.example',
      ])
    ).toMatchObject({ dkim: 'pass', dkimDomains: ['b.example', 'c.example'] })
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
    confirmationWindowOpen: false,
  }

  it('accepts an allow-listed, authenticated forwarder', () => {
    expect(acceptMessage(base)).toEqual({ accept: true, confirmationProvider: null })
  })

  it('accepts on the From header when the envelope is not listed and DKIM aligns with it', () => {
    expect(
      acceptMessage({
        ...base,
        envelopeFrom: 'bounce@srs.vendor.com',
        headerFrom: 'me@gmail.com',
        auth: auth({
          spf: 'pass',
          spfDomain: 'srs.vendor.com',
          dkim: 'pass',
          dkimDomains: ['gmail.com'],
        }),
      })
    ).toEqual({ accept: true, confirmationProvider: null })
  })

  it('binds the passing authentication to the identity that matched the allow-list', () => {
    const fromOnly = {
      ...base,
      allowedSenders: ['ceo@allowed.example'],
      envelopeFrom: 'a@sender.example',
      headerFrom: 'ceo@allowed.example',
    }
    expect(
      acceptMessage({
        ...fromOnly,
        auth: auth({
          spf: 'pass',
          spfDomain: 'sender.example',
          dmarc: 'fail',
          dmarcDomain: 'allowed.example',
        }),
      })
    ).toEqual({
      accept: false,
      reason: 'authentication',
    })
    expect(
      acceptMessage({ ...fromOnly, auth: auth({ dkim: 'pass', dkimDomains: ['sender.example'] }) })
    ).toEqual({ accept: false, reason: 'authentication' })
    expect(
      acceptMessage({ ...fromOnly, auth: auth({ dmarc: 'pass', dmarcDomain: 'allowed.example' }) })
    ).toEqual({ accept: true, confirmationProvider: null })
    expect(
      acceptMessage({ ...fromOnly, auth: auth({ dkim: 'pass', dkimDomains: ['allowed.example'] }) })
    ).toEqual({ accept: true, confirmationProvider: null })
    expect(
      acceptMessage({
        ...fromOnly,
        auth: auth({ dkim: 'pass', dkimDomains: ['mail.allowed.example'] }),
      })
    ).toEqual({ accept: true, confirmationProvider: null })
    // A lookalike domain is not aligned.
    expect(
      acceptMessage({
        ...fromOnly,
        auth: auth({ dkim: 'pass', dkimDomains: ['allowed.example.sender.example'] }),
      })
    ).toEqual({ accept: false, reason: 'authentication' })
  })

  it('requires the envelope sender’s own domain to authenticate when the envelope matched', () => {
    expect(
      acceptMessage({ ...base, auth: auth({ spf: 'pass', spfDomain: 'sender.example' }) })
    ).toEqual({ accept: false, reason: 'authentication' })
    expect(
      acceptMessage({ ...base, auth: auth({ dkim: 'pass', dkimDomains: ['gmail.com'] }) })
    ).toEqual({ accept: true, confirmationProvider: null })
  })

  it('never lets a From-only message through on an explicit DMARC failure', () => {
    expect(
      acceptMessage({
        ...base,
        allowedSenders: ['ceo@allowed.example'],
        envelopeFrom: 'a@sender.example',
        headerFrom: 'ceo@allowed.example',
        auth: auth({ dmarc: 'fail', spf: 'pass', spfDomain: 'allowed.example' }),
      })
    ).toEqual({ accept: false, reason: 'authentication' })
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

  describe('forwarding confirmations', () => {
    const GOOGLE = auth({ dkim: 'pass', dkimDomains: ['google.com'] })
    const confirmation = {
      ...base,
      enabled: false,
      allowedSenders: [],
      envelopeFrom: 'forwarding-noreply@google.com',
      headerFrom: 'forwarding-noreply@google.com',
      auth: GOOGLE,
      confirmationWindowOpen: true,
    }

    it('lets the provider through during the setup window, before anyone is allow-listed', () => {
      expect(acceptMessage(confirmation)).toEqual({ accept: true, confirmationProvider: 'gmail' })
    })

    it('requires the authentication to be the provider’s own', () => {
      expect(acceptMessage({ ...confirmation, auth: FAIL })).toEqual({
        accept: false,
        reason: 'authentication',
      })
      expect(
        acceptMessage({
          ...confirmation,
          auth: auth({
            spf: 'fail',
            dkim: 'pass',
            dkimDomains: ['sender.example'],
            dmarc: 'pass',
            dmarcDomain: 'sender.example',
          }),
        })
      ).toEqual({ accept: false, reason: 'authentication' })
    })

    it('applies the ordinary rules outside the setup window', () => {
      expect(acceptMessage({ ...confirmation, confirmationWindowOpen: false })).toEqual({
        accept: false,
        reason: 'disabled',
      })
      expect(
        acceptMessage({ ...confirmation, enabled: true, confirmationWindowOpen: false })
      ).toEqual({ accept: false, reason: 'sender' })
      expect(
        acceptMessage({
          ...confirmation,
          envelopeFrom: 'anyone@proton.me',
          headerFrom: 'anyone@proton.me',
          auth: auth({
            spf: 'pass',
            spfDomain: 'proton.me',
            dkim: 'pass',
            dkimDomains: ['proton.me'],
            dmarc: 'pass',
            dmarcDomain: 'proton.me',
          }),
          confirmationWindowOpen: false,
        })
      ).toEqual({ accept: false, reason: 'disabled' })
    })
  })

  it('treats an allow-listed Proton mailbox as a sender, not a confirmation', () => {
    expect(
      acceptMessage({
        ...base,
        allowedSenders: ['me@proton.me'],
        envelopeFrom: 'me@proton.me',
        auth: auth({ spf: 'pass', spfDomain: 'proton.me' }),
      })
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

  it('keeps a link only when its host is the provider’s', () => {
    for (const url of [
      'https://elsewhere.example/?proton.me',
      'https://proton.me.elsewhere.example/confirm',
      'https://elsewhere.example/account.proton.me',
      'https://proton.me@elsewhere.example/',
      'https://proton.me:8443/confirm',
      'http://account.proton.me/confirm',
    ]) {
      expect(extractConfirmation('proton', 'Confirm', `Open ${url}`).url).toBeNull()
    }
    expect(
      extractConfirmation(
        'gmail',
        null,
        'Confirmation code: 812345678\nhttps://elsewhere.example/mail-settings.google.com/vf-x'
      )
    ).toEqual({ provider: 'gmail', code: '812345678', url: null })
    expect(extractConfirmation('other', null, 'https://example.test/x').url).toBeNull()
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
