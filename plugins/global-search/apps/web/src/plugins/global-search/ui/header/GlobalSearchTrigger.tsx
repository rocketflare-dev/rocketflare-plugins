/**
 * The header's search box (`UiPlugin.header`, placement `center`): a button that looks like an
 * input and opens the ⌘K palette — so does ⌘K / Ctrl-K anywhere in the shell. The palette is its
 * own lazy chunk, loaded on first open. Below `sm` it is an icon button, so the one-row header
 * fits at every width. Focus returns to wherever it was when the palette closes.
 */
import { MagnifyingGlassIcon } from '@heroicons/react/24/outline'
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'

const CommandPalette = lazy(() => import('../components/CommandPalette'))

/** ⌘K on a Mac, Ctrl-K elsewhere — both are accepted everywhere. */
export function isPaletteShortcut(e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey'>) {
  return (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k'
}

const isMac = () => typeof navigator !== 'undefined' && /mac/i.test(navigator.platform)

export default function GlobalSearchTrigger() {
  const [open, setOpen] = useState(false)
  const returnFocus = useRef<HTMLElement | null>(null)

  const show = useCallback(() => {
    returnFocus.current = document.activeElement as HTMLElement | null
    setOpen(true)
  }, [])
  const close = useCallback(() => {
    setOpen(false)
    const el = returnFocus.current
    // After the dialog unmounts, or the focus would land on a node that is going away.
    setTimeout(() => el?.focus?.(), 0)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isPaletteShortcut(e)) return
      e.preventDefault()
      setOpen(o => {
        if (!o) returnFocus.current = document.activeElement as HTMLElement | null
        return true
      })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <>
      <button
        type="button"
        onClick={show}
        aria-label="Search"
        aria-haspopup="dialog"
        aria-keyshortcuts="Meta+K Control+K"
        className="btn btn-sm btn-ghost btn-square sm:w-full sm:max-w-sm sm:justify-start sm:gap-2 sm:px-3 sm:border sm:border-[var(--border-default)] font-normal text-muted"
      >
        <MagnifyingGlassIcon className="w-4 h-4 shrink-0" aria-hidden="true" />
        <span className="hidden sm:inline flex-1 text-left truncate">Search…</span>
        <kbd className="kbd kbd-xs hidden sm:inline-flex">{isMac() ? '⌘K' : 'Ctrl K'}</kbd>
      </button>
      {open && (
        <Suspense fallback={null}>
          <CommandPalette onClose={close} />
        </Suspense>
      )}
    </>
  )
}
