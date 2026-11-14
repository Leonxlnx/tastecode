/**
 * Example chats for the new design's sidebar. Lab-only mock data.
 *
 * Times are minutes before the lab loaded, so Today, Yesterday and the older
 * date groups always have something in them. `created` and `updated` differ
 * on purpose: an old chat with fresh activity lands near the top under
 * "Last updated" and near the bottom under "Created".
 */

/**
 * idle: nothing new. running: the agent is working. unread: it finished and
 * you haven't looked yet. approval / input / failed: it's stuck on you
 * (waiting for approval, waiting for an answer, or it failed); the same
 * three the app's "Needs you" band shows.
 */
export type ChatStatus = 'idle' | 'running' | 'unread' | 'approval' | 'input' | 'failed'

export type Chat = {
  id: string
  title: string
  project: string
  /** Epoch ms. */
  created: number
  /** Epoch ms. */
  updated: number
  status: ChatStatus
  pinned: boolean
}

export const LOADED_AT = Date.now()

const M = 60_000
const H = 60 * M
const D = 24 * H

type Example = [id: string, title: string, created: number, updated: number, status?: ChatStatus, pinned?: 'pinned']

/** Projects in the order they were added. `playground` is empty on purpose. */
const examples: Record<string, Example[]> = {
  tastecode: [
    ['release-notes', 'Release notes for v0.5.0', 5 * H, 5 * H, 'idle', 'pinned'],
    ['organize-menu', 'Wire up the organize menu', 25 * M, 1 * M, 'running'],
    ['focus-ring', 'Soften the prompt bar focus ring', 2 * H, 3 * M, 'unread'],
    ['worktree-crash', 'Crash when a worktree is deleted mid-turn', 40 * D, 1 * H],
    ['model-picker-keys', 'Model picker keyboard navigation', 6 * H, 8 * M, 'approval'],
    ['sidebar-spacing', 'Audit sidebar spacing', 1 * D, 35 * M, 'input'],
    ['transcript-jump', 'Why does the transcript jump on resize?', 3 * D, 3 * D],
    ['cmd-shims', 'Fix Windows .cmd shim escaping', 9 * D, 2 * H, 'failed'],
    ['nightly-checklist', 'Promote dev to nightly checklist', 15 * D, 15 * D],
  ],
  'design-system': [
    ['squircles', 'Squircle corners on every control', 2 * H, 40 * M, 'unread'],
    ['dark-tokens', 'Dark mode token audit', 4 * D, 4 * D],
    ['etched-lines', 'Etched separators in the light theme', 8 * D, 6 * D],
    ['hover-springs', 'Spring curves for hover icons', 20 * D, 20 * D],
    ['terminal-mono', 'Pick a monospace for the terminal', 70 * D, 70 * D],
  ],
  website: [
    ['pricing-faq', 'Pricing page FAQ', 3 * D, 1 * D],
    ['og-image', 'OG image for the launch post', 26 * H, 26 * H],
    ['hero-copy', 'Hero copy variations', 7 * D, 7 * D],
    ['changelog-layout', 'Changelog page layout', 45 * D, 45 * D],
  ],
  mobile: [
    ['push-done', 'Push notifications when a turn finishes', 3 * H, 12 * M, 'running'],
    ['qr-pairing', 'Pair a phone with a QR code', 12 * D, 3 * H, 'input'],
    ['offline-cache', 'Offline transcript cache', 31 * D, 31 * D],
  ],
  infra: [
    // Pinned and waiting on you: in the Inbox it shows under Needs you.
    ['notarize', 'Sign and notarize the macOS build', 2 * D, 22 * M, 'approval', 'pinned'],
    ['feed-404', 'Nightly update feed returns 404', 50 * M, 50 * M, 'unread'],
    ['appimage-speed', 'Speed up the Linux AppImage build', 5 * D, 5 * D, 'running'],
    ['signing-key', 'Rotate the release signing key', 120 * D, 100 * D],
  ],
  playground: [],
}

export const exampleProjects: string[] = Object.keys(examples)

export const exampleChats: Chat[] = Object.entries(examples).flatMap(([project, chats]) =>
  chats.map(([id, title, created, updated, status = 'idle', pinned]) => ({
    id,
    title,
    project,
    created: LOADED_AT - created,
    updated: LOADED_AT - updated,
    status,
    pinned: pinned === 'pinned',
  })),
)
