/**
 * Mock data for the design lab. Mirrors the app's design sandbox
 * (apps/web/src/sandbox/demo-data.ts) so screens look like the real thing.
 * Nothing here talks to a server.
 */

export type Chat = { id: string; title: string; time: string; status?: 'running' | 'idle' }
export type Project = { name: string; chats: Chat[]; open?: boolean }

export const pinned: Chat[] = [{ id: 'release-notes', title: 'Release notes for v0.5.0', time: '5h' }]

export const projects: Project[] = [
  {
    name: 'tastecode',
    open: true,
    chats: [
      { id: 'focus-ring', title: 'Soften the prompt bar focus ring', time: '2h' },
      { id: 'sidebar-spacing', title: 'Audit sidebar spacing', time: '1d', status: 'running' },
      { id: 'transcript-jump', title: 'Why does the transcript jump on resize?', time: '3d' },
    ],
  },
  { name: 'design-system', chats: [{ id: 'dark-tokens', title: 'Dark mode token audit', time: '4d' }] },
  { name: 'website', chats: [{ id: 'hero-copy', title: 'Hero copy variations', time: '1w' }] },
]

/** One block of an assistant reply. Kept tiny on purpose: paragraphs and bullet lists. */
export type Block = { kind: 'p'; text: string } | { kind: 'ul'; items: string[] }

export type Turn =
  | { role: 'user'; text: string }
  | { role: 'assistant'; worked: string; blocks: Block[]; time: string }

export const transcript: Turn[] = [
  {
    role: 'user',
    text: 'The prompt bar focus ring is too loud. Can you soften it without hurting contrast for keyboard users?',
  },
  {
    role: 'assistant',
    worked: 'Worked for 48s',
    time: '18:37',
    blocks: [
      { kind: 'p', text: 'I softened the ring rather than removing it:' },
      {
        kind: 'ul',
        items: [
          'The outline now mixes the accent at 55% instead of drawing it at full strength.',
          'It sits 1px from the bar instead of 2px, so it reads as part of the control.',
          'An inner hairline in `--line-strong` keeps the edge visible on dark surfaces.',
        ],
      },
      {
        kind: 'p',
        text: 'The focus-outline tests still pass. Keyboard focus measures 3.4:1 against `--bg-prompt`, above the 3:1 that WCAG asks for non-text contrast.',
      },
    ],
  },
  { role: 'user', text: 'Looks better. Does the light theme still pass?' },
  {
    role: 'assistant',
    worked: 'Worked for 22s',
    time: '18:46',
    blocks: [
      { kind: 'p', text: 'Yes. In the light theme the mixed accent lands at 4.1:1 against the prompt bar, and the contrast tests pass.' },
      { kind: 'p', text: 'If you want it quieter still, `50%` is the lowest mix that keeps 3:1 in both themes.' },
    ],
  },
  { role: 'user', text: 'Keep 55%. Anything else to check before I merge?' },
  {
    role: 'assistant',
    worked: 'Worked for 8s',
    time: '18:56',
    blocks: [
      {
        kind: 'p',
        text: 'Nothing else. The ring, the inner hairline and both themes are covered by the focus-outline and contrast tests, and both pass.',
      },
    ],
  },
]
