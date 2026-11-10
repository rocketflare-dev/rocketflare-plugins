/**
 * A guide page as the reader renders it: heading ids from the server's outline, callouts from the
 * config's labels, links between pages kept in the app, and raw HTML SANITISED — a page may use
 * `<kbd>` and `<details>`, never a script, a handler, a frame or a style.
 */
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { GuideMarkdown } from '../../ui/pages/GuideMarkdown'
import { calloutLabelText } from '../../ui/pages/remarkGuide'

function renderPage(markdown: string, outline = [{ id: 'do-it', text: 'Do it', level: 2 }]) {
  return render(
    <MemoryRouter>
      <GuideMarkdown
        markdown={markdown}
        pagePath="start/welcome.md"
        outline={outline as never}
        calloutLabels={['RULE OF THUMB', 'NOTE']}
      />
    </MemoryRouter>
  )
}

describe('GuideMarkdown', () => {
  it('gives headings the outline’s ids, so citations land', () => {
    const { container } = renderPage('Intro.\n\n## Do it\n\nSteps.')
    expect(container.querySelector('h2')?.id).toBe('do-it')
  })

  it('turns a labelled blockquote into a callout, in sentence case; leaves others alone', () => {
    const { container } = renderPage(
      '> **RULE OF THUMB** — Invite with the role they need today.\n\n> A plain quote.'
    )
    const aside = container.querySelector('aside[data-callout="rule-of-thumb"]')
    expect(aside).not.toBeNull()
    expect(aside?.textContent).toContain('Rule of thumb')
    expect(aside?.textContent).toContain('Invite with the role they need today.')
    expect(aside?.textContent).not.toContain('—')
    expect(container.querySelectorAll('blockquote')).toHaveLength(1)
    expect(calloutLabelText('RULE OF THUMB')).toBe('Rule of thumb')
  })

  it('keeps a link between pages in the reader; opens an outside one in a new tab', () => {
    renderPage('[Reports](reports.md#reading-a-report) and [Acme](https://acme.test).')
    expect(screen.getByRole('link', { name: 'Reports' }).getAttribute('href')).toBe(
      '/guide?path=start%2Freports.md#reading-a-report'
    )
    const outside = screen.getByRole('link', { name: 'Acme' })
    expect(outside.getAttribute('target')).toBe('_blank')
    expect(outside.getAttribute('rel')).toBe('noopener noreferrer')
  })

  it('allows kbd and details, and strips script, handlers, frames and styles', () => {
    const { container } = renderPage(
      [
        'Press <kbd>?</kbd>.',
        '',
        '<details><summary>More</summary>',
        '',
        'Folded.',
        '',
        '</details>',
        '',
        '<script>window.pwned = 1</script>',
        '<img src="x.png" alt="x" onerror="window.pwned = 1">',
        '<iframe src="https://evil.test"></iframe>',
        '<p style="color:red" onclick="window.pwned = 1">Styled</p>',
        '<a href="javascript:alert(1)">bad</a>',
      ].join('\n')
    )
    expect(container.querySelector('kbd')?.textContent).toBe('?')
    expect(container.querySelector('details summary')?.textContent).toBe('More')
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('iframe')).toBeNull()
    expect(container.querySelector('[onerror]')).toBeNull()
    expect(container.querySelector('[onclick]')).toBeNull()
    expect(container.querySelector('[style]')).toBeNull()
    expect(container.innerHTML).not.toContain('javascript:')
    expect((window as unknown as { pwned?: number }).pwned).toBeUndefined()
  })
})
