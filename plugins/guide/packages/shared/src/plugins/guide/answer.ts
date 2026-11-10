/**
 * What of a model's "Ask the Guide" answer a reader sees. One pure implementation for the server
 * (which parses the `CITATIONS:` block off the finished answer) and the UI (which hides it while
 * the answer streams), so the two never disagree about where the answer ends.
 *
 * Models do not always write the block as the prompt asks. Seen in practice:
 * - the header decorated as Markdown (`- CITATIONS:`, `**CITATIONS:**`, `### Citations:`), which
 *   left an orphaned `-` or `**` behind as an empty bullet, and which the server did not
 *   recognise at all;
 * - Markdown footnote references (`[^2][^5]`) as well as, or instead of, the block. With no
 *   definitions they render as literal text.
 *
 * Zero imports, like `./content.ts`.
 */

/**
 * The block's header: a line reading `CITATIONS:`, whatever Markdown a model wraps it in — list
 * markers, a heading, a blockquote, bold, italics or a code span, before or after the colon.
 */
const CITATIONS_HEADER =
  /^[ \t]*(?:[-*+>#][ \t]*)*(?:\d+[.)][ \t]*)?[*_`]*citations[*_`]*[ \t]*:[*_`]*[ \t]*/im

/** A line that is only Markdown decoration: what a stripped header or footnote leaves behind. */
const DECORATION_ONLY = /^[ \t]*(?:[-*+>#_`=]+|\d+[.)])?[ \t]*$/

/** A footnote reference, `[^1]` or `[^note]`. */
const FOOTNOTE_REF = /\[\^[^\]\s]+\]/g

/** A footnote definition line, `[^1]: …`. */
const FOOTNOTE_DEF = /^[ \t]*\[\^[^\]\s]+\]:.*$/gm

/** Split an answer at its `CITATIONS:` header: the prose before it and the block after it. */
export function splitGuideAnswer(text: string): { prose: string; block: string | null } {
  const match = CITATIONS_HEADER.exec(text)
  if (!match) return { prose: text, block: null }
  return { prose: text.slice(0, match.index), block: text.slice(match.index + match[0].length) }
}

/**
 * The answer as a reader should see it: without the citations block, without footnote marks
 * and without the decoration either of them left on the last lines. Safe on a partial answer
 * mid-stream.
 */
export function cleanGuideAnswer(text: string): string {
  const { prose } = splitGuideAnswer(text)
  const lines = prose.replace(FOOTNOTE_DEF, '').replace(FOOTNOTE_REF, '').split('\n')
  while (lines.length > 0 && DECORATION_ONLY.test(lines[lines.length - 1] ?? '')) lines.pop()
  return lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()
}
