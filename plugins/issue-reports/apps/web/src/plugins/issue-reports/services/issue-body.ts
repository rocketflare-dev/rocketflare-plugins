/**
 * What lands on GitHub: the agent's summary first, then who reported it and from where, then the
 * whole conversation folded away under `<details>`. Pure, so the exact text is unit-tested.
 *
 * No labels and no assignee — the team triages on GitHub.
 */
import type { IssueReportDraft } from '@rocketflare/shared/plugins/issue-reports/index'

/** GitHub refuses a body over 65 536 characters; leave room for the summary and the frame. */
export const GITHUB_BODY_MAX = 65_000

export interface TranscriptEntry {
  speaker: 'reporter' | 'agent'
  text: string
}

export interface IssueBodyInput {
  draft: IssueReportDraft
  reporterName: string
  pagePath?: string
  transcript: readonly TranscriptEntry[]
}

const TRUNCATED = '\n\n_…the start of the conversation was cut to fit GitHub’s size limit._'

function quoteBlock(text: string): string {
  return text
    .trim()
    .split('\n')
    .map(line => `> ${line}`)
    .join('\n')
}

function renderTranscript(reporterName: string, transcript: readonly TranscriptEntry[]): string {
  return transcript
    .map(entry => {
      const who = entry.speaker === 'reporter' ? reporterName : 'Assistant'
      return `**${who}:**\n${quoteBlock(entry.text)}`
    })
    .join('\n\n')
}

export function buildIssueBody(input: IssueBodyInput): string {
  const lead =
    input.draft.mode === 'comment' ? `**Also reported by ${input.reporterName}.**\n\n` : ''
  const context = [
    `**Reported by:** ${input.reporterName}, through Ideas & issues in the app`,
    input.pagePath ? `**Page:** \`${input.pagePath}\`` : null,
  ]
    .filter(Boolean)
    .join('  \n')
  const head = `${lead}${input.draft.body.trim()}\n\n---\n\n${context}\n\n<details>\n<summary>Full conversation</summary>\n\n`
  const tail = '\n\n</details>\n'

  let transcript = renderTranscript(input.reporterName, input.transcript)
  const room = GITHUB_BODY_MAX - head.length - tail.length
  if (transcript.length > room) {
    // Keep the END: the latest answers are what the summary was drafted from.
    transcript = TRUNCATED + transcript.slice(transcript.length - (room - TRUNCATED.length))
  }
  return head + transcript + tail
}
