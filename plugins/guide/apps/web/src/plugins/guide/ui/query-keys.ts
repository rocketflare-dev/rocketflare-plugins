/**
 * The plugin's query families (D31). Every root starts with `guide:`. The guide is static content
 * for the life of a deployment, so nothing here refetches on focus or on a timer.
 */
const TOC = 'guide:toc'
const PAGE = 'guide:page'
const SEARCH = 'guide:search'

export const guideKeys = {
  toc: [TOC] as const,
  page: (path: string) => [PAGE, path] as const,
  search: (q: string) => [SEARCH, q] as const,
}

export const guideQueryKeys = {
  [TOC]: { all: guideKeys.toc },
  [PAGE]: { all: [PAGE] as const, page: guideKeys.page },
  [SEARCH]: { all: [SEARCH] as const, search: guideKeys.search },
} as const
