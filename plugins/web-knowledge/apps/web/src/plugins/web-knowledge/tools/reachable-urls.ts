/**
 * Which URLs `fetch_page` may read in this chat turn or agent-run attempt: the ones `web_search`
 * returned to it, plus the URLs the person typed (`ToolCtx.requesterUrls`). A URL is a request the Worker makes on the model's say-so, and its path and query
 * can carry anything the model has read, so a URL the model composed is refused however public it
 * looks. One set per `agentTools` call, shared by the two tools.
 */
export interface ReachableUrls {
  add(url: string): void
  has(url: string): boolean
}

/** The form two spellings of one page share: parsed, without a fragment. */
function normalise(raw: string): string | null {
  try {
    const url = new URL(raw)
    url.hash = ''
    return url.toString()
  } catch {
    return null
  }
}

export function reachableUrls(initial: readonly string[] = []): ReachableUrls {
  const urls = new Set<string>()
  const add = (raw: string) => {
    const url = normalise(raw)
    if (url) urls.add(url)
  }
  initial.forEach(add)
  return {
    add,
    has: raw => {
      const url = normalise(raw)
      return url !== null && urls.has(url)
    },
  }
}
