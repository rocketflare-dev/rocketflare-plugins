/**
 * A small guide built through the REAL loader (`buildGuideBundle`), for every test that needs one:
 * two member pages, one admin page, a fact and a screen. Deterministic — the hash is sha256.
 */
import { createHash } from 'node:crypto'
import {
  buildGuideBundle,
  type GuideBundle,
  type GuideSourceFile,
} from '@rocketflare/shared/plugins/guide/index'

export const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')

export const FIXTURE_CONFIG = {
  label: 'Acme handbook',
  appName: 'Acme',
  parts: [
    {
      id: 'start',
      label: 'Getting started',
      sections: [{ id: 'basics', label: 'The basics' }],
    },
    { id: 'admin', label: 'Administration', sections: [{ id: 'people', label: 'People' }] },
  ],
  calloutLabels: ['NOTE'],
  facts: { 'invite.days': '7' },
  screens: {
    '/': 'start/welcome.md',
    '/settings': 'admin/people.md',
    '/reports': 'start/reports.md',
  },
}

const page = (fm: Record<string, string>, body: string) =>
  `---\n${Object.entries(fm)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')}\n---\n\n${body}\n`

export const FIXTURE_FILES: GuideSourceFile[] = [
  { path: 'guide.config.json', raw: JSON.stringify(FIXTURE_CONFIG, null, 2) },
  { path: 'VOICE.md', raw: '# Voice\n\nNot a page.\n' },
  {
    path: 'start/welcome.md',
    raw: page(
      {
        title: 'Welcome',
        part: 'start',
        section: 'basics',
        order: '1',
        audience: 'member',
        summary: 'Where things are.',
        sources: '[src/home.ts]',
        verified: '"1234567"',
      },
      '# Welcome\n\nAcme keeps your work in one place.\n\n## Finding your way\n\nThe navigation on the left lists every screen. See [reports](reports.md#reading-a-report).\n\n## Watch out for\n\nA screen you expected is missing when your role cannot open it.'
    ),
  },
  {
    path: 'start/reports.md',
    raw: page(
      {
        title: 'Reports',
        part: 'start',
        section: 'basics',
        order: '2',
        audience: 'member',
        summary: 'Read the weekly figures.',
        sources: '[src/reports.ts]',
        verified: '"1234567"',
      },
      '# Reports\n\nThe weekly figures for your team.\n\n## Reading a report\n\nEach row is one week of throughput, newest first.'
    ),
  },
  {
    path: 'admin/people.md',
    raw: page(
      {
        title: 'Managing people',
        part: 'admin',
        section: 'people',
        order: '1',
        audience: 'admin',
        summary: 'Invitations and roles.',
        sources: '[src/people.ts]',
        verified: '"1234567"',
      },
      '# Managing people\n\nAdmins decide who is in the organisation.\n\n## Do it\n\nAn admin sends an invitation to an email address. It expires after {{fact:invite.days}} days.\n\n> **NOTE** — Only an owner can make someone an owner.'
    ),
  },
]

export function buildFixture(files: GuideSourceFile[] = FIXTURE_FILES): GuideBundle {
  const built = buildGuideBundle({ files, images: [], hash: sha256 })
  if (!built.bundle) {
    throw new Error(`fixture does not build: ${JSON.stringify(built.problems, null, 2)}`)
  }
  return built.bundle
}
